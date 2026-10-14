import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pruneMobileDownload, configureAndroidBackend, normalizeMobileApiOrigin } from '../tools/prune-mobile-assets.mjs';

function fixture(t) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'astha-mobile-assets-'));
  t.after(() => {
    const relative = path.relative(tempRoot, fs.realpathSync(root));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

for (const [platform, nativePath] of Object.entries({
  android: 'android/app/src/main/assets/public',
  ios: 'ios/App/App/public',
})) {
  test(platform + ' excludes only the copied APK and preserves the public download', t => {
    const root = fixture(t);
    const publicDir = path.join(root, nativePath);
    const source = path.join(root, 'web', 'downloads', 'astha.apk');
    const copied = path.join(publicDir, 'downloads', 'astha.apk');
    for (const file of [source, copied]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'archived installer fixture');
    }
    fs.writeFileSync(path.join(publicDir, 'index.html'), 'application fixture');
    assert.equal(pruneMobileDownload(root, platform), true);
    assert.equal(fs.existsSync(copied), false);
    assert.equal(fs.readFileSync(source, 'utf8'), 'archived installer fixture');
    assert.equal(fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'), 'application fixture');
    assert.equal(pruneMobileDownload(root, platform), false);
  });
}

test('missing or unsupported native destinations fail without removing source content', t => {
  const root = fixture(t);
  assert.throws(() => pruneMobileDownload(root, 'other'), /Unsupported native platform/);
  assert.throws(() => pruneMobileDownload(root, 'android'), /have not been copied/);
});

test('Android backend configuration changes only copied assets and rejects unsafe origins', t => {
  const root = fixture(t);
  const native = path.join(root, 'android/app/src/main/assets/public');
  fs.mkdirSync(native, { recursive: true });
  fs.mkdirSync(path.join(root, 'web'));
  fs.writeFileSync(path.join(root, 'web/config.js'), "window.ASTHA_API_BASE = '';\n");
  fs.writeFileSync(path.join(native, 'config.js'), "window.ASTHA_API_BASE = '';\n");
  assert.equal(configureAndroidBackend(root, 'https://astha.example/'), 'https://astha.example');
  assert.match(fs.readFileSync(path.join(native, 'config.js'), 'utf8'), /window\.ASTHA_API_BASE = "https:\/\/astha\.example";/);
  assert.equal(fs.readFileSync(path.join(root, 'web/config.js'), 'utf8'), "window.ASTHA_API_BASE = '';\n");
  for (const value of ['', 'http://astha.example', 'https://key@astha.example', 'https://astha.example/api', 'https://astha.example?key=x', 'https://astha.example#x', 'https://localhost', 'https://127.0.0.1']) {
    assert.throws(() => normalizeMobileApiOrigin(value), /HTTPS backend origin/);
  }
});
