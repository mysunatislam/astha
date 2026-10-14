package com.astha.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Locale;

/**
 * Reads new messages aloud while ASTHA is not on screen, including with the phone locked,
 * and sends the reply the user dictates after a spoken yes.
 *
 * It runs only after the user turned it on inside ASTHA, and shows a notification with a
 * "Turn off" button for as long as it runs. The microphone opens only for a few seconds right
 * after ASTHA has read a message or asked a question about it; it never listens otherwise.
 * Nothing is stored or logged. Silence, noise or anything but a clear yes at the confirm
 * step means nothing is sent. It waits while a call is in progress.
 */
public class AsthaMessageAssistant extends Service {
    static final String PREFERENCES = "astha_native";
    static final String BACKGROUND = "background_messages";
    static final String LANGUAGE = "voice_language";
    static final String ACTION_STOP = "com.astha.companion.STOP_MESSAGE_ASSISTANT";
    private static final String CHANNEL = "astha_messages";
    private static final int NOTIFICATION_ID = 4107;
    private static final long LISTEN_LIMIT_MS = 9000;
    private static final long CALL_RETRY_MS = 30000;
    private static final int QUEUE_LIMIT = 5;

    /** True while ASTHA's own screen is in front; the page answers messages itself then. */
    static volatile boolean appVisible = false;
    private static volatile AsthaMessageAssistant instance;

    private static final class Pending {
        final String key, app, sender, text;
        final boolean canReply;

        Pending(String key, String app, String sender, String text, boolean canReply) {
            this.key = key;
            this.app = app;
            this.sender = sender;
            this.text = text;
            this.canReply = canReply;
        }
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable nextMessage = this::next;
    private final ArrayDeque<Pending> queue = new ArrayDeque<>();
    private Pending current;
    private String stage;
    private String draft = "";
    private int retries;
    private boolean listenBangla;   // the language the user speaks to ASTHA
    private boolean bangla;         // the language ASTHA can speak back on this phone
    private TextToSpeech voice;
    private boolean voiceReady;
    private SpeechRecognizer recognizer;
    private Runnable listenLimit;
    private AudioFocusRequest focus;
    private int turn;

    static AsthaMessageAssistant running() {
        return instance;
    }

    static void start(Context context, String language) {
        Intent intent = new Intent(context, AsthaMessageAssistant.class).putExtra(LANGUAGE, language);
        ContextCompat.startForegroundService(context, intent);
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, AsthaMessageAssistant.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            // "Turn off" in the notification is the same as turning it off inside ASTHA.
            getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit().putBoolean(BACKGROUND, false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        String language = intent == null ? null : intent.getStringExtra(LANGUAGE);
        if (language == null) language = getSharedPreferences(PREFERENCES, MODE_PRIVATE).getString(LANGUAGE, "en");
        listenBangla = "bn".equals(language);
        try {
            showNotification();
        } catch (RuntimeException refused) {
            // Android refuses a microphone service that was not started while ASTHA was on screen.
            stopSelf();
            return START_NOT_STICKY;
        }
        instance = this;
        if (voice == null) {
            voice = new TextToSpeech(getApplicationContext(), status -> main.post(() -> {
                voiceReady = status == TextToSpeech.SUCCESS && voice != null;
                if (voiceReady) prepareVoice();
                if (current == null) next();
            }));
        } else if (voiceReady) {
            prepareVoice();   // the language may have changed
        }
        // Not restarted by Android on its own: it only ever runs because the user turned it on.
        return START_NOT_STICKY;
    }

    private void showNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.astha_messages_label), NotificationManager.IMPORTANCE_LOW));
        }
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent open = launch == null ? null : PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE);
        PendingIntent turnOff = PendingIntent.getService(this, 1,
            new Intent(this, AsthaMessageAssistant.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(getString(R.string.astha_messages_label))
            .setContentText(getString(R.string.astha_messages_running))
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, getString(R.string.astha_messages_turn_off), turnOff)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Locale installed(Locale... wanted) {
        for (Locale locale : wanted) {
            if (voice.isLanguageAvailable(locale) >= TextToSpeech.LANG_AVAILABLE) return locale;
        }
        return null;
    }

    private void prepareVoice() {
        Locale banglaVoice = listenBangla ? installed(new Locale("bn", "BD"), new Locale("bn", "IN"), new Locale("bn")) : null;
        // With no Bangla voice on the phone, ASTHA speaks English instead of staying silent.
        bangla = banglaVoice != null;
        Locale chosen = bangla ? banglaVoice : installed(Locale.US, Locale.UK, Locale.ENGLISH);
        if (chosen != null) voice.setLanguage(chosen);
        voice.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build());
        voice.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String id) {}

            @Override
            public void onDone(String id) {
                main.post(() -> spoken(id));
            }

            @Override
            public void onError(String id) {
                main.post(() -> spoken(id));
            }
        });
    }

    /** Called by the notification listener when a message arrives and ASTHA is not in front. */
    void offer(String key, String app, String sender, String text, boolean canReply) {
        main.post(() -> {
            // An edited or repeated notification for the same conversation replaces the one waiting.
            for (Pending waiting : new ArrayList<>(queue)) if (waiting.key.equals(key)) queue.remove(waiting);
            while (queue.size() >= QUEUE_LIMIT) queue.pollFirst();
            queue.add(new Pending(key, app, sender, text, canReply));
            if (current == null) next();
        });
    }

    private AudioManager audio() {
        return (AudioManager) getSystemService(Context.AUDIO_SERVICE);
    }

    private boolean inCall() {
        AudioManager audio = audio();
        int mode = audio == null ? AudioManager.MODE_NORMAL : audio.getMode();
        return mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION || mode == AudioManager.MODE_RINGTONE;
    }

    // Music and videos turn down while ASTHA talks, and come back when the message is done.
    private void holdAudio() {
        AudioManager audio = audio();
        if (audio == null || focus != null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).build())
            .build();
        audio.requestAudioFocus(focus);
    }

    private void releaseAudio() {
        AudioManager audio = audio();
        if (audio != null && focus != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) audio.abandonAudioFocusRequest(focus);
        focus = null;
    }

    private void next() {
        main.removeCallbacks(nextMessage);
        stopListening();
        current = null;
        stage = null;
        draft = "";
        retries = 0;
        if (!voiceReady || queue.isEmpty()) {
            releaseAudio();
            return;
        }
        if (inCall()) {
            releaseAudio();
            main.postDelayed(nextMessage, CALL_RETRY_MS);   // never talk over a call
            return;
        }
        current = queue.pollFirst();
        stage = MessageCommands.DECIDE;
        holdAudio();
        say(MessageCommands.announce(bangla, current.app, current.sender, current.text, current.canReply), current.canReply);
    }

    // Each utterance carries whether the microphone should open once it has been spoken.
    private void say(String words, boolean thenListen) {
        String id = (++turn) + (thenListen ? ":listen" : ":next");
        if (voice.speak(words, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) spoken(id);
    }

    private void spoken(String id) {
        if (id == null || !id.startsWith(turn + ":")) return;   // an older sentence finishing late
        if (id.endsWith(":listen") && current != null) listen();
        else next();
    }

    private void listen() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            say(MessageCommands.notSent(bangla), false);
            return;
        }
        stopListening();
        final int heardFor = turn;
        recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override
            public void onResults(Bundle results) {
                ArrayList<String> heard = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                answered(heardFor, heard == null || heard.isEmpty() ? "" : heard.get(0));
            }

            @Override
            public void onError(int error) {
                answered(heardFor, "");
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
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, listenBangla ? "bn-BD" : "en-US")
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        recognizer.startListening(intent);
        // The microphone closes on its own even if the recognizer never reports back.
        listenLimit = () -> answered(heardFor, "");
        main.postDelayed(listenLimit, LISTEN_LIMIT_MS);
    }

    private void stopListening() {
        if (listenLimit != null) main.removeCallbacks(listenLimit);
        listenLimit = null;
        if (recognizer != null) {
            recognizer.cancel();
            recognizer.destroy();
            recognizer = null;
        }
    }

    private void answered(int heardFor, String heard) {
        if (heardFor != turn || current == null) return;
        stopListening();
        MessageCommands.Command command = MessageCommands.parse(heard, stage);
        switch (command.kind) {
            case REPLY:
            case TEXT:
                draft = command.text;
                stage = MessageCommands.CONFIRM;
                say(MessageCommands.confirm(bangla, current.sender, draft), true);
                return;
            case ASK_TEXT:
            case CHANGE:
                stage = MessageCommands.COMPOSE;
                say(MessageCommands.askText(bangla, current.sender), true);
                return;
            case REPEAT:
                say(MessageCommands.announce(bangla, current.app, current.sender, current.text, true), true);
                return;
            case YES:
                if (MessageCommands.CONFIRM.equals(stage)) {
                    send();
                    return;
                }
                break;
            case UNKNOWN:
                if (retries++ == 0) {
                    say(MessageCommands.prompt(bangla), true);
                    return;
                }
                break;
            case NOTHING:
                if (MessageCommands.DECIDE.equals(stage)) {
                    next();   // no answer to a new message: leave it and say nothing more
                    return;
                }
                break;
            default:
                break;
        }
        say(MessageCommands.notSent(bangla), false);
    }

    private void send() {
        AsthaNotificationListener listener = AsthaNotificationListener.running();
        boolean delivered = listener != null && listener.reply(current.key, draft);
        say(delivered ? MessageCommands.sent(bangla, current.sender) : MessageCommands.failed(bangla), false);
    }

    @Override
    public void onDestroy() {
        instance = null;
        main.removeCallbacksAndMessages(null);
        stopListening();
        releaseAudio();
        queue.clear();
        current = null;
        if (voice != null) voice.shutdown();
        voice = null;
        voiceReady = false;
        super.onDestroy();
    }
}
