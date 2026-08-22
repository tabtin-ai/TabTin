import path from 'node:path';

export function resolvePackagePlan({ rootDir, platform, args }) {
  const androidDir = path.join(rootDir, 'apps', 'tabtin-android');
  const hasTask = Boolean(args[0] && !args[0].startsWith('--'));
  const task = hasTask ? args[0] : 'assembleRelease';
  const taskArgs = hasTask ? args.slice(1) : args;
  if (platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'gradlew.bat', task, ...taskArgs],
      cwd: androidDir,
    };
  }
  return {
    command: path.join(androidDir, 'gradlew'),
    args: [task, ...taskArgs],
    cwd: androidDir,
  };
}
