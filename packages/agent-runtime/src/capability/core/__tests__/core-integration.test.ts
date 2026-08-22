/**
 * Core 三件套 + NativeBackendSession 集成测试 —— W2.2.1 Stage 4。
 *
 * 验证场景：W2.3 实施时宿主层会做的事（buildCapabilities → bind →
 * prepareAgentTools → composeCapabilityHooks）在 Core 三件套上端到端走通。
 *
 * 阶段 2.3 (2026-05-20) 清理：prepareAgentInstructions 整路下线，相关测试块删除。
 *
 * 覆盖：
 *   1. 实例化 NativeBackendSession（mock execImpl）
 *   2. FileSystemCap + ShellCap + SkillsCap 都 bind(session)
 *   3. prepareAgentTools 合并 3 个工具（0 + 1 + 2）名称无冲突
 *   4. composeCapabilityHooks 返回 EngineHooks 能被调用且按 caps 顺序执行
 *   6. CapabilityRegistry register / create / validateDependencies 全链路
 *   7. 真 NativeBackendSession + ShellCap.run_terminal_command 通过 SpawnSandboxBackend
 *      执行真命令（关卡 1 地板生效）
 *   8. SkillsCap.hooks().beforeIteration 与其他 cap hooks 共存按顺序执行
 *   9. clone 整组 caps 后能 bind 新 session 重新跑链路
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  CapabilityRegistry,
  prepareAgentTools,
} from '../../index.js';
// ：SkillsCap / CliCap / McpCap 三个平台目录类 Cap 已整体迁到宿主包，
// runtime core 只保留通用能力（filesystem / shell 等）。
// 本集成测试相应剥离 SkillsCap 用例——SkillsCap 契约 / tools / hooks / clone
// 由宿主包的 skills 集成测试全量覆盖，此处不再重复。
// 注：正文不写宿主包名字面量，避免触发 check-agent-boundary AH-003
// （agent-runtime 任何文件含该字面量即判为「反向知晓宿主包」）。
import { FileSystemCap, ShellCap } from '../index.js';
import {
  NativeBackendSession,
  type NativeBackendSessionInit,
} from '../../native/native-backend-session.js';
import type { ExecResult, ExecOptions } from '../../backend-session.js';
import type { PtyManagerBridge, AgentCommandRequest, AgentCommandResult, AgentSpawnDetachedResult, AgentReadOptions, AgentReadResult, AgentKillSignal, AgentSessionEventName, AgentSessionEventHandler, AgentSessionUnsubscribe } from '@tabtin/terminal-core';
import { testHardlineChecker, allowAllHardlineChecker } from '../../../../tests/helpers/hardline-checker.js';
import { createTestSafeFsPort } from '../../../../tests/helpers/safe-fs-port.js';

// ─── Mock PtyManagerBridge（WP1 2026-05-13）───────────────────────────
//
// 集成测试不再走 NativeBackendSession.exec → spawn 路径（ShellCap PTY 化后改
// 调 PtyManagerBridge）。Mock bridge 把 mock execImpl 风格的 ExecResult 转
// AgentCommandResult，让 ShellCap 装配链路能跑（registry / prepareAgentTools
// / compose 等不涉及真 spawn 的用例）。真 spawn e2e 已退役（PTY 路径下
// NativeBackendSession 不再是 ShellCap 的依赖链路）。
function makeMockBridge(opts?: { stdoutTemplate?: (cmd: string) => string }): PtyManagerBridge {
  return {
    async executeAgentCommand(req: AgentCommandRequest): Promise<AgentCommandResult> {
      const stdout = opts?.stdoutTemplate?.(req.command) ?? `executed: ${req.command}`;
      return {
        status: 'ok',
        exitCode: 0,
        stdout,
        stderr: '',
        durationMs: 1,
        truncated: false,
        outputBytes: stdout.length,
        cwd: req.cwd ?? '/tmp',
        sessionId: `mock-integ-${Date.now().toString(36)}`,
      };
    },
    async spawnAgentSessionDetached(_req): Promise<AgentSpawnDetachedResult> {
      throw new Error('integration tests do not exercise background path');
    },
    async readAgentSessionOutput(_id, _o?): Promise<AgentReadResult> { throw new Error('not used'); },
    async killAgentSession(_id, _s?): Promise<void> {},
    subscribe<E extends AgentSessionEventName>(_e: E, _h: AgentSessionEventHandler<E>): AgentSessionUnsubscribe { return () => {}; },
  };
}

// ─── 测试辅助：tmpDir 隔离 ────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-integ-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function makeMockNativeSession(init?: Partial<NativeBackendSessionInit>): NativeBackendSession {
  const calls: Array<{ command: string; opts?: ExecOptions }> = [];
  const session = new NativeBackendSession({
    sessionId: init?.sessionId ?? 'integ-session',
    agentId: init?.agentId ?? 'integ-agent',
    agentHomeRoot: init?.agentHomeRoot ?? tmpDir,
    fs: init?.fs ?? createTestSafeFsPort(),
    execImpl: init?.execImpl ??
      (async (command, execOpts) => {
        calls.push({ command, opts: execOpts });
        return {
          stdout: `executed: ${command}`,
          stderr: '',
          exitCode: 0,
          durationMs: 1,
        };
      }),
  });
  // 把 calls 挂到 session 上方便测试断言
  (session as unknown as { __calls: typeof calls }).__calls = calls;
  return session;
}

function makeFakeContext(): import('../../../engine/contracts/tools.js').ToolContext {
  return {
    threadId: 'integ-thread',
    // §17.6 D4：ToolContext.sessionId → runtimeId（runtime UUID）+ threadId 业务对话。
    runtimeId: 'integ-runtime',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
  };
}

// ─── 1. CapabilityRegistry 全链路 ─────────────────────────────────────

describe('Core 二件套 / CapabilityRegistry 全链路', () => {
  it('register / create / list / validateDependencies 全过', () => {
    const reg = new CapabilityRegistry();
    reg.register('filesystem', () => new FileSystemCap());
    reg.register('shell', () => new ShellCap({
      checkHardlineCommand: allowAllHardlineChecker, ptyManagerBridge: makeMockBridge() }));

    expect(reg.list().map((e) => e.type)).toEqual([
      'filesystem',
      'shell',
    ]);
    expect(reg.list().map((e) => e.category)).toEqual(['core', 'core']);

    const caps = ['filesystem', 'shell'].map((t) => reg.create(t));
    expect(() => reg.validateDependencies(caps)).not.toThrow();
  });

  it('Core 二件套都自报 type / category 正确', () => {
    const fsCap = new FileSystemCap();
    const shCap = new ShellCap({
      checkHardlineCommand: allowAllHardlineChecker, ptyManagerBridge: makeMockBridge() });
    expect(fsCap.type).toBe('filesystem');
    expect(shCap.type).toBe('shell');
    expect(fsCap.category).toBe('core');
    expect(shCap.category).toBe('core');
  });
});

// ─── 2. prepareAgentTools 合并核心工具 ───────────────────────────────

describe('prepareAgentTools(核心工具)', () => {
  it('合并 1 个 tool 名无冲突 + 全部合规（FileSystemCap.tools() 返回空）', async () => {
    const fsCap = new FileSystemCap();
    const shCap = new ShellCap({
      checkHardlineCommand: allowAllHardlineChecker, ptyManagerBridge: makeMockBridge() });
    const session = makeMockNativeSession();
    await fsCap.bind(session);
    await shCap.bind(session);

    // ：SkillsCap 迁 host；本地文件交付并入 present_to_user。
    const result = prepareAgentTools([fsCap, shCap]);
    const names = result.tools.map((t) => t.name);

    expect(names).toEqual([
      'run_terminal_command',
    ]);

    for (const n of names) {
      expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }

    // ShellCap 1 件 = 1
    expect(result.schemaCache.size).toBe(1);
    expect(result.schemaCache.has('shell:run_terminal_command')).toBe(true);
  });
});

// ─── 3. prepareAgentInstructions: 阶段 2.3 已下线，集成测试同步删除 ───

// ─── 4. composeCapabilityHooks ───────────────────────────────────────
//
// ：原两条 composeCapabilityHooks(三件套) 用例断言 SkillsCap 经
// beforeRun/beforeModel 注入 skills_listing + 指纹缓存稳定。SkillsCap 已迁到
// 宿主包，该行为由宿主包 skills 集成测试的「SkillsCap hooks().beforeRun +
// beforeModel」「指纹缓存」用例全量覆盖；composeCapabilityHooks 组合语义
// （顺序 / 空数组 / 多 cap）由本包 capability/__tests__/prepare.test.ts 覆盖。
// 故此处删除。（不写宿主包名字面量，避免触发 AH-003。）

// ─── 5. NativeBackendSession e2e 用例已退役（WP1 2026-05-13）─────────
//
// 历史背景：原 `ShellCap.run_terminal_command 通过 bootstrapNativeBackend
// 真 spawn` + `truncated 字段链路` + `env 透传经 SpawnSandboxBackend 关卡 1
// sanitize` 三条 e2e 用例验证 ShellCap 通过 NativeBackendSession.exec →
// SpawnSandboxBackend 真 spawn 的端到端字段透传 + sanitize。
//
// **WP1 PTY 化后**：ShellCap 改走 `PtyManagerBridge.executeAgentCommand`,
// 不再调 NativeBackendSession.exec。bootstrapNativeBackend / SpawnSandboxBackend
// 不再是 ShellCap 的依赖链路（agent-bridge.ts JSDoc 第 7-12 行）；env sanitize
// + truncated 字段透传归 bridge 实现层职责（WP2）。
//
// **替代覆盖**：
//   - ShellCap.run_terminal_command 行为契约由 `shell.test.ts` 73 个
//     bridge-mock 用例完整覆盖（envelope 字段 / status / truncated /
//     persisted_output_path 等）。
//   - bridge 真实现 → PtyManager 真 spawn 的 e2e 验证归 WP2 的 contract test
//     （`packages/terminal-core/src/__tests__/agent-bridge-contract.ts`）。
describe('Core 三件套（FileSystemCap 空 tools）', () => {
  it('FileSystemCap.tools() 返回空数组（W1 宪法删除 list_directory / mkdir）', () => {
    const cap = new FileSystemCap();
    expect(cap.tools()).toEqual([]);
  });
});

// ─── 6. 跨 cap 同名 tool 冲突（fail-fast 校验） ──────────────────────

describe('Core 三件套 / prepareAgentTools 冲突检测', () => {
  it('两个 Capability 贡献同名 tool → 抛 CapabilityToolsConflictError', async () => {
    const shCap = new ShellCap({
      checkHardlineCommand: allowAllHardlineChecker, ptyManagerBridge: makeMockBridge() });

    // 构造一个故意同名的"伪 cap"：tools() 返回 run_terminal_command
    class ConflictCap {
      readonly type = 'conflict-test';
      readonly category = 'core' as const;
      tools() {
        return [
          {
            name: 'run_terminal_command', // 与 ShellCap 撞名
            description: 'duplicate',
            inputSchema: { type: 'object' as const },
            isReadOnly: true,
            execute: async () => ({ content: '' }),
          },
        ];
      }
    }

    const session = makeMockNativeSession();
    await shCap.bind(session);

    expect(() => prepareAgentTools([shCap, new ConflictCap()])).toThrow(
      /Tool name "run_terminal_command" is contributed by both/,
    );
  });

  it('同一 Cap 实例 bind 两次不同 sessionId → 抛"concurrent sessions"错', async () => {
    const fsCap = new FileSystemCap();
    const sessionA = makeMockNativeSession({ sessionId: 'A' });
    const sessionB = makeMockNativeSession({ sessionId: 'B' });

    await fsCap.bind(sessionA);
    await expect(fsCap.bind(sessionB)).rejects.toThrow(
      /cannot be reused across concurrent sessions/,
    );

    // 同 sessionId 多次 bind OK（CapabilityBase 默认行为）
    await expect(fsCap.bind(sessionA)).resolves.toBeUndefined();
  });
});

// ─── 7. clone 后整组 caps 重新装配 ───────────────────────────────────

describe('Core 三件套 clone 后重装', () => {
  it('一组 caps 全部 clone 后能 bind 新 session 跑装配链路', async () => {
    const fsCap = new FileSystemCap({ deny_read_paths: ['~/.ssh'] });
    const shCap = new ShellCap({
      checkHardlineCommand: allowAllHardlineChecker, ptyManagerBridge: makeMockBridge(), config: { terminal_mode: 'sandboxed' } });

    const sessionA = makeMockNativeSession({ sessionId: 'A' });
    await fsCap.bind(sessionA);
    await shCap.bind(sessionA);

    // clone 二件套（模拟 W2.3 在新 Run 创建时做的事）
    const fsCloned = fsCap.clone();
    const shCloned = shCap.clone();

    const sessionB = makeMockNativeSession({ sessionId: 'B' });
    await fsCloned.bind(sessionB);
    await shCloned.bind(sessionB);

    // ：SkillsCap 迁 host 后 FileSystemCap 贡献 0 + ShellCap 贡献 1 = 1
    const tools = prepareAgentTools([fsCloned, shCloned]);
    expect(tools.tools).toHaveLength(1);
    // 阶段 2.3 (2026-05-20) 清理：prepareAgentInstructions 段下线，instructions 收集测试删除
  });
});
