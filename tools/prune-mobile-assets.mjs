import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicPaths = {
  android: ['android', 'app', 'src', 'main', 'assets', 'public'],
  ios: ['ios', 'App', 'App', 'public'],
};
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;

// Capacitor copies the entire web directory. Keep the website's existing APK download,
// but exclude that archived installer from the generated Android and iOS app assets.
export function pruneMobileDownload(projectRoot, platform) {
  if (!Object.hasOwn(publicPaths, platform)) throw new Error('Unsupported native platform.');
  const root = fs.realpathSync(path.resolve(projectRoot));
  const publicDir = path.join(root, ...publicPaths[platform]);
  if (!fs.existsSync(publicDir)) throw new Error('Capacitor public assets have not been copied.');
  if (comparable(fs.realpathSync(publicDir)) !== comparable(publicDir)) {
    throw new Error('Refusing to modify a linked native assets directory.');
  }
  const download = path.join(publicDir, 'downloads', 'astha.apk');
  if (!fs.existsSync(download)) return false;
  if (!fs.lstatSync(download).isFile() || comparable(fs.realpathSync(download)) !== comparable(download)) {
    throw new Error('Refusing to modify a linked or non-file archived installer.');
  }
  fs.unlinkSync(download);
  return true;
}

if (process.argv[1] && comparable(path.resolve(process.argv[1])) === comparable(fileURLToPath(import.meta.url))) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  if (!process.env.CAPACITOR_ROOT_DIR || comparable(fs.realpathSync(process.env.CAPACITOR_ROOT_DIR)) !== comparable(fs.realpathSync(root))) {
    throw new Error('Run this script through Capacitor from this project.');
  }
  const platform = process.env.CAPACITOR_PLATFORM_NAME;
  if (platform !== 'web' && pruneMobileDownload(root, platform)) {
    console.log('Excluded archived APK from generated ' + platform + ' assets.');
  }
}
