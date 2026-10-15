// Native policy source wiring complements pure Java lifecycle tests; no phone claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../android/app/src/main/java/com/astha/companion/' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const plugin = read('AsthaNativePlugin.java'), service = read('AsthaMessageAssistant.java');
function method(source, start) {
  const from = source.indexOf(start), to = source.indexOf('\n    }', from);
  assert(from >= 0 && to > from, start);
  return source.slice(from, to);
}

test('each enable callback belongs to its original request and foreground work rechecks the full policy', () => {
  const enable = method(plugin, 'public void setBackgroundMessages(');
  assert.match(enable, /backgroundRequests\.begin\(call\)/);
  assert.match(enable, /backgroundRequests\.awaitPermission\(change\.request\)/);
  assert.match(method(plugin, 'private void backgroundPermissionResult('), /backgroundRequests\.permissionResult\(call\)/);
  assert.match(method(plugin, 'private String backgroundStartError('), /AsthaMessageAssistant\.startError\(getContext\(\), foregroundForSpeech\(\)\)/);
  const start = method(plugin, 'private void startBackground(');
  assert.match(start, /recognitionHandler\.post/);
  assert.match(start, /synchronized \(backgroundRequests\)/);
  assert(start.indexOf('backgroundRequests.mayStart(request, true)') < start.indexOf('backgroundStartError()'));
  assert(start.indexOf('backgroundStartError()') < start.indexOf('putBoolean(AsthaMessageAssistant.BACKGROUND, true)'));
  assert(start.indexOf('putBoolean(AsthaMessageAssistant.BACKGROUND, true)') < start.indexOf('AsthaMessageAssistant.start('));
  assert.match(start, /catch \(RuntimeException refused\)[\s\S]*putBoolean\(AsthaMessageAssistant\.BACKGROUND, false\)/);
});

test('disable, consent revoke, pause and destroy invalidate pending enables without disabling an already accepted background choice', () => {
  for (const name of ['public void setBackgroundMessages(', 'public void setMessageAccessConsent(',
    'protected void handleOnPause(', 'protected void handleOnDestroy(']) {
    assert.match(method(plugin, name), /cancelBackgroundEnable\(\)/, name);
  }
  const cancel = method(plugin, 'private void cancelBackgroundEnable(');
  assert.match(cancel, /backgroundRequests\.cancel\(\)/);
  assert(cancel.indexOf('if (previous == null) return') < cancel.indexOf('putBoolean('));
  assert.match(cancel, /finishBackground\(previous, "cancelled"\)/);
  assert.match(method(plugin, 'public void load('), /backgroundStartError\(\)/);
  assert.match(method(plugin, 'public void load('), /putBoolean\(AsthaMessageAssistant\.BACKGROUND, false\)/);
});

test('service authorization includes notification access, microphone, Android13 posting and global/channel display', () => {
  const policy = method(service, 'static String startError(');
  for (const required of ['message_access_consent', 'getEnabledListenerPackages', 'Manifest.permission.RECORD_AUDIO',
    'VERSION_CODES.TIRAMISU', 'Manifest.permission.POST_NOTIFICATIONS', 'notificationVisible(context)']) assert(policy.includes(required), required);
  const display = method(service, 'private static boolean notificationVisible(');
  for (const required of ['areNotificationsEnabled()', 'getNotificationChannel(CHANNEL)', 'NotificationManager.IMPORTANCE_NONE']) assert(display.includes(required), required);
  assert.match(method(service, 'private static boolean permitted('), /getBoolean\(BACKGROUND, false\) && startError\(context, true\) == null/);
  const entry = method(service, 'public int onStartCommand(');
  assert(entry.indexOf('if (!permitted(this))') < entry.indexOf('showNotification()'));
  assert.match(entry, /disableAndStop\(\)/);
});

test('queued, spoken, recognized and confirmed service work cannot bypass current permission or background choice', () => {
  for (const name of ['void offer(', 'private void next(', 'private void say(', 'private void spoken(',
    'private void listen(', 'private void onDeviceInputUnavailable(', 'private void answered(', 'private void send(']) {
    assert.match(method(service, name), /if \(!mayWork\(\)\) return;/, name);
  }
  const send = method(service, 'private void send(');
  assert(send.indexOf('mayWork()') < send.indexOf('listener.reply('));
  const listen = method(service, 'private void listen(');
  assert(listen.lastIndexOf('if (!mayWork()) return;') < listen.indexOf('recognizer.startListening(intent)'));
  const denied = method(service, 'private void disableAndStop(');
  assert.match(denied, /putBoolean\(BACKGROUND, false\)/); assert.match(denied, /dropPending\(\)/); assert.match(denied, /stopSelf\(\)/);
});
