package com.astha.companion;

/** Shared fail-closed gates; starting additionally requires a visible activity. */
final class BackgroundMessagePolicy {
    private BackgroundMessagePolicy() {}

    static String startError(boolean foreground, boolean consent, boolean access,
                             boolean microphone, boolean notifications, boolean display) {
        if (!foreground) return "foreground_required";
        if (!consent) return "consent_required";
        if (!access) return "service_disabled";
        if (!microphone) return "permission";
        if (!notifications) return "notifications_permission";
        if (!display) return "notifications_disabled";
        return null;
    }
}
