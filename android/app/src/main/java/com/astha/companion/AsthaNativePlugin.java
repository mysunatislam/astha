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
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

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
    private final SpeechInputRequests<PluginCall> speechRequests = new SpeechInputRequests<>();
    private final SpeechInputRequests<PluginCall> backgroundRequests = new SpeechInputRequests<>();
    private SpeechInputRequests.Request<PluginCall> recognizerRequest;
    private final Handler recognitionHandler = new Handler(Looper.getMainLooper());
    private Runnable recognitionLimit;

    @Override
    public void load() {
        AsthaMessageAssistant.appVisible = true;
        if (messageConsent()) AsthaNotificationListener.deliverTo(this::forwardMessage);
        // Turned on earlier by the user: start it again now that ASTHA is on screen.
        if (messageConsent() && backgroundWanted()) {
            try {
                if (backgroundStartError() != null) throw new IllegalStateException();
                AsthaMessageAssistant.start(getContext(), preferences().getString(AsthaMessageAssistant.LANGUAGE, "en"));
            } catch (RuntimeException refused) {
                preferences().edit().putBoolean(AsthaMessageAssistant.BACKGROUND, false).apply();
                AsthaMessageAssistant.stop(getContext());
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
        AsthaMessageAssistant.pauseForForeground();
    }

    @Override
    protected void handleOnPause() {
        AsthaMessageAssistant.appVisible = false;
        cancelBackgroundEnable();
        // The page never listens while it is in the background; only the assistant may, if on.
        cancelSpeechInput();
    }

    @Override
    protected void handleOnDestroy() {
        AsthaMessageAssistant.appVisible = false;
        cancelBackgroundEnable();
        AsthaNotificationListener.deliverTo(null);
        if (voice != null) voice.shutdown();
        cancelSpeechInput();
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

    // Shared with the locked-phone assistant: a language being available does not
    // prove its voice is installed or that synthesis stays off the network.
    static Voice installedLocalVoice(TextToSpeech engine, Locale... wanted) {
        if (engine == null || engine.getVoices() == null) return null;
        for (Locale locale : wanted) {
            for (Voice candidate : engine.getVoices()) {
                if (candidate == null || candidate.isNetworkConnectionRequired() ||
                    candidate.getFeatures() != null && candidate.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                if (locale.equals(candidate.getLocale())) return candidate;
            }
        }
        for (Locale locale : wanted) {
            for (Voice candidate : engine.getVoices()) {
                if (candidate == null || candidate.isNetworkConnectionRequired() ||
                    candidate.getFeatures() != null && candidate.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                if (locale.getLanguage().equals(candidate.getLocale().getLanguage())) return candidate;
            }
        }
        return null;
    }

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
        boolean onDeviceOnly = !Boolean.FALSE.equals(call.getBoolean("onDeviceOnly", true));
        if (onDeviceOnly) {
            Voice chosen = installedLocalVoice(voice, wanted);
            if (chosen == null || voice.setVoice(chosen) != TextToSpeech.SUCCESS) {
                call.reject("No installed offline voice is available for this language.", "voice_language_unavailable");
                return;
            }
        } else {
            Locale locale = null;
            for (Locale candidate : wanted) {
                if (voice.isLanguageAvailable(candidate) >= TextToSpeech.LANG_AVAILABLE) {
                    locale = candidate;
                    break;
                }
            }
            if (locale == null || voice.setLanguage(locale) < TextToSpeech.LANG_AVAILABLE) {
                call.reject("The device has no voice for this language.", "voice_language_unavailable");
                return;
            }
        }
        Float rate = call.getFloat("rate", 1f);
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
        SpeechInputRequests.Change<PluginCall> change = speechRequests.begin(call);
        recognitionHandler.post(() -> {
            finishListening(change.previous, "", null);
            if (!speechRequests.mayStart(change.request, foregroundForSpeech())) {
                finishListening(change.request, "", null);
                return;
            }
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                if (speechRequests.awaitPermission(change.request)) requestPermissionForAlias("microphone", call, "microphoneResult");
                return;
            }
            startRecognition(change.request);
        });
    }

    @PermissionCallback
    private void microphoneResult(PluginCall call) {
        SpeechInputRequests.Request<PluginCall> request = speechRequests.permissionResult(call);
        if (request == null) return; // Stop, pause, destruction or replacement already owns cleanup.
        recognitionHandler.post(() -> {
            if (!speechRequests.mayStart(request, foregroundForSpeech())) finishListening(request, "", null);
            else if (getPermissionState("microphone") == PermissionState.GRANTED) startRecognition(request);
            else finishListening(request, null, "permission");
        });
    }

    private boolean foregroundForSpeech() {
        return AsthaMessageAssistant.appVisible && getActivity() != null &&
            !getActivity().isFinishing() && !getActivity().isDestroyed();
    }

    private void cancelSpeechInput() {
        // Invalidate synchronously, before queued main-thread work or a permission
        // callback can start the old (possibly online) recognizer.
        SpeechInputRequests.Request<PluginCall> previous = speechRequests.cancel();
        recognitionHandler.post(() -> finishListening(previous, "", null));
    }

    private void releaseRecognizer() {
        if (recognitionLimit != null) recognitionHandler.removeCallbacks(recognitionLimit);
        recognitionLimit = null;
        if (recognizer != null) {
            SpeechRecognizer previous = recognizer;
            recognizer = null;
            recognizerRequest = null;
            previous.cancel();
            previous.destroy();
        }
    }

    private void finishListening(SpeechInputRequests.Request<PluginCall> request, String text, String errorCode) {
        if (request == null) return;
        if (recognizerRequest == request) releaseRecognizer();
        if (!speechRequests.complete(request)) return;
        PluginCall call = request.call;
        if (errorCode != null) {
            call.reject("Speech recognition did not complete.", errorCode);
            return;
        }
        JSObject result = new JSObject();
        result.put("text", text == null ? "" : text);
        call.resolve(result);
    }

    private void startRecognition(SpeechInputRequests.Request<PluginCall> request) {
        PluginCall call = request.call;
        String language = call.getString("language", "bn-BD");
        boolean onDeviceOnly = !Boolean.FALSE.equals(call.getBoolean("onDeviceOnly", true));
        recognitionHandler.post(() -> {
            if (!speechRequests.mayStart(request, foregroundForSpeech())) {
                finishListening(request, "", null);
                return;
            }
            Context context = getContext();
            if (onDeviceOnly && (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context))) {
                finishListening(request, null, "on_device_unavailable");
                return;
            }
            if (!onDeviceOnly && !SpeechRecognizer.isRecognitionAvailable(context)) {
                finishListening(request, null, "recognizer_unavailable");
                return;
            }
            final SpeechRecognizer requestRecognizer;
            try {
                if (onDeviceOnly) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) requestRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
                    else { finishListening(request, null, "on_device_unavailable"); return; }
                } else requestRecognizer = SpeechRecognizer.createSpeechRecognizer(context);
            } catch (RuntimeException unavailable) {
                finishListening(request, null, onDeviceOnly ? "on_device_unavailable" : "recognizer_unavailable");
                return;
            }
            recognizer = requestRecognizer;
            recognizerRequest = request;
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override
                public void onResults(Bundle results) {
                    if (!speechRequests.mayStart(request, foregroundForSpeech()) || recognizer != requestRecognizer) return;
                    ArrayList<String> heard = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    finishListening(request, heard == null || heard.isEmpty() ? "" : heard.get(0), null);
                }

                @Override
                public void onError(int error) {
                    if (!speechRequests.mayStart(request, foregroundForSpeech()) || recognizer != requestRecognizer) return;
                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) finishListening(request, "", null);
                    else if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) finishListening(request, null, "permission");
                    else if (error == SpeechRecognizer.ERROR_NETWORK || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT) finishListening(request, null, "network");
                    else if (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE) finishListening(request, null, "language_unavailable");
                    else finishListening(request, null, "recognition_failed");
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
            Runnable begin = () -> {
                if (!speechRequests.mayStart(request, foregroundForSpeech()) || recognizer != requestRecognizer) return;
                try { requestRecognizer.startListening(intent); }
                catch (RuntimeException unavailable) { finishListening(request, null, "recognition_failed"); }
            };
            // A broken service must not keep a microphone request pending forever,
            // including while an optional language-support query is outstanding.
            recognitionLimit = () -> finishListening(request, null, "recognition_timeout");
            recognitionHandler.postDelayed(recognitionLimit, 20000);
            if (onDeviceOnly && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                try {
                    requestRecognizer.checkRecognitionSupport(intent, context.getMainExecutor(), new RecognitionSupportCallback() {
                        @Override
                        public void onSupportResult(RecognitionSupport support) {
                            if (!speechRequests.mayStart(request, foregroundForSpeech()) || recognizer != requestRecognizer) return;
                            boolean installed = support.getInstalledOnDeviceLanguages().stream().anyMatch(language::equalsIgnoreCase);
                            if (installed) begin.run(); else finishListening(request, null, "language_unavailable");
                        }

                        @Override
                        public void onError(int error) {
                            if (!speechRequests.mayStart(request, foregroundForSpeech()) || recognizer != requestRecognizer) return;
                            // Older on-device providers may not implement this optional
                            // query. The selected engine is still strictly on-device.
                            if (error == SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT) begin.run();
                            else finishListening(request, null, error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ? "language_unavailable" : "recognition_failed");
                        }
                    });
                } catch (RuntimeException unsupportedQuery) { begin.run(); }
            } else begin.run();
        });
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        cancelSpeechInput();
        call.resolve();
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
            cancelBackgroundEnable();
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
            cancelBackgroundEnable();
            preferences().edit().putBoolean(AsthaMessageAssistant.BACKGROUND, false).apply();
            AsthaMessageAssistant.stop(getContext());
            call.resolve();
            return;
        }
        if (!messageConsent()) {
            call.reject("Message help has not been turned on in ASTHA.", "consent_required");
            return;
        }
        SpeechInputRequests.Change<PluginCall> change = backgroundRequests.begin(call);
        finishBackground(change.previous, "cancelled");
        // An unfinished/replaced enable attempt cannot leave a previous service authorized.
        preferences().edit().putBoolean(AsthaMessageAssistant.BACKGROUND, false).apply();
        AsthaMessageAssistant.stop(getContext());
        if (!foregroundForSpeech()) { finishBackground(change.request, "foreground_required"); return; }
        if (!notificationAccessEnabled()) { finishBackground(change.request, "service_disabled"); return; }
        // It needs the microphone for the answer, and shows a notification while it runs.
        List<String> needed = new ArrayList<>();
        if (getPermissionState("microphone") != PermissionState.GRANTED) needed.add("microphone");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) needed.add("notifications");
        if (!needed.isEmpty()) {
            if (backgroundRequests.awaitPermission(change.request)) {
                requestPermissionForAliases(needed.toArray(new String[0]), call, "backgroundPermissionResult");
            }
            return;
        }
        startBackground(change.request);
    }

    @PermissionCallback
    private void backgroundPermissionResult(PluginCall call) {
        SpeechInputRequests.Request<PluginCall> request = backgroundRequests.permissionResult(call);
        if (request != null) startBackground(request);
    }

    private String backgroundStartError() {
        return AsthaMessageAssistant.startError(getContext(), foregroundForSpeech());
    }

    private void finishBackground(SpeechInputRequests.Request<PluginCall> request, String error) {
        if (request == null || !backgroundRequests.complete(request)) return;
        if (error == null) request.call.resolve();
        else request.call.reject("Locked-phone message help was not enabled.", error);
    }

    private void cancelBackgroundEnable() {
        SpeechInputRequests.Request<PluginCall> previous = backgroundRequests.cancel();
        if (previous == null) return; // A successfully enabled service may continue when the screen locks.
        preferences().edit().putBoolean(AsthaMessageAssistant.BACKGROUND, false).apply();
        AsthaMessageAssistant.stop(getContext());
        finishBackground(previous, "cancelled");
    }

    private void startBackground(SpeechInputRequests.Request<PluginCall> request) {
        recognitionHandler.post(() -> {
            synchronized (backgroundRequests) {
                if (!backgroundRequests.mayStart(request, true)) { finishBackground(request, "cancelled"); return; }
                String error = backgroundStartError();
                if (error != null) { finishBackground(request, error); return; }
                // onStartCommand may run before this method returns: authorize first, then start.
                preferences().edit().putBoolean(AsthaMessageAssistant.BACKGROUND, true).apply();
                try {
                    AsthaMessageAssistant.start(getContext(), preferences().getString(AsthaMessageAssistant.LANGUAGE, "en"));
                } catch (RuntimeException refused) {
                    preferences().edit().putBoolean(AsthaMessageAssistant.BACKGROUND, false).apply();
                    AsthaMessageAssistant.stop(getContext());
                    finishBackground(request, "not_started");
                    return;
                }
                finishBackground(request, null);
            }
        });
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
