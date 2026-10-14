package com.astha.companion;

import static org.junit.Assert.*;
import org.junit.Test;

public class MessageTargetsTest {
    @Test public void reusedNotificationIdCannotRedirectAConfirmedReply() {
        MessageTargets<String> targets = new MessageTargets<>(20);
        String oldToken = targets.put("app|notification7", "Rina private reply action").token;
        String newToken = targets.put("app|notification7", "Different account or recipient action").token;
        assertNotEquals(oldToken, newToken);
        assertNull(targets.take(oldToken));
        assertEquals("Different account or recipient action", targets.take(newToken));
        assertNull(targets.take(newToken));
    }
    @Test public void removalConsentWithdrawalAndEvictionRevokeConfirmations() {
        MessageTargets<String> targets = new MessageTargets<>(1);
        String removed = targets.put("first", "first action").token;
        targets.remove("first"); assertNull(targets.take(removed));
        String evicted = targets.put("first", "first action").token;
        String latest = targets.put("second", "second action").token;
        assertNull(targets.take(evicted));
        targets.clear(); assertNull(targets.take(latest));
    }
    @Test public void expiredConfirmationCannotSendAndDifferentConversationsStaySeparate() {
        long[] now = {1000};
        MessageTargets<String> targets = new MessageTargets<>(20, () -> now[0]);
        String first = targets.put("Rina", "Rina action").token;
        String other = targets.put("Rahim", "Rahim action").token;
        assertEquals("Rahim action", targets.take(other));
        now[0] += 120000;
        assertNull(targets.take(first));
    }
}
