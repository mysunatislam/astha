package com.astha.companion;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * Lets ASTHA read aloud what another app is showing, when the user asks.
 *
 * It is off until the user turns it on in Android's Accessibility settings, and ASTHA
 * additionally requires its own in-app consent before using it. It observes nothing in the
 * background: events are ignored, nothing is stored, and the screen is inspected only for
 * the duration of one explicit request. Password fields are never read. It cannot tap,
 * type or send anything.
 */
public class AsthaAccessibilityService extends AccessibilityService {
    private static volatile AsthaAccessibilityService instance;

    static AsthaAccessibilityService running() {
        return instance;
    }

    /** What is visible right now, bounded so one request cannot return an unlimited capture. */
    static final class ScreenText {
        final String app;
        final String text;
        final boolean truncated;

        ScreenText(String app, String text, boolean truncated) {
            this.app = app;
            this.text = text;
            this.truncated = truncated;
        }
    }

    @Override
    protected void onServiceConnected() {
        instance = this;
    }

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Intentionally empty: ASTHA does not watch what the user does in other apps.
    }

    @Override
    public void onInterrupt() {
        // Nothing is spoken by this service itself.
    }

    ScreenText describe(int maxNodes, int maxChars) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return new ScreenText("", "", false);
        CharSequence owner = root.getPackageName();
        List<String> lines = new ArrayList<>();
        ArrayDeque<AccessibilityNodeInfo> pending = new ArrayDeque<>();
        pending.add(root);
        int visited = 0;
        int length = 0;
        boolean truncated = false;
        String previous = "";
        while (!pending.isEmpty()) {
            AccessibilityNodeInfo node = pending.removeFirst();
            if (node == null) continue;
            if (++visited > maxNodes) {
                truncated = true;
                break;
            }
            if (!node.isVisibleToUser()) continue;
            // A password, or anything inside a password field, is never read.
            if (!node.isPassword()) {
                CharSequence value = node.getText();
                if (value == null || value.length() == 0) value = node.getContentDescription();
                String line = value == null ? "" : value.toString().trim();
                if (!line.isEmpty() && !line.equals(previous)) {
                    if (length + line.length() > maxChars) {
                        truncated = true;
                        break;
                    }
                    lines.add(line);
                    length += line.length() + 1;
                    previous = line;
                }
                for (int index = 0; index < node.getChildCount(); index++) pending.addLast(node.getChild(index));
            }
        }
        return new ScreenText(owner == null ? "" : owner.toString(), String.join("\n", lines), truncated);
    }
}
