package com.astha.companion;

import static org.junit.Assert.*;
import org.junit.Test;

public class BackgroundMessagePolicyTest {
    private String blocked(boolean[] granted) {
        return BackgroundMessagePolicy.startError(granted[0], granted[1], granted[2],
            granted[3], granted[4], granted[5]);
    }

    @Test public void normalEnableCompletesOnlyTheOriginalVisibleRequest() {
        SpeechInputRequests<Object> requests = new SpeechInputRequests<>();
        Object call = new Object();
        SpeechInputRequests.Request<Object> request = requests.begin(call).request;
        assertTrue(requests.awaitPermission(request));
        assertSame(request, requests.permissionResult(call));
        assertTrue(requests.mayStart(request, true));
        assertNull(blocked(new boolean[] {true, true, true, true, true, true}));
        assertTrue(requests.complete(request));
        assertFalse(requests.complete(request));
    }

    @Test public void everyRequiredGateFailsClosedWithItsOwnReason() {
        String[] codes = {"foreground_required", "consent_required", "service_disabled",
            "permission", "notifications_permission", "notifications_disabled"};
        for (int denied = 0; denied < codes.length; denied++) {
            boolean[] granted = {true, true, true, true, true, true};
            granted[denied] = false;
            assertEquals("Gate " + denied, codes[denied], blocked(granted));
        }
        assertEquals("notifications_permission", blocked(new boolean[] {true, true, true, true, false, false}));
        assertEquals("consent_required", blocked(new boolean[] {true, false, false, false, false, false}));
    }

    @Test public void offRevokePauseDestroyAndReplacementInvalidatePermissionCallbacks() {
        for (String reason : new String[] {"off", "consent", "pause", "destroy", "replacement"}) {
            SpeechInputRequests<Object> requests = new SpeechInputRequests<>();
            Object call = new Object();
            SpeechInputRequests.Request<Object> old = requests.begin(call).request;
            assertTrue(requests.awaitPermission(old));
            if ("replacement".equals(reason)) requests.begin(new Object());
            else requests.cancel();
            assertNull(reason, requests.permissionResult(call));
            assertFalse(reason, requests.mayStart(old, true));
        }
    }

    @Test public void queuedGrantCannotSurviveCancellationOrOverrideNewerEnable() {
        SpeechInputRequests<Object> requests = new SpeechInputRequests<>();
        Object call = new Object();
        SpeechInputRequests.Request<Object> old = requests.begin(call).request;
        assertTrue(requests.awaitPermission(old));
        assertSame(old, requests.permissionResult(call)); // Callback has queued work on the UI thread.
        requests.cancel();
        SpeechInputRequests.Request<Object> next = requests.begin(new Object()).request;
        assertFalse(requests.mayStart(old, true));
        requests.complete(old);
        assertTrue(requests.mayStart(next, true));
        assertFalse(requests.mayStart(next, false));
    }
}
