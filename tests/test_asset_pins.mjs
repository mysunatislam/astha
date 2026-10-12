import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

// Browser runtimes are outside the npm lockfiles. A range such as @3 lets the CDN change the
// code a released app executes; each must name one exact published version.
test('every CDN runtime loaded by the generated app is pinned to an exact version', () => {
  const urls = [...new Set([...html.matchAll(/https:\/\/cdn\.jsdelivr\.net\/npm\/[^'"`\s)]+/g)].map(match => match[0]))];
  assert(urls.length >= 7, 'expected the known browser runtimes: ' + urls.join(', '));
  for (const url of urls) {
    const spec = /^https:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[a-z0-9-]+\/)?[a-z0-9.-]+)@([^/]+)\//.exec(url);
    assert(spec, 'unversioned CDN runtime: ' + url);
    assert.match(spec[2], /^\d+\.\d+\.\d+$/, `${spec[1]} must use an exact version, not "${spec[2]}"`);
  }
  assert(urls.some(url => url.includes('/@huggingface/transformers@3.8.1/')));
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/npm\/[^'"`\s]*@(latest|next)\b/);
});
