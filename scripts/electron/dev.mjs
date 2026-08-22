#!/usr/bin/env node
/**
 * dev.mjs — 跨平台启动 Electron dev。
 *
 * 原 dev 脚本含 POSIX shell 语法；其中 `2>/dev/null`、`;`、`|| true`、以及 dev:no-hmr 的内联 `VAR=1 cmd` 都是 POSIX shell
 * 语法。pnpm 在 Windows 上经 cmd.exe 执行 script，cmd 会把 /dev/null 当路径报
 * 「系统找不到指定的路径」并中断整行，导致 electron-vite 根本起不来。
 *
 * 本脚本前台拉起 electron-vite dev，透传 stdio、信号与退出码。
 *
 * 用法：node scripts/dev.mjs electron
 *   --no-hmr           设 TABTIN_DISABLE_RENDERER_HMR=1（关渲染进程 HMR）
 *   --im               开启 IM 联调：启动时进入「消息」模块（配合 electron-im-start.sh 拉起双端）
 *   --profile preprod  显式加载 apps/tabtin-electron/.env.preprod 连接预发环境
 *   --env-file <path>  显式加载指定 dev env 文件（相对当前 package cwd）
 */
import { spawnSync, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildTag } from '../../apps/tabtin-electron/scripts/resolve-build-tag.mjs';
import { injectGitBuildInfoEnv } from '../../apps/tabtin-electron/scripts/resolve-git-build-info.mjs';
import { createElectronDevOutputMonitor } from './electron-dev-output.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const args = process.argv.slice(2);
const noHmr = args.includes('--no-hmr');
const imMode = args.includes('--im') || process.env.TABTIN_DEV_IM_MODE === '1';
const profileArgIndex = args.indexOf('--profile');
const explicitProfile = profileArgIndex >= 0 ? args[profileArgIndex + 1]?.trim() : '';
const envFileArgIndex = args.indexOf('--env-file');
const explicitEnvFile = envFileArgIndex >= 0 ? args[envFileArgIndex + 1]?.trim() : '';
const supportedProfiles = new Set(['preprod']);
if (explicitProfile && !supportedProfiles.has(explicitProfile)) {
  console.error(`[electron-dev] 不支持的 dev profile: ${explicitProfile}`);
  process.exit(1);
}
if (envFileArgIndex >= 0 && !explicitEnvFile) {
  console.error('[electron-dev] --env-file 需要传入 env 文件路径');
  process.exit(1);
}
if (explicitProfile && explicitEnvFile) {
  console.error('[electron-dev] --profile 与 --env-file 不能同时使用，请选择一种环境来源');
  process.exit(1);
}
const resolvedEnvFile = explicitEnvFile
  ? path.resolve(process.cwd(), explicitEnvFile)
  : '';
if (resolvedEnvFile) {
  try {
    if (!statSync(resolvedEnvFile).isFile()) {
      console.error(`[electron-dev] env 路径不是文件: ${resolvedEnvFile}`);
      process.exit(1);
    }
  } catch {
    console.error(`[electron-dev] env 文件不存在: ${resolvedEnvFile}`);
    process.exit(1);
  }
}

// ── 前台启动 electron-vite dev ──────────────────────────────────────────────
// pnpm 跑 script 时已把 node_modules/.bin 注入 PATH，子进程继承得到 electron-vite。
// win32 下用 shell:true 让 cmd 按 PATHEXT 解析 electron-vite.cmd（裸 spawn .cmd 会 EINVAL）。
const env = { ...process.env };
if (noHmr) env.TABTIN_DISABLE_RENDERER_HMR = '1';
// IM 联调模式把每次 Electron 冷启动 / 主进程重启都带回「消息」模块，
// 避免开发者反复手点侧栏分段控件。只影响 dev，生产构建不会注入该变量。
if (imMode) {
  env.TABTIN_DEV_IM_MODE = '1';
  env.VITE_DEV_INITIAL_MODULE = 'im';
}
// `TABTIN_BUILD_PROFILE` / `TABTIN_VITE_MODE` are build-only selectors.
// `TABTIN_RUNTIME_PROFILE` is for packaged/debug overrides; plain dev must
// always use the dedicated TabTin Dev identity unless a dev profile is explicit.
// If a shell keeps `TABTIN_BUILD_PROFILE=preprod` after packaging, plain
// `pnpm dev` would load apps/tabtin-electron/.env.preprod and make the
// in-app Agent/chat rail talk to the preprod backend instead of root .env.
for (const key of Object.keys(env)) {
  const normalized = key.toUpperCase();
  if (
    normalized === 'ELECTRON_RUN_AS_NODE' ||
    normalized === 'TABTIN_BUILD_PROFILE' ||
    normalized === 'TABTIN_VITE_MODE' ||
    normalized === 'TABTIN_RUNTIME_PROFILE' ||
    normalized === 'TABTIN_ELECTRON_DEV_ENV_FILE'
  ) {
    delete env[key];
  }
}
if (explicitProfile) {
  env.TABTIN_BUILD_PROFILE = explicitProfile;
  env.TABTIN_VITE_MODE = explicitProfile;
  env.TABTIN_RUNTIME_PROFILE = explicitProfile;
}
if (resolvedEnvFile) {
  env.TABTIN_ELECTRON_DEV_ENV_FILE = resolvedEnvFile;
}

try {
  spawnSync(process.execPath, [path.join(__dirname, 'process-cleanup.mjs'), '--all', '--current-only', '--quiet'], {
    stdio: 'ignore',
  });
} catch {
  // Cleanup is best-effort; failing it should not block a dev boot.
}

// dev 也注入 GitFlow alpha tag，避免 UI / errorReporter 退化成 package.json#version (1.0.0)。
if (!env.VITE_APP_VERSION?.trim()) {
  const buildTag = resolveBuildTag();
  if (buildTag) {
    env.VITE_APP_VERSION = buildTag;
    console.log(`[electron-dev] 注入 VITE_APP_VERSION="${buildTag}" (GitFlow alpha tag)`);
  }
}
injectGitBuildInfoEnv({
  env,
  log: (message) => console.log(message.replace('[run-electron-vite]', '[electron-dev]')),
});

const communityBootstrap =
  process.env.TABTIN_COMMUNITY_DEV_BOOTSTRAP === '1' &&
  typeof process.send === 'function';
const child = spawn('electron-vite', ['dev'], {
  stdio: communityBootstrap ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  shell: isWin,
  env,
});

if (communityBootstrap) {
  const monitor = createElectronDevOutputMonitor((event) => process.send?.(event));
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
    monitor.inspect(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
    monitor.inspect(chunk);
  });
}

// Ctrl+C / 终止信号转发给子进程，避免父 Node 先退留下 electron-vite 孤儿进程。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* 子进程可能已退出 */
    }
  });
}

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
child.on('error', (err) => {
  console.error(`[electron-dev] 启动 electron-vite 失败: ${err.message}`);
  process.exit(1);
});
