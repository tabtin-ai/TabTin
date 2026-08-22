#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const aliases = new Map([
  ['server', 'backend'],
  ['admin', 'admindash'],
  ['desktop', 'electron'],
  ['web', 'tabtin-web'],
]);
const targetScripts = {
  backend: 'scripts/backend/dev.mjs',
  admindash: 'scripts/admindash/dev.mjs',
  electron: 'scripts/electron/dev.mjs',
  'tabtin-web': 'scripts/tabtin-web/dev.mjs',
  community: 'scripts/electron/community/start.mjs',
};
const defaultClients = ['admindash', 'electron', 'tabtin-web'];

export function normalizeDevTarget(value = 'all') {
  const normalized = value.trim().toLowerCase();
  return aliases.get(normalized) ?? normalized;
}

export function resolveDevPlan(value = 'all') {
  const target = normalizeDevTarget(value);
  if (target === 'all') return ['backend', ...defaultClients];
  if (target in targetScripts) return [target];
  throw new Error(
    `未知开发目标 “${value}”。可用目标: all, ${Object.keys(targetScripts).join(', ')}`,
  );
}

export function resolveTargetCommand(
  target,
  args = [],
  platform = process.platform,
) {
  if (target === 'electron') {
    const pnpmArgs = [
      '--filter',
      'tabtin-electron',
      'dev',
      ...(args.length > 0 ? ['--', ...args] : []),
    ];
    if (platform === 'win32') {
      return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'pnpm.cmd', ...pnpmArgs],
      };
    }
    return { command: 'pnpm', args: pnpmArgs };
  }

  return {
    command: process.execPath,
    args: [path.join(rootDir, targetScripts[target]), ...args],
  };
}

function spawnTarget(target, args = []) {
  const command = resolveTargetCommand(target, args);
  return spawn(
    command.command,
    command.args,
    {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    },
  );
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function ensureWorkspaceDependencies() {
  if (existsSync(path.join(rootDir, 'node_modules', '.modules.yaml'))) return;
  const windows = process.platform === 'win32';
  const command = windows ? process.env.ComSpec || 'cmd.exe' : 'pnpm';
  const args = windows
    ? ['/d', '/s', '/c', 'pnpm.cmd', 'install', '--frozen-lockfile']
    : ['install', '--frozen-lockfile'];
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm install exited with code ${result.status}`);
  }
}

export async function runDev(value = 'all', args = []) {
  const plan = resolveDevPlan(value);
  if (!plan.includes('community')) ensureWorkspaceDependencies();
  const children = [];
  const stopChildren = (signal = 'SIGTERM') => {
    for (const child of children) {
      if (!child.killed) child.kill(signal);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => stopChildren(signal));
  }

  if (plan[0] === 'backend') {
    console.log('[dev] 先启动后端并等待健康检查通过...');
    const backend = spawnTarget('backend', plan.length === 1 ? args : []);
    children.push(backend);
    const backendCode = await waitForExit(backend);
    children.splice(children.indexOf(backend), 1);
    if (backendCode !== 0 || plan.length === 1) return backendCode;
  }

  const clients = plan.filter((target) => target !== 'backend');
  console.log(`[dev] 启动客户端: ${clients.join(', ')}`);
  children.push(...clients.map((target) => spawnTarget(target, args)));
  const codes = await Promise.all(
    children.map((child, index) =>
      waitForExit(child).then((code) => {
        if (code !== 0) {
          console.error(`[dev] 客户端 ${clients[index]} 异常退出（code ${code}），停止其余客户端`);
          stopChildren();
        }
        return code;
      }),
    ),
  );
  return codes.find((code) => code !== 0) ?? 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await runDev(
      process.argv[2] ?? 'all',
      process.argv.slice(3).filter((arg) => arg !== '--'),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
