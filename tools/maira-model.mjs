// Which model answers ASTHA's requests is decided by a GPT profile in the Maira project,
// not by anything ASTHA sends. This tool shows the project's models and profiles and can
// point a profile at another model.
//
//   node tools/maira-model.mjs                      list models, profiles and defaults
//   node tools/maira-model.mjs --set <model>        change the model of the profile ASTHA uses
//   node tools/maira-model.mjs --set <model> --profile <id>
//
// It reads MAIRA_API_KEY, MAIRA_PROJECT_KEY and MAIRA_PROFILE_ID from the environment or
// server/.env, sends them only to Maira, and never prints them.
import '../server/env.js';

const BASE = 'https://api.recommender.gigalogy.com';
const apiKey = process.env.MAIRA_API_KEY || process.env.API_KEY || '';
const projectKey = process.env.MAIRA_PROJECT_KEY || process.env.PROJECT_KEY || '';
const configuredProfile = process.env.MAIRA_PROFILE_ID || '';
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };

if (!apiKey || !projectKey) {
  console.error('MAIRA_API_KEY and MAIRA_PROJECT_KEY are not configured. Nothing was sent.');
  process.exit(2);
}

async function maira(method, path, body) {
  const response = await fetch(BASE + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'project-key': projectKey, 'api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* reported below without echoing the body */ }
  if (!response.ok) {
    const reason = data?.detail?.error || data?.detail?.message || data?.message || data?.detail;
    throw new Error(method + ' ' + path + ' answered ' + response.status + (typeof reason === 'string' ? ': ' + reason.slice(0, 200) : ''));
  }
  return data;
}
// List endpoints wrap their rows differently; find the first array of objects.
function rows(data) {
  const seen = new Set();
  const search = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) return value.every(item => item && typeof item === 'object') ? value : null;
    for (const child of Object.values(value)) { const found = search(child); if (found) return found; }
    return null;
  };
  return search(data) || [];
}
const short = id => typeof id === 'string' && id.length > 12 ? id.slice(0, 8) + '…' : String(id ?? '');
const idOf = profile => profile.profile_id || profile.id || profile._id || profile.gpt_profile_id;

const [modelData, profileData, settingsData] = await Promise.all([
  maira('GET', '/v1/gpt/models?start=0&size=100'),
  maira('GET', '/v1/gpt/profiles?start=0&size=100'),
  maira('GET', '/v1/gpt/settings').catch(() => null),
]);
const models = rows(modelData), profiles = rows(profileData);
// The settings arrive as { detail: { settings: {...} } }; older answers put them one level up.
const settings = settingsData?.detail?.settings || settingsData?.detail?.response || settingsData?.detail || settingsData || {};
const defaults = { text: settings.default_profile, vision: settings.default_vision_profile };

console.log('Models available to this project:');
for (const model of models) console.log('  ' + (model.name || model.model || '?') + '  (' + (model.provider || 'provider not stated') + ')');
if (!models.length) console.log('  none listed');
console.log('\nProfiles:');
for (const profile of profiles) {
  const id = idOf(profile), marks = [];
  if (id === defaults.text) marks.push('project default');
  if (id === defaults.vision) marks.push('default for images');
  if (id === configuredProfile) marks.push('ASTHA: MAIRA_PROFILE_ID');
  console.log('  ' + short(id) + '  ' + (profile.name || 'unnamed') + '  →  ' + (profile.model || 'model not stated') + (marks.length ? '   [' + marks.join(', ') + ']' : ''));
}
console.log('\nASTHA sends ' + (configuredProfile ? 'profile ' + short(configuredProfile) + ' (MAIRA_PROFILE_ID).' : 'no profile id, so Maira uses the project defaults marked above.'));

const wanted = option('--set');
if (!wanted) process.exit(0);
const known = models.map(model => model.name || model.model);
if (!known.includes(wanted)) {
  console.error('\n"' + wanted + '" is not in this project\'s model list. Nothing was changed.');
  process.exit(2);
}
// With no profile named, change the ones ASTHA actually reaches: its own, or both defaults.
const targets = [...new Set(option('--profile') ? [option('--profile')] : configuredProfile ? [configuredProfile] : [defaults.text, defaults.vision].filter(Boolean))];
if (!targets.length) {
  console.error('\nNo profile could be identified. Pass --profile <id>. Nothing was changed.');
  process.exit(2);
}
for (const target of targets) {
  const current = profiles.find(profile => idOf(profile) === target || String(idOf(profile)).startsWith(target));
  if (!current) { console.error('\nProfile ' + short(target) + ' was not found. It was not changed.'); process.exitCode = 2; continue; }
  if (current.model === wanted) { console.log('\n' + short(idOf(current)) + ' already uses ' + wanted + '.'); continue; }
  // Send the profile back as it is with only the model replaced.
  const { profile_id, id, _id, created_at, updated_at, ...editable } = current;
  await maira('PUT', '/v1/gpt/profiles/' + encodeURIComponent(idOf(current)), { ...editable, model: wanted });
  console.log('\n' + short(idOf(current)) + ' (' + (current.name || 'unnamed') + '): ' + (current.model || 'unset') + ' → ' + wanted);
}
