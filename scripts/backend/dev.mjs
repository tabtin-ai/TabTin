#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

export function resolveBackendCommand(
  platform = process.platform,
  root = rootDir,
) {
  if (platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'call', 'scripts\\backend\\restart.bat'],
    };
  }
  return {
    command: 'bash',
    args: [path.join(root, 'scripts', 'backend', 'restart.sh')],
  };
}

function ensureWorkspaceDependencies(root, platform, spawn = spawnSync) {
  if (existsSync(path.join(root, 'node_modules', '.modules.yaml'))) return;
  const command =
    platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'pnpm';
  const args =
    platform === 'win32'
      ? ['/d', '/s', '/c', 'pnpm.cmd', 'install', '--frozen-lockfile']
      : ['install', '--frozen-lockfile'];
  const result = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`pnpm install exited with code ${result.status}`);
}

export function runBackend({
  platform = process.platform,
  root = rootDir,
  spawn = spawnSync,
} = {}) {
  ensureWorkspaceDependencies(root, platform, spawn);
  const plan = resolveBackendCommand(platform, root);
  const result = spawn(plan.command, plan.args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? (result.signal ? 1 : 0);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = runBackend();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
