/**
 * Subprocess env helper —— 最小子集（仅保留"返回继承当前进程的 env"语义）。
 *
 * 保留这个 helper 是为了：
 *   1. 给宿主一个明确的扩展点：未来需要 scrub 时改这一处即可
 *   2. LSPServerInstance / LSPClient 调用点集中，review 时容易交叉验证
 *
 * Electron 适配：
 *   在 Electron 主进程里 spawn .mjs 子进程时，`process.execPath` 指向
 *   Electron binary 而不是 Node。直接 spawn 会启动新 Electron 实例（弹窗 /
 *   崩溃），而不是把 .mjs 当 Node 脚本跑。
 *
 *   修复：检测到 Electron 环境（`process.versions.electron` 存在）时，
 *   往子进程 env 注入 `ELECTRON_RUN_AS_NODE=1`，让 Electron binary 以
 *   纯 Node 模式启动子进程。
 *
 *   参考：https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node
 *
 *   注意：测试在 vitest（纯 Node 环境）跑，`process.versions.electron` 是
 *   undefined，所以这条分支不会影响单元测试；只在 Electron 主进程里生效。
 */

type ProcessWithVersions = NodeJS.Process & {
  versions: NodeJS.ProcessVersions & { electron?: string };
};

function isElectronProcess(): boolean {
  return Boolean((process as ProcessWithVersions).versions.electron);
}

export function subprocessEnv(): NodeJS.ProcessEnv {
  if (isElectronProcess()) {
    return { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  }
  return process.env;
}
