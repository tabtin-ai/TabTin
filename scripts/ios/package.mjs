import path from 'node:path';

export function resolvePackagePlan({ rootDir, platform, args }) {
  if (platform !== 'darwin') {
    throw new Error('iOS 只能在安装了 Xcode 的 macOS 上打包。');
  }
  return {
    command: 'xcodebuild',
    args: [
      '-project',
      path.join(rootDir, 'apps', 'tabtin-ios', 'Tabtin.xcodeproj'),
      '-scheme',
      'Tabtin',
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS',
      '-archivePath',
      path.join(rootDir, 'dist', 'ios', 'Tabtin.xcarchive'),
      'archive',
      ...args,
    ],
    cwd: rootDir,
  };
}
