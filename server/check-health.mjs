// Probe only this process's local readiness route. Never load or print secrets.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkHealth({ port = process.env.PORT || '8787', timeoutMillis = 3000 } = {}) {
  const value = String(port);
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535 ||
      !Number.isInteger(timeoutMillis) || timeoutMillis < 1 || timeoutMillis > 3000) return false;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMillis);
  try {
    const response = await fetch(`http://127.0.0.1:${Number(value)}/api/health`, {
      signal: controller.signal, redirect: 'error',
    });
    if (response.status !== 200 || !response.body) return false;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > 4096) { controller.abort(); return false; }
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')).ok === true;
  } catch {
    return false;
  } finally {
    controller.abort();
    clearTimeout(deadline);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await checkHealth() ? 0 : 1;
}
