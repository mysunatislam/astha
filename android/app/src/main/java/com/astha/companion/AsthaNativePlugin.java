package com.astha.companion;

import android.Manifest;
import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
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
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class AsthaNativePlugin extends Plugin {
    private static final String PREFERENCES = "astha_native";
    private static final String SCREEN_CONSENT = "screen_access_consent";
    private static final int MAX_SPOKEN = 4000;
    private static final int MAX_SCREEN_NODES = 400;
    private static final int MAX_SCREEN_CHARS = 6000;

    private TextToSpeech voice;
    private volatile boolean voiceReady;
    private final Map<String, PluginCall> speaking = new ConcurrentHashMap<>();
    private SpeechRecognizer recognizer;
    private PluginCall listening;

    @Override
    public void load() {
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
    protected void handleOnDestroy() {
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
        Locale locale = "bn".equals(call.getString("lang", "en")) ? new Locale("bn", "BD") : Locale.US;
        if (voice.isLanguageAvailable(locale) < TextToSpeech.LANG_AVAILABLE) {
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
