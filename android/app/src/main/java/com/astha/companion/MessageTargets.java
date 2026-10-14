package com.astha.companion;

import java.util.LinkedHashMap;
import java.util.UUID;
import java.util.function.LongSupplier;

/** A confirmation refers to one notification revision, never the latest use of its ID. */
final class MessageTargets<T> {
    private static final long LIFETIME_MS = 120000;
    private final int limit;
    private final LongSupplier clock;
    private final LinkedHashMap<String, Target<T>> byConversation = new LinkedHashMap<>();

    static final class Target<T> {
        final String token;
        final String conversation;
        final T value;
        final long created;

        Target(String conversation, T value, long created) {
            this.token = UUID.randomUUID().toString();
            this.conversation = conversation;
            this.value = value;
            this.created = created;
        }
    }

    MessageTargets(int limit) { this(limit, () -> System.nanoTime() / 1000000); }
    MessageTargets(int limit, LongSupplier clock) { this.limit = limit; this.clock = clock; }

    synchronized Target<T> put(String conversation, T value) {
        Target<T> target = new Target<>(conversation, value, clock.getAsLong());
        byConversation.remove(conversation);
        byConversation.put(conversation, target);
        while (byConversation.size() > limit) byConversation.remove(byConversation.keySet().iterator().next());
        return target;
    }

    /** One use only. A replacement, removal, expiry or consent withdrawal invalidates it. */
    synchronized T take(String token) {
        Target<T> found = null;
        for (Target<T> target : byConversation.values()) if (target.token.equals(token)) { found = target; break; }
        if (found == null) return null;
        byConversation.remove(found.conversation);
        return clock.getAsLong() - found.created < LIFETIME_MS ? found.value : null;
    }

    synchronized void remove(String conversation) { byConversation.remove(conversation); }
    synchronized void clear() { byConversation.clear(); }
}
