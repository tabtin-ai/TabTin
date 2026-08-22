import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCommunityDoctorChecks } from './community/doctor.mjs';

const REGISTRIES = {
  global: 'https://registry.npmjs.org',
  cn: 'https://registry.npmmirror.com',
};

const CHINA_BINARY_MIRRORS = {
  ELECTRON_MIRROR: 'https://cdn.npmmirror.com/binaries/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    'https://cdn.npmmirror.com/binaries/electron-builder-binaries/',
  SENTRYCLI_CDNURL: 'https://cdn.npmmirror.com/binaries/sentry-cli',
};

const ELECTRON_ARTIFACT_BASE_URLS = {
  global: 'https://github.com/electron/electron/releases/download',
  cn: 'https://cdn.npmmirror.com/binaries/electron',
};

const ELECTRON_PROBE_TIMEOUT_MS = 2500;

const MIRROR_ENV_ALLOWLIST = Object.keys(CHINA_BINARY_MIRRORS);

export function resolveElectronInstallProfile(region) {
  if (!(region in REGISTRIES)) {
    throw new Error(`Unsupported region "${region}"; expected global or cn.`);
  }

  return {
    region,
    registry: REGISTRIES[region],
    env: region === 'cn' ? { ...CHINA_BINARY_MIRRORS } : {},
  };
}

function getElectronVersion() {
  const packagePath = new URL(
    '../../apps/tabtin-electron/package.json',
    import.meta.url,
  );
  const electronPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
  const version =
    electronPackage.devDependencies?.electron ??
    electronPackage.dependencies?.electron;

  if (!version)
    throw new Error(
      'apps/tabtin-electron/package.json does not declare Electron.',
    );
  return version.replace(/^[^\d]*/, '');
}

export function buildElectronArtifactUrl(profile, version, platform, arch) {
  const artifactBaseUrl = ELECTRON_ARTIFACT_BASE_URLS[profile.region];
  if (!artifactBaseUrl)
    throw new Error(
      `Unsupported Electron install profile "${profile.region}".`,
    );

  return `${artifactBaseUrl}/v${version}/electron-v${version}-${platform}-${arch}.zip`;
}

async function probeElectronInstallProfile(region, dependencies) {
  const profile = resolveElectronInstallProfile(region);
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const createTimeoutSignal =
    dependencies.createTimeoutSignal ?? AbortSignal.timeout;
  if (typeof fetchImpl !== 'function') return false;

  const version = getElectronVersion();
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const requests = [
    `${profile.registry}/-/ping`,
    buildElectronArtifactUrl(profile, version, platform, arch),
  ];

  try {
    const responses = await Promise.all(
      requests.map((url) =>
        fetchImpl(url, {
          signal: createTimeoutSignal(ELECTRON_PROBE_TIMEOUT_MS),
        }),
      ),
    );
    return responses.every((response) => response?.ok === true);
  } catch {
    return false;
  }
}

export async function resolveElectronInstallRegion(
  requested,
  dependencies = {},
) {
  if (requested === 'global' || requested === 'cn') return requested;
  if (requested !== 'auto') {
    throw new Error(
      `Unsupported region "${requested}"; expected auto, global, or cn.`,
    );
  }

  const probeProfile =
    dependencies.probeProfile ??
    ((region) => probeElectronInstallProfile(region, dependencies));

  const globalHealthy = await probeProfile('global').catch(() => false);
  if (globalHealthy) return 'global';

  const chinaHealthy = await probeProfile('cn').catch(() => false);
  if (chinaHealthy) return 'cn';

  throw new Error(
    'Electron install sources are unavailable: global registry/binary unavailable; cn registry/binary unavailable. Retry with --region global or --region cn.',
  );
}

export function buildElectronInstallPlan(region) {
  const profile = resolveElectronInstallProfile(region);

  return {
    ...profile,
    command: 'pnpm',
    args: [
      'install',
      '--force',
      '--frozen-lockfile',
      '--registry',
      profile.registry,
    ],
  };
}

export function formatDryRun(plan) {
  const lines = [
    `region: ${plan.region}`,
    `registry: ${plan.registry}`,
    'environment:',
  ];

  const configuredMirrors = MIRROR_ENV_ALLOWLIST.filter(
    (name) => plan.env[name],
  );
  if (configuredMirrors.length === 0) {
    lines.push('  (no mirror overrides)');
  } else {
    for (const name of configuredMirrors)
      lines.push(`  ${name}=${plan.env[name]}`);
  }

  lines.push(`command: ${plan.command} ${plan.args.join(' ')}`);
  return `${lines.join('\n')}\n`;
}

export function getNativeBuildToolHint(platform) {
  if (platform === 'win32') {
    return 'node-pty source builds require Python and Visual Studio Build Tools with Desktop development with C++.';
  }
  if (platform === 'darwin') {
    return 'node-pty source builds require Python and Xcode Command Line Tools.';
  }
  return 'node-pty source builds require Python, make, and a C/C++ compiler toolchain.';
}

export function runElectronBootstrapDoctor() {
  const checks = collectCommunityDoctorChecks();

  console.log('Community development doctor');
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.summary}`);
    if (!check.ok) console.log(`  ${check.remediation}`);
  }

  return checks.every((check) => !check.required || check.ok);
}

function parseArguments(argv) {
  let region = 'global';
  let dryRun = false;
  let doctor = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--region') {
      region = argv[index + 1];
      if (!region) throw new Error('--region requires global or cn.');
      index += 1;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--doctor') {
      doctor = true;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true, region, dryRun, doctor };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { help: false, region, dryRun, doctor };
}

function printHelp() {
  console.log(`Usage: node scripts/electron/install-dependencies.mjs [options]

Options:
  --region global|cn  Select the official or China download profile (default: global)
  --dry-run           Print the safe child-process plan without installing
  --doctor            Check package manager and native build prerequisites
  --help              Show this help`);
}

function getPlatformPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function runtimeCommandExists(command, platform) {
  const locator = platform === 'win32' ? 'where.exe' : 'which';
  return spawnSync(locator, [command], { stdio: 'ignore' }).status === 0;
}

function getPnpmInvocation(plan, platform, comSpec, commandExistsImpl) {
  const useCorepack =
    !commandExistsImpl('pnpm') && commandExistsImpl('corepack');
  const command = useCorepack ? 'corepack' : 'pnpm';
  const args = useCorepack ? ['pnpm', ...plan.args] : plan.args;

  if (platform === 'win32') {
    return {
      command: comSpec ?? process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `${command}.cmd`, ...args],
      useCorepack,
    };
  }

  return { command, args, useCorepack };
}

function createCorepackPnpmShim(platform) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tabtin-pnpm-'));
  if (platform === 'win32') {
    writeFileSync(
      path.join(directory, 'pnpm.cmd'),
      '@echo off\r\ncorepack.cmd pnpm %*\r\n',
      'utf8',
    );
  } else {
    writeFileSync(
      path.join(directory, 'pnpm'),
      '#!/bin/sh\nexec corepack pnpm "$@"\n',
      { encoding: 'utf8', mode: 0o755 },
    );
  }
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function prependProcessPath(env, directory, platform) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const effectivePathKey = pathKey ?? 'PATH';
  const delimiter = getPlatformPath(platform).delimiter;
  return {
    ...env,
    [effectivePathKey]: env[effectivePathKey]
      ? `${directory}${delimiter}${env[effectivePathKey]}`
      : directory,
  };
}

function assertInstallStageSucceeded(result, stage) {
  if (result.error) throw result.error;
  if (result.signal)
    throw new Error(`${stage} terminated by signal ${result.signal}`);
  if (result.status !== 0) {
    const error = new Error(`${stage} exited with code ${result.status}`);
    error.exitCode = result.status;
    throw error;
  }
}

export function runElectronInstall(
  plan,
  {
    rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    platform = process.platform,
    env = process.env,
    comSpec,
    spawnSyncImpl = spawnSync,
    commandExistsImpl = (command) => runtimeCommandExists(command, platform),
    createPnpmShimImpl = createCorepackPnpmShim,
  } = {},
) {
  const pathApi = getPlatformPath(platform);
  const pnpm = getPnpmInvocation(
    plan,
    platform,
    comSpec,
    commandExistsImpl,
  );
  const shim = pnpm.useCorepack ? createPnpmShimImpl(platform) : null;
  const baseEnv = { ...env, ...plan.env };
  const childEnv = shim
    ? prependProcessPath(baseEnv, shim.directory, platform)
    : baseEnv;

  try {
    const pnpmResult = spawnSyncImpl(pnpm.command, pnpm.args, {
      cwd: rootDir,
      env: childEnv,
      shell: false,
      stdio: 'inherit',
    });
    assertInstallStageSucceeded(
      pnpmResult,
      'Electron dependency installation',
    );

    const electronPackageDir = pathApi.join(
      rootDir,
      'apps',
      'tabtin-electron',
      'node_modules',
      'electron',
    );
    const electronBinaryResult = spawnSyncImpl(
      process.execPath,
      [pathApi.join(electronPackageDir, 'install.js')],
      {
        cwd: electronPackageDir,
        env: childEnv,
        shell: false,
        stdio: 'inherit',
      },
    );
    assertInstallStageSucceeded(
      electronBinaryResult,
      'Electron binary installation',
    );
    return electronBinaryResult;
  } finally {
    shim?.cleanup();
  }
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    if (options.doctor) {
      if (!runElectronBootstrapDoctor()) process.exitCode = 1;
      return;
    }

    const plan = buildElectronInstallPlan(options.region);
    if (options.dryRun) {
      process.stdout.write(formatDryRun(plan));
      return;
    }
    runElectronInstall(plan);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.exitCode ?? 1;
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
