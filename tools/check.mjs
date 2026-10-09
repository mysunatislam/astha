import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = process.env.ASTHA_PYTHON || 'python';
const env = { ...process.env, DB_PATH: ':memory:', CLOUD_AI_PROVIDER: 'auto', GEMINI_API_KEY: '', MAIRA_API_KEY: '', MAIRA_PROJECT_KEY: '', MAIRA_PROFILE_ID: '', MAIRA_API_URL: '', MAIRA_TOKEN: '', API_KEY: '', PROJECT_KEY: '' };
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(python, ['tools/build.py']);
const first = ['web/index.html', 'web/sw.js'].map(file => fs.readFileSync(path.join(root, file)));
run(python, ['tools/build.py']);
for (const [index, file] of ['web/index.html', 'web/sw.js'].entries()) {
  if (!first[index].equals(fs.readFileSync(path.join(root, file)))) throw new Error('Non-reproducible build: ' + file);
}
for (const folder of ['server', 'tools', 'web']) {
  for (const file of fs.readdirSync(path.join(root, folder)).filter(file => /\.(m?js)$/.test(file))) run(process.execPath, ['--check', path.join(folder, file)]);
}
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
let inlineCount = 0;
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=/.test(match[1]) || !match[2].trim()) continue;
  new vm.Script(match[2], { filename: 'web/index.html:inline-' + (++inlineCount) });
}
if (!inlineCount) throw new Error('Generated app has no inline script');
run(process.execPath, ['tests/test_agent_client.mjs']);
run(process.execPath, ['tests/test_agent_server.mjs']);
const tests = fs.readdirSync(path.join(root, 'tests')).filter(file => /(?:\.test|test_.*)\.mjs$/.test(file) && !['test_agent_client.mjs', 'test_agent_server.mjs'].includes(file));
run(process.execPath, ['--test', ...tests.map(file => path.join('tests', file))]);
console.log('Build reproducibility, all JavaScript syntax and regression tests passed.');
