import path from 'node:path';

const platformNames = {
  darwin: 'mac',
  linux: 'linux',
  win32: 'win',
  mac: 'mac',
  win: 'win',
};

export function resolvePackagePlan({ rootDir, platform, args }) {
  const requestedPlatform = args[0]?.startsWith('--')
    ? platform
    : (args[0] ?? platform);
  const buildPlatform = platformNames[requestedPlatform];
  if (!buildPlatform) {
    throw new Error(`Electron 不支持打包平台: ${requestedPlatform}`);
  }
  const profileIndex = args.indexOf('--profile');
  const archIndex = args.indexOf('--arch');
  const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'local';
  const arch = archIndex >= 0 ? args[archIndex + 1] : undefined;
  return {
    command: 'bash',
    args: [
      path.join(
        rootDir,
        'apps',
        'tabtin-electron',
        'scripts',
        'build-packaged-app.sh',
      ),
      buildPlatform,
      profile,
      ...(arch ? [arch] : []),
    ],
    cwd: rootDir,
  };
}
