// Parse the actual manifest/rule resources. A missing storage domain or transfer
// section would leave personal WebView/native state eligible for system transfer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Android backup and device transfer exclude all private CE/DE and external app storage', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const script = `
from pathlib import Path
import xml.etree.ElementTree as ET
root = Path.cwd() / 'android/app/src/main'
android = '{http://schemas.android.com/apk/res/android}'
app = ET.parse(root / 'AndroidManifest.xml').getroot().find('application')
assert app is not None and app.get(android + 'allowBackup') == 'false'
expected = {'root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'}
def resource(attribute):
    reference = app.get(android + attribute)
    assert reference and reference.startswith('@xml/')
    return ET.parse(root / 'res/xml' / (reference.removeprefix('@xml/') + '.xml')).getroot()
def excludes_everything(section):
    assert section is not None
    assert all(child.tag == 'exclude' and child.attrib.keys() == {'domain', 'path'} and child.get('path') == '.' for child in section)
    domains = [child.get('domain') for child in section]
    assert len(domains) == len(expected) and set(domains) == expected
legacy = resource('fullBackupContent')
assert legacy.tag == 'full-backup-content'
excludes_everything(legacy)
modern = resource('dataExtractionRules')
assert modern.tag == 'data-extraction-rules'
assert [child.tag for child in modern] == ['cloud-backup', 'device-transfer']
for mode in ('cloud-backup', 'device-transfer'):
    excludes_everything(modern.find(mode))
print('Actual Android XML excludes all 9 storage domains for legacy backup, cloud backup and device transfer.')
`;
  const result = spawnSync(process.env.ASTHA_PYTHON || 'python', ['-B', '-c', script], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /all 9 storage domains/);
});
