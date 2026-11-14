import { packager } from '@electron/packager';
import { cp, mkdir, rm, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preview = process.argv.includes('--preview');
const applicationName = preview ? 'Paperjoin Preview' : 'Paperjoin';
const stage = path.join(root, preview ? 'artifacts/desktop-preview-source' : 'artifacts/desktop-source');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const folder of ['dist', 'electron', 'assets']) await cp(path.join(root, folder), path.join(stage, folder), { recursive: true });
if (preview) {
  const mainPath = path.join(stage, 'electron/main.cjs');
  const main = await readFile(mainPath, 'utf8');
  await writeFile(mainPath, main.replace("app.setName('Paperjoin');", "app.setName('Paperjoin Preview');\napp.setPath('userData', path.join(app.getPath('appData'), 'Paperjoin Preview'));"));
}
const original = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'paperjoin', productName: applicationName, version: original.version, description: 'A private PDF workspace for your Mac', main: 'electron/main.cjs', license: 'UNLICENSED' }, null, 2));
let electronZipDir;
const cache = path.join(os.homedir(), 'Library/Caches/electron');
const zipName = `electron-v${original.devDependencies.electron}-darwin-arm64.zip`;
try {
  for (const folder of await readdir(cache, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const candidate = path.join(cache, folder.name);
    try { await access(path.join(candidate, zipName)); electronZipDir = candidate; break; } catch {}
  }
} catch {}
const applications = await packager({ electronZipDir, extraResource: [path.join(root, 'native/bin/paperjoin-compress')], dir: stage, name: applicationName, platform: 'darwin', arch: 'arm64', electronVersion: original.devDependencies.electron, out: path.join(root, preview ? 'artifacts/desktop-preview' : `output/desktop/${original.version}`), overwrite: true, asar: true, prune: false, icon: path.join(root, 'assets/icon.icns'), appBundleId: preview ? 'local.paperjoin.desktop.preview' : 'local.paperjoin.desktop', appCategoryType: 'public.app-category.productivity', appVersion: original.version, buildVersion: original.version, executableName: applicationName, darwinDarkModeSupport: true });
for (const directory of applications) {
  const application = directory.endsWith('.app') ? directory : path.join(directory, `${applicationName}.app`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', application], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', application], { stdio: 'inherit' });
  console.log(`Mac application: ${application}`);
}
