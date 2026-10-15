package com.astha.companion;

/** Request identity across permission dialogs, queued UI work and recognizer callbacks. */
final class SpeechInputRequests<T> {
    static final class Request<T> {
        final T call;
        final long generation;
        private boolean completed;

        Request(T call, long generation) {
            this.call = call;
            this.generation = generation;
        }
    }

    static final class Change<T> {
        final Request<T> request, previous;

        Change(Request<T> request, Request<T> previous) {
            this.request = request;
            this.previous = previous;
        }
    }

    private long generation;
    private Request<T> current, permission;

    synchronized Change<T> begin(T call) {
        if (call == null) throw new IllegalArgumentException("A request is required.");
        Request<T> previous = current;
        current = new Request<>(call, ++generation);
        permission = null;
        return new Change<>(current, previous);
    }

    synchronized boolean mayStart(Request<T> request, boolean visible) {
        return visible && request != null && current == request &&
            request.generation == generation && !request.completed;
    }

    synchronized boolean awaitPermission(Request<T> request) {
        if (!mayStart(request, true)) return false;
        permission = request;
        return true;
    }

    synchronized Request<T> permissionResult(T call) {
        if (permission == null || permission.call != call || !mayStart(permission, true)) return null;
        Request<T> request = permission;
        permission = null;
        return request;
    }

    synchronized Request<T> cancel() {
        Request<T> previous = current;
        current = null;
        permission = null;
        ++generation;
        return previous;
    }

    synchronized boolean complete(Request<T> request) {
        if (request == null || request.completed) return false;
        request.completed = true;
        if (current == request) {
            current = null;
            permission = null;
            ++generation;
        }
        return true;
    }
}
