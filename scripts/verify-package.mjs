// Check the packaged artifacts and the resources they must carry.
//
// This is the automated half of docs/packaged-verification.md. It cannot press
// a native file dialog or the system print dialog; those checks are listed in
// the document and are recorded per release. It can prove that the package was
// produced, that the file association is declared, and that the platform's
// RTKLIB tools and licence are present.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLATFORM = process.platform === 'darwin' ? 'macos'
  : process.platform === 'win32' ? 'windows'
  : process.platform === 'linux' ? 'linux'
  : null;

if (!PLATFORM) {
  console.error(`Unsupported host platform: ${process.platform}`);
  process.exit(1);
}

function walk(path, predicate, found = []) {
  if (!existsSync(path)) return found;
  if (predicate(path)) {
    found.push(path);
    return found;
  }
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) walk(join(path, name), predicate, found);
  } else if (predicate(path)) {
    found.push(path);
  }
  return found;
}

const bundleRoot = process.env.NORTHSTAR_BUNDLE_ROOT
  ? resolve(ROOT, process.env.NORTHSTAR_BUNDLE_ROOT)
  : join(ROOT, 'src-tauri', 'target', 'release', 'bundle');
const artifactPatterns = {
  macos: path => path.endsWith('.app'),
  windows: path => path.endsWith('.exe') || path.endsWith('.msi'),
  linux: path => path.endsWith('.AppImage') || path.endsWith('.deb')
};
const artifacts = walk(bundleRoot, artifactPatterns[PLATFORM]);
if (!artifacts.length) {
  console.error(`No packaged ${PLATFORM} artifact under ${bundleRoot}.`);
  console.error('Run npm run build first, then npm run verify:package.');
  process.exit(1);
}

const config = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const extensions = (entry) => (entry.ext || []).map(ext => ext.replace(/^\./, ''));
// The single-dot suffix is the one macOS resolves; the compound one is kept for
// files older builds wrote and for the Windows and Linux packages.
const association = (config.bundle?.fileAssociations || []).find(entry =>
  extensions(entry).includes('northstar')
);
if (!association) {
  console.error('tauri.conf.json does not declare the .northstar association.');
  process.exit(1);
}
if (!extensions(association).includes('northstar.json')) {
  console.error('tauri.conf.json dropped the .northstar.json association older builds wrote.');
  process.exit(1);
}

const resourceRoot = join(ROOT, 'src-tauri', 'resources', 'rtklib', PLATFORM);
const binaries = PLATFORM === 'windows'
  ? ['rnx2rtkp.exe', 'convbin.exe']
  : ['rnx2rtkp', 'convbin'];
for (const name of binaries) {
  if (!existsSync(join(resourceRoot, 'bin', name))) {
    console.error(`The ${PLATFORM} RTKLIB bundle is missing bin/${name}.`);
    console.error('Run scripts/bundle-rtklib-linux.sh on Linux, or restore the committed bundle.');
    process.exit(1);
  }
}
for (const name of ['BUNDLED.json', 'LICENSE.txt']) {
  if (!existsSync(join(resourceRoot, name))) {
    console.error(`The ${PLATFORM} RTKLIB bundle is missing ${name}.`);
    process.exit(1);
  }
}

console.log(`Packaged ${PLATFORM} artifact: ${artifacts[0]}`);
if (artifacts.length > 1) console.log(`  and ${artifacts.length - 1} more`);
console.log(`Declared file association: ${association.ext.join(', ')} (${association.name || 'unnamed'})`);
console.log(`RTKLIB bundle: ${resourceRoot}`);
console.log('');
console.log('Automated packaged-artifact checks passed.');
console.log('Now complete the interactive checks in docs/packaged-verification.md:');
const interactiveChecks = [
  'native Open and Save-a-Copy dialogs',
  ...(PLATFORM === 'macos'
    ? ['macOS: double-click a .northstar project; a compound .northstar.json needs File > Open Project (docs/file-association.md)']
    : ['double-click a .northstar project from Finder or Explorer']),
  'restore window size, position and state after relaunch',
  'native menu actions and map shortcuts',
  'system print dialog with the selected-points report',
  'update check, signature verification, install and restart',
  'readiness card, Convert card and GNSS post-processing job'
];
for (const item of interactiveChecks) {
  console.log(`  [ ] ${item}`);
}
