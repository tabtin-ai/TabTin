export function resolvePackagePlan({ rootDir }) {
  return {
    command: 'docker',
    args: [
      'build',
      '-f',
      'apps/tabtin_django/Dockerfile',
      '-t',
      'tabtin-backend:local',
      '.',
    ],
    cwd: rootDir,
  };
}
