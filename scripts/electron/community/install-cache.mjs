import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MARKER_PATH = [
  'node_modules',
  '.cache',
  'tabtin-community-bootstrap.json',
];
const COMMUNITY_BOOTSTRAP_VERSION = '2';

function getFingerprintFiles(rootDir) {
  return [
    join(rootDir, 'pnpm-lock.yaml'),
    join(rootDir, 'package.json'),
    join(rootDir, 'apps', 'tabtin-electron', 'package.json'),
  ];
}

function getMarkerPath(rootDir) {
  return join(rootDir, ...MARKER_PATH);
}

function getElectronModulePath(rootDir) {
  return join(
    rootDir,
    'apps',
    'tabtin-electron',
    'node_modules',
    'electron',
    'package.json',
  );
}

function getElectronPathFile(rootDir) {
  return join(
    rootDir,
    'apps',
    'tabtin-electron',
    'node_modules',
    'electron',
    'path.txt',
  );
}

function resolveElectronBinaryPath(rootDir, pathText) {
  const electronDir = join(dirname(getElectronModulePath(rootDir)), 'dist');
  const binaryPath = pathText.trim();
  if (!binaryPath || isAbsolute(binaryPath)) return null;

  const resolvedPath = resolve(electronDir, binaryPath);
  const relativePath = relative(electronDir, resolvedPath);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }

  return resolvedPath;
}

export async function computeElectronInstallFingerprint(rootDir) {
  const files = await Promise.all(
    getFingerprintFiles(rootDir).map((file) => readFile(file)),
  );
  const hash = createHash('sha256');

  hash.update(COMMUNITY_BOOTSTRAP_VERSION);
  for (const content of files) hash.update(content);
  return hash.digest('hex');
}

export async function isElectronInstallCurrent(rootDir, fingerprint) {
  try {
    const [
      markerText,
      workspacePackageText,
      electronPackageText,
      electronPathText,
    ] = await Promise.all([
      readFile(getMarkerPath(rootDir), 'utf8'),
      readFile(
        join(rootDir, 'apps', 'tabtin-electron', 'package.json'),
        'utf8',
      ),
      readFile(getElectronModulePath(rootDir), 'utf8'),
      readFile(getElectronPathFile(rootDir), 'utf8'),
    ]);
    const marker = JSON.parse(markerText);
    const workspacePackage = JSON.parse(workspacePackageText);
    const electronPackage = JSON.parse(electronPackageText);
    const electronBinaryPath = resolveElectronBinaryPath(
      rootDir,
      electronPathText,
    );
    if (!electronBinaryPath) return false;
    const electronBinary = await stat(electronBinaryPath);
    const expectedVersion =
      workspacePackage.devDependencies?.electron ??
      workspacePackage.dependencies?.electron;

    return (
      marker.fingerprint === fingerprint &&
      typeof expectedVersion === 'string' &&
      electronPackage.version === expectedVersion.replace(/^[^\d]*/, '') &&
      electronPathText.trim().length > 0 &&
      electronBinary.isFile()
    );
  } catch {
    return false;
  }
}

export async function markElectronInstallCurrent(rootDir, metadata) {
  const markerPath = getMarkerPath(rootDir);
  const marker = {
    fingerprint: metadata.fingerprint,
    region: metadata.region,
    installedAt: metadata.installedAt ?? new Date().toISOString(),
  };

  await mkdir(join(rootDir, 'node_modules', '.cache'), { recursive: true });
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, 'utf8');
}
