// Android's native HTTP client carries the server's HttpOnly cookie without storing
// tokens in JavaScript. Keep model downloads, personal-provider calls and web fetch
// unchanged. The Capacitor-wide HTTP and document.cookie patches remain disabled.
(function (win) {
  'use strict';
  const cap = win.Capacitor;
  if (!cap || !cap.isNativePlatform() || cap.getPlatform() !== 'android') return;
  const originalFetch = win.fetch.bind(win);
  const CONNECT_TIMEOUT = 5000;
  const READ_TIMEOUT = 30000;
  const WALL_TIMEOUT = 35000;
  const MAX_RESPONSE = 16 * 1024 * 1024;
  const allowedOptions = new Set(['method', 'headers', 'body', 'credentials', 'signal', 'cache', 'mode', 'redirect']);
  const forbiddenHeaders = new Set(['cookie', 'set-cookie', 'set-cookie2', 'host', 'origin', 'referer', 'content-length', 'transfer-encoding']);
  const PENDING_LOGOUT = 'astha.logout_pending.v2';
  let sessionTail = Promise.resolve();
  let logoutPending = false;
  try { logoutPending = win.localStorage.getItem(PENDING_LOGOUT) === '1'; } catch {}

  function markPendingLogout() {
    const newlyPending = !logoutPending;
    logoutPending = true;
    try { win.localStorage.setItem(PENDING_LOGOUT, '1'); } catch {}
    // Clear the verified account and invalidate outstanding frontend generations
    // before an abandoned native auth response can change its cookie underneath it.
    if (newlyPending && typeof win.ASTHA_CLEAR_ACCOUNT === 'function') {
      try { win.ASTHA_CLEAR_ACCOUNT({ logout: true }); } catch {}
    }
  }
  function hasPendingLogout() {
    try { return logoutPending || win.localStorage.getItem(PENDING_LOGOUT) === '1'; }
    catch { return logoutPending; }
  }
  function clearPendingLogout() {
    logoutPending = false;
    try { win.localStorage.removeItem(PENDING_LOGOUT); } catch {}
  }

  function apiTarget(resource) {
    let base, target;
    try {
      base = new URL(win.ASTHA_API_BASE);
      const value = typeof resource === 'string' || resource instanceof URL ? resource : resource.url;
      target = new URL(value, win.location.href);
    } catch { return null; }
    if (target.origin !== base.origin || !target.pathname.startsWith('/api/')) return null;
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' || target.username || target.password) {
      throw new TypeError('Native API requires a configured HTTPS origin.');
    }
    return target;
  }
  function aborted(signal) {
    return signal?.reason ?? new DOMException('The request was aborted.', 'AbortError');
  }
  function responseFromNative(reply, url, method, binary) {
    if (!reply || !Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599) throw new TypeError('Invalid native API response.');
    if (reply.status >= 300 && reply.status < 400) throw new TypeError('Native API redirects are not permitted.');
    if (reply.url && reply.url !== url.href) throw new TypeError('Native API response URL changed.');
    const headers = new Headers();
    for (const [key, value] of Object.entries(reply.headers || {})) {
      if (['set-cookie', 'set-cookie2'].includes(key.toLowerCase())) continue;
      if (typeof value !== 'string') throw new TypeError('Invalid native API response headers.');
      headers.set(key, value);
    }
    let body = null;
    if (method !== 'HEAD' && ![204, 205].includes(reply.status)) {
      const type = headers.get('content-type') || '';
      const json = type.toLowerCase().includes('application/json');
      // Capacitor decodes JSON errors even when arraybuffer was requested for TTS.
      if (binary && !json) {
        // Android Base64.DEFAULT wraps output with CR/LF; other characters remain
        // invalid so malformed provider data never silently changes its bytes.
        const encoded = typeof reply.data === 'string' ? reply.data.replace(/[\r\n]/g, '') : '';
        if (typeof reply.data !== 'string' || reply.data.length > MAX_RESPONSE || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
          throw new TypeError('Invalid native API binary response.');
        }
        const decoded = atob(encoded);
        const bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
        body = bytes;
      } else {
        body = json ? JSON.stringify(reply.data) : typeof reply.data === 'string' ? reply.data : JSON.stringify(reply.data);
        if (body === undefined || body.length > MAX_RESPONSE) throw new TypeError('Invalid native API response body.');
      }
    }
    const response = new Response(body, { status: reply.status, headers });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  }

  win.fetch = async function (resource, options = {}) {
    const url = apiTarget(resource);
    if (!url) return originalFetch(resource, options);
    if (!(typeof resource === 'string' || resource instanceof URL)) throw new TypeError('Native API requires a URL and explicit request options.');
    for (const key of Object.keys(options)) if (!allowedOptions.has(key)) throw new TypeError('Unsupported native API request option.');
    if (options.credentials !== 'include' || options.mode && options.mode !== 'cors' || options.redirect && options.redirect !== 'error') {
      throw new TypeError('Unsupported native API credentials, mode or redirect policy.');
    }
    const method = (options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new TypeError('Unsupported native API method.');
    const headers = new Headers(options.headers);
    for (const [key] of headers) if (forbiddenHeaders.has(key)) throw new TypeError('Unsupported native API request header.');
    let data = options.body;
    if (data != null) {
      if (['GET', 'HEAD'].includes(method) || typeof data !== 'string' || data.length > MAX_RESPONSE || !/^application\/json(?:\s*;|$)/i.test(headers.get('content-type') || '')) {
        throw new TypeError('Native API request bodies must be bounded JSON strings.');
      }
      JSON.parse(data);
    }
    const signal = options.signal;
    if (signal?.aborted) throw aborted(signal);
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new TypeError('Invalid native API abort signal.');
    const client = cap.Plugins?.CapacitorHttp;
    if (!client || typeof client.request !== 'function') throw new TypeError('Native API transport is unavailable.');
    const binary = url.pathname === '/api/speak';
    const sessionRequest = url.pathname.startsWith('/api/auth/') || url.pathname === '/api/account/delete';
    const setsSession = method === 'POST' && ['/api/auth/signup', '/api/auth/login', '/api/auth/guest'].includes(url.pathname);
    const isLogout = method === 'POST' && url.pathname === '/api/auth/logout';
    // A rejected/aborted call does not cancel Capacitor's underlying IO. Its bounded
    // native timeouts still apply; consume late settlement without exposing its result.
    return new Promise((resolve, reject) => {
      let settled = false;
      let sent = false;
      let abandoned = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(value);
      };
      const abandon = error => {
        abandoned = true;
        if (sent && setsSession) markPendingLogout();
        finish(error);
      };
      const onAbort = () => abandon(aborted(signal));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      timer = setTimeout(() => abandon(new DOMException('Native API request timed out.', 'TimeoutError')), WALL_TIMEOUT);
      const invoke = async () => {
        // A queued call whose caller already cancelled must never reach the server.
        if (settled) return;
        if (hasPendingLogout() && !isLogout) {
          finish(new TypeError('Native session logout must be confirmed before API access.'));
          return;
        }
        sent = true;
        try {
          const reply = await client.request({
            url: url.href, method, headers: Object.fromEntries(headers),
            ...(data != null ? { data } : {}),
            connectTimeout: CONNECT_TIMEOUT, readTimeout: READ_TIMEOUT,
            disableRedirects: true, responseType: binary ? 'arraybuffer' : 'text',
          });
          // Explicit logout also clears a persisted transport gate, including
          // when its UI caller timed out before native completion.
          if (isLogout) {
            const response = responseFromNative(reply, url, method, false);
            if (!response.ok || (await response.clone().json()).ok !== true) throw new TypeError('Native logout was not confirmed.');
            clearPendingLogout();
            if (!settled) finish(null, response);
          } else if (!settled) finish(null, responseFromNative(reply, url, method, binary));
        } catch (error) {
          if (isLogout) markPendingLogout();
          if (!settled) abandon(error);
        }
        if (abandoned && setsSession) {
          // Cookie updates happen natively even after JS abort. Clear an abandoned
          // sign-in before any queued sign-in/logout/read can use its late cookie.
          // Keep the existing pending-logout flag if the server cannot confirm it.
          markPendingLogout();
          try {
            const logoutUrl = new URL('/api/auth/logout', url.origin);
            const reply = await client.request({ url: logoutUrl.href, method: 'POST', headers: {}, connectTimeout: CONNECT_TIMEOUT, readTimeout: READ_TIMEOUT, disableRedirects: true, responseType: 'text' });
            const response = responseFromNative(reply, logoutUrl, 'POST', false);
            if (!response.ok || (await response.json()).ok !== true) throw new TypeError('Native logout was not confirmed.');
            clearPendingLogout();
          } catch { /* Boot retries logout before it verifies any session. */ }
        }
      };
      // All API calls wait for preceding session changes. Only session operations
      // extend the queue, so independent memory/model requests retain concurrency.
      const operation = sessionTail.then(invoke);
      if (sessionRequest) sessionTail = operation.catch(() => {});
      else operation.catch(error => finish(error));
    });
  };
})(window);
