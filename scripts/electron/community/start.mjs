import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectCommunityDoctorChecks,
  createCommunityDoctorRuntimeContext,
} from './doctor.mjs';
import {
  formatBackendFailure,
  probeCommunityBackend,
  resolveBackendCommand,
  startCommunityBackend,
  waitForCommunityBackend,
} from './backend.mjs';
import {
  computeElectronInstallFingerprint,
  isElectronInstallCurrent,
  markElectronInstallCurrent,
} from './install-cache.mjs';
import { ensureCommunityEnvFile } from './environment.mjs';
import {
  formatCommunityDevHelp,
  parseCommunityDevArgs,
} from './options.mjs';
import {
  resolveElectronInstallProfile,
  resolveElectronInstallRegion,
} from '../install-dependencies.mjs';
import { waitForElectronReady } from './electron-readiness.mjs';
import { runTimedStage } from './timing.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HEALTH_TARGETS = [
  'Django http://127.0.0.1:6060/health',
  'Collab http://127.0.0.1:4100/health',
  'Centrifugo 127.0.0.1:8100',
];

function getRootDir() {
  return path.resolve(path.dirname(SCRIPT_PATH), '../../..');
}

function getEnvironmentFile(rootDir) {
  return path.join(rootDir, 'apps', 'tabtin-electron', '.env.opensource.local');
}

function getElectronCommand(rootDir) {
  return {
    command: process.execPath,
    args: [
      path.join(rootDir, 'scripts', 'electron', 'dev.mjs'),
      '--env-file',
      getEnvironmentFile(rootDir),
    ],
  };
}

function assertSpawnSucceeded(result, stage) {
  if (result.error) throw result.error;
  if (result.signal)
    throw new Error(`${stage} terminated by signal ${result.signal}`);
  if (result.status !== 0)
    throw new Error(`${stage} exited with code ${result.status}`);
}

export async function ensureElectronInstall({
  rootDir,
  region,
  spawnSyncImpl = spawnSync,
}) {
  const fingerprint = await computeElectronInstallFingerprint(rootDir);
  if (await isElectronInstallCurrent(rootDir, fingerprint))
    return { cached: true };

  const result = spawnSyncImpl(
    process.execPath,
    [
      path.join(rootDir, 'scripts', 'electron', 'install-dependencies.mjs'),
      '--region',
      region,
    ],
    { cwd: rootDir, stdio: 'inherit', shell: false },
  );
  assertSpawnSucceeded(result, 'Electron dependency installation');
  await markElectronInstallCurrent(rootDir, {
    fingerprint,
    region,
  });
  return { cached: false };
}

export async function prepareElectronWorkspace({
  rootDir,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  // 与 `pnpm --dir apps/tabtin-electron dev` 的 predev 同源：workspace dist、
  // Go CLI、tabtin-filegen、desktop runtimes。只跑 predev-build 会漏掉 filegen，
  // 首次 `tabtin file create` 只能落到手动 build.sh。
  const result = spawnSyncImpl(
    process.execPath,
    [
      pathApi.join(
        rootDir,
        'apps',
        'tabtin-electron',
        'scripts',
        'prepare-dev-runtime.mjs',
      ),
    ],
    { cwd: rootDir, stdio: 'inherit', shell: false },
  );
  assertSpawnSucceeded(result, 'Electron workspace preparation');
}

function defaultDoctor({ backendAlreadyHealthy }) {
  return collectCommunityDoctorChecks({
    ...createCommunityDoctorRuntimeContext(),
    backendAlreadyHealthy,
  });
}

function printDoctorChecks(checks, output) {
  if (!Array.isArray(checks)) return;

  for (const check of checks) {
    output(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.summary}`);
    if (!check.ok && check.remediation) output(`  ${check.remediation}`);
  }
}

function assertDoctorReady(checks) {
  if (checks === false) throw new Error('Community development doctor failed');
  if (!Array.isArray(checks)) return;

  const failed = checks.filter(
    (check) => check.required && !check.ok,
  );
  if (failed.length > 0) {
    throw new Error(failed.map((check) => check.summary).join('; '));
  }
}

function printDryRun({ options, rootDir, platform, output }) {
  const backend = resolveBackendCommand(platform, rootDir);
  const electron = getElectronCommand(rootDir);
  output(`region strategy: ${options.region}`);
  if (options.region === 'auto') {
    output('registry: auto probe before installation');
  } else {
    output(
      `registry: ${resolveElectronInstallProfile(options.region).registry}`,
    );
  }
  output(
    `backend: ${options.skipBackend ? 'health check only' : 'start if unhealthy'}`,
  );
  output(`backend command: ${backend.command} ${backend.args.join(' ')}`);
  output(`environment file: ${getEnvironmentFile(rootDir)}`);
  output(`health targets: ${HEALTH_TARGETS.join('; ')}`);
  output(`electron command: ${electron.command} ${electron.args.join(' ')}`);
}

export async function runCommunityDev(dependencies = {}) {
  const rootDir = dependencies.rootDir ?? getRootDir();
  const platform = dependencies.platform ?? process.platform;
  const output = dependencies.output ?? console.log;
  const options = parseCommunityDevArgs(
    dependencies.argv ?? process.argv.slice(2),
  );

  if (options.help) {
    output(formatCommunityDevHelp());
    return { options, mode: 'help' };
  }

  if (options.dryRun) {
    printDryRun({ options, rootDir, platform, output });
    return { options, mode: 'dry-run' };
  }

  const timingOptions = {
    now: dependencies.now ?? performance.now.bind(performance),
    output,
  };
  const timed = (label, operation) =>
    runTimedStage(label, operation, timingOptions);
  const probeBackend = dependencies.probeBackend ?? probeCommunityBackend;
  let report = await timed('后端状态检查', () => probeBackend());
  const doctor = dependencies.doctor ?? defaultDoctor;
  const doctorChecks = await timed('开发环境检查', () =>
    doctor({ backendAlreadyHealthy: report.healthy }),
  );
  printDoctorChecks(doctorChecks, output);
  assertDoctorReady(doctorChecks);
  if (options.doctor) return { options, mode: 'doctor' };
  if (options.skipBackend && !report.healthy) {
    throw new Error(formatBackendFailure({ report, rootDir }));
  }

  const resolveRegion =
    dependencies.resolveRegion ?? resolveElectronInstallRegion;
  const region = await timed('依赖源选择', () => resolveRegion(options.region));
  const ensureInstall = dependencies.ensureInstall ?? ensureElectronInstall;
  await timed('Electron 依赖安装', () => ensureInstall({ rootDir, region }));

  const ensureEnv = dependencies.ensureEnv ?? ensureCommunityEnvFile;
  await timed('开发配置准备', () => ensureEnv(getEnvironmentFile(rootDir)));

  if (!report.healthy) {
    const startBackend = dependencies.startBackend ?? startCommunityBackend;
    await timed('后端服务启动', () => startBackend({ platform, rootDir }));
    const waitForBackend =
      dependencies.waitForBackend ?? waitForCommunityBackend;
    report = await timed('后端健康等待', () => waitForBackend());
  }

  if (!report.healthy) throw new Error(formatBackendFailure({ report, rootDir }));

  const prepareWorkspace =
    dependencies.prepareWorkspace ?? prepareElectronWorkspace;
  await timed('Electron dev runtime 准备', () =>
    prepareWorkspace({ rootDir, platform }),
  );

  const startElectron = dependencies.startElectron ?? startCommunityElectron;
  await startElectron({ rootDir, output, now: timingOptions.now });
  return { options, region, report };
}

function getElectronWorkspace(rootDir, platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.join(rootDir, 'apps', 'tabtin-electron');
}

function createElectronProcessEnv({ rootDir, platform, env }) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const electronBin = pathApi.join(
    getElectronWorkspace(rootDir, platform),
    'node_modules',
    '.bin',
  );
  const effectivePathKey = pathKey ?? 'PATH';
  const inheritedPath = env[effectivePathKey];

  return {
    ...env,
    [effectivePathKey]: inheritedPath
      ? `${electronBin}${pathApi.delimiter}${inheritedPath}`
      : electronBin,
  };
}

export function terminateElectronProcessTree({
  child,
  platform = process.platform,
  signal = 'SIGTERM',
  spawnSyncImpl = spawnSync,
}) {
  if (platform === 'win32' && Number.isInteger(child.pid)) {
    const result = spawnSyncImpl(
      'taskkill',
      ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', shell: false },
    );
    if (!result.error && result.status === 0) return;
  }

  try {
    child.kill(signal);
  } catch {
    // The child may already have exited.
  }
}

export async function startCommunityElectron({
  rootDir,
  platform = process.platform,
  env = process.env,
  output = console.log,
  now = performance.now.bind(performance),
  readyTimeoutMs = 600_000,
  spawnImpl = spawn,
  signalSource = process,
  terminateProcessTree = terminateElectronProcessTree,
}) {
  const electron = getElectronCommand(rootDir);
  const startedAt = now();
  const child = spawnImpl(electron.command, electron.args, {
    cwd: getElectronWorkspace(rootDir, platform),
    env: {
      ...createElectronProcessEnv({ rootDir, platform, env }),
      TABTIN_COMMUNITY_DEV_BOOTSTRAP: '1',
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    shell: false,
  });

  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const signalHandlers = new Map(
    signals.map((signal) => [
      signal,
      () => {
        terminateProcessTree({ child, platform, signal });
      },
    ]),
  );
  for (const signal of signals) {
    signalSource.on(signal, signalHandlers.get(signal));
  }

  const exitResult = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (status, signal) => resolve({ status, signal }));
  });

  try {
    await waitForElectronReady({ child, timeoutMs: readyTimeoutMs });
    output(
      `[community-dev] Electron 已就绪（${((now() - startedAt) / 1_000).toFixed(1)}s）`,
    );
    assertSpawnSucceeded(await exitResult, 'Electron development server');
  } catch (error) {
    terminateProcessTree({ child, platform, signal: 'SIGTERM' });
    throw error;
  } finally {
    for (const signal of signals) {
      signalSource.removeListener(signal, signalHandlers.get(signal));
    }
  }
}

async function main() {
  try {
    await runCommunityDev();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  main();
}
