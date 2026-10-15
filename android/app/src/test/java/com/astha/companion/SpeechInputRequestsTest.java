package com.astha.companion;

import static org.junit.Assert.*;
import org.junit.Test;

public class SpeechInputRequestsTest {
    @Test public void stopDuringPermissionCannotStartAfterGrant() {
        SpeechInputRequests<Object> requests = new SpeechInputRequests<>();
        Object call = new Object();
        SpeechInputRequests.Request<Object> pending = requests.begin(call).request;
        assertTrue(requests.awaitPermission(pending));
        assertSame(pending, requests.cancel());
        assertNull(requests.permissionResult(call));
        assertFalse(requests.mayStart(pending, true));
        assertTrue(requests.complete(pending));
        assertFalse(requests.complete(pending));
    }

    @Test public void queuedStartCannotSurvivePauseOrNewRequest() {
        SpeechInputRequests<Object> requests = new SpeechInputRequests<>();
        SpeechInputRequests.Request<Object> old = requests.begin(new Object()).request;
        assertFalse(requests.mayStart(old, false));
        requests.cancel();
        assertFalse(requests.mayStart(old, true));
        SpeechInputRequests.Request<Object> next = requests.begin(new Object()).request;
        assertTrue(requests.mayStart(next, true));
        assertFalse(requests.mayStart(old, true));
        requests.complete(old); // late cleanup must not cancel a newer microphone request
        assertTrue(requests.mayStart(next, true));
    }

    @Test public void permissionBelongsToExactCallAndGeneration() {
        SpeechInputRequests<Object> requests = new SpeechInputRequests<>();
        Object first = new Object(), second = new Object();
        SpeechInputRequests.Request<Object> old = requests.begin(first).request;
        assertTrue(requests.awaitPermission(old));
        SpeechInputRequests.Change<Object> change = requests.begin(second);
        assertSame(old, change.previous);
        assertTrue(requests.awaitPermission(change.request));
        assertNull(requests.permissionResult(first));
        assertSame(change.request, requests.permissionResult(second));
        assertNull(requests.permissionResult(second));
        requests.cancel();
        assertFalse(requests.mayStart(change.request, true));
        // Even reuse of a caller object cannot revive its earlier generation token.
        SpeechInputRequests.Request<Object> latest = requests.begin(second).request;
        assertFalse(requests.mayStart(change.request, true));
        assertTrue(requests.mayStart(latest, true));
    }

    @Test public void completionOfCurrentRequestInvalidatesCallbacks() {
        SpeechInputRequests<Object> requests = new SpeechInputRequests<>();
        SpeechInputRequests.Request<Object> request = requests.begin(new Object()).request;
        assertTrue(requests.awaitPermission(request));
        assertTrue(requests.complete(request));
        assertFalse(requests.mayStart(request, true));
        assertNull(requests.permissionResult(request.call));
        assertNull(requests.cancel());
    }
}
