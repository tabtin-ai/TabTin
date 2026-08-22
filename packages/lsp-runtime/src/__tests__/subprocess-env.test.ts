/**
 * subprocessEnv() Electron 适配测试。
 *
 * 由 2026-05-13 三轮 review 中的 P0-1 暴露：
 *   - 在 Electron 主进程里 spawn .mjs 子进程时，`process.execPath` 指向
 *     Electron binary（非 node binary）
 *   - 直接 spawn 会启动新 Electron 实例，弹空白窗口 / 崩溃
 *   - 必须传 `ELECTRON_RUN_AS_NODE=1` 让 Electron binary 以纯 Node 模式启动
 *
 * 单元测试为什么之前没暴露这个 bug：vitest 跑在 Node 进程下，`process.execPath`
 * 真的是 node，所以 builtin-servers.test.ts 的"bundled 端到端 spawn"测试都通过。
 *
 * 本测试通过 mock `process.versions.electron` 模拟 Electron 环境，确保
 * subprocessEnv() 在 Electron 下自动注入 ELECTRON_RUN_AS_NODE='1'。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { subprocessEnv } from '../util/subprocess-env.js';

describe('subprocessEnv() Electron 适配（P0-1 防护）', () => {
  const originalElectron = (
    process.versions as NodeJS.ProcessVersions & { electron?: string }
  ).electron;

  afterEach(() => {
    if (originalElectron === undefined) {
      delete (process.versions as NodeJS.ProcessVersions & { electron?: string })
        .electron;
    } else {
      (
        process.versions as NodeJS.ProcessVersions & { electron?: string }
      ).electron = originalElectron;
    }
  });

  it('Node 环境下不注入 ELECTRON_RUN_AS_NODE', () => {
    // vitest 默认跑在 Node 下，process.versions.electron 应该是 undefined
    delete (process.versions as NodeJS.ProcessVersions & { electron?: string })
      .electron;

    const env = subprocessEnv();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('Electron 环境下注入 ELECTRON_RUN_AS_NODE=1', () => {
    // 模拟 Electron 主进程：process.versions.electron 由 Electron runtime 注入
    (
      process.versions as NodeJS.ProcessVersions & { electron?: string }
    ).electron = '32.0.0';

    const env = subprocessEnv();
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('Electron 环境下保留其余 env 字段（PATH 等）', () => {
    (
      process.versions as NodeJS.ProcessVersions & { electron?: string }
    ).electron = '32.0.0';

    const env = subprocessEnv();
    // 不应覆盖系统 PATH 等
    expect(env.PATH).toBe(process.env.PATH);
    // 必加 ELECTRON_RUN_AS_NODE
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
