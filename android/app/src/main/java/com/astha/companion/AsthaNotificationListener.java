package com.astha.companion;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import com.getcapacitor.JSObject;

import java.util.LinkedHashMap;

/**
 * Lets ASTHA announce an incoming message and send the reply its user dictates.
 *
 * It is off until the user enables notification access in Android settings, and ASTHA
 * additionally requires its own in-app consent. A message goes to the open ASTHA page, or,
 * when ASTHA is not on screen and the user turned it on, to the locked-phone assistant.
 * With neither (ASTHA closed, or consent off) every notification is ignored and nothing is
 * kept. Only conversation
 * notifications are considered. A reply goes through the messaging app's own reply action,
 * to the conversation the notification belongs to, and only when ASTHA asks for it after
 * the user has confirmed the words. Nothing is stored on disk or logged.
 */
public class AsthaNotificationListener extends NotificationListenerService {
    interface Receiver {
        void onMessage(JSObject message);
    }

    private static final int KEPT = 20;
    private static final int MAX_SENDER = 80;
    private static final int MAX_TEXT = 500;
    private static volatile AsthaNotificationListener instance;
    private static volatile Receiver receiver;
    // Held in memory only, so a reply can reach the conversation it answers.
    private final LinkedHashMap<String, StatusBarNotification> recent = new LinkedHashMap<>();

    static AsthaNotificationListener running() {
        return instance;
    }

    static void deliverTo(Receiver next) {
        receiver = next;
        // The locked-phone assistant may still be answering a message the page no longer needs.
        if (next == null && AsthaMessageAssistant.running() == null) clear();
    }

    /** Drops every message held for a reply, for example when consent is withdrawn. */
    static void clear() {
        AsthaNotificationListener service = instance;
        if (service != null) service.forget();
    }

    private void forget() {
        synchronized (recent) {
            recent.clear();
        }
    }

    @Override
    public void onListenerConnected() {
        instance = this;
    }

    @Override
    public void onListenerDisconnected() {
        instance = null;
        forget();
    }

    @Override
    public void onDestroy() {
        instance = null;
        forget();
        super.onDestroy();
    }

    /** The action a person would use to type a reply, or null when the app offers none. */
    static Notification.Action replyAction(Notification notification) {
        if (notification.actions == null) return null;
        for (Notification.Action action : notification.actions) {
            RemoteInput[] inputs = action.getRemoteInputs();
            if (inputs == null) continue;
            for (RemoteInput input : inputs) {
                if (input.getAllowFreeFormInput()) return action;
            }
        }
        return null;
    }

    private static String clip(CharSequence value, int limit) {
        String text = value == null ? "" : value.toString().trim();
        return text.length() > limit ? text.substring(0, limit) : text;
    }

    private String appName(String packageName) {
        try {
            PackageManager packages = getPackageManager();
            ApplicationInfo info = packages.getApplicationInfo(packageName, 0);
            return clip(packages.getApplicationLabel(info), MAX_SENDER);
        } catch (PackageManager.NameNotFoundException missing) {
            return "";
        }
    }

    @Override
    public void onNotificationPosted(StatusBarNotification posted) {
        // While ASTHA is on screen its page answers; otherwise the assistant does, if it is on.
        AsthaMessageAssistant assistant = AsthaMessageAssistant.appVisible ? null : AsthaMessageAssistant.running();
        Receiver target = assistant == null ? receiver : null;
        if ((assistant == null && target == null) || posted == null) return;
        Notification notification = posted.getNotification();
        if (notification == null || posted.isOngoing() || getPackageName().equals(posted.getPackageName())) return;
        if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        Notification.Action reply = replyAction(notification);
        // Conversations only: not downloads, reminders, music or system notices.
        if (!Notification.CATEGORY_MESSAGE.equals(notification.category) && reply == null) return;
        Bundle extras = notification.extras;
        if (extras == null) return;
        String sender = clip(extras.getCharSequence(Notification.EXTRA_TITLE), MAX_SENDER);
        String text = clip(extras.getCharSequence(Notification.EXTRA_TEXT), MAX_TEXT);
        if (sender.isEmpty() || text.isEmpty()) return;
        String key = posted.getKey();
        synchronized (recent) {
            recent.remove(key);
            recent.put(key, posted);
            while (recent.size() > KEPT) recent.remove(recent.keySet().iterator().next());
        }
        String app = appName(posted.getPackageName());
        if (assistant != null) {
            assistant.offer(key, app, sender, text, reply != null);
            return;
        }
        JSObject message = new JSObject();
        message.put("key", key);
        message.put("app", app);
        message.put("sender", sender);
        message.put("text", text);
        message.put("canReply", reply != null);
        target.onMessage(message);
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification removed) {
        if (removed == null) return;
        synchronized (recent) {
            recent.remove(removed.getKey());
        }
    }

    /** Sends the words through the conversation's own reply action. False when it is gone. */
    boolean reply(String key, String words) {
        StatusBarNotification target;
        synchronized (recent) {
            target = recent.get(key);
        }
        if (target == null) return false;
        Notification.Action action = replyAction(target.getNotification());
        if (action == null || action.actionIntent == null) return false;
        Bundle results = new Bundle();
        for (RemoteInput input : action.getRemoteInputs()) results.putCharSequence(input.getResultKey(), words);
        Intent filled = new Intent();
        RemoteInput.addResultsToIntent(action.getRemoteInputs(), filled, results);
        try {
            action.actionIntent.send(this, 0, filled);
            return true;
        } catch (PendingIntent.CanceledException cancelled) {
            return false;
        }
    }
}
