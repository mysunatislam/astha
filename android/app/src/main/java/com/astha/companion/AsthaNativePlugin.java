package com.astha.companion;

import android.Manifest;
import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Device capabilities the Android WebView does not provide: a local voice, a speech
 * recognizer, and (only after explicit opt-in) reading the screen of other apps.
 * No request content is logged.
 */
@CapacitorPlugin(
    name = "AsthaNative",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class AsthaNativePlugin extends Plugin {
    private static final String PREFERENCES = "astha_native";
    private static final String SCREEN_CONSENT = "screen_access_consent";
    private static final String MESSAGE_CONSENT = "message_access_consent";
    private static final int MAX_REPLY = 1000;
    private static final int MAX_SPOKEN = 4000;
    private static final int MAX_SCREEN_NODES = 400;
    private static final int MAX_SCREEN_CHARS = 6000;
    private static final int MAX_APP_MATCHES = 5;
    private static final int MAX_SHARED_TEXT = 2000;

    private TextToSpeech voice;
    private volatile boolean voiceReady;
    private final Map<String, PluginCall> speaking = new ConcurrentHashMap<>();
    private SpeechRecognizer recognizer;
    private PluginCall listening;

    @Override
    public void load() {
        AsthaMessageAssistant.appVisible = true;
        if (messageConsent()) AsthaNotificationListener.deliverTo(this::forwardMessage);
        // Turned on earlier by the user: start it again now that ASTHA is on screen.
        if (messageConsent() && backgroundWanted() && getPermissionState("microphone") == PermissionState.GRANTED) {
            try {
                AsthaMessageAssistant.start(getContext(), preferences().getString(AsthaMessageAssistant.LANGUAGE, "en"));
            } catch (RuntimeException refused) {
                // The status line then reports that it is not running.
            }
        }
        voice = new TextToSpeech(getContext().getApplicationContext(), status -> {
            voiceReady = status == TextToSpeech.SUCCESS;
            if (!voiceReady) return;
            voice.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String id) {}

                @Override
                public void onDone(String id) {
                    finishSpeaking(id, true);
                }

                @Override
                public void onError(String id) {
                    finishSpeaking(id, false);
                }

                @Override
                public void onStop(String id, boolean interrupted) {
                    finishSpeaking(id, false);
                }
            });
        });
    }

    @Override
    protected void handleOnResume() {
        AsthaMessageAssistant.appVisible = true;
    }

    @Override
    protected void handleOnPause() {
        AsthaMessageAssistant.appVisible = false;
        // The page never listens while it is in the background; only the assistant may, if on.
        getActivity().runOnUiThread(() -> finishListening("", null));
    }

    @Override
    protected void handleOnDestroy() {
        AsthaMessageAssistant.appVisible = false;
        AsthaNotificationListener.deliverTo(null);
        if (voice != null) voice.shutdown();
        getActivity().runOnUiThread(this::releaseRecognizer);
    }

    private void finishSpeaking(String id, boolean completed) {
        PluginCall call = speaking.remove(id);
        if (call == null) return;
        JSObject result = new JSObject();
        result.put("completed", completed);
        call.resolve(result);
    }

    private void finishAllSpeaking() {
        for (String id : new ArrayList<>(speaking.keySet())) finishSpeaking(id, false);
    }

    // ---- Speech output ---------------------------------------------------------------

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (!voiceReady || text == null || text.trim().isEmpty() || text.length() > MAX_SPOKEN) {
            call.reject("No device voice is available.", "voice_unavailable");
            return;
        }
        // Phones ship Bangla as Bangladesh, India or just "bn"; use whichever is installed.
        Locale[] wanted = "bn".equals(call.getString("lang", "en"))
            ? new Locale[] { new Locale("bn", "BD"), new Locale("bn", "IN"), new Locale("bn") }
            : new Locale[] { Locale.US, Locale.UK, Locale.ENGLISH };
        Locale locale = null;
        for (Locale candidate : wanted) {
            if (voice.isLanguageAvailable(candidate) >= TextToSpeech.LANG_AVAILABLE) {
                locale = candidate;
                break;
            }
        }
        if (locale == null) {
            call.reject("The device has no voice for this language.", "voice_language_unavailable");
            return;
        }
        Float rate = call.getFloat("rate", 1f);
        voice.setLanguage(locale);
        voice.setSpeechRate(Math.max(0.5f, Math.min(2f, rate == null ? 1f : rate)));
        // A new sentence replaces the one being spoken; the replaced call reports it did not finish.
        finishAllSpeaking();
        String id = UUID.randomUUID().toString();
        speaking.put(id, call);
        if (voice.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) finishSpeaking(id, false);
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        if (voiceReady) voice.stop();
        finishAllSpeaking();
        call.resolve();
    }

    // ---- Speech input ----------------------------------------------------------------

    @PluginMethod
    public void listen(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphoneResult");
            return;
        }
        startRecognition(call);
    }

    @PermissionCallback
    private void microphoneResult(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) startRecognition(call);
        else call.reject("Microphone permission was not granted.", "permission");
    }

    private void releaseRecognizer() {
        if (recognizer != null) {
            recognizer.cancel();
            recognizer.destroy();
            recognizer = null;
        }
    }

    private void finishListening(String text, String errorCode) {
        PluginCall call = listening;
        listening = null;
        releaseRecognizer();
        if (call == null) return;
        if (errorCode != null) {
            call.reject("Speech recognition did not complete.", errorCode);
            return;
        }
        JSObject result = new JSObject();
        result.put("text", text == null ? "" : text);
        call.resolve(result);
    }

    private void startRecognition(PluginCall call) {
        String language = call.getString("language", "bn-BD");
        getActivity().runOnUiThread(() -> {
            Context context = getContext();
            if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                call.reject("This device has no speech recognizer.", "recognizer_unavailable");
                return;
            }
            // Only one request listens at a time; an earlier one ends without a result.
            finishListening("", null);
            listening = call;
            recognizer = SpeechRecognizer.createSpeechRecognizer(context);
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override
                public void onResults(Bundle results) {
                    ArrayList<String> heard = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    finishListening(heard == null || heard.isEmpty() ? "" : heard.get(0), null);
                }

                @Override
                public void onError(int error) {
                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) finishListening("", null);
                    else if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) finishListening(null, "permission");
                    else if (error == SpeechRecognizer.ERROR_NETWORK || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT) finishListening(null, "network");
                    else finishListening(null, "recognition_failed");
                }

                @Override
                public void onReadyForSpeech(Bundle params) {}

                @Override
                public void onBeginningOfSpeech() {}

                @Override
                public void onRmsChanged(float rmsdB) {}

                @Override
                public void onBufferReceived(byte[] buffer) {}

                @Override
                public void onEndOfSpeech() {}

                @Override
                public void onPartialResults(Bundle partialResults) {}

                @Override
                public void onEvent(int eventType, Bundle params) {}
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.getPackageName());
            recognizer.startListening(intent);
        });
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            finishListening("", null);
            call.resolve();
        });
    }

    // ---- Opening an app or the share sheet, each time the user asks ---------------------
    // Ordinary intents only. ASTHA cannot choose a recipient, press send, call or text.

    private List<ResolveInfo> launchable() {
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        return getContext().getPackageManager().queryIntentActivities(launcher, 0);
    }

    @PluginMethod
    public void findApps(PluginCall call) {
        String wanted = call.getString("name", "");
        wanted = wanted == null ? "" : wanted.trim().toLowerCase(Locale.ROOT);
        if (wanted.isEmpty() || wanted.length() > 60) {
            call.reject("Name an app to look for.", "invalid_name");
            return;
        }
        PackageManager packages = getContext().getPackageManager();
        String own = getContext().getPackageName();
        List<JSObject> exact = new ArrayList<>();
        List<JSObject> partial = new ArrayList<>();
        for (ResolveInfo info : launchable()) {
            String id = info.activityInfo.packageName;
            if (own.equals(id)) continue;
            CharSequence shown = info.loadLabel(packages);
            String label = shown == null ? "" : shown.toString().trim();
            String folded = label.toLowerCase(Locale.ROOT);
            if (label.isEmpty() || !folded.contains(wanted)) continue;
            JSObject app = new JSObject();
            app.put("id", id);
            app.put("label", label);
            (folded.equals(wanted) ? exact : partial).add(app);
        }
        // An exact name wins outright; otherwise the caller hears the few candidates.
        List<JSObject> chosen = exact.isEmpty() ? partial : exact;
        JSArray apps = new JSArray();
        for (int index = 0; index < chosen.size() && index < MAX_APP_MATCHES; index++) apps.put(chosen.get(index));
        JSObject result = new JSObject();
        result.put("apps", apps);
        call.resolve(result);
    }

    @PluginMethod
    public void openApp(PluginCall call) {
        String id = call.getString("id", "");
        Intent launch = id == null || id.isEmpty() ? null : getContext().getPackageManager().getLaunchIntentForPackage(id);
        if (launch == null) {
            call.reject("That app cannot be opened.", "app_unavailable");
            return;
        }
        getContext().startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }

    @PluginMethod
    public void shareText(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty() || text.length() > MAX_SHARED_TEXT) {
            call.reject("There is nothing to share.", "invalid_text");
            return;
        }
        // Android's own chooser: the user picks the app and the person, and sends it.
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
        getContext().startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }

    // ---- Messages: announce, and reply only with words the user confirmed ---------------

    private boolean messageConsent() {
        return preferences().getBoolean(MESSAGE_CONSENT, false);
    }

    private void forwardMessage(JSObject message) {
        notifyListeners("message", message);
    }

    private boolean notificationAccessEnabled() {
        return NotificationManagerCompat.getEnabledListenerPackages(getContext()).contains(getContext().getPackageName());
    }

    @PluginMethod
    public void messageAccessStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("consent", messageConsent());
        result.put("enabled", notificationAccessEnabled());
        result.put("background", messageConsent() && backgroundWanted());
        call.resolve(result);
    }

    @PluginMethod
    public void setMessageAccessConsent(PluginCall call) {
        boolean granted = Boolean.TRUE.equals(call.getBoolean("granted", false));
        preferences().edit().putBoolean(MESSAGE_CONSENT, granted).apply();
        if (!granted) {
            preferences().edit().putBoolean(AsthaMessageAssistant.BACKGROUND, false).apply();
            AsthaMessageAssistant.stop(getContext());
            AsthaNotificationListener.clear();
        }
        // Without consent the listener has nowhere to deliver, so it ignores and keeps nothing.
        AsthaNotificationListener.deliverTo(granted ? this::forwardMessage : null);
        call.resolve();
    }

    private boolean backgroundWanted() {
        return preferences().getBoolean(AsthaMessageAssistant.BACKGROUND, false);
    }

    /** Reading messages aloud while ASTHA is not on screen: a separate choice, off by default. */
    @PluginMethod
    public void setBackgroundMessages(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        preferences().edit().putString(AsthaMessageAssistant.LANGUAGE, "bn".equals(call.getString("lang", "en")) ? "bn" : "en").apply();
        if (!enabled) {
            preferences().edit().putBoolean(AsthaMessageAssistant.BACKGROUND, false).apply();
            AsthaMessageAssistant.stop(getContext());
            call.resolve();
            return;
        }
        if (!messageConsent()) {
            call.reject("Message help has not been turned on in ASTHA.", "consent_required");
            return;
        }
        // It needs the microphone for the answer, and shows a notification while it runs.
        List<String> needed = new ArrayList<>();
        if (getPermissionState("microphone") != PermissionState.GRANTED) needed.add("microphone");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) needed.add("notifications");
        if (!needed.isEmpty()) {
            requestPermissionForAliases(needed.toArray(new String[0]), call, "backgroundPermissionResult");
            return;
        }
        startBackground(call);
    }

    @PermissionCallback
    private void backgroundPermissionResult(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Microphone permission was not granted.", "permission");
            return;
        }
        startBackground(call);
    }

    private void startBackground(PluginCall call) {
        try {
            AsthaMessageAssistant.start(getContext(), preferences().getString(AsthaMessageAssistant.LANGUAGE, "en"));
        } catch (RuntimeException refused) {
            call.reject("Android did not let ASTHA keep running.", "not_started");
            return;
        }
        preferences().edit().putBoolean(AsthaMessageAssistant.BACKGROUND, true).apply();
        call.resolve();
    }

    @PluginMethod
    public void openNotificationAccessSettings(PluginCall call) {
        if (!messageConsent()) {
            call.reject("Message help has not been turned on in ASTHA.", "consent_required");
            return;
        }
        // Android shows its own warning and only the user can grant notification access.
        getContext().startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }

    @PluginMethod
    public void replyToMessage(PluginCall call) {
        if (!messageConsent()) {
            call.reject("Message help has not been turned on in ASTHA.", "consent_required");
            return;
        }
        AsthaNotificationListener listener = AsthaNotificationListener.running();
        if (listener == null) {
            call.reject("ASTHA does not have notification access.", "service_disabled");
            return;
        }
        String key = call.getString("key", "");
        String text = call.getString("text", "");
        if (key == null || key.isEmpty() || text == null || text.trim().isEmpty() || text.length() > MAX_REPLY) {
            call.reject("There is nothing to send.", "invalid_reply");
            return;
        }
        JSObject result = new JSObject();
        result.put("sent", listener.reply(key, text));
        call.resolve(result);
    }

    // ---- Reading other apps, only after explicit opt-in --------------------------------

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private boolean screenConsent() {
        return preferences().getBoolean(SCREEN_CONSENT, false);
    }

    /** The service, but only when both Android and the user's in-app choice allow it. */
    private AsthaAccessibilityService permittedService(PluginCall call) {
        AsthaAccessibilityService service = AsthaAccessibilityService.running();
        if (!screenConsent()) {
            call.reject("Screen reading has not been turned on in ASTHA.", "consent_required");
            return null;
        }
        if (service == null) {
            call.reject("ASTHA is not enabled in Android Accessibility settings.", "service_disabled");
            return null;
        }
        return service;
    }

    @PluginMethod
    public void screenAccessStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("consent", screenConsent());
        result.put("serviceEnabled", AsthaAccessibilityService.running() != null);
        call.resolve(result);
    }

    @PluginMethod
    public void setScreenAccessConsent(PluginCall call) {
        boolean granted = Boolean.TRUE.equals(call.getBoolean("granted", false));
        preferences().edit().putBoolean(SCREEN_CONSENT, granted).apply();
        AsthaAccessibilityService service = AsthaAccessibilityService.running();
        // Turning it off in ASTHA also switches the Android service off.
        if (!granted && service != null) service.disableSelf();
        call.resolve();
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        if (!screenConsent()) {
            call.reject("Screen reading has not been turned on in ASTHA.", "consent_required");
            return;
        }
        // Android shows its own warning and only the user can switch the service on.
        getContext().startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }

    @PluginMethod
    public void readScreen(PluginCall call) {
        AsthaAccessibilityService service = permittedService(call);
        if (service == null) return;
        AsthaAccessibilityService.ScreenText screen = service.describe(MAX_SCREEN_NODES, MAX_SCREEN_CHARS);
        JSObject result = new JSObject();
        result.put("app", screen.app);
        result.put("text", screen.text);
        result.put("truncated", screen.truncated);
        call.resolve(result);
    }

    @PluginMethod
    public void globalAction(PluginCall call) {
        AsthaAccessibilityService service = permittedService(call);
        if (service == null) return;
        String action = call.getString("action", "");
        int code;
        if ("back".equals(action)) code = AccessibilityService.GLOBAL_ACTION_BACK;
        else if ("home".equals(action)) code = AccessibilityService.GLOBAL_ACTION_HOME;
        else {
            // Navigation only. Tapping, typing and sending are deliberately not offered.
            call.reject("Unsupported action.", "unsupported_action");
            return;
        }
        JSObject result = new JSObject();
        result.put("performed", service.performGlobalAction(code));
        call.resolve(result);
    }
}
