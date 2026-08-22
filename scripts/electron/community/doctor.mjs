import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const rootPackage = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
);
const REQUIRED_NODE_RANGE = rootPackage.engines.node;
const REQUIRED_PNPM = rootPackage.packageManager;
const WINDOWS_VSWHERE =
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
const WINDOWS_VSWHERE_ARGS = [
  '-products',
  '*',
  '-requires',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '-property',
  'installationPath',
];

function parseVersion(version) {
  const match = String(version ?? '').match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return match.slice(1).map((part) => Number(part ?? 0));
}

function isAtLeast(version, minimum) {
  const actual = parseVersion(version);
  const expected = parseVersion(minimum);
  if (!actual || !expected) return false;

  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] > expected[index]) return true;
    if (actual[index] < expected[index]) return false;
  }
  return true;
}

function commandExists(command) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  return spawnSync(locator, [command], { stdio: 'ignore' }).status === 0;
}

function commandOutput(
  command,
  args,
  {
    platform = process.platform,
    spawnSyncImpl = spawnSync,
    comSpec = process.env.ComSpec ?? 'cmd.exe',
  } = {},
) {
  const isWindowsCommandShim =
    platform === 'win32' && command.toLowerCase().endsWith('.cmd');
  const result = spawnSyncImpl(
    isWindowsCommandShim ? comSpec : command,
    isWindowsCommandShim
      ? ['/d', '/s', '/c', `${command} ${args.join(' ')}`]
      : args,
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function resolveRuntimeCommand(command, platform) {
  return platform === 'win32' && ['pnpm', 'corepack'].includes(command)
    ? `${command}.cmd`
    : command;
}

export function createCommunityDoctorRuntimeContext({
  platform = process.platform,
  commandExists: commandExistsImpl = commandExists,
  commandOutput: commandOutputOverride,
  spawnSyncImpl = spawnSync,
  comSpec,
  existsSync: existsSyncImpl = existsSync,
} = {}) {
  const commandOutputImpl =
    commandOutputOverride ??
    ((command, args) =>
      commandOutput(command, args, { platform, spawnSyncImpl, comSpec }));
  const names = [
    'node',
    'pnpm',
    'corepack',
    'python',
    'python3',
    'py',
    'go',
    'docker',
    'make',
    'c++',
    'g++',
  ];
  if (platform === 'win32') names.push('cl.exe');

  const commands = new Set(names.filter(commandExistsImpl));
  const vswhereAvailable =
    platform === 'win32' && existsSyncImpl(WINDOWS_VSWHERE);
  if (vswhereAvailable) commands.add('vswhere.exe');
  const xcodeSelectPath =
    platform === 'darwin'
      ? Boolean(commandOutputImpl('xcode-select', ['-p']))
      : undefined;
  const dockerReady =
    commands.has('docker') &&
    Boolean(commandOutputImpl('docker', ['info', '--format', '{{.ServerVersion}}']));

  return {
    platform,
    nodeVersion: process.version,
    packageManager: commands.has('pnpm')
      ? `pnpm@${commandOutputImpl(resolveRuntimeCommand('pnpm', platform), ['--version'])}`
      : null,
    corepackPnpmVersion:
      !commands.has('pnpm') && commands.has('corepack')
        ? commandOutputImpl(resolveRuntimeCommand('corepack', platform), [
            'pnpm',
            '--version',
          ])
        : null,
    commands,
    vswhereQuery: vswhereAvailable
      ? () => commandOutputImpl(WINDOWS_VSWHERE, WINDOWS_VSWHERE_ARGS)
      : undefined,
    xcodeSelectPath,
    dockerReady,
    backendAlreadyHealthy: false,
  };
}

function hasCommand(commands, ...names) {
  return names.some((name) => commands.has(name));
}

function check(id, ok, required, summary, remediation) {
  return { id, ok, required, summary, remediation };
}

function matchesRequiredPnpmMajor(version) {
  const requiredMajor = parseVersion(REQUIRED_PNPM)?.[0];
  return parseVersion(version)?.[0] === requiredMajor;
}

export function collectCommunityDoctorChecks(
  context = createCommunityDoctorRuntimeContext(),
) {
  const commands = context.commands ?? new Set();
  const platform = context.platform ?? process.platform;
  const nodeVersion = context.nodeVersion ?? process.version;
  const packageManager = context.packageManager;
  const nodeOk = isAtLeast(
    nodeVersion,
    REQUIRED_NODE_RANGE.replace(/^>=\s*/, ''),
  );
  const pnpmOnPath =
    hasCommand(commands, 'pnpm') && matchesRequiredPnpmMajor(packageManager);
  const corepackAvailable =
    !hasCommand(commands, 'pnpm') && hasCommand(commands, 'corepack');
  const corepackCanRunPnpm =
    corepackAvailable && matchesRequiredPnpmMajor(context.corepackPnpmVersion);
  const pythonOk =
    platform === 'win32'
      ? hasCommand(commands, 'python', 'py')
      : hasCommand(commands, 'python3', 'python');
  const vswhereInstallationPath =
    platform === 'win32' &&
    !hasCommand(commands, 'cl.exe', 'cl') &&
    hasCommand(commands, 'vswhere.exe', 'vswhere') &&
    typeof context.vswhereQuery === 'function'
      ? context.vswhereQuery()
      : null;
  const buildToolsOk =
    platform === 'win32'
      ? hasCommand(commands, 'cl.exe', 'cl') ||
        (typeof vswhereInstallationPath === 'string' &&
          vswhereInstallationPath.trim().length > 0)
      : platform === 'darwin'
        ? context.xcodeSelectPath === undefined
          ? hasCommand(commands, 'xcode-select')
          : Boolean(context.xcodeSelectPath)
        : hasCommand(commands, 'make') && hasCommand(commands, 'c++', 'g++');
  const backendAlreadyHealthy = Boolean(context.backendAlreadyHealthy);
  const dockerOk = context.dockerReady ?? hasCommand(commands, 'docker');
  const goOk = hasCommand(commands, 'go');

  return [
    check(
      'node',
      nodeOk,
      true,
      nodeOk
        ? `Node ${nodeVersion} satisfies ${REQUIRED_NODE_RANGE}.`
        : `Node ${nodeVersion} does not satisfy ${REQUIRED_NODE_RANGE}.`,
      `Install Node ${REQUIRED_NODE_RANGE}, then rerun node scripts/dev.mjs community --doctor.`,
    ),
    check(
      'pnpm',
      pnpmOnPath || corepackCanRunPnpm,
      true,
      pnpmOnPath
        ? `${packageManager} matches ${REQUIRED_PNPM}.`
        : corepackCanRunPnpm
          ? `pnpm is not on PATH; Corepack can run ${REQUIRED_PNPM}.`
          : corepackAvailable
            ? `Corepack cannot run a pnpm version matching ${REQUIRED_PNPM}.`
            : `pnpm must match ${REQUIRED_PNPM}.`,
      corepackAvailable
        ? `Use corepack pnpm --version (target ${REQUIRED_PNPM}); this doctor does not enable Corepack globally.`
        : `Install ${REQUIRED_PNPM}, then rerun node scripts/dev.mjs community --doctor.`,
    ),
    check(
      'python',
      pythonOk,
      true,
      pythonOk
        ? 'Python 3 command is available.'
        : 'Python 3 command is missing.',
      'Install Python 3 and ensure python (Windows) or python3 is available on PATH.',
    ),
    check(
      'build-tools',
      buildToolsOk,
      true,
      buildToolsOk
        ? 'Native build tools are available.'
        : 'Native build tools are missing.',
      platform === 'win32'
        ? 'Install Visual Studio Build Tools with Desktop development with C++, then rerun the doctor.'
        : platform === 'darwin'
          ? 'Run xcode-select --install, then rerun the doctor.'
          : 'Install make and a C/C++ compiler (c++ or g++), then rerun the doctor.',
    ),
    check(
      'docker',
      dockerOk,
      !backendAlreadyHealthy,
      backendAlreadyHealthy
        ? 'Backend is already healthy; Docker is not required for this run.'
        : dockerOk
          ? 'Docker daemon is available for the local backend.'
          : 'Docker Desktop or another Docker daemon is required to start the local backend.',
      'Start Docker Desktop (or another Docker daemon), then rerun node scripts/dev.mjs community --doctor.',
    ),
    check(
      'go',
      goOk,
      true,
      goOk
        ? 'Go is available for the Electron predev build.'
        : 'Go is required for the Electron predev build.',
      'Install Go and ensure go is available on PATH, then rerun the doctor.',
    ),
  ];
}
