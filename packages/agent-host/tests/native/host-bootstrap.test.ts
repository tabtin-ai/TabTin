/**
 * host-bootstrap 多 session workspaceRoot 隔离 e2e —— W1.2 P1 (d) /
 * W2.3 收尾验证。
 *
 * **背景**：W1.2 落地后 `bootstrapNativeBackend` 通过 `if (!alreadyRegistered)`
 * 让多 session 共享同一份 SpawnSandboxBackend / CommandExecutor 实例池。
 * CommandExecutor 自身的 `workspaceRoot` 是 ctor 一次性写入 —— 多 Space 并行
 * 时第二个 session 注册被跳过，它的 init.workspaceRoot 永远不会替换全局
 * executor 的 workspaceRoot，调 `session.exec(cmd)` 不带 cwd 时全部走第一个
 * session 的 workspaceRoot，多 Space 串扰。
 *
 * **修法**（W2.2.1 顺手 + W2.3 验证）：在 host-bootstrap.ts:155-204 把
 * `init.workspaceRoot` 闭包捕获到 execImpl wrapper —— 每次调 backend.execute
 * 时若 opts.cwd 缺省，用本 session 的 workspaceRoot 兜底，而非依赖
 * CommandExecutor 的全局值。
 *
 * **本测试断言**：两个 session 共享同一 registry 但各传不同 workspaceRoot,
 * 调 `pwd`（不带 cwd）时输出各自的 workspaceRoot —— 不串扰。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { ExecutionBackendRegistry } from '@tabtin/terminal-core';
import { bootstrapNativeBackend } from '../../src/native/host-bootstrap.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-bootstrap-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('bootstrapNativeBackend per-session workspaceRoot 隔离 (W1.2 P1 (d))', () => {
  it('两个 session 共享 registry 但各走自己的 workspaceRoot（exec 不带 cwd 时）', async () => {
    const registry = new ExecutionBackendRegistry();

    // 准备两个**不同**的 workspace 目录
    const wsA = path.join(tmpDir, 'space-a');
    const wsB = path.join(tmpDir, 'space-b');
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });

    const bootstrapA = await bootstrapNativeBackend({
      sessionId: 'session-a',
      agentId: 'agent-a',
      agentHomeRoot: path.join(tmpDir, 'home-a'),
      sandboxRoot: path.join(tmpDir, 'sandbox-shared'),
      workspaceRoot: wsA,
      registry,
    });
    const bootstrapB = await bootstrapNativeBackend({
      sessionId: 'session-b',
      agentId: 'agent-b',
      agentHomeRoot: path.join(tmpDir, 'home-b'),
      sandboxRoot: path.join(tmpDir, 'sandbox-shared'),
      workspaceRoot: wsB,
      registry,
    });

    try {
      // 共享 registry 校验：两个 bootstrap 的 backend 是同一个实例（factory 复用）
      expect(bootstrapA.backend).toBe(bootstrapB.backend);

      // 关键断言：调 pwd（不带 cwd），两个 session 应输出各自的 workspaceRoot
      // —— 用 `realpath` 解决 macOS /var → /private/var 的 symlink 等价性。
      const realWsA = fs.realpathSync(wsA);
      const realWsB = fs.realpathSync(wsB);

      const resA = await bootstrapA.session.exec('pwd', { timeout: 5000 });
      const resB = await bootstrapB.session.exec('pwd', { timeout: 5000 });

      expect(resA.exitCode).toBe(0);
      expect(resB.exitCode).toBe(0);

      // session A 的 pwd 应该等于 wsA（解 symlink 等价），不应等于 wsB
      expect(fs.realpathSync(resA.stdout.trim())).toBe(realWsA);
      expect(fs.realpathSync(resB.stdout.trim())).toBe(realWsB);
      expect(resA.stdout.trim()).not.toBe(resB.stdout.trim());
    } finally {
      await bootstrapA.session.shutdown();
      await bootstrapB.session.shutdown();
      await registry.dispose();
    }
  });

  it('opts.cwd 显式传入时优先于 sessionWorkspaceRoot', async () => {
    const registry = new ExecutionBackendRegistry();

    const sessionWs = path.join(tmpDir, 'session-ws');
    const explicitCwd = path.join(tmpDir, 'explicit-cwd');
    fs.mkdirSync(sessionWs, { recursive: true });
    fs.mkdirSync(explicitCwd, { recursive: true });

    const bootstrap = await bootstrapNativeBackend({
      sessionId: 'session-explicit',
      agentId: 'agent-explicit',
      agentHomeRoot: path.join(tmpDir, 'home-explicit'),
      sandboxRoot: path.join(tmpDir, 'sandbox-explicit'),
      workspaceRoot: sessionWs,
      registry,
    });

    try {
      // 优先级：opts.cwd > sessionWorkspaceRoot
      const result = await bootstrap.session.exec('pwd', {
        cwd: explicitCwd,
        timeout: 5000,
      });
      expect(result.exitCode).toBe(0);
      expect(fs.realpathSync(result.stdout.trim())).toBe(fs.realpathSync(explicitCwd));
    } finally {
      await bootstrap.session.shutdown();
      await registry.dispose();
    }
  });
});
