import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pruneMobileDownload } from '../tools/prune-mobile-assets.mjs';

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
