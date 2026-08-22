/**
 * ShellCap 单测 —— WP1 PTY 化重写（2026-05-13）。
 *
 * **重写背景**：W2.2.1 ~ W8 原版 ShellCap 单测基于 `BackendSession.exec` +
 * `child_process.spawn` 双路径模型。WP1 把 ShellCap 接入 `PtyManagerBridge`
 * 后，整套 mock 模型变成单一 bridge mock（详见 agent-bridge.ts JSDoc）。
 *
 * 保留的契约覆盖：
 *   1. 静态契约（type / category）
 *   2. tools() 返回 1 件 + name 合规 + isReadOnly = false + schema 字段
 *   3. ShellCapInit.ptyManagerBridge 必填，缺失同步 throw
 *   4. handler 调 bridge.executeAgentCommand 透传 command / timeout / env / cwd /
 *      agentMeta（toolUseId / spaceId / agentId / threadId / description 入参或 intent /
 *      originatedBy: 'local-llm-shellcap'）
 *   5. ToolContext.toolUseId === undefined 时 handler 同步 throw（硬契约）
 *   6. envelope 字段：success / exitCode / durationMs / truncated / degraded /
 *      stdout / stderr (永远空) / persisted_output_path / persisted_output_size /
 *      persisted_output_truncated_by_backend / agent_session_id /
 *      path_quoting_warnings；**已删除**：pid / persisted_stderr_path /
 *      persisted_stderr_size
 *   7. background 路径走 bridge.spawnAgentSessionDetached → envelope 含
 *      background_task_id (= sessionId) / output_file (= outputFilePath) /
 *      banner stdout
 *   8. hardline 硬拒绝 / sleep 拦截 / restrictedShellChecker 受限模式拦截
 *   9. skillContextProvider 凭据注入（同名 skill 优先）+ 未注入 SYSTEM_NOTICE
 *  10. env 装配（user / TABTIN_* / skill credential）+ TABTIN_* 过滤
 *  11. timeout default 120_000 + 显式覆盖
 *  12. 工具 description LLM 引导文本删除 persisted_stderr_path 相关引导
 *  13. 大输出落盘（仅 stdout 单源）
 *  14. path_quoting_warnings 在所有出口透传
 *  15. instructions() 派生 + 工具偏好提示（阶段 2.3 下线，仅留占位段标记）
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  ShellCap,
  normalizeAgentStdout,
  SHELL_WAIT_MS_DEFAULT,
  SHELL_WAIT_MS_MIN,
  SHELL_WAIT_MS_MAX,
  SHELL_HARD_TIMEOUT_MS_MIN,
  SHELL_HARD_TIMEOUT_MS_MAX,
} from '../shell.js';
import type { SkillContextProvider } from '../shell.js';
import { validateToolInput } from '../../../engine/tooling/tool-schema-validator.js';
import { INVALID_PARAM_FORMAT } from '../../../engine/errors/error-kinds.js';
// ：run_terminal_command 的 LLM-facing 裁剪已从「result.llmContextContent」
// （已废弃的 summarizeToolOutput 读取路径，故此处不再 import）迁到 LLM 发送边界
// （query.ts 构造 llmRequest 时 projectMessagesForLlm → projectShellToolResultContent
// → buildShellLlmContextContent）。故 LLM 视角的 slim 投影单源在
// buildShellLlmContextContent，直接对它断言即测真实边界行为。
import { buildShellLlmContextContent } from '../../../engine/context/llm-context-projection.js';
import {
  ManagedTaskStore,
  type AgentCommandRequest,
  type AgentCommandResult,
  type AgentSpawnDetachedResult,
  type PtyManagerBridge,
  type AgentReadResult,
  type AgentReadOptions,
  type AgentKillSignal,
  type AgentSessionEventName,
  type AgentSessionEventHandler,
  type AgentSessionUnsubscribe,
} from '@tabtin/terminal-core';
import type {
  StreamEvent,
} from '../../../engine/contracts/wire-protocol.js';
import { StreamEvents } from '../../../engine/contracts/stream-events.js';
import { testHardlineChecker, allowAllHardlineChecker } from '../../../../tests/helpers/hardline-checker.js';

// ─── Bridge mock 工厂 ────────────────────────────────────────────────────

interface BridgeMockState {
  /**
   * **2026-05-18 重构兼容字段**：旧版 shell.ts 走 executeAgentCommand foreground 路径，
   * 新版统一走 spawnAgentSessionDetached + readAgentSessionOutput polling。
   * 为最小改测试，executeCalls 字段重新映射为"spawn 请求记录"
   * （行为上 spawnAgentSessionDetached 的 req 也是 AgentCommandRequest，字段一致）。
   * 新测试可直接用 spawnDetachedCalls；旧测试 executeCalls 仍能拿到 req。
   */
  executeCalls: AgentCommandRequest[];
  spawnDetachedCalls: AgentCommandRequest[];
  readCalls: Array<{ sessionId: string; sinceByteOffset?: number; sinceCursor?: number }>;
  killCalls: Array<{ sessionId: string; signal?: AgentKillSignal }>;
  bridge: PtyManagerBridge;
}

interface MockReadSnapshot {
  output?: string;
  outputBytes?: number;
  isRunning?: boolean;
  exitCode?: number | null;
  cwd?: string;
  lastOutputAt?: number;
  truncated?: boolean;
  /** RT-4 R1：模拟 bridge 返回的下次增量 cursor。 */
  nextCursor?: number;
  pid?: number;
}

function makeBridgeMock(opts?: {
  /**
   * 自定义 spawnAgentSessionDetached 返回（默认随机 sessionId + /tmp 路径）。
   */
  scriptSpawnDetached?: (req: AgentCommandRequest) => AgentSpawnDetachedResult | Promise<AgentSpawnDetachedResult>;
  /** spawnAgentSessionDetached throw（模拟 spawn 失败） */
  throwOnSpawnDetached?: () => Error;
  /**
   * 自定义 readAgentSessionOutput 返回。默认返回 isRunning=false + exitCode=0 + output='ok'
   * （模拟命令立即完成）。可自定义多次调用返回不同状态（如先 running 再 completed）。
   */
  scriptRead?: (sessionId: string, callIndex: number) => MockReadSnapshot | Promise<MockReadSnapshot>;
  /** readAgentSessionOutput throw */
  throwOnRead?: (sessionId: string) => Error;
  /**
   * 2026-05-23 push 通知重构 commit 2：可选注入 ManagedTaskStore——让 shell.ts
   * duck-type `bridge.getManagedTaskStore?.()` 能拿到真实 store，从而验证
   * dedup 路径 + sync 出口 markNotified 行为。
   *
   * 不传时 bridge 不暴露 getManagedTaskStore（跟 ShellCap 早期路径兼容），
   * shell.ts 的 store 引用会是 undefined，`store?.markNotified` 走 no-op 分支。
   */
  managedTaskStore?: ManagedTaskStore;
}): BridgeMockState {
  const executeCalls: AgentCommandRequest[] = [];
  const spawnDetachedCalls: AgentCommandRequest[] = [];
  const readCalls: Array<{ sessionId: string; sinceByteOffset?: number; sinceCursor?: number }> = [];
  const killCalls: Array<{ sessionId: string; signal?: AgentKillSignal }> = [];

  const bridge: PtyManagerBridge & { getManagedTaskStore?: () => ManagedTaskStore } = {
    async executeAgentCommand(_req: AgentCommandRequest): Promise<AgentCommandResult> {
      // 2026-05-18 重构后 shell.ts 不再调 executeAgentCommand；
      // 保留方法实现以满足 interface 契约，contract test 仍会触达。
      throw new Error('executeAgentCommand: retired by 2026-05-18 ShellCap rewrite');
    },
    async spawnAgentSessionDetached(req: AgentCommandRequest): Promise<AgentSpawnDetachedResult> {
      spawnDetachedCalls.push(req);
      executeCalls.push(req); // 兼容旧测试：req 字段语义一致
      if (opts?.throwOnSpawnDetached) throw opts.throwOnSpawnDetached();
      if (opts?.scriptSpawnDetached) return await Promise.resolve(opts.scriptSpawnDetached(req));
      const sessionId = `mock-detached-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      // 2026-05-23 push 通知重构 commit 2：如果注入了 store，自动 createRecord
      // 让 ShellCap 的 markNotified / dedup 等代码路径能找到 record。
      if (opts?.managedTaskStore) {
        opts.managedTaskStore.createRecord({
          session_id: sessionId,
          command: req.command,
          cwd: req.cwd ?? '/tmp/mock-cwd',
          env: req.env,
          spaceId: req.agentMeta.spaceId,
          // §17.6 D4：threadId 同时承担"UI 关联"+"push 路由"双重职责，
          // 取代旧 conversation_session_id 字段（已删）。
          threadId: req.agentMeta.threadId,
          toolUseId: req.agentMeta.toolUseId,
          output_file_path: `/tmp/tabtin-agent-tasks/${sessionId}.log`,
          sync_notification_claim: req.syncNotificationClaim === true,
        });
      }
      return {
        sessionId,
        outputFilePath: `/tmp/tabtin-agent-tasks/${sessionId}.log`,
      };
    },
    async readAgentSessionOutput(
      sessionId: string,
      readOpts?: AgentReadOptions,
    ): Promise<AgentReadResult> {
      readCalls.push({ sessionId, sinceByteOffset: readOpts?.sinceByteOffset, sinceCursor: readOpts?.sinceCursor });
      if (opts?.throwOnRead) throw opts.throwOnRead(sessionId);
      const snap = opts?.scriptRead
        ? await Promise.resolve(opts.scriptRead(sessionId, readCalls.length - 1))
        : {};
      // 默认：命令立即完成（exitCode=0, output='ok'）
      return {
        output: snap.output ?? 'ok',
        outputBytes: snap.outputBytes ?? 2,
        isRunning: snap.isRunning ?? false,
        exitCode: snap.exitCode ?? 0,
        cwd: snap.cwd ?? '/tmp/mock-cwd',
        lastOutputAt: snap.lastOutputAt ?? Date.now(),
        truncated: snap.truncated ?? false,
        nextCursor: snap.nextCursor,
        pid: snap.pid,
      };
    },
    async killAgentSession(sessionId: string, signal?: AgentKillSignal): Promise<void> {
      killCalls.push({ sessionId, signal });
    },
    subscribe<E extends AgentSessionEventName>(
      _event: E,
      _handler: AgentSessionEventHandler<E>,
    ): AgentSessionUnsubscribe {
      return () => {};
    },
  };

  // 2026-05-23 push 通知重构 commit 2：duck-type `getManagedTaskStore` —— shell.ts
  // 通过这个方法拿到 store 引用做 dedup / markNotified。
  if (opts?.managedTaskStore) {
    bridge.getManagedTaskStore = () => opts.managedTaskStore!;
  }

  return { executeCalls, spawnDetachedCalls, readCalls, killCalls, bridge };
}

const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

function makeFakeContext(
  overrides?: Partial<import('../../../engine/contracts/tools.js').ToolContext>,
): import('../../../engine/contracts/tools.js').ToolContext {
  return {
    threadId: 'test-thread',
    agentRunId: 'test-agent-run',
    // §17.6 D4：ToolContext.sessionId → runtimeId（runtime UUID）。
    runtimeId: 'test-runtime',
    toolUseId: 'mock-tool-use',
    //  RB2：spaceId / organizationId 已移出 ToolContext 核心契约，
    // 改由 host 装配期烘进 ShellCapInit（见 makeShellCap 的 spaceId 默认值）。
    abortSignal: new AbortController().signal,
    messages: [],
    ...overrides,
  };
}

const PROTECTED_ENV_FOR_RESULT_TESTS = {
  __TABTIN_MID: 'secret-mid-value',
  TABTIN_ZETA: 'secret-zeta-value',
  _TABTIN_ALPHA: 'secret-alpha-value',
};
const SORTED_IGNORED_KEYS = [
  'TABTIN_ZETA',
  '_TABTIN_ALPHA',
  '__TABTIN_MID',
];

function expectIgnoredKeysWarning(result: { content: unknown }): void {
  const parsed = JSON.parse(String(result.content)) as Record<string, unknown>;
  expect(parsed.ignored_keys).toEqual(SORTED_IGNORED_KEYS);
  expect(new Set(parsed.ignored_keys as string[]).size).toBe(SORTED_IGNORED_KEYS.length);
  expect(parsed.ignored_keys_warning).toEqual(expect.stringContaining('Protected env keys were ignored'));
  expect(String(parsed.ignored_keys_warning).match(/Protected env keys were ignored/g)).toHaveLength(1);
  const serialized = JSON.stringify(parsed);
  expect(serialized).not.toContain('secret-mid-value');
  expect(serialized).not.toContain('secret-zeta-value');
  expect(serialized).not.toContain('secret-alpha-value');
}

// 简化构造工具，复用 bridge mock
//  RB2：spaceId / organizationId 现为 ShellCapInit 装配期烘焙的
// per-runtime 常量（默认 'mock-space' 对齐旧 ToolContext 默认值）。需要特定
// space 的用例改在此处烘焙，而非塞进 ToolContext。
function makeShellCap(initOverrides?: {
  config?: import('../shell.js').ShellCapConfig;
  bridge?: PtyManagerBridge;
  skillContextProvider?: SkillContextProvider;
  emitStreamEvent?: (event: StreamEvent) => void;
  defaultTimeoutMs?: number;
  restrictedShellChecker?: import('../restricted-shell-allowlist.js').RestrictedShellAllowlistChecker;
  spaceId?: string;
  agentId?: string;
  organizationId?: string;
}): { cap: ShellCap; mock: BridgeMockState } {
  const mock = makeBridgeMock();
  const bridgeToUse = initOverrides?.bridge ?? mock.bridge;
  const cap = new ShellCap({
      checkHardlineCommand: testHardlineChecker,
    config: initOverrides?.config,
    ptyManagerBridge: bridgeToUse,
    skillContextProvider: initOverrides?.skillContextProvider,
    emitStreamEvent: initOverrides?.emitStreamEvent,
    defaultTimeoutMs: initOverrides?.defaultTimeoutMs,
    restrictedShellChecker: initOverrides?.restrictedShellChecker,
    spaceId:
      initOverrides && 'spaceId' in initOverrides ? initOverrides.spaceId : 'mock-space',
    agentId:
      initOverrides && 'agentId' in initOverrides ? initOverrides.agentId : 'mock-agent',
    organizationId: initOverrides?.organizationId,
  });
  return { cap, mock };
}

// ─── 1. 静态契约 ──────────────────────────────────────────────────────

describe('ShellCap 静态契约', () => {
  it('type === "shell" / category === "core"', () => {
    const { cap } = makeShellCap();
    expect(cap.type).toBe('shell');
    expect(cap.category).toBe('core');
  });

  it('required_capability_types 返回空 Set', () => {
    const { cap } = makeShellCap();
    expect(cap.required_capability_types?.()?.size).toBe(0);
  });
});

// ─── 2. ShellCapInit 构造契约 ────────────────────────────────────────

describe('ShellCap 构造契约（WP1：ptyManagerBridge 必填 + Stage 3c hardline）', () => {
  it('缺 ptyManagerBridge 同步 throw', () => {
    expect(() => new ShellCap({
      checkHardlineCommand: testHardlineChecker,} as never)).toThrow(/ptyManagerBridge is required/);
  });

  it('ptyManagerBridge === null 同步 throw', () => {
    expect(() => new ShellCap({
      checkHardlineCommand: testHardlineChecker, ptyManagerBridge: null as unknown as PtyManagerBridge })).toThrow(
      /ptyManagerBridge is required/,
    );
  });

  it('缺 checkHardlineCommand 同步 throw', () => {
    const { bridge } = makeBridgeMock();
    expect(() =>
      new ShellCap({ ptyManagerBridge: bridge } as never),
    ).toThrow(/checkHardlineCommand is required/);
  });

  it('未传 init（旧 ShellCapConfig 直传形态已退役）→ throw', () => {
    expect(() => new ShellCap(undefined as unknown as never)).toThrow(
      /requires ShellCapInit with required ptyManagerBridge/,
    );
  });
});

// ─── 3. tools() ──────────────────────────────────────────────────────

describe('ShellCap tools()', () => {
  it('返回 1 件：run_terminal_command（2026-05-23 push 通知重构 commit B：删 await/kill 工具）', () => {
    const { cap } = makeShellCap();
    const names = cap.tools().map((t) => t.name);
    expect(names).toEqual(['run_terminal_command']);
  });

  it('run_terminal_command name 合规 + isReadOnly = false', () => {
    const { cap } = makeShellCap();
    const tool = cap.tools()[0];
    expect(tool.name).toMatch(TOOL_NAME_REGEX);
    expect(tool.isReadOnly).toBe(false);
  });

  it('run_terminal_command 输入 schema 含 command (required) / description / wait_ms / hard_timeout_ms / pattern / env（cwd / timeout / run_in_background 不暴露）', () => {
    const { cap } = makeShellCap();
    const schema = cap.tools()[0].inputSchema as {
      type: string;
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties?: boolean;
    };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['command', 'description', 'wait_ms', 'hard_timeout_ms', 'pattern', 'env']),
    );
    // 2026-05-18 重构：旧 timeout / run_in_background 字段已删除
    expect(Object.keys(schema.properties)).not.toContain('cwd');
    expect(Object.keys(schema.properties)).not.toContain('timeout');
    expect(Object.keys(schema.properties)).not.toContain('run_in_background');
    expect(Object.keys(schema.properties)).not.toContain('intent');
    expect(schema.required).toEqual(['command']);
    expect(schema.required).not.toContain('description');
    expect(schema.required).not.toContain('intent');
    expect(schema.properties.description.type).toBe('string');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.wait_ms.type).toBe('integer');
    expect(schema.properties.wait_ms.minimum).toBe(SHELL_WAIT_MS_MIN);
    expect(schema.properties.wait_ms.maximum).toBe(SHELL_WAIT_MS_MAX);
    expect(schema.properties.wait_ms.default).toBe(SHELL_WAIT_MS_DEFAULT);
    expect(schema.properties.hard_timeout_ms.type).toBe('integer');
    expect(schema.properties.hard_timeout_ms.minimum).toBe(SHELL_HARD_TIMEOUT_MS_MIN);
    expect(schema.properties.hard_timeout_ms.maximum).toBe(SHELL_HARD_TIMEOUT_MS_MAX);
    expect(schema.properties.env.additionalProperties).toEqual({ type: 'string' });
  });

  it('run_terminal_command 输入 schema 拒绝范围内的小数毫秒值', () => {
    const { cap } = makeShellCap();
    const schema = cap.tools()[0].inputSchema;
    const results = [
      validateToolInput(schema, { command: 'echo', wait_ms: 1.5 }),
      validateToolInput(schema, { command: 'echo', hard_timeout_ms: 1.5 }),
    ];
    expect(results.map((result) => result.valid)).toEqual([false, false]);
  });

  it('run_terminal_command 声明 maxResultSizeChars（输出大时走 storage）', () => {
    const { cap } = makeShellCap();
    expect(cap.tools()[0].maxResultSizeChars).toBeGreaterThan(0);
  });
});

describe('ShellCap run_terminal_command description 入参', () => {
  it('description 输入参数写入 agentMeta.description，优先于 runtime intent', async () => {
    const { cap, mock } = makeShellCap();
    await cap.tools()[0].execute(
      { command: 'echo', description: '  探测 hi 命令  ' },
      makeFakeContext({
        toolCallMetadata: { intent: 'runtime intent 不应覆盖 description' },
      }),
    );
    expect(mock.executeCalls[0].agentMeta.description).toBe('探测 hi 命令');
  });

  it('空白 description 不覆盖 runtime intent', async () => {
    const { cap, mock } = makeShellCap();
    await cap.tools()[0].execute(
      { command: 'echo', description: '   ' },
      makeFakeContext({
        toolCallMetadata: { intent: '探测 hi 命令' },
      }),
    );
    expect(mock.executeCalls[0].agentMeta.description).toBe('探测 hi 命令');
  });

  it('只传 description 时写入 agentMeta.description', async () => {
    const { cap, mock } = makeShellCap();
    await cap.tools()[0].execute(
      { command: 'echo', description: '列出当前目录' },
      makeFakeContext(),
    );
    expect(mock.executeCalls[0].agentMeta.description).toBe('列出当前目录');
  });

  it('description 与 intent 都缺时 agentMeta.description 为空', async () => {
    const { cap, mock } = makeShellCap();
    await cap.tools()[0].execute({ command: 'echo' }, makeFakeContext());
    expect(mock.executeCalls[0].agentMeta.description).toBeUndefined();
  });
});

describe('ShellCap 预执行失败的保护 env 告警', () => {
  it.each([
    ['越界 wait_ms', { wait_ms: SHELL_WAIT_MS_MAX + 1 }],
    ['越界 hard_timeout_ms', { hard_timeout_ms: SHELL_HARD_TIMEOUT_MS_MAX + 1 }],
    ['非法 pattern', { pattern: '[' }],
  ])('%s 仍返回 ignored_keys 且不 spawn', async (_name, invalidInput) => {
    const { cap, mock } = makeShellCap();
    const result = await cap.tools()[0].execute(
      {
        command: 'echo hi',
        env: PROTECTED_ENV_FOR_RESULT_TESTS,
        ...invalidInput,
      },
      makeFakeContext(),
    );

    expect(result.isError).toBe(true);
    expectIgnoredKeysWarning(result);
    expect(mock.spawnDetachedCalls).toHaveLength(0);
  });
});

// ─── 3.5 threadId 硬契约 (F7 前置闸门 / 终端假运行根治) ────────────────
//
// 【2026-05-31 第三轮修复 P1-2】这条 F7 关键用例原本埋在下面那个
// `describe.skip('...foreground 路径 (deprecated by 2026-05-18 重构...)')` 块里
// 跟着整块被 skip，**永不执行**——"测试锁死 F7"是假的。F7 是「假运行根治」的前置
// 闸门（threadId 是后台命令终态投递的唯一路由键，空则 `emitPushNotificationOnExit`
// 直接 return → 终态不投 → 重载永远转圈）。该 deprecated 块里**其它**用例确实因
// 2026-05-18 重构过时（待重写），但本 F7 用例断言的 `shell.ts:1308` threadId 硬契约
// 在重构后**依然存在且生效**，故单独提出来放进这个会真正运行的 describe。
describe('ShellCap threadId 硬契约 (F7)', () => {
  it('context.threadId 缺省（undefined）时同步 throw（F7 前置闸门 / 终端假运行根治 hard contract）', async () => {
    // F7：threadId 是后台命令终态投递的唯一路由键。生产链路保证非空（host
    // query 入口拒绝空 sessionId + 子 Agent 合成 agent-${childId}），这里锁死
    // "未来 orchestration 透传断层" 不被静默吞成空串而触发假运行。
    const { cap, mock } = makeShellCap();
    await expect(
      cap.tools()[0].execute(
        { command: 'echo' },
        makeFakeContext({ threadId: undefined as unknown as string }),
      ),
    ).rejects.toThrow(/context\.threadId is missing/);
    expect(mock.executeCalls).toHaveLength(0);
    expect(mock.spawnDetachedCalls).toHaveLength(0);
  });

  it('context.threadId 为空串("")时也同步 throw（PRD 强调的"被静默吞成空串"断层）', async () => {
    // 生产闸门是 `if (!context.threadId)`（shell.ts:1308），undefined 与 '' 都拦。
    // PRD §0.5/§5 反复强调的真实断层是"透传断层被静默吞成空串"——故空串这条比
    // undefined 更贴近现实，单独锁死（三视角 review P3 补全）。
    const { cap, mock } = makeShellCap();
    await expect(
      cap.tools()[0].execute(
        { command: 'echo' },
        makeFakeContext({ threadId: '' }),
      ),
    ).rejects.toThrow(/context\.threadId is missing/);
    expect(mock.executeCalls).toHaveLength(0);
    expect(mock.spawnDetachedCalls).toHaveLength(0);
  });
});

// ─── 3.6 spaceId 硬契约 (终端假运行根治 Wave 1 尾巴：从 deprecated skip 块救出) ──
//
// 【 RB2 更新】spaceId 由 host 装配期烘进 `ShellCapInit`（per-runtime
// 常量），不再从运行时 `ToolContext` 读。硬契约源随之从
// `if (!context.spaceId) throw` 迁到 `requireShellContext` 的
// `if (!spaceId) throwMissingSpaceId()`（shell.ts:1194）——烘焙缺失（未烘 /
// 烘成空串）即撞硬契约 throw，语义与旧 `context.spaceId` 缺失完全一致（都会导致
// session 落 `_unscoped/` + agentMeta 硬契约违约）。故此处从「context.spaceId 缺省」
// 改为「烘焙 spaceId 缺省」，用 makeShellCap({ spaceId }) 构造未烘 / 空串烘焙。
describe('ShellCap spaceId 硬契约', () => {
  it('烘焙 spaceId 缺省（undefined）时同步 throw（与 toolUseId / threadId 同款 hard contract）', async () => {
    const { cap, mock } = makeShellCap({ spaceId: undefined });
    await expect(
      cap.tools()[0].execute(
        { command: 'echo' },
        makeFakeContext(),
      ),
    ).rejects.toThrow(/baked spaceId is missing/);
    expect(mock.executeCalls).toHaveLength(0);
    expect(mock.spawnDetachedCalls).toHaveLength(0);
  });

  it('烘焙 spaceId 为空串("")时也同步 throw（与 threadId 同款"被静默吞成空串"断层）', async () => {
    // 生产闸门是 `if (!spaceId)`（shell.ts:1194），undefined 与 '' 都拦。
    // 真实断层是"host 装配透传断层被静默吞成空串"→ 烘焙 spaceId='' → session 落
    // `_unscoped/` + agentMeta 硬契约 throw，故空串这条比 undefined 更贴近现实。
    const { cap, mock } = makeShellCap({ spaceId: '' });
    await expect(
      cap.tools()[0].execute(
        { command: 'echo' },
        makeFakeContext(),
      ),
    ).rejects.toThrow(/baked spaceId is missing/);
    expect(mock.executeCalls).toHaveLength(0);
    expect(mock.spawnDetachedCalls).toHaveLength(0);
  });
});

describe('ShellCap 真实 Agent 身份注入', () => {
  it('分别写入 agentMeta.agentId 与 TABTIN_AGENT_ID，不复用 Workspace ID', async () => {
    const { cap, mock } = makeShellCap({
      spaceId: 'workspace-1',
      organizationId: 'organization-1',
      agentId: 'agent-1',
    });

    await cap.tools()[0].execute({ command: 'echo identity' }, makeFakeContext());

    expect(mock.executeCalls).toHaveLength(1);
    expect(mock.executeCalls[0].agentMeta).toMatchObject({
      spaceId: 'workspace-1',
      agentId: 'agent-1',
    });
    expect(mock.executeCalls[0].env).toMatchObject({
      TABTIN_SPACE_ID: 'workspace-1',
      TABTIN_AGENT_ID: 'agent-1',
      TABTIN_ORGANIZATION_ID: 'organization-1',
    });
  });

  it('子 Agent 后台命令：agentMeta.threadId 跟父对话，notificationThreadId 用 childId', async () => {
    const { cap, mock } = makeShellCap({ spaceId: 'space-001', agentId: 'agent-001' });
    await cap.tools()[0].execute(
      { command: 'echo hi' },
      makeFakeContext({
        toolUseId: 'tool-use-child',
        threadId: 'parent-thread',
        assistantSubagentRunId: 'child-run-id',
        workspaceRoot: '/tmp/proj',
      }),
    );

    const req = mock.executeCalls[0];
    expect(req.agentMeta.threadId).toBe('parent-thread');
    expect(req.agentMeta.notificationThreadId).toBe('child-run-id');
    expect(req.env).toMatchObject({ TABTIN_THREAD_ID: 'parent-thread' });
  });

  it('优先使用 ToolContext.notificationThreadId', async () => {
    const { cap, mock } = makeShellCap({ spaceId: 'space-001', agentId: 'agent-001' });
    await cap.tools()[0].execute(
      { command: 'echo hi' },
      makeFakeContext({
        toolUseId: 'tool-use-assembled',
        threadId: 'parent-thread',
        assistantSubagentRunId: 'other-child',
        notificationThreadId: 'assembled-child',
        workspaceRoot: '/tmp/proj',
      }),
    );

    expect(mock.executeCalls[0].agentMeta.notificationThreadId).toBe('assembled-child');
  });

  it('主 Agent 后台命令：notificationThreadId 与 threadId 相同', async () => {
    const { cap, mock } = makeShellCap({ spaceId: 'space-001', agentId: 'agent-001' });
    await cap.tools()[0].execute(
      { command: 'echo hi' },
      makeFakeContext({
        toolUseId: 'tool-use-main',
        threadId: 'parent-thread',
        workspaceRoot: '/tmp/proj',
      }),
    );

    const req = mock.executeCalls[0];
    expect(req.agentMeta.threadId).toBe('parent-thread');
    expect(req.agentMeta.notificationThreadId).toBe('parent-thread');
  });
});

// ─── 4. handler foreground 调 bridge.executeAgentCommand ──────────────

describe.skip('ShellCap run_terminal_command foreground 路径 (deprecated by 2026-05-18 重构，待 P1-8 重写)', () => {
  it('调 bridge.executeAgentCommand 透传 command + timeout + env + cwd', async () => {
    const { cap, mock } = makeShellCap();
    await cap.tools()[0].execute(
      { command: 'ls -la', timeout: 5000, env: { FOO: 'bar' } },
      makeFakeContext({ workspaceRoot: '/tmp/proj' }),
    );

    expect(mock.executeCalls).toHaveLength(1);
    const req = mock.executeCalls[0];
    expect(req.command).toBe('ls -la');
    expect(req.cwd).toBe('/tmp/proj');
    expect(req.timeoutMs).toBe(5000);
    // §17.6 D4.b：env 含用户传的 FOO + TABTIN_WORKSPACE + TABTIN_THREAD_ID（值取
    // context.threadId）。原 TABTIN_SESSION_ID 已改名为 TABTIN_THREAD_ID。
    expect(req.env).toMatchObject({
      FOO: 'bar',
      TABTIN_WORKSPACE: '/tmp/proj',
      TABTIN_THREAD_ID: 'test-thread',
    });
  });

  it('agentMeta 字段全填（toolUseId / spaceId / agentId / threadId / originatedBy），description 来自 runtime intent', async () => {
    const { cap, mock } = makeShellCap({ spaceId: 'space-001', agentId: 'agent-001' });
    await cap.tools()[0].execute(
      { command: 'echo hi' },
      makeFakeContext({
        toolUseId: 'tool-use-xyz',
        threadId: 'thread-abc',
        workspaceRoot: '/tmp/proj',
        toolCallMetadata: { intent: '探测 hi 命令' },
      }),
    );

    const req = mock.executeCalls[0];
    expect(req.agentMeta.toolUseId).toBe('tool-use-xyz');
    expect(req.agentMeta.spaceId).toBe('space-001');
    // ：agentId 与 spaceId 独立烘焙，不再复用 spaceId
    expect(req.agentMeta.agentId).toBe('agent-001');
    expect(req.agentMeta.threadId).toBe('thread-abc');
    expect(req.agentMeta.description).toBe('探测 hi 命令');
    expect(req.agentMeta.originatedBy).toBe('local-llm-shellcap');
  });

  // 注：原 `context.spaceId 缺省时同步 throw` 用例已于 2026-05-31 Wave 1 尾巴
  // 救出到上方会真正运行的 `describe('ShellCap spaceId 硬契约')`（shell.ts:1273
  // 硬契约在重构后依然生效，不应随本 deprecated 块被 skip）。

  it('agentMeta.agentId 使用烘焙的真实 Agent id', async () => {
    const { cap, mock } = makeShellCap({ spaceId: 'space-xyz', agentId: 'agent-xyz' });
    await cap.tools()[0].execute(
      { command: 'echo' },
      makeFakeContext(),
    );
    expect(mock.executeCalls[0].agentMeta.spaceId).toBe('space-xyz');
    expect(mock.executeCalls[0].agentMeta.agentId).toBe('agent-xyz');
  });

  it('description 输入参数写入 agentMeta.description，优先于 runtime intent', async () => {
    const { cap, mock } = makeShellCap();
    await cap.tools()[0].execute(
      { command: 'echo', description: '  探测 hi 命令  ' },
      makeFakeContext({
        toolCallMetadata: { intent: 'runtime intent 不应覆盖 description' },
      }),
    );
    expect(mock.executeCalls[0].agentMeta.description).toBe('探测 hi 命令');
  });

  it('空白 description 不覆盖 runtime intent', async () => {
    const { cap, mock } = makeShellCap();
    await cap.tools()[0].execute(
      { command: 'echo', description: '   ' },
      makeFakeContext({
        toolCallMetadata: { intent: '探测 hi 命令' },
      }),
    );
    expect(mock.executeCalls[0].agentMeta.description).toBe('探测 hi 命令');
  });

  it('未显式传 timeout 时使用默认 120_000ms（DEFAULT_AGENT_COMMAND_TIMEOUT_MS）', async () => {
    const { cap, mock } = makeShellCap();
    await cap.tools()[0].execute({ command: 'ls' }, makeFakeContext());
    expect(mock.executeCalls[0].timeoutMs).toBe(120_000);
  });

  it('ShellCapInit.defaultTimeoutMs 覆盖默认值', async () => {
    const { cap, mock } = makeShellCap({ defaultTimeoutMs: 60_000 });
    await cap.tools()[0].execute({ command: 'ls' }, makeFakeContext());
    expect(mock.executeCalls[0].timeoutMs).toBe(60_000);
  });

  it('envelope 字段完整：success / exitCode / durationMs / stdout / stderr (空) / agent_session_id', async () => {
    const { cap } = makeShellCap();
    const r = await cap.tools()[0].execute({ command: 'echo hi' }, makeFakeContext());
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe("completed");
    expect(parsed.exit_code).toBe(0);
    expect(parsed.durationMs).toBe(12);
    expect(parsed.stdout).toBe('ok');
    expect(parsed.stderr).toBe('');
    expect(typeof parsed.agent_session_id).toBe('string');
    expect(parsed.truncated).toBe(false);
    expect(r.isError).toBeUndefined();
  });

  it('envelope 已删除 pid / persisted_stderr_path / persisted_stderr_size 字段', async () => {
    const big = 'X'.repeat(80 * 1024); // 触发 stdout 落盘
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'ok',
          exitCode: 0,
          stdout: big,
          stderr: '',
          durationMs: 1,
          truncated: false,
          outputBytes: big.length,
          cwd: '/tmp',
          sessionId: 'mock-session-rm-stderr-fields',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'cat /big' },
      makeFakeContext({ sessionId: 'persist-no-stderr' }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.persisted_output_path).toBeDefined();
    expect('pid' in parsed).toBe(false);
    expect('persisted_stderr_path' in parsed).toBe(false);
    expect('persisted_stderr_size' in parsed).toBe(false);
  });

  it('exitCode != 0 时 success = false 但 isError 不置（命令失败 ≠ 系统错）', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'ok',
          exitCode: 1,
          stdout: '',
          stderr: '',
          durationMs: 5,
          truncated: false,
          outputBytes: 0,
          cwd: '/tmp',
          sessionId: 'mock-exit-1',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'grep foo /no/match' },
      makeFakeContext(),
    );
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content as string);
    expect(parsed.success).toBe(false);
    expect(parsed.exit_code).toBe(1);
  });

  it('truncated = true 透传', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'ok',
          exitCode: 0,
          stdout: 'a',
          stderr: '',
          durationMs: 1,
          truncated: true,
          outputBytes: 9999,
          cwd: '/tmp',
          sessionId: 'mock-truncated',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute({ command: 'cat /huge' }, makeFakeContext());
    const parsed = JSON.parse(r.content as string);
    expect(parsed.truncated).toBe(true);
  });

  it('degraded = true / degradedReason 透传', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'ok',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          durationMs: 1,
          truncated: false,
          outputBytes: 2,
          cwd: '/tmp',
          sessionId: 'mock-degraded',
          degraded: true,
          degradedReason: 'sandbox-not-supported-by-pty',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute({ command: 'echo' }, makeFakeContext());
    const parsed = JSON.parse(r.content as string);
    expect(parsed.degraded).toBe(true);
    expect(parsed.degraded_reason).toBe('sandbox-not-supported-by-pty');
  });

  it('status = "timeout" → isError + REQUEST_TIMEOUT + hint 引导 wait_ms:0 + 不含废弃参数名', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'timeout',
          exitCode: null,
          stdout: 'partial output',
          stderr: '',
          durationMs: 120_000,
          truncated: false,
          outputBytes: 14,
          cwd: '/tmp',
          sessionId: 'mock-timeout-sess',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'pnpm build', timeout: 1000 },
      makeFakeContext(),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error_kind).toBe('request_timeout');
    expect(parsed.timeout_ms).toBe(1000);
    expect(parsed.agent_session_id).toBe('mock-timeout-sess');
    expect(parsed.backgrounded_reason).toBeUndefined();
    // 2026-05-21 review 第三轮反向断言：hint 必须引导现行 wait_ms 路径，
    // 绝不能引用 2026-05-18 重构前的 run_in_background / background_task_id。
    expect(parsed.hint).toMatch(/wait_ms/);
    expect(parsed.hint).not.toMatch(/run_in_background/);
    expect(parsed.hint).not.toMatch(/background_task_id/);
    // **WP1 R1 用户视角 P1-4 加固**：stdout < 64KB（无 persisted_output_path）→
    // hint 引导读 `stdout` 字段而不是误导 LLM 调 read_file(undefined)
    expect(parsed.persisted_output_path).toBeUndefined();
    expect(parsed.hint).toMatch(/in the `stdout` field/);
    expect(parsed.error).toMatch(/shell process was terminated/);
  });

  it('status = "timeout" + 大输出 → hint 引导用 read_file 读 persisted_output_path', async () => {
    const big = 'X'.repeat(80 * 1024);
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'timeout',
          exitCode: null,
          stdout: big,
          stderr: '',
          durationMs: 120_000,
          truncated: false,
          outputBytes: big.length,
          cwd: '/tmp',
          sessionId: 'mock-timeout-big',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'pnpm test' },
      makeFakeContext({ sessionId: 'timeout-big' }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.persisted_output_path).toBeDefined();
    // 大输出落盘后 hint 引导 read_file 读 persisted_output_path
    expect(parsed.hint).toMatch(/persisted_output_path/);
    expect(parsed.hint).toMatch(/read_file/);
  });

  it('status = "error" + abortSignal **未** aborted → 执行层主动 kill 分支（abort_reason undefined + 通用 hint）', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'error',
          exitCode: null,
          stdout: 'partial output before kill',
          stderr: '',
          durationMs: 5_000,
          truncated: false,
          outputBytes: 26,
          cwd: '/tmp',
          sessionId: 'mock-killed-sess',
        }),
      }).bridge,
    });
    // abortSignal **未** aborted → bridge 主动 kill 路径（如 per-Space session
    // limit / cleanup），abort_reason 字段不出现，hint 引导可重试
    const r = await cap.tools()[0].execute(
      { command: 'long-running' },
      makeFakeContext(),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error_kind).toBe('request_timeout');
    expect(parsed.agent_session_id).toBe('mock-killed-sess');
    expect(parsed.stdout).toContain('partial output before kill');
    // WP4：abort_reason undefined → 通用执行层主动 kill hint
    expect(parsed.abort_reason).toBeUndefined();
    expect(parsed.hint).toMatch(/shell process layer/i);
    expect(parsed.hint).toMatch(/not\W+a user intent signal/i);
  });

  it('status = "error" + abortSignal **已** aborted（默认 reason）→ abort_reason = user_interrupt + Do not auto-retry hint', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'error',
          exitCode: null,
          stdout: 'partial output before user kill',
          stderr: '',
          durationMs: 3_000,
          truncated: false,
          outputBytes: 32,
          cwd: '/tmp',
          sessionId: 'mock-user-killed-sess',
        }),
      }).bridge,
    });
    const ac = new AbortController();
    ac.abort(); // 用户主动 abort
    const r = await cap.tools()[0].execute(
      { command: 'long-running' },
      makeFakeContext({ abortSignal: ac.signal }),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.error_kind).toBe('request_timeout');
    expect(parsed.abort_reason).toBe('user_interrupt');
    expect(parsed.hint).toMatch(/Do not auto-retry/i);
    expect(parsed.hint).toMatch(/user wanted to stop/i);
  });

  it('status = "error" + abortSignal.reason 带 tool_call_cancelled 标记 → abort_reason = tool_call_cancelled', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'error',
          exitCode: null,
          stdout: '',
          stderr: '',
          durationMs: 100,
          truncated: false,
          outputBytes: 0,
          cwd: '/tmp',
          sessionId: 'mock-cancel-sess',
        }),
      }).bridge,
    });
    const ac = new AbortController();
    ac.abort({ type: 'tool_call_cancelled', batchId: 'batch-7' });
    const r = await cap.tools()[0].execute(
      { command: 'sibling-cancelled' },
      makeFakeContext({ abortSignal: ac.signal }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.abort_reason).toBe('tool_call_cancelled');
    expect(parsed.hint).toMatch(/sibling tool/i);
    expect(parsed.hint).toMatch(/orchestration layer/i);
  });

  it('bridge.executeAgentCommand 抛 AbortError name → REQUEST_TIMEOUT envelope + hint 引导现行 wait_ms', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        throwOnExecute: () => {
          const e = new Error('connection severed');
          e.name = 'AbortError';
          return e;
        },
      }).bridge,
    });
    const r = await cap.tools()[0].execute({ command: 'long' }, makeFakeContext());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.error_kind).toBe('request_timeout');
    // 2026-05-21 review 第三轮反向断言：hint 必须引用现行 wait_ms 路径。
    expect(parsed.hint).toMatch(/wait_ms/);
    expect(parsed.hint).not.toMatch(/run_in_background/);
    expect(parsed.hint).not.toMatch(/background_task_id/);
  });

  it('bridge.executeAgentCommand 抛 ABORT_ERR code → REQUEST_TIMEOUT envelope', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        throwOnExecute: () => {
          const e = new Error('signal aborted') as Error & { code?: string };
          e.code = 'ABORT_ERR';
          return e;
        },
      }).bridge,
    });
    const r = await cap.tools()[0].execute({ command: 'long' }, makeFakeContext());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.error_kind).toBe('request_timeout');
  });

  it('bridge.executeAgentCommand 抛非 abort error（即便 message 含 "aborted"）→ INTERNAL_ERROR（不再 regex 误匹配）', async () => {
    // **WP1 R1 用户视角 P1-6 加固**：bridge 实现层若 throw 含 "aborted" 子串
    // 但不是真 abort 的错误（如 PTY 连接 "aborted by remote"），原 regex 匹配
    // 会误识别为 user abort → 错的 REQUEST_TIMEOUT hint。新逻辑只看
    // AbortError name / ABORT_ERR code，不再做 text 匹配。
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        throwOnExecute: () => new Error('PTY connection aborted by remote host'),
      }).bridge,
    });
    const r = await cap.tools()[0].execute({ command: 'ls' }, makeFakeContext());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.error_kind).toBe('internal_error');
    expect(parsed.error).toMatch(/aborted by remote host/);
    // 不能走 REQUEST_TIMEOUT 路径（之前会误识别）
    // 2026-05-21 review 第三轮反向断言：REQUEST_TIMEOUT hint 已迁移到 wait_ms，
    // 这里也要确保走的是 INTERNAL_ERROR 路径而非误打误撞含废弃术语。
    expect(parsed.hint).not.toMatch(/wait_ms/);
    expect(parsed.hint).not.toMatch(/run_in_background/);
    expect(parsed.hint).not.toMatch(/background_task_id/);
  });

  it('bridge.executeAgentCommand 抛非 AbortError → INTERNAL_ERROR envelope', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        throwOnExecute: () => new Error('per-Space session limit reached'),
      }).bridge,
    });
    const r = await cap.tools()[0].execute({ command: 'ls' }, makeFakeContext());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.error_kind).toBe('internal_error');
    expect(parsed.error).toMatch(/session limit/);
    expect(parsed.hint).toMatch(/PtyManager not initialized|session limit reached|node-pty/);
  });
});

// ─── 5. toolUseId 硬契约 ────────────────────────────────────────────

describe('ShellCap toolUseId 硬契约（WP1 hard contract）', () => {
  it('context.toolUseId === undefined → 同步 throw（不降级 fallback）', async () => {
    const { cap } = makeShellCap();
    await expect(
      cap.tools()[0].execute(
        { command: 'ls' },
        makeFakeContext({ toolUseId: undefined }),
      ),
    ).rejects.toThrow(/context\.toolUseId is missing/);
  });
});

// ─── 6. 入参校验 ─────────────────────────────────────────────────────

describe('ShellCap 入参校验', () => {
  it('空 command 拒绝', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute({ command: '   ' }, makeFakeContext());
    expect(r.isError).toBe(true);
    expect(mock.executeCalls).toHaveLength(0);
  });

  it('非字符串 command 拒绝', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute({ command: 123 }, makeFakeContext());
    expect(r.isError).toBe(true);
    expect(mock.executeCalls).toHaveLength(0);
  });

  it('env 中非字符串值 → INVALID_PARAM_FORMAT 且不 spawn', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'echo', env: { GOOD: 'yes', BAD_NUM: 42 } },
      makeFakeContext(),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.error_kind).toBe(INVALID_PARAM_FORMAT);
    expect(parsed.error).toMatch(/env\.BAD_NUM/);
    expect(String(parsed.error)).not.toContain('42');
    expect(mock.executeCalls).toHaveLength(0);
  });

  it('env 非 object → INVALID_PARAM_FORMAT 且不 spawn', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'echo', env: 'FOO=bar' },
      makeFakeContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content as string).error_kind).toBe(INVALID_PARAM_FORMAT);
    expect(mock.executeCalls).toHaveLength(0);
  });

  it('LLM 传 TABTIN_* / _TABTIN_* / __TABTIN_* env 被过滤（平台契约不可污染）', async () => {
    const { cap, mock } = makeShellCap({ spaceId: 'real-space', agentId: 'real-agent' });
    const r = await cap.tools()[0].execute(
      {
        command: 'echo',
        env: {
          TABTIN_WORKSPACE: '/evil/path',
          // §17.6 D4.b：LLM 仍可能传旧字段名（实际生产路径不该出现，但测试
          // 校验"任何 TABTIN_* 都该被过滤"）。
          TABTIN_THREAD_ID: 'fake-thread',
          TABTIN_AGENT_RUN_ID: 'fake-run',
          TABTIN_AGENT_ID: 'fake-agent',
          TABTIN_SPACE_ID: 'fake-space',
          TABTIN_CUSTOM: 'llm-attempt',
          _TABTIN_TRANSPORT_TOKEN: 'fake-token',
          __TABTIN_SKILL_CREDENTIAL_PRESERVE_KEYS__: 'OPENAI_API_KEY',
          LEGITIMATE: 'ok',
        },
      },
      makeFakeContext({ workspaceRoot: '/real/workspace' }),
    );
    const env = mock.executeCalls[0].env ?? {};
    expect(env.TABTIN_WORKSPACE).toBe('/real/workspace');
    // §17.6 D4.b：TABTIN_SESSION_ID → TABTIN_THREAD_ID。
    expect(env.TABTIN_THREAD_ID).toBe('test-thread');
    expect(env.TABTIN_AGENT_RUN_ID).toBe('test-agent-run');
    expect(env.TABTIN_AGENT_ID).toBe('real-agent');
    expect(env.TABTIN_SPACE_ID).toBe('real-space');
    expect(env.TABTIN_CUSTOM).toBeUndefined();
    expect(env._TABTIN_TRANSPORT_TOKEN).toBeUndefined();
    expect(env.__TABTIN_SKILL_CREDENTIAL_PRESERVE_KEYS__).toBeUndefined();
    expect(env.LEGITIMATE).toBe('ok');
    const parsed = JSON.parse(r.content as string) as Record<string, unknown>;
    expect(parsed.ignored_keys).toEqual([
      'TABTIN_AGENT_RUN_ID',
      'TABTIN_AGENT_ID',
      'TABTIN_CUSTOM',
      'TABTIN_SPACE_ID',
      'TABTIN_THREAD_ID',
      'TABTIN_WORKSPACE',
      '_TABTIN_TRANSPORT_TOKEN',
      '__TABTIN_SKILL_CREDENTIAL_PRESERVE_KEYS__',
    ]);
    expect(String(parsed.ignored_keys_warning)).toContain('TABTIN_WORKSPACE');
    expect(String(parsed.ignored_keys_warning).match(/Protected env keys were ignored/g)).toHaveLength(1);
    // 不得泄漏受保护键的 value
    expect(JSON.stringify(parsed)).not.toContain('/evil/path');
    expect(JSON.stringify(parsed)).not.toContain('fake-token');
    expect(JSON.stringify(parsed)).not.toContain('OPENAI_API_KEY');
    expect(mock.executeCalls[0].agentMeta.agentId).toBe('real-agent');
  });
});

// ─── 7. instructions ────────────────────────────────────────────────
// 阶段 2.3（2026-05-20）：`Capability.instructions?()` 接口下线，
// ShellCap.instructions() + 配套测试整体删除。配置（terminal_mode /
// operation_switches / high_risk_requires_approval）依然由 ShellCap 持有，
// 仅消费方从"LLM 提示"改为"W3 HITL Pipeline 决策"。

// ─── 8. hardline 硬拒绝 ──────────────────────────────────────────────

describe('ShellCap hardline 硬拒绝', () => {
  it('hardline 命中 → JSON envelope + 不调 bridge', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'rm -rf /', env: PROTECTED_ENV_FOR_RESULT_TESTS },
      makeFakeContext(),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.success).toBe(false);
    expect(parsed.blocked_by).toBe('security_policy_hardline');
    expect(parsed.error).toContain('blocked by security policy');
    expectIgnoredKeysWarning(r);
    expect(mock.executeCalls).toHaveLength(0);
  });
});

// ─── 9. sleep 命令直接放行（PRD §7.1：sleep 拦截规则已删） ──────────

describe('ShellCap sleep 命令直接放行（push 通知重构 commit B）', () => {
  it('bare `sleep 5` 直接走 spawn 路径，不再被拦截', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute({ command: 'sleep 5' }, makeFakeContext());
    expect(r.isError).toBeFalsy();
    expect(mock.spawnDetachedCalls).toHaveLength(1);
  });

  it('`sleep 10 && curl ...` 直接走 spawn 路径', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'sleep 10 && curl localhost:3000' },
      makeFakeContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(mock.spawnDetachedCalls).toHaveLength(1);
  });

  it('`sleep 1` (sub-2s) 同样走 spawn 路径', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute({ command: 'sleep 1' }, makeFakeContext());
    expect(r.isError).toBeFalsy();
    expect(mock.spawnDetachedCalls).toHaveLength(1);
  });

  it('循环内 sleep 走 spawn 路径', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'for i in 1 2; do sleep 1; done' },
      makeFakeContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(mock.spawnDetachedCalls).toHaveLength(1);
  });

  it('wait_ms=0 时 sleep 5 走背景化路径', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'sleep 5', wait_ms: 0, env: PROTECTED_ENV_FOR_RESULT_TESTS },
      makeFakeContext({ workspaceRoot: '/tmp' }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expectIgnoredKeysWarning(r);
    expect(mock.spawnDetachedCalls).toHaveLength(1);
  });
});

// ─── 10. restrictedShellChecker 受限模式 ─────────────────────────────

describe('ShellCap restrictedShellChecker（L16 W5.5）', () => {
  it('checker 放行 → 正常调 bridge', async () => {
    const { cap, mock } = makeShellCap({
      restrictedShellChecker: { async isAllowed() { return { allowed: true }; } },
    });
    const r = await cap.tools()[0].execute(
      { command: 'tabtin doc list --format json' },
      makeFakeContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(mock.executeCalls).toHaveLength(1);
  });

  it('checker 拒绝（write_risk）→ jsonError + 不调 bridge', async () => {
    const { cap, mock } = makeShellCap({
      restrictedShellChecker: {
        async isAllowed() {
          return { allowed: false, reason: '命令 tabtin doc create 标记为 write', code: 'write_risk' };
        },
      },
    });
    const r = await cap.tools()[0].execute(
      { command: 'tabtin doc create --title hi' },
      makeFakeContext(),
    );
    expect(mock.executeCalls).toHaveLength(0);
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.error_kind).toBe('mode_restricted');
    expect(parsed.blocked_by).toBe('restricted_shell_allowlist');
    expect(parsed.validator_code).toBe('write_risk');
    expect(parsed.hint).toMatch(/Agent mode/);
  });

  it('checker 拒绝（system_command_rejected）→ hint 引导 adjust flag', async () => {
    const { cap } = makeShellCap({
      restrictedShellChecker: {
        async isAllowed() {
          return { allowed: false, reason: '系统命令 allowlist 拒绝', code: 'system_command_rejected' };
        },
      },
    });
    const r = await cap.tools()[0].execute(
      { command: 'git log --output=/tmp/x' },
      makeFakeContext(),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.validator_code).toBe('system_command_rejected');
    expect(parsed.hint).toMatch(/safeFlags/);
    expect(parsed.hint).toMatch(/adjust|adjusting|removing/i);
  });
});

// ─── 11. Skill 凭据注入（W2.3 P0-1）──────────────────────────────────

describe('ShellCap Skill 凭据注入', () => {
  //  RB2：spaceId 已从 ToolContext.skillContext 移出，改由 host 烘进
  // ShellCapInit（makeShellCap 默认 'mock-space'）。凭据解析用烘焙 spaceId，故
  // skillContext 只保留 skillKey / primaryEnv。
  function makeSkillContext(): import('../../../engine/contracts/tools.js').ToolContext {
    return makeFakeContext({
      skillContext: {
        skillKey: 'github/star-watcher',
        primaryEnv: 'GITHUB_TOKEN',
      },
    });
  }

  it('provider 返回 env → bridge.env 含 skill 凭据（同名 skill 优先）', async () => {
    const provider: SkillContextProvider = {
      async resolveCredentials() {
        return {
          env: { GITHUB_TOKEN: 'ghp_secret_xyz', SHARED: 'from-skill' },
          serviceName: 'github',
          credentialId: 'cred-001',
        };
      },
    };
    const { cap, mock } = makeShellCap({ skillContextProvider: provider });
    await cap.tools()[0].execute(
      { command: 'curl https://api.github.com/user', env: { SHARED: 'from-user', UA: 'tabtin' } },
      makeSkillContext(),
    );
    const env = mock.executeCalls[0].env ?? {};
    expect(env.GITHUB_TOKEN).toBe('ghp_secret_xyz');
    expect(env.SHARED).toBe('from-skill');
    expect(env.UA).toBe('tabtin');
  });

  it('provider 返回 null → 不注入 env + emit SYSTEM_NOTICE', async () => {
    const events: StreamEvent[] = [];
    const provider: SkillContextProvider = { async resolveCredentials() { return null; } };
    const { cap, mock } = makeShellCap({
      skillContextProvider: provider,
      emitStreamEvent: (e) => events.push(e),
    });
    await cap.tools()[0].execute({ command: 'echo hi' }, makeSkillContext());
    expect(mock.executeCalls).toHaveLength(1);
    const notice = events.find((e) => e.type === StreamEvents.SYSTEM_NOTICE);
    expect((notice?.payload as { notice_type?: string })?.notice_type).toBe('skill_credential_unavailable');
  });

  it('缺 agentId 时不调 reveal、不阻塞 shell，发 unavailable notice', async () => {
    const events: StreamEvent[] = [];
    const resolver = vi.fn(async () => ({
      env: { GITHUB_TOKEN: 'should-not-inject' },
      serviceName: 'github',
      credentialId: 'cred-x',
    }));
    const { cap, mock } = makeShellCap({
      agentId: '',
      skillContextProvider: { resolveCredentials: resolver },
      emitStreamEvent: (e) => events.push(e),
    });
    await cap.tools()[0].execute({ command: 'echo hi' }, makeSkillContext());
    expect(resolver).not.toHaveBeenCalled();
    expect(mock.executeCalls).toHaveLength(1);
    expect(mock.executeCalls[0].env).not.toHaveProperty('GITHUB_TOKEN');
    expect(mock.executeCalls[0].agentMeta.agentId).toBe('');
    const notice = events.find((e) => e.type === StreamEvents.SYSTEM_NOTICE);
    expect((notice?.payload as { notice_type?: string })?.notice_type).toBe('skill_credential_unavailable');
  });

  it('provider 抛错 → 不阻塞主流程，发 SYSTEM_NOTICE', async () => {
    const events: StreamEvent[] = [];
    const provider: SkillContextProvider = {
      async resolveCredentials() { throw new Error('IPC failed'); },
    };
    const { cap, mock } = makeShellCap({
      skillContextProvider: provider,
      emitStreamEvent: (e) => events.push(e),
    });
    await cap.tools()[0].execute({ command: 'echo hi' }, makeSkillContext());
    expect(mock.executeCalls).toHaveLength(1);
    const notice = events.find((e) => e.type === StreamEvents.SYSTEM_NOTICE);
    expect((notice?.payload as { notice_type?: string })?.notice_type).toBe('skill_credential_unavailable');
  });

  it('provider 注入但带 warnings → emit warning notice', async () => {
    const events: StreamEvent[] = [];
    const provider: SkillContextProvider = {
      async resolveCredentials() {
        return {
          env: { OPENAI_API_KEY: 'sk-xxx' },
          warnings: ['primary_env_ignored_for_mapped_service'],
        };
      },
    };
    const { cap } = makeShellCap({
      skillContextProvider: provider,
      emitStreamEvent: (e) => events.push(e),
    });
    await cap.tools()[0].execute({ command: 'echo' }, makeSkillContext());
    const notice = events.find(
      (e) =>
        e.type === StreamEvents.SYSTEM_NOTICE &&
        (e.payload as { notice_type?: string }).notice_type === 'skill_credential_warning',
    );
    expect(notice).toBeDefined();
  });
});

// ─── 12. background 路径 ─────────────────────────────────────────────

describe.skip('ShellCap run_in_background 路径 (deprecated by 2026-05-18 重构，wait_ms 替代，待 P1-8 重写)', () => {
  it('走 bridge.spawnAgentSessionDetached + envelope 含 background_task_id / output_file', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'pnpm dev', run_in_background: true },
      makeFakeContext({ workspaceRoot: '/tmp/proj' }),
    );
    expect(mock.spawnDetachedCalls).toHaveLength(1);
    expect(mock.executeCalls).toHaveLength(0);
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe("completed");
    expect(parsed.background).toBe(true);
    expect(typeof parsed.background_task_id).toBe('string');
    expect(typeof parsed.output_file).toBe('string');
    expect(parsed.output_file).toMatch(/tabtin-agent-tasks/);
    expect(parsed.output_file).toMatch(/\.log$/);
    expect(parsed.stdout).toMatch(/Background task started/);
    expect(parsed.stdout).toContain(parsed.background_task_id);
    expect(parsed.stdout).toContain(parsed.output_file);
    expect(parsed.stdout).toMatch(/read_file/);
    expect(parsed.stdout).toMatch(/Do NOT re-invoke/);
    // 2026-05-23：Agent tab 是 transcript；LLM 想停掉用 `run_terminal_command kill <pid>`；
    // 用户侧兜底是关闭 transcript tab，不再引导 Ctrl+C 接管。
    expect(parsed.stdout).toMatch(/close the Agent transcript tab/);
    expect(parsed.stdout).not.toMatch(/Ctrl\+C/);
    expect(parsed.stdout).toMatch(/ask_user/);
    expect(parsed.hint).toBe(parsed.stdout);
  });

  it('background envelope 无 pid 字段（PTY 化后已删除）', async () => {
    const { cap } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'true', run_in_background: true },
      makeFakeContext({ workspaceRoot: '/tmp' }),
    );
    const parsed = JSON.parse(r.content as string);
    expect('pid' in parsed).toBe(false);
  });

  it('bridge.spawnAgentSessionDetached 抛错 → INTERNAL_ERROR envelope', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        throwOnSpawnDetached: () => new Error('node-pty load failure'),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'sleep 100', run_in_background: true },
      makeFakeContext(),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.error_kind).toBe('internal_error');
    expect(parsed.error).toMatch(/node-pty load failure/);
    expect(parsed.hint).toMatch(/PtyManager is not yet ready|per-Space session limit|node-pty/);
  });

  it('hardline 命令在 run_in_background=true 仍被前置拦截', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'rm -rf /', run_in_background: true },
      makeFakeContext(),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.blocked_by).toBe('security_policy_hardline');
    expect(mock.spawnDetachedCalls).toHaveLength(0);
  });
});

// ─── 13. 大输出落盘（仅 stdout 单源）──────────────────────────────────

describe.skip('ShellCap 大输出落盘 (deprecated by 2026-05-18 重构，待 P1-8 重写为 full_output_path)', () => {
  it('stdout 超 64KB → 落盘到 persisted_output_path + head/tail preview', async () => {
    const big = 'X'.repeat(80 * 1024);
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'ok',
          exitCode: 0,
          stdout: big,
          stderr: '',
          durationMs: 1,
          truncated: false,
          outputBytes: big.length,
          cwd: '/tmp',
          sessionId: 'mock-persist',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'echo big' },
      makeFakeContext({ sessionId: 'persist-stdout' }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(typeof parsed.persisted_output_path).toBe('string');
    expect(parsed.persisted_output_path).toContain('tabtin-tool-results');
    expect(parsed.persisted_output_path).toMatch(/-stdout\.log$/);
    expect(parsed.persisted_output_size).toBe(80 * 1024);
    expect(parsed.stdout.length).toBeLessThan(80 * 1024);
    expect(parsed.stdout).toMatch(/elided/);
    expect(parsed.stdout).toMatch(/persisted_output_path/);
  });

  it('stdout < 64KB → 不落盘', async () => {
    const { cap } = makeShellCap();
    const r = await cap.tools()[0].execute({ command: 'echo small' }, makeFakeContext());
    const parsed = JSON.parse(r.content as string);
    expect(parsed.persisted_output_path).toBeUndefined();
    expect(parsed.stdout).toBe('ok');
  });

  it('大输出 + truncated → persisted_output_truncated_by_backend 透传', async () => {
    const big = 'X'.repeat(80 * 1024);
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'ok',
          exitCode: 0,
          stdout: big,
          stderr: '',
          durationMs: 1,
          truncated: true,
          outputBytes: big.length,
          cwd: '/tmp',
          sessionId: 'mock-persist-trunc',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'cat /huge' },
      makeFakeContext({ sessionId: 'persist-trunc' }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.persisted_output_path).toBeDefined();
    expect(parsed.persisted_output_truncated_by_backend).toBe(true);
    expect(parsed.truncated).toBe(true);
  });

  it('执行层 inline 截断时 persisted_output_path 读取 bridge raw 输出文件并清理原文件', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabtin-raw-output-test-'));
    const rawPath = path.join(dir, 'raw.log');
    const full = `${'HEAD'.repeat(8 * 1024)}\nMIDDLE\n${'TAIL'.repeat(8 * 1024)}`;
    await fs.writeFile(rawPath, full, 'utf8');

    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'ok',
          exitCode: 0,
          stdout: 'HEADHEAD\n...[output truncated by TabTin process runner]',
          stderr: '',
          durationMs: 1,
          truncated: true,
          outputBytes: Buffer.byteLength(full, 'utf8'),
          outputFilePath: rawPath,
          outputFileSize: Buffer.byteLength(full, 'utf8'),
          cwd: '/tmp',
          sessionId: 'mock-raw-output',
        }),
      }).bridge,
    });

    const r = await cap.tools()[0].execute(
      { command: 'cat /huge' },
      makeFakeContext({ sessionId: 'persist-from-raw' }),
    );
    const parsed = JSON.parse(r.content as string);
    const persisted = await fs.readFile(parsed.persisted_output_path, 'utf8');

    expect(persisted).toBe(full);
    expect(parsed.persisted_output_size).toBe(Buffer.byteLength(full, 'utf8'));
    expect(parsed.persisted_output_truncated_by_backend).toBe(true);
    await expect(fs.access(rawPath)).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('落盘后 LLM 可读取完整内容', async () => {
    const big = 'A'.repeat(70 * 1024);
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'ok',
          exitCode: 0,
          stdout: big,
          stderr: '',
          durationMs: 1,
          truncated: false,
          outputBytes: big.length,
          cwd: '/tmp',
          sessionId: 'mock-persist-read',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'echo' },
      makeFakeContext({ sessionId: 'persist-read' }),
    );
    const parsed = JSON.parse(r.content as string);
    const content = await fs.readFile(parsed.persisted_output_path, 'utf8');
    expect(content).toBe(big);
  });

  it('persisted_output_path 在 macOS 走 realpath（不以 /var/ 直接开头）', async () => {
    const big = 'Y'.repeat(80 * 1024);
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'ok',
          exitCode: 0,
          stdout: big,
          stderr: '',
          durationMs: 1,
          truncated: false,
          outputBytes: big.length,
          cwd: '/tmp',
          sessionId: 'mock-realpath',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'cat /big' },
      makeFakeContext({ sessionId: 'realpath-test' }),
    );
    const parsed = JSON.parse(r.content as string);
    if (process.platform === 'darwin') {
      const startsWithVar = parsed.persisted_output_path.startsWith('/var/');
      const startsWithPrivate = parsed.persisted_output_path.startsWith('/private/');
      expect(startsWithVar && !startsWithPrivate).toBe(false);
    }
  });
});

// ─── 14. description LLM 引导文本 ───────────────────────────────────

describe.skip('ShellCap description LLM 引导 (2026-05-18 重构改了 description 文本，待 P1-8 重写断言)', () => {
  function getToolDescription(): string {
    const { cap } = makeShellCap();
    return cap.tools()[0].description;
  }

  it('persisted_output_path 单源引导（不再提 persisted_stderr_path）', () => {
    const desc = getToolDescription();
    expect(desc).toContain('persisted_output_path');
    // 关键：description 不再提 persisted_stderr_path
    expect(desc).not.toContain('persisted_stderr_path');
  });

  it('保留：64KB 阈值数字 + read_file 接续引导', () => {
    const desc = getToolDescription();
    expect(desc).toContain('64KB');
    expect(desc).toContain('read_file');
  });

  it('保留：$TABTIN_WORKSPACE / 256KB / 120000ms / 6 项工具偏好清单', () => {
    const desc = getToolDescription();
    expect(desc).toContain('$TABTIN_WORKSPACE');
    expect(desc).toContain('256KB');
    expect(desc).toMatch(/120000ms|120 ?秒|2 ?分钟/);
    expect(desc).toContain('glob_search');
    expect(desc).toContain('grep_search');
    expect(desc).toContain('edit_file');
    expect(desc).toContain('write_file');
  });

  it('明示 stderr 字段始终为空字符串 + 不需要读（PTY 合流，避免 LLM 反复猜）', () => {
    const desc = getToolDescription();
    expect(desc).toMatch(/stdout 字段|合流到 stdout|完整内容在 `stdout` 字段/);
    expect(desc).toMatch(/stderr.*始终为空|stderr.*空字符串/);
    expect(desc).toMatch(/不需要读/);
  });

  it('含字段映射表：foreground → persisted_output_path / background → output_file', () => {
    const desc = getToolDescription();
    // 字段映射表把两条路径明示出来，避免 LLM 拿到 envelope 后用错字段名调 read_file
    expect(desc).toMatch(/foreground 大输出.*persisted_output_path/);
    expect(desc).toMatch(/background.*output_file/);
    expect(desc).toMatch(/output_file 字段映射|按此查表/);
  });

  it('保留：sandbox runtime 措辞已删', () => {
    const desc = getToolDescription();
    expect(desc).not.toContain('sandbox runtime');
  });
});

// ─── 15. path_quoting_warnings 五路径透传 ────────────────────────────

describe('ShellCap path_quoting_warnings 透传', () => {
  const WS = '/tmp/path with spaces';
  const hasQuotingWarnings = (parsed: Record<string, unknown>): boolean => {
    const w = parsed.path_quoting_warnings;
    return Array.isArray(w) && w.length > 0;
  };

  it('hardline 路径透传', async () => {
    const { cap } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: `rm -rf / ${WS}/foo` },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.blocked_by).toBe('security_policy_hardline');
    expect(hasQuotingWarnings(parsed)).toBe(true);
  });

  it('restricted 模式拒绝路径透传', async () => {
    const { cap } = makeShellCap({
      restrictedShellChecker: {
        async isAllowed() { return { allowed: false, reason: 'r', code: 'write_risk' }; },
      },
    });
    const r = await cap.tools()[0].execute(
      { command: `cat ${WS}/file` },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.blocked_by).toBe('restricted_shell_allowlist');
    expect(hasQuotingWarnings(parsed)).toBe(true);
  });

  it('timeout 路径透传', async () => {
    const { cap } = makeShellCap({
      // 2026-05-18 重构后 wait_ms 超时不再视为错误，而是返 status='running'。
      // 用 scriptRead 模拟"任务仍在跑"让 wait_ms 到期 → running 分支应仍透传 path_quoting_warnings。
      bridge: makeBridgeMock({
        scriptRead: () => ({
          isRunning: true,
          output: '',
          outputBytes: 0,
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: `cat ${WS}/big`, wait_ms: 50 },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expect(hasQuotingWarnings(parsed)).toBe(true);
  });

  it('成功路径透传', async () => {
    const { cap } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: `cat ${WS}/file` },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe("completed");
    expect(hasQuotingWarnings(parsed)).toBe(true);
  });

  it('background 路径透传（wait_ms: 0 等价旧 run_in_background）', async () => {
    const { cap } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: `tail -f ${WS}/log`, wait_ms: 0 },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expect(parsed.session_id).toMatch(/^mock-detached-/);
    expect(hasQuotingWarnings(parsed)).toBe(true);
  });

  it('RT-4 R1：poll 走 cursor 增量、终态做一次全量读（消除每轮全量重读 O(n²)）', async () => {
    // scriptRead：首轮增量 running（带 nextCursor 推进），次轮增量 completed，
    // 终态再全量读一次（sinceByteOffset:0）拿完整 stdout。
    const mock = makeBridgeMock({
      scriptRead: (_sid, callIndex) => {
        if (callIndex === 0) return { isRunning: true, output: 'a', outputBytes: 1, nextCursor: 1 };
        if (callIndex === 1) return { isRunning: false, exitCode: 0, output: 'b', outputBytes: 2, nextCursor: 2 };
        // callIndex >= 2：终态 readFullOutput 的全量读，返回完整 stdout。
        return { isRunning: false, exitCode: 0, output: 'FULLOUTPUT', outputBytes: 10, nextCursor: 2 };
      },
    });
    const { cap } = makeShellCap({ bridge: mock.bridge });
    const r = await cap.tools()[0].execute(
      { command: `cat ${WS}/file`, wait_ms: 2000 },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('completed');
    // 终态 stdout 来自全量读（'FULLOUTPUT'），不是最后一次增量片段（'b'）
    expect(parsed.stdout).toBe('FULLOUTPUT');
    // poll 中间走 cursor 增量：首轮 sinceCursor=0，次轮推进到 1（不再每轮全量重读）
    expect(mock.readCalls[0].sinceCursor).toBe(0);
    expect(mock.readCalls[1].sinceCursor).toBe(1);
    // 终态做且仅做一次全量读（sinceByteOffset:0、不带 cursor）
    const fullReads = mock.readCalls.filter((c) => c.sinceByteOffset === 0 && c.sinceCursor === undefined);
    expect(fullReads.length).toBe(1);
  });
});

// ─── 16. abortSignal 透传 ───────────────────────────────────────────

describe.skip('ShellCap abortSignal 透传 (待 P1-8 适配统一 spawn 路径)', () => {
  it('context.abortSignal 透传到 bridge.executeAgentCommand.signal', async () => {
    const ctrl = new AbortController();
    const { cap, mock } = makeShellCap();
    await cap.tools()[0].execute(
      { command: 'echo' },
      makeFakeContext({ abortSignal: ctrl.signal }),
    );
    expect(mock.executeCalls[0].signal).toBe(ctrl.signal);
  });
});

// ─── 17. Skill 凭据脱敏（W2.3 P0-1 契约）────────────────────────────────

describe.skip('ShellCap Skill 凭据脱敏 (待 P1-8 适配 polling 路径)', () => {
  //  RB2：spaceId 已从 skillContext 移出（见上方 makeSkillContext 说明）。
  function makeSkillContext(): import('../../../engine/contracts/tools.js').ToolContext {
    return makeFakeContext({
      skillContext: {
        skillKey: 'github/star-watcher',
        primaryEnv: 'GITHUB_TOKEN',
      },
    });
  }

  it('stdout 含 skill 凭据值 → 替换为 ***REDACTED***', async () => {
    const provider: SkillContextProvider = {
      async resolveCredentials() {
        return { env: { GITHUB_TOKEN: 'ghp_secret_xyz' } };
      },
    };
    const { cap } = makeShellCap({
      skillContextProvider: provider,
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'ok',
          exitCode: 0,
          stdout: 'login: ghp_secret_xyz authenticated',
          stderr: '',
          durationMs: 15,
          truncated: false,
          outputBytes: 33,
          cwd: '/tmp',
          sessionId: 'mock-redact',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'curl https://api.github.com/user' },
      makeSkillContext(),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.stdout).not.toContain('ghp_secret_xyz');
    expect(parsed.stdout).toContain('login:');
    expect(parsed.stdout).toContain('authenticated');
  });

  it('未注入 secretEnv → stdout 原样返回（不走脱敏）', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'ok',
          exitCode: 0,
          stdout: 'arbitrary content',
          stderr: '',
          durationMs: 1,
          truncated: false,
          outputBytes: 17,
          cwd: '/tmp',
          sessionId: 'mock-no-secret',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute({ command: 'echo hi' }, makeFakeContext());
    const parsed = JSON.parse(r.content as string);
    expect(parsed.stdout).toBe('arbitrary content');
  });

  it('用户 input.env value 不参与脱敏 source（仅 skill credential value 脱敏）', async () => {
    const provider: SkillContextProvider = {
      async resolveCredentials() {
        return { env: { GITHUB_TOKEN: 'ghp_secretXYZ' } };
      },
    };
    const { cap } = makeShellCap({
      skillContextProvider: provider,
      bridge: makeBridgeMock({
        scriptExecute: () => ({
          status: 'ok',
          exitCode: 0,
          stdout: 'UA=tabtin-app GITHUB_TOKEN=ghp_secretXYZ',
          stderr: '',
          durationMs: 1,
          truncated: false,
          outputBytes: 41,
          cwd: '/tmp',
          sessionId: 'mock-skill-redact',
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'env', env: { UA: 'tabtin-app' } },
      makeSkillContext(),
    );
    const parsed = JSON.parse(r.content as string);
    // skill 凭据值替换
    expect(parsed.stdout).not.toContain('ghp_secretXYZ');
    expect(parsed.stdout).toContain('***REDACTED***');
    // 用户 env value 原样保留——不参与脱敏 source
    expect(parsed.stdout).toContain('tabtin-app');
  });

  it('skillContext 未提供 → 不调 provider，按"无注入"行为执行', async () => {
    let providerCallCount = 0;
    const provider: SkillContextProvider = {
      async resolveCredentials() {
        providerCallCount++;
        return null;
      },
    };
    const { cap } = makeShellCap({ skillContextProvider: provider });
    await cap.tools()[0].execute(
      { command: 'echo hi' },
      makeFakeContext(), // 无 skillContext
    );
    expect(providerCallCount).toBe(0);
  });
});

// ─── 18. policyActionKind 字段（schema 契约）────────────────────────────

describe('ShellCap policyActionKind / extractPolicyParams（v3 judge 接入）', () => {
  it('run_terminal_command.policyActionKind === "shell"', () => {
    const { cap } = makeShellCap();
    const tool = cap.tools()[0];
    expect(tool.policyActionKind).toBe('shell');
  });

  it('extractPolicyParams 返回 { command } 字典', () => {
    const { cap } = makeShellCap();
    const tool = cap.tools()[0];
    expect(typeof tool.extractPolicyParams).toBe('function');
    expect(tool.extractPolicyParams!({ command: 'echo hi' })).toEqual({ command: 'echo hi' });
    expect(tool.extractPolicyParams!({})).toEqual({});
  });
});

// ─── run_terminal_command description / hint 防漂移（push 通知重构 commit B）──
//
// description / hint 必须不含已删工具的字面引用（await_background_task /
// kill_background_task），也不含废弃参数名（run_in_background / background_task_id）。

describe('run_terminal_command description / hint 防漂移（push 通知重构 commit B）', () => {
  it('description 不含已删工具的字面引用，也不含废弃参数名', () => {
    const { cap } = makeShellCap();
    const runTool = cap.tools()[0];
    expect(runTool.description).not.toMatch(/await_background_task/);
    expect(runTool.description).not.toMatch(/kill_background_task/);
    expect(runTool.description).not.toMatch(/run_in_background/);
    expect(runTool.description).not.toMatch(/background_task_id/);
    // 递归扫 inputSchema field descriptions
    const schemaText = JSON.stringify(runTool.inputSchema);
    expect(schemaText).not.toMatch(/await_background_task/);
    expect(schemaText).not.toMatch(/kill_background_task/);
    expect(schemaText).not.toMatch(/run_in_background/);
    expect(schemaText).not.toMatch(/background_task_id/);
  });

  it('description 包含当前短描述关键契约', () => {
    const { cap } = makeShellCap();
    const runTool = cap.tools()[0];
    expect(runTool.description).toMatch(/completed/);
    expect(runTool.description).toMatch(/running/);
    expect(runTool.description).toMatch(/wait_ms/);
    expect(runTool.description).toMatch(/pattern/);
    expect(runTool.description).toMatch(/shell_runtime/);
    // ：不得再用 bash 等待示例诱导 Windows Agent。
    expect(runTool.description).not.toMatch(/until curl/);
    expect(runTool.description).not.toMatch(/\[\[ ! -f/);
  });
});

// ─── 18b. foreground tool_progress──────────────────────────────

describe('ShellCap foreground tool_progress', () => {
  const FIXED_SESSION_ID = 'agent-mock-space-foreground-progress';

  it('wait_ms>0 spawn 后立即 emit tool_progress 带 session_id，且 req 注入 onProgress', async () => {
    const events: StreamEvent[] = [];
    const store = new ManagedTaskStore({});
    const bridgeState = makeBridgeMock({
      managedTaskStore: store,
      scriptSpawnDetached: (req) => {
        store.createRecord({
          session_id: FIXED_SESSION_ID,
          command: req.command,
          cwd: req.cwd ?? '/tmp/mock-cwd',
          env: req.env,
          spaceId: req.agentMeta.spaceId,
          threadId: req.agentMeta.threadId,
          toolUseId: req.agentMeta.toolUseId,
          output_file_path: `/tmp/${FIXED_SESSION_ID}.log`,
          sync_notification_claim: req.syncNotificationClaim === true,
        });
        return {
          sessionId: FIXED_SESSION_ID,
          outputFilePath: `/tmp/${FIXED_SESSION_ID}.log`,
        };
      },
      scriptRead: (_sessionId, callIndex) => (
        callIndex === 0
          ? { isRunning: true, output: 'partial\n', outputBytes: 8, pid: 4242 }
          : { isRunning: false, exitCode: 0, output: 'done\n', outputBytes: 5 }
      ),
    });
    const { cap } = makeShellCap({
      emitStreamEvent: (e) => events.push(e),
      bridge: bridgeState.bridge,
    });

    await cap.tools()[0].execute(
      { command: 'pnpm build', wait_ms: 60_000 },
      makeFakeContext({ workspaceRoot: '/tmp/mock-cwd' }),
    );

    expect(typeof bridgeState.spawnDetachedCalls[0]?.onProgress).toBe('function');

    const progressEvents = events.filter(
      (e) => (e.payload as { notice_type?: string })?.notice_type === 'tool_progress',
    );
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);

    const first = progressEvents[0]!.payload as Record<string, unknown>;
    expect(first.session_id).toBe(FIXED_SESSION_ID);
    expect(first.tool_call_id).toBe('mock-tool-use');
    expect(first.tool_name).toBe('run_terminal_command');
    expect(first.command).toBe('pnpm build');
  });

  it('wait_ms=0 不注入 onProgress、不 emit tool_progress', async () => {
    const events: StreamEvent[] = [];
    const bridgeState = makeBridgeMock();
    const { cap } = makeShellCap({
      emitStreamEvent: (e) => events.push(e),
      bridge: bridgeState.bridge,
    });

    await cap.tools()[0].execute(
      { command: 'sleep 5', wait_ms: 0 },
      makeFakeContext(),
    );

    expect(bridgeState.spawnDetachedCalls[0]?.onProgress).toBeUndefined();
    expect(events.some(
      (e) => (e.payload as { notice_type?: string })?.notice_type === 'tool_progress',
    )).toBe(false);
  });
});

// ─── 18c. foreground 用户停止（consumeKillRequest）（ live）──────────
//
// 前台命令 kill 后 pty session 移除与 record.status 翻转之间存在竞态窗口，隐式
// 的 `!isRunning` 检测会让 poll 误读 running 而一直空等 → Agent 卡住。修法：与
// detach 对称的显式 kill 信号，poll 每轮 consumeKillRequest 读到即确定性退出。

describe('ShellCap foreground 用户停止', () => {
  const KILL_SESSION_ID = 'agent-mock-space-foreground-kill';

  it('poll 读到 requestKill → 返回 completed + killed_reason=user_interrupt，并 kill 进程', async () => {
    const store = new ManagedTaskStore({});
    const bridgeState = makeBridgeMock({
      managedTaskStore: store,
      scriptSpawnDetached: (req) => {
        store.createRecord({
          session_id: KILL_SESSION_ID,
          command: req.command,
          cwd: req.cwd ?? '/tmp/mock-cwd',
          env: req.env,
          spaceId: req.agentMeta.spaceId,
          threadId: req.agentMeta.threadId,
          toolUseId: req.agentMeta.toolUseId,
          output_file_path: `/tmp/${KILL_SESSION_ID}.log`,
          sync_notification_claim: req.syncNotificationClaim === true,
        });
        return {
          sessionId: KILL_SESSION_ID,
          outputFilePath: `/tmp/${KILL_SESSION_ID}.log`,
        };
      },
      // 关键：进程始终"仍在运行"——模拟前台 kill 后 isRunning 竞态不翻转的场景。
      // 第 2 次 read 前测试注入 requestKill，poll 应据显式信号退出（不靠 isRunning）。
      scriptRead: (sessionId, callIndex) => {
        if (callIndex === 0) {
          // 首读运行中 → 注入用户停止请求供下一轮消费
          store.requestKill(sessionId);
          return { isRunning: true, output: 'partial\n', outputBytes: 8, pid: 4242 };
        }
        return { isRunning: true, output: 'partial\n', outputBytes: 8, pid: 4242 };
      },
    });
    const { cap } = makeShellCap({ bridge: bridgeState.bridge });

    const result = await cap.tools()[0].execute(
      { command: 'sleep 600', wait_ms: 5_000 },
      makeFakeContext({ workspaceRoot: '/tmp/mock-cwd' }),
    );

    const envelope = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(envelope.status).toBe('completed');
    expect(envelope.killed_reason).toBe('user_interrupt');
    expect(envelope.exited_by).toBe('signal');
    expect(envelope.session_id).toBe(KILL_SESSION_ID);
    // 兜底 kill 已触发（幂等叠加 IPC 侧 killAgentSession）
    expect(bridgeState.killCalls.some((c) => c.sessionId === KILL_SESSION_ID)).toBe(true);
    // sync 出口 markNotified：抑制重复 push
    expect(store.get(KILL_SESSION_ID)?.notified).toBe(true);
  });
});

// ─── 19. push 通知重构 commit 2：sync 出口 markNotified suppress ──────────
//
// ShellCap 在所有"LLM 已通过 sync tool_result 看到 envelope"的出口必须调
// `store.markNotified(sessionId)` suppress bridge 后续可能触发的 push notification，
// 否则 LLM 会重复收到同一任务的 "background-task-completed" 通知。
//
// 4 类 sync 出口：
//   ✓ completed 分支（最常见）—— shell.ts:2246
//   ✓ abort signal aborted REQUEST_TIMEOUT —— shell.ts:~2092
//   ✓ session_lost INTERNAL_ERROR —— shell.ts:~2117
//   ✓ ReDoS pattern 路径 —— performance.now spy 确定性覆盖
//
// 注：spawn 失败路径 record 不存在（managedTaskStore 不创建），markNotified 自动 no-op。

describe('ShellCap sync 出口 markNotified（push 通知重构 commit 2）', () => {
  // 复用一个固定 sessionId 便于跨 bridge mock / store / 测试断言三处对账。
  const FIXED_SESSION_ID = 'fixed-session-for-test';

  function setupWithFixedSession(opts?: {
    throwOnRead?: () => Error;
    /** 默认让 read 立即返回 isRunning=false → 进 completed 分支 */
    scriptRead?: (sessionId: string, callIndex: number) => MockReadSnapshot | Promise<MockReadSnapshot>;
    afterCreateRecord?: (store: ManagedTaskStore, sessionId: string) => void;
  }) {
    const store = new ManagedTaskStore({});
    const { cap, mock } = makeShellCap({
      bridge: makeBridgeMock({
        managedTaskStore: store,
        scriptSpawnDetached: (req) => {
          store.createRecord({
            session_id: FIXED_SESSION_ID,
            command: req.command,
            cwd: req.cwd ?? '/tmp/mock-cwd',
            env: req.env,
            spaceId: req.agentMeta.spaceId,
            threadId: req.agentMeta.threadId,
            toolUseId: req.agentMeta.toolUseId,
            output_file_path: `/tmp/${FIXED_SESSION_ID}.log`,
            sync_notification_claim: req.syncNotificationClaim === true,
          });
          opts?.afterCreateRecord?.(store, FIXED_SESSION_ID);
          return {
            sessionId: FIXED_SESSION_ID,
            outputFilePath: `/tmp/${FIXED_SESSION_ID}.log`,
          };
        },
        throwOnRead: opts?.throwOnRead,
        scriptRead: opts?.scriptRead,
      }).bridge,
    });
    return { cap, mock, store };
  }

  it('completed 分支调 markNotified → record.notified === true', async () => {
    const { cap, store } = setupWithFixedSession();
    // 默认 scriptRead → isRunning=false + exitCode=0 → completed 分支
    const r = await cap.tools()[0].execute(
      { command: 'echo hi' },
      makeFakeContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(store.get(FIXED_SESSION_ID)?.notified).toBe(true);
    expect(store.get(FIXED_SESSION_ID)?.notification_state).toBe('foreground_waiting');
  });

  it('wait_ms>0 时先认领 sync completion，覆盖 exit 先于首轮 poll 的竞态', async () => {
    let claimWasPresentAtExit = false;
    const { cap, store } = setupWithFixedSession({
      afterCreateRecord: (s, sessionId) => {
        claimWasPresentAtExit = s.get(sessionId)?.sync_notification_claim === true;
        // 模拟 bridge exit handler 在 ShellCap 首轮 read/poll 前先完成 updateOnExit；
        // producer 此时会因 sync_notification_claim suppress push，等待 ShellCap 同步交付终态。
        s.updateOnExit(sessionId, {
          status: 'completed',
          exit_code: 0,
          exited_by: 'normal_exit',
        });
      },
    });

    const r = await cap.tools()[0].execute(
      { command: 'ls', wait_ms: 1000 },
      makeFakeContext(),
    );
    const parsed = JSON.parse(r.content as string);

    expect(parsed.status).toBe('completed');
    expect(claimWasPresentAtExit).toBe(true);
    expect(store.get(FIXED_SESSION_ID)?.status).toBe('completed');
    expect(store.get(FIXED_SESSION_ID)?.notified).toBe(true);
    expect(store.get(FIXED_SESSION_ID)?.sync_notification_claim).toBeUndefined();
  });

  it('#706 tabtin doc 前台命令同样被 claim 覆盖（命令无关）：exit 先于首轮 poll 不重复 push', async () => {
    //  与  同源——`tabtin doc create/search` 与 `ls` 一样走 ShellCap
    // run_terminal_command（默认 wait_ms=60s>0）。#690 修复的
    // sync_notification_claim 是命令无关的：任何 wait_ms>0 的前台命令在 exit 先于
    // ShellCap 首轮 poll 时都被 claim suppress 掉后台 push，由 ShellCap 同步交付终态。
    // 本例用文档命令复刻  race 断言其同样不触发额外一轮 agent 调用。
    let claimWasPresentAtExit = false;
    const { cap, store } = setupWithFixedSession({
      afterCreateRecord: (s, sessionId) => {
        claimWasPresentAtExit = s.get(sessionId)?.sync_notification_claim === true;
        s.updateOnExit(sessionId, {
          status: 'completed',
          exit_code: 0,
          exited_by: 'normal_exit',
        });
      },
    });

    const r = await cap.tools()[0].execute(
      { command: 'tabtin doc create --title "demo1" --format json', wait_ms: 60000 },
      makeFakeContext(),
    );
    const parsed = JSON.parse(r.content as string);

    expect(parsed.status).toBe('completed');
    // claim 在 spawn 时就写入（命令无关），覆盖快命令 exit 先于首轮 poll 的竞态。
    expect(claimWasPresentAtExit).toBe(true);
    // 同步交付终态 → markNotified 清 claim + 设 notified；后台 producer 因 notified
    // / claim 任一条件 suppress push → 不会有第二轮"任务已完成"激活额外 turn。
    expect(store.get(FIXED_SESSION_ID)?.notified).toBe(true);
    expect(store.get(FIXED_SESSION_ID)?.sync_notification_claim).toBeUndefined();
    // 前台同步交付，notification_state 不进 background_exposed（push 的硬前置条件之一）。
    expect(store.get(FIXED_SESSION_ID)?.notification_state).toBe('foreground_waiting');
  });

  it('wait_ms 超时返回 running 时释放 sync claim，后台真实完成仍满足 push 条件', async () => {
    const { cap, store } = setupWithFixedSession({
      scriptRead: () => ({
        isRunning: true,
        output: '',
        outputBytes: 0,
      }),
    });

    const r = await cap.tools()[0].execute(
      { command: 'sleep 5', wait_ms: 1 },
      makeFakeContext(),
    );
    const parsed = JSON.parse(r.content as string);
    const runningRecord = store.get(FIXED_SESSION_ID);

    expect(parsed.status).toBe('running');
    expect(runningRecord?.status).toBe('running');
    expect(runningRecord?.notified).toBeUndefined();
    expect(runningRecord?.sync_notification_claim).toBeUndefined();
    expect(runningRecord?.threadId).toBe('test-thread');

    store.updateOnExit(FIXED_SESSION_ID, {
      status: 'completed',
      exit_code: 0,
      exited_by: 'normal_exit',
    });
    const completedRecord = store.get(FIXED_SESSION_ID);
    expect(completedRecord?.status).toBe('completed');
    expect(completedRecord?.notified).toBeUndefined();
    expect(completedRecord?.sync_notification_claim).toBeUndefined();
    expect(completedRecord?.threadId).toBe('test-thread');
  });

  it('poll 中 consumeDetachRequest → 返回 running envelope、不 kill、hint 标明 user detached', async () => {
    const store = new ManagedTaskStore({});
    const bridgeMock = makeBridgeMock({
      managedTaskStore: store,
      scriptSpawnDetached: (req) => {
        store.createRecord({
          session_id: FIXED_SESSION_ID,
          command: req.command,
          cwd: req.cwd ?? '/tmp/mock-cwd',
          env: req.env,
          spaceId: req.agentMeta.spaceId,
          threadId: req.agentMeta.threadId,
          toolUseId: req.agentMeta.toolUseId,
          output_file_path: `/tmp/${FIXED_SESSION_ID}.log`,
          sync_notification_claim: req.syncNotificationClaim === true,
        });
        return {
          sessionId: FIXED_SESSION_ID,
          outputFilePath: `/tmp/${FIXED_SESSION_ID}.log`,
        };
      },
      scriptRead: (_sessionId, callIndex) => {
        if (callIndex === 0) {
          store.requestDetach(FIXED_SESSION_ID);
        }
        return {
          isRunning: true,
          output: 'partial\n',
          outputBytes: 8,
          pid: 4242,
        };
      },
    });
    const { cap } = makeShellCap({ bridge: bridgeMock.bridge });

    const r = await cap.tools()[0].execute(
      { command: 'sleep 999', wait_ms: 60_000 },
      makeFakeContext(),
    );
    const parsed = JSON.parse(r.content as string);

    expect(parsed.status).toBe('running');
    expect(parsed.pid).toBe(4242);
    expect(parsed.hint?.reason).toMatch(/User detached command to background/i);
    expect(bridgeMock.killCalls).toHaveLength(0);
    expect(store.get(FIXED_SESSION_ID)?.notification_state).toBe('background_exposed');
    expect(store.get(FIXED_SESSION_ID)?.status).toBe('running');
  });

  it('abort signal aborted 路径 seal store + kill，不再留 running', async () => {
    // 在 spawn 完成前 abort，poll 第一轮 while top 命中 abort 分支
    const ctrl = new AbortController();
    const store = new ManagedTaskStore({});
    const bridgePack = makeBridgeMock({
      managedTaskStore: store,
      scriptSpawnDetached: (req) => {
        ctrl.abort();
        store.createRecord({
          session_id: FIXED_SESSION_ID,
          command: req.command,
          cwd: req.cwd ?? '/tmp/mock-cwd',
          env: req.env,
          spaceId: req.agentMeta.spaceId,
          threadId: req.agentMeta.threadId,
          toolUseId: req.agentMeta.toolUseId,
          output_file_path: `/tmp/${FIXED_SESSION_ID}.log`,
          sync_notification_claim: req.syncNotificationClaim === true,
        });
        return {
          sessionId: FIXED_SESSION_ID,
          outputFilePath: `/tmp/${FIXED_SESSION_ID}.log`,
        };
      },
    });
    const { cap } = makeShellCap({
      bridge: bridgePack.bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'long-running', env: PROTECTED_ENV_FOR_RESULT_TESTS },
      makeFakeContext({ abortSignal: ctrl.signal }),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('failed');
    expect(parsed.error_kind).toBe('request_timeout');
    expect(parsed.session_id).toBe(FIXED_SESSION_ID);
    expect(parsed.hint?.reason).toMatch(/terminated/i);
    // ：工具卡 failed 时 store 不得仍为 running（否则底条矛盾）
    const record = store.get(FIXED_SESSION_ID);
    expect(record?.notified).toBe(true);
    expect(record?.status).toBe('killed');
    expect(record?.killed_reason).toBe('user_interrupt');
    expect(record?.status).not.toBe('running');
    expect(bridgePack.killCalls).toEqual([
      { sessionId: FIXED_SESSION_ID, signal: 'SIGTERM' },
    ]);
  });

  it('session_lost 路径调 markNotified → record.notified === true', async () => {
    const { cap, store } = setupWithFixedSession({
      // readAgentSessionOutput 抛错触发 session_lost 分支
      throwOnRead: () => new Error('agent session not found'),
    });
    const r = await cap.tools()[0].execute(
      { command: 'echo hi', env: PROTECTED_ENV_FOR_RESULT_TESTS },
      makeFakeContext(),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('failed');
    expect(parsed.error_kind).toBe('internal_error');
    // session_lost envelope 里 error 字段含 sessionId 文本（shell.ts:2123 `Lost track of spawned session ${sessionId}.`）
    expect(parsed.error).toMatch(/Lost track of spawned session/);
    expectIgnoredKeysWarning(r);
    // 关键断言：record.notified 必须是 true
    expect(store.get(FIXED_SESSION_ID)?.notified).toBe(true);
    expect(store.get(FIXED_SESSION_ID)?.notification_state).toBe('foreground_waiting');
  });

  it('pattern ReDoS failed 路径保留错误契约并返回 ignored_keys warning', async () => {
    const nowSpy = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(101);
    try {
      const { cap, store } = setupWithFixedSession({
        scriptRead: () => ({
          isRunning: true,
          output: 'aaaaaaaa',
          outputBytes: 8,
        }),
      });
      const r = await cap.tools()[0].execute(
        {
          command: 'long-running',
          pattern: 'a+',
          env: PROTECTED_ENV_FOR_RESULT_TESTS,
        },
        makeFakeContext(),
      );

      expect(r.isError).toBe(true);
      const parsed = JSON.parse(r.content as string);
      expect(parsed.status).toBe('failed');
      expect(parsed.error_kind).toBe(INVALID_PARAM_FORMAT);
      expect(parsed.session_id).toBe(FIXED_SESSION_ID);
      expect(parsed.error).toMatch(/ReDoS/);
      expectIgnoredKeysWarning(r);
      expect(store.get(FIXED_SESSION_ID)?.notified).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('ShellCap running 出口标记后台暴露语义', () => {
  const FIXED_SESSION_ID = 'fixed-session-for-background-exposed';

  function setupWithFixedSession(opts?: {
    scriptRead?: (sessionId: string, callIndex: number) => MockReadSnapshot | Promise<MockReadSnapshot>;
  }) {
    const store = new ManagedTaskStore({});
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        managedTaskStore: store,
        scriptSpawnDetached: (req) => {
          store.createRecord({
            session_id: FIXED_SESSION_ID,
            command: req.command,
            cwd: req.cwd ?? '/tmp/mock-cwd',
            env: req.env,
            spaceId: req.agentMeta.spaceId,
            threadId: req.agentMeta.threadId,
            toolUseId: req.agentMeta.toolUseId,
            output_file_path: `/tmp/${FIXED_SESSION_ID}.log`,
          });
          return {
            sessionId: FIXED_SESSION_ID,
            outputFilePath: `/tmp/${FIXED_SESSION_ID}.log`,
          };
        },
        scriptRead: opts?.scriptRead,
      }).bridge,
    });
    return { cap, store };
  }

  it('wait_ms=0 立即 running 前标记 background_exposed', async () => {
    const { cap, store } = setupWithFixedSession();
    const r = await cap.tools()[0].execute(
      { command: 'sleep 1', wait_ms: 0 },
      makeFakeContext(),
    );
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expect(store.get(FIXED_SESSION_ID)?.notification_state).toBe('background_exposed');
  });

  it('wait_ms 到期仍 running 前标记 background_exposed', async () => {
    const { cap, store } = setupWithFixedSession({
      scriptRead: () => ({ output: 'still running', outputBytes: 13, isRunning: true, exitCode: null }),
    });
    const r = await cap.tools()[0].execute(
      { command: 'sleep 1', wait_ms: 1 },
      makeFakeContext(),
    );
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expect(store.get(FIXED_SESSION_ID)?.notification_state).toBe('background_exposed');
  });

  it('pattern 命中但进程仍 running 前标记 background_exposed', async () => {
    const { cap, store } = setupWithFixedSession({
      scriptRead: () => ({
        output: 'server ready',
        outputBytes: 12,
        isRunning: true,
        exitCode: null,
        nextCursor: 12,
      }),
    });
    const r = await cap.tools()[0].execute(
      { command: 'pnpm dev', wait_ms: 60_000, pattern: 'ready' },
      makeFakeContext(),
    );
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expect(parsed.pattern_matched.text).toBe('ready');
    expect(store.get(FIXED_SESSION_ID)?.notification_state).toBe('background_exposed');
  });

  it('dedup 返回 running 前标记已有 record 为 background_exposed', async () => {
    const store = new ManagedTaskStore({});
    store.createRecord({
      session_id: FIXED_SESSION_ID,
      command: 'du -sh .',
      cwd: '/workspace',
      env: {
        TABTIN_WORKSPACE: '/workspace',
        TABTIN_THREAD_ID: 'test-thread',
        TABTIN_AGENT_RUN_ID: 'test-agent-run',
        TABTIN_SPACE_ID: 'mock-space',
      },
      spaceId: 'mock-space',
      agentId: 'mock-agent',
      threadId: 'test-thread',
      toolUseId: 'existing-tool-use',
      output_file_path: `/tmp/${FIXED_SESSION_ID}.log`,
    });
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({ managedTaskStore: store }).bridge,
    });

    const r = await cap.tools()[0].execute(
      { command: 'du -sh .' },
      makeFakeContext({ workspaceRoot: '/workspace' }),
    );
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expect(parsed.dedup_hit).toBe(true);
    expect(store.get(FIXED_SESSION_ID)?.notification_state).toBe('background_exposed');
  });
});

// ─── 20. 终端假运行根治 v3 Layer 3：running 快照携带 hard_timeout_ms ──────────
//
// 缺口（Wave 2 收尾）：LLM 通过 run_terminal_command(hard_timeout_ms=...) 传的命令
// 真死线进了 ManagedTaskRecord（内存账本），却没写进 Django status:"running" 快照
// content → Layer 3 celery `mark_stale_running_terminals` 读不到 per-block 阈值、
// 所有 running 都走 12h 默认 → 用户有意 hard_timeout_ms > 12h 的长驻命令（仍存活）
// 会被误标 unknown（"运行状态未知"）。
//
// 契约对齐（只读确认 apps/tabtin_django/apps/chat/conversation/terminal_state_gc.py）：
//   - 字段名 = 顶层 `hard_timeout_ms`（GC `content.get("hard_timeout_ms")`，第 138/203 行）。
//   - 值 = 正整数毫秒（GC `_coerce_positive_int` 丢弃 <=0 / 非数字 → 回落 12h 默认）。
//   - 只在 LLM 显式传了才写；没传 → 不写该键（undefined 被 JSON.stringify 省略），
//     Layer 3 回落默认。
//
// 4 处 running envelope 全覆盖：wait_ms=0 / wait_ms 用尽 / pattern 命中 / dedup 命中。

describe('ShellCap running 快照携带 hard_timeout_ms（终端假运行根治 v3 Layer 3 前向兼容）', () => {
  const WS = '/tmp/ws-hardtimeout';
  // 真·长驻服务死线：24h > 12h 默认（GC 据此保护，不在 12h 误标 unknown）。
  const HT_24H = 24 * 60 * 60 * 1000;

  // ── wait_ms=0 立即背景化 ──
  it('wait_ms=0 + 传 hard_timeout_ms → running 快照带该字段', async () => {
    const { cap } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'sleep 999999', wait_ms: 0, hard_timeout_ms: HT_24H },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expect(parsed.hard_timeout_ms).toBe(HT_24H);
  });

  it('wait_ms=0 + 不传 hard_timeout_ms → running 快照不带该键（GC 回落 12h 默认）', async () => {
    const { cap } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'sleep 999999', wait_ms: 0 },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expect(parsed).not.toHaveProperty('hard_timeout_ms');
  });

  it('wait_ms=0 + 传非整数 hard_timeout_ms → INVALID_PARAM_FORMAT 且不 spawn', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'sleep 999999', wait_ms: 0, hard_timeout_ms: 86_400_000.9 },
      makeFakeContext({ workspaceRoot: WS }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content as string).error_kind).toBe(INVALID_PARAM_FORMAT);
    expect(mock.spawnDetachedCalls).toHaveLength(0);
  });

  it('wait_ms=0 + 传非正数 hard_timeout_ms(0) → INVALID_PARAM_FORMAT 且不 spawn', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'sleep 999999', wait_ms: 0, hard_timeout_ms: 0 },
      makeFakeContext({ workspaceRoot: WS }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content as string).error_kind).toBe(INVALID_PARAM_FORMAT);
    expect(mock.executeCalls).toHaveLength(0);
  });

  it('wait_ms=0 + 传负数 hard_timeout_ms(-1) → INVALID_PARAM_FORMAT 且不 spawn', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'sleep 999999', wait_ms: 0, hard_timeout_ms: -1 },
      makeFakeContext({ workspaceRoot: WS }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content as string).error_kind).toBe(INVALID_PARAM_FORMAT);
    expect(mock.executeCalls).toHaveLength(0);
  });

  // ── wait_ms 用尽转后台（PRD §1.1/§1.3 核心场景） ──
  it('wait_ms 用尽转 running + 传 hard_timeout_ms → 带该字段', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptRead: () => ({ isRunning: true, output: '', outputBytes: 0 }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'tail -f log', wait_ms: 50, hard_timeout_ms: HT_24H },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expect(parsed.hard_timeout_ms).toBe(HT_24H);
  });

  it('wait_ms 用尽转 running + 不传 → 不带该键', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptRead: () => ({ isRunning: true, output: '', outputBytes: 0 }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'tail -f log', wait_ms: 50 },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expect(parsed).not.toHaveProperty('hard_timeout_ms');
  });

  // ── pattern 命中提前返回 running ──
  it('pattern 命中转 running + 传 hard_timeout_ms → 带该字段', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptRead: () => ({
          isRunning: true,
          output: 'Local: http://localhost:3000',
          outputBytes: 28,
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'npm run dev', wait_ms: 30000, pattern: 'Local: http', hard_timeout_ms: HT_24H },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expect(parsed.pattern_matched).toBeTruthy();
    expect(parsed.hard_timeout_ms).toBe(HT_24H);
  });

  it('pattern 命中转 running + 不传 → 不带该键', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptRead: () => ({
          isRunning: true,
          output: 'Local: http://localhost:3000',
          outputBytes: 28,
        }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'npm run dev', wait_ms: 30000, pattern: 'Local: http' },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.pattern_matched).toBeTruthy();
    expect(parsed).not.toHaveProperty('hard_timeout_ms');
  });

  // ── dedup 命中复用历史 record 的 hard_timeout_ms ──
  //
  // mergedEnv 在无用户 env 时 = buildTabtinRuntimeEnv(context)；据此构造可命中的
  // dedup record（command/cwd/env/threadId 全等 + 窗口内）。dedup 仅按这 4 项匹配，
  // 不看本次入参 hard_timeout_ms —— running 快照应取历史 record 的真死线。
  const DEDUP_ENV = {
    TABTIN_WORKSPACE: WS,
    TABTIN_THREAD_ID: 'test-thread',
    TABTIN_AGENT_RUN_ID: 'test-agent-run',
    TABTIN_SPACE_ID: 'mock-space',
  };

  it('dedup 命中 → running 快照带历史 record 的 hard_timeout_ms', async () => {
    // Wave3：hard_timeout_ms 上限 24h；历史 record 用合法上界。
    const store = new ManagedTaskStore({});
    store.createRecord({
      session_id: 'dedup-existing',
      command: 'sleep 999999',
      cwd: WS,
      env: DEDUP_ENV,
      spaceId: 'mock-space',
      agentId: 'mock-agent',
      threadId: 'test-thread',
      toolUseId: 'orig-tool-use',
      output_file_path: '/tmp/dedup-existing.log',
      hard_timeout_ms: 86_400_000,
    });
    const { cap, mock } = makeShellCap({
      bridge: makeBridgeMock({ managedTaskStore: store }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'sleep 999999', wait_ms: 0 },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('running');
    expect(parsed.dedup_hit).toBe(true);
    expect(parsed.session_id).toBe('dedup-existing');
    expect(parsed.hard_timeout_ms).toBe(86_400_000);
    // dedup 命中复用历史 record，不应再 spawn
    expect(mock.spawnDetachedCalls).toHaveLength(0);
  });

  it('dedup 命中 + 历史 record 无 hard_timeout_ms → running 快照不带该键', async () => {
    const store = new ManagedTaskStore({});
    store.createRecord({
      session_id: 'dedup-existing-2',
      command: 'sleep 888888',
      cwd: WS,
      env: DEDUP_ENV,
      spaceId: 'mock-space',
      agentId: 'mock-agent',
      threadId: 'test-thread',
      toolUseId: 'orig-tool-use',
      output_file_path: '/tmp/dedup-existing-2.log',
    });
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({ managedTaskStore: store }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'sleep 888888', wait_ms: 0 },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.dedup_hit).toBe(true);
    expect(parsed).not.toHaveProperty('hard_timeout_ms');
  });

  it('dedup 命中：取历史 record 的 hard_timeout_ms，无视本次入参冲突值（且值满足 GC 接受条件）', async () => {
    const store = new ManagedTaskStore({});
    store.createRecord({
      session_id: 'dedup-conflict',
      command: 'sleep 777777',
      cwd: WS,
      env: DEDUP_ENV,
      spaceId: 'mock-space',
      agentId: 'mock-agent',
      threadId: 'test-thread',
      toolUseId: 'orig-tool-use',
      output_file_path: '/tmp/dedup-conflict.log',
      hard_timeout_ms: 86_400_000,
    });
    const { cap, mock } = makeShellCap({
      bridge: makeBridgeMock({ managedTaskStore: store }).bridge,
    });
    const r = await cap.tools()[0].execute(
      // 本次显式传一个与历史 record 冲突的值；dedup 只按 command/cwd/env/threadId 匹配，
      // running 快照应取历史 record 的真死线（86_400_000），而非本次入参（600_000）。
      { command: 'sleep 777777', wait_ms: 0, hard_timeout_ms: 600_000 },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.dedup_hit).toBe(true);
    expect(parsed.session_id).toBe('dedup-conflict');
    expect(mock.spawnDetachedCalls).toHaveLength(0);
    // 历史 record 值赢，本次入参被无视（锁死回归成 `hardTimeoutMs ?? dedup.hard_timeout_ms` 的风险）。
    expect(parsed.hard_timeout_ms).toBe(86_400_000);
    // dedup-sourced 值同样应满足 Layer 3 GC 接受条件（正整数毫秒、> 12h 默认）。
    expect(Number.isInteger(parsed.hard_timeout_ms)).toBe(true);
    expect(parsed.hard_timeout_ms).toBeGreaterThan(12 * 60 * 60 * 1000);
  });

  // ── 跨契约一致性：写入值满足 Layer 3 GC 接受条件（正整数毫秒，> 12h 默认） ──
  it('写入的 hard_timeout_ms 是正整数毫秒且 > 12h 默认（保护真·长驻服务不被误标 unknown）', async () => {
    const { cap } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'sleep 999999', wait_ms: 0, hard_timeout_ms: HT_24H },
      makeFakeContext({ workspaceRoot: WS }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(Number.isInteger(parsed.hard_timeout_ms)).toBe(true);
    expect(parsed.hard_timeout_ms).toBeGreaterThan(0);
    expect(parsed.hard_timeout_ms).toBeGreaterThan(12 * 60 * 60 * 1000);
  });
});

// ─── RT-2：执行根（Agent working_dir）不可达 → cwd_not_found ───────────────
//
// runner 在 spawn 前同步抛 ExecutionRootUnreachableError（code=
// 'EXECUTION_ROOT_UNREACHABLE'），bridge 透传，ShellCap 映射成结构化
// cwd_not_found envelope + 明确 hint，而不是把 Node 的误导性
// `spawn /bin/zsh ENOENT` 当 SPAWN_FAILURE 抛给 LLM（详见
// docs/overview/ai-issues-overview.md RT-2）。
describe('ShellCap RT-2：执行根不可达 → cwd_not_found', () => {
  function makeExecRootUnreachableError(cwd: string): Error {
    return Object.assign(new Error(`Execution root does not exist: ${cwd}`), {
      code: 'EXECUTION_ROOT_UNREACHABLE',
      cwd,
      reason: 'missing',
    });
  }

  it('cwd 不可达 → failed + error_kind=cwd_not_found + 明确 hint（别换 shell / 别偷换根 / 让用户重设）', async () => {
    const badCwd = '/Volumes/开发/tabtin/edit_file';
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        throwOnSpawnDetached: () => makeExecRootUnreachableError(badCwd),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'df -h' },
      makeFakeContext({ workspaceRoot: badCwd }),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('failed');
    expect(parsed.error_kind).toBe('cwd_not_found');
    expect(parsed.error).toMatch(/Working directory is unreachable/);
    expect(parsed.error).toContain(badCwd);
    expect(parsed.hint.next_action).toBe('ask_user');
    // hint 必须教 LLM 不要误判成 shell 问题、不要偷换根、要让用户重设工作目录
    expect(parsed.hint.reason).toContain(badCwd);
    expect(parsed.hint.reason).toMatch(/NOT a shell problem/i);
    expect(parsed.hint.reason).toMatch(/different shell path/i);
    expect(parsed.hint.reason).toMatch(/do NOT silently cd/i);
    expect(parsed.hint.reason).toMatch(/re-select a working directory/i);
  });

  it('error.cwd 缺失时回落 context.workspaceRoot（hint 仍指向具体目录）', async () => {
    const ws = '/Volumes/开发/tabtin/edit_file';
    const errNoCwd = Object.assign(new Error('Execution root does not exist'), {
      code: 'EXECUTION_ROOT_UNREACHABLE',
    });
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({ throwOnSpawnDetached: () => errNoCwd }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'ls' },
      makeFakeContext({ workspaceRoot: ws }),
    );
    const parsed = JSON.parse(r.content as string);
    expect(parsed.error_kind).toBe('cwd_not_found');
    expect(parsed.hint.reason).toContain(ws);
  });

  it('普通 spawn 失败（非执行根问题）仍走 spawn_failure，不被误归类', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        throwOnSpawnDetached: () => new Error('node-pty load failure'),
      }).bridge,
    });
    const r = await cap.tools()[0].execute(
      { command: 'echo hi', env: PROTECTED_ENV_FOR_RESULT_TESTS },
      makeFakeContext({ workspaceRoot: '/tmp' }),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('failed');
    expect(parsed.error_kind).toBe('spawn_failure');
    expect(parsed.error_kind).not.toBe('cwd_not_found');
    expectIgnoredKeysWarning(r);
  });
});

// ───  大输出卸载：A1 剥回显 / A2 CRLF 归一 / A3 JSON 感知卸载 ──────────

describe('normalizeAgentStdout（ A1+A2 纯函数）', () => {
  it('A2：CRLF → LF', () => {
    expect(normalizeAgentStdout('a\r\nb\r\n', 'nomatch')).toBe('a\nb\n');
  });

  it('A2：孤立 CR → LF', () => {
    expect(normalizeAgentStdout('a\rb', 'nomatch')).toBe('a\nb');
  });

  it('A1：剥掉 `$ <command>\\n` 回显（CRLF 源）', () => {
    expect(normalizeAgentStdout('$ echo hi\r\nhello\r\nworld\r\n', 'echo hi')).toBe('hello\nworld\n');
  });

  it('A1：剥回显（LF-only 源）', () => {
    expect(normalizeAgentStdout('$ ls\nout\n', 'ls')).toBe('out\n');
  });

  it('A1：多行 / heredoc 命令的整段回显都剥掉', () => {
    const command = 'cat <<E\nx\nE';
    const raw = '$ cat <<E\nx\nE\nreal-output\n';
    expect(normalizeAgentStdout(raw, command)).toBe('real-output\n');
  });

  it('A1：输出以 `$ ` 开头但与命令不匹配 → 不误删（仅 CRLF 归一）', () => {
    expect(normalizeAgentStdout('$ other thing\r\nx\r\n', 'echo hi')).toBe('$ other thing\nx\n');
  });

  it('回显后无内容 → 空串', () => {
    expect(normalizeAgentStdout('$ ls\r\n', 'ls')).toBe('');
  });

  it('空输出 → 空串', () => {
    expect(normalizeAgentStdout('', 'echo hi')).toBe('');
  });
});

describe('ShellCap 大输出卸载端到端', () => {
  it('A1+A2：completed 的 stdout 无命令回显、无 CR', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptRead: () => ({ output: '$ echo hi\r\nhello\r\nworld\r\n', isRunning: false, exitCode: 0 }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute({ command: 'echo hi' }, makeFakeContext());
    const parsed = JSON.parse(r.content as string);
    expect(parsed.status).toBe('completed');
    expect(parsed.stdout).toBe('hello\nworld\n');
    expect(parsed.stdout).not.toContain('\r');
    expect(parsed.stdout).not.toContain('$ echo hi');
  });

  it('A3：大 JSON 数组 → head-tail 预览 + 落盘 full_output_path', async () => {
    const bigArray = JSON.stringify(
      Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item-${'x'.repeat(20)}` })),
    );
    expect(Buffer.byteLength(bigArray, 'utf-8')).toBeGreaterThan(30 * 1024);
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptRead: () => ({ output: bigArray, isRunning: false, exitCode: 0, outputBytes: bigArray.length }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute({ command: 'tabtin table list --format json' }, makeFakeContext());
    const parsed = JSON.parse(r.content as string);
    expect(parsed.stdout_truncated).toBe(true);
    expect(parsed.stdout).not.toContain('__tabtin_output_summary');
    expect(parsed.stdout).toMatch(/elided|omitted/);
    expect(parsed.stdout).toContain('item-xxxxx');
    expect(typeof parsed.full_output_path).toBe('string');
    expect(Buffer.byteLength(parsed.stdout, 'utf-8')).toBeLessThan(30 * 1024);
  });

  it('A3：大 JSON 控制信号 → 截断输出旁路提取 control_signals', async () => {
    const payload = JSON.stringify({
      ok: false,
      finalUrl: 'https://example.com/login',
      login_required: {
        reason: 'browser login wall',
        tab_id: 'view-login-wall-1',
      },
      body: 'x'.repeat(40 * 1024),
    });
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptRead: () => ({ output: payload, isRunning: false, exitCode: 0, outputBytes: payload.length }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute({ command: 'browser snapshot --json' }, makeFakeContext());
    const parsed = JSON.parse(r.content as string);
    expect(parsed.stdout_truncated).toBe(true);
    expect(parsed.control_signals).toEqual({
      login_required: {
        domain: 'example.com',
        reason: 'browser login wall',
        tab_id: 'view-login-wall-1',
      },
    });
  });

  it('A3 回落：大非 JSON 输出 → head-tail 预览（不是 JSON 摘要）', async () => {
    const bigText = 'X'.repeat(40 * 1024);
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptRead: () => ({ output: bigText, isRunning: false, exitCode: 0, outputBytes: bigText.length }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute({ command: 'cat big.log' }, makeFakeContext());
    const parsed = JSON.parse(r.content as string);
    expect(parsed.stdout_truncated).toBe(true);
    expect(parsed.stdout).not.toContain('__tabtin_output_summary');
    expect(parsed.stdout).toMatch(/elided/);
  });

  it('一致性守卫：completed 的 stdout 逐字节等于 normalizeAgentStdout 产出（未截断场景）', async () => {
    //  不变量：tool_result content 是 LLM 消费 + 入参检视快照的单一真相源，
    // 由 normalizeAgentStdout 在此单点产出（终端 transcript 另存原始，不分叉）。
    const raw = '$ mycmd\r\nfoo\r\nbar\r\n';
    const command = 'mycmd';
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptRead: () => ({ output: raw, isRunning: false, exitCode: 0 }),
      }).bridge,
    });
    const r = await cap.tools()[0].execute({ command }, makeFakeContext());
    const parsed = JSON.parse(r.content as string);
    expect(parsed.stdout).toBe(normalizeAgentStdout(raw, command));
    expect(parsed.stdout).toBe('foo\nbar\n');
  });
});

// ───  shell file_history envelope ─────────────────────────────────

describe('ShellCap run_terminal_command · file_history', () => {
  it('completed 路径写入 file_history 且 pre-track 变更文件', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-fh-int-'));
    const wsReal = await fs.realpath(ws);
    const target = path.join(wsReal, 'tracked.txt');
    await fs.writeFile(target, 'before');

    const edits: Array<{ anchorId: string; absPath: string }> = [];
    const fileHistory = {
      beginSnapshot: async () => {},
      trackEdit: async (anchorId: string, absPath: string) => {
        edits.push({ anchorId, absPath });
      },
    };

    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptRead: async (_sid, idx) => {
          if (idx === 0) return { output: 'ok', isRunning: true, exitCode: null };
          await fs.writeFile(target, 'after');
          return { output: 'ok', isRunning: false, exitCode: 0 };
        },
      }).bridge,
    });

    const ctx = makeFakeContext({
      workspaceRoot: wsReal,
      fileHistory,
      agentRunId: 'run-shell-fh',
    });
    const r = await cap.tools()[0].execute({ command: 'echo mutate' }, ctx);
    const parsed = JSON.parse(r.content as string);

    expect(parsed.status).toBe('completed');
    expect(parsed.file_history).toBeDefined();
    expect(parsed.file_history.tracked_count).toBeGreaterThanOrEqual(1);
    expect(edits.some((e) => e.absPath === path.resolve(target))).toBe(true);
    expect(parsed.file_history.modified_count).toBeGreaterThanOrEqual(1);
    // 路径事实端到端透出（轮末「本轮产物」收集卡消费）
    expect(parsed.file_history.modified_paths).toEqual(['tracked.txt']);

    await fs.rm(wsReal, { recursive: true, force: true });
  });

  it('wait_ms=0 背景化时 file_history.status=deferred', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-fh-bg-'));
    const wsReal = await fs.realpath(ws);

    const { cap } = makeShellCap();
    const ctx = makeFakeContext({
      workspaceRoot: wsReal,
      fileHistory: { beginSnapshot: async () => {}, trackEdit: async () => {} },
      agentRunId: 'run-bg',
    });
    const r = await cap.tools()[0].execute({ command: 'sleep 9', wait_ms: 0 }, ctx);
    const parsed = JSON.parse(r.content as string);

    expect(parsed.status).toBe('running');
    expect(parsed.file_history?.status).toBe('deferred');
    expect(parsed.file_history?.degraded).toBe(true);
    expect(parsed.file_history?.degraded_reason).toBe('background_deferred');

    await fs.rm(wsReal, { recursive: true, force: true });
  });
});

describe('ShellCap run_terminal_command · LLM-facing result compactness', () => {
  it('completed 正常退出：canonical 保留诊断字段，LLM 上下文只保留决策字段', async () => {
    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptRead: () => ({
          output: '3229-checkpoint-test.log\n3229-vitest-full.log\n3229-vitest-full2.log\n',
          isRunning: false,
          exitCode: 0,
        }),
      }).bridge,
    });

    const r = await cap.tools()[0].execute({ command: 'ls' }, makeFakeContext());
    const canonical = JSON.parse(r.content as string);
    // ：LLM 边界投影单源 buildShellLlmContextContent（见文件头 import 说明）。
    const llm = JSON.parse(buildShellLlmContextContent(canonical));

    expect(canonical.status).toBe('completed');
    expect(typeof canonical.session_id).toBe('string');
    expect(typeof canonical.output_file).toBe('string');
    expect(canonical.exited_by).toBe('normal_exit');
    expect(typeof canonical.duration_ms).toBe('number');

    expect(llm).toEqual({
      status: 'completed',
      exit_code: 0,
      stdout: '3229-checkpoint-test.log\n3229-vitest-full.log\n3229-vitest-full2.log\n',
    });
  });

  it('completed 有文件变化：canonical 保留 file_history，LLM 上下文隐藏 file_history', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-llm-fh-'));
    const wsReal = await fs.realpath(ws);
    const target = path.join(wsReal, 'tracked.txt');
    await fs.writeFile(target, 'before');

    const { cap } = makeShellCap({
      bridge: makeBridgeMock({
        scriptRead: async (_sid, idx) => {
          if (idx === 0) return { output: 'ok', isRunning: true, exitCode: null };
          await fs.writeFile(target, 'after');
          return { output: 'ok', isRunning: false, exitCode: 0 };
        },
      }).bridge,
    });

    const r = await cap.tools()[0].execute(
      { command: 'echo mutate' },
      makeFakeContext({
        workspaceRoot: wsReal,
        fileHistory: { beginSnapshot: async () => {}, trackEdit: async () => {} },
        agentRunId: 'run-shell-llm-fh',
      }),
    );
    const canonical = JSON.parse(r.content as string);
    const llm = JSON.parse(buildShellLlmContextContent(canonical));

    expect(canonical.file_history.tracked_count).toBeGreaterThanOrEqual(1);
    expect(canonical.file_history.modified_count).toBeGreaterThanOrEqual(1);
    expect(llm.file_history).toBeUndefined();

    await fs.rm(wsReal, { recursive: true, force: true });
  });

  it('running 后台任务：LLM 上下文保留继续操作所需字段', async () => {
    const { cap } = makeShellCap();
    const r = await cap.tools()[0].execute({ command: 'sleep 9', wait_ms: 0 }, makeFakeContext());
    const canonical = JSON.parse(r.content as string);
    const llm = JSON.parse(buildShellLlmContextContent(canonical));

    expect(canonical.status).toBe('running');
    expect(canonical.file_history?.status).toBe('deferred');
    expect(llm.status).toBe('running');
    expect(llm.session_id).toBe(canonical.session_id);
    expect(llm.output_file).toBe(canonical.output_file);
    expect(llm.hint).toBeDefined();
    expect(llm.file_history).toBeUndefined();
  });
});

// ─── Wave3：timeout 硬错误 + schema 边界（不再 clamp / input_clamped）──────────

describe('ShellCap Wave3 wait_ms / hard_timeout_ms 硬错误', () => {
  it('wait_ms 越上界 → schema validator + execute 均失败且不 spawn；无 input_clamped', async () => {
    const { cap, mock } = makeShellCap();
    const schema = cap.tools()[0].inputSchema;
    const over = SHELL_WAIT_MS_MAX + 1;
    const schemaResult = validateToolInput(schema, { command: 'echo', wait_ms: over });
    expect(schemaResult.valid).toBe(false);
    expect(schemaResult.errors.some((e) => e.path === 'wait_ms' && e.rule === 'maximum')).toBe(true);

    const r = await cap.tools()[0].execute({ command: 'echo', wait_ms: over }, makeFakeContext());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string);
    expect(parsed.error_kind).toBe(INVALID_PARAM_FORMAT);
    expect(parsed).not.toHaveProperty('input_clamped');
    expect(mock.executeCalls).toHaveLength(0);
  });

  it('wait_ms 越下界 → execute 失败且不 spawn', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'echo', wait_ms: SHELL_WAIT_MS_MIN - 1 },
      makeFakeContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content as string).error_kind).toBe(INVALID_PARAM_FORMAT);
    expect(mock.executeCalls).toHaveLength(0);
  });

  it('wait_ms 上界附近的小数 → execute 失败且不 spawn', async () => {
    const { cap, mock } = makeShellCap();
    const r = await cap.tools()[0].execute(
      { command: 'echo', wait_ms: SHELL_WAIT_MS_MAX + 0.5 },
      makeFakeContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content as string).error_kind).toBe(INVALID_PARAM_FORMAT);
    expect(mock.spawnDetachedCalls).toHaveLength(0);
  });

  it('hard_timeout_ms 越上界 → schema + execute 失败且不 spawn', async () => {
    const { cap, mock } = makeShellCap();
    const schema = cap.tools()[0].inputSchema;
    const over = SHELL_HARD_TIMEOUT_MS_MAX + 1;
    const schemaResult = validateToolInput(schema, {
      command: 'echo',
      hard_timeout_ms: over,
    });
    expect(schemaResult.valid).toBe(false);
    expect(schemaResult.errors.some((e) => e.path === 'hard_timeout_ms' && e.rule === 'maximum')).toBe(
      true,
    );

    const r = await cap.tools()[0].execute(
      { command: 'echo', hard_timeout_ms: over },
      makeFakeContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content as string).error_kind).toBe(INVALID_PARAM_FORMAT);
    expect(mock.executeCalls).toHaveLength(0);
  });

  it('边界值 wait_ms=0 / MAX 与 hard_timeout_ms=MIN / MAX 可执行', async () => {
    const { cap, mock } = makeShellCap();
    for (const input of [
      { command: 'echo ok', wait_ms: SHELL_WAIT_MS_MIN },
      { command: 'echo ok', wait_ms: SHELL_WAIT_MS_MAX },
      { command: 'echo ok', wait_ms: 0, hard_timeout_ms: SHELL_HARD_TIMEOUT_MS_MIN },
      { command: 'echo ok', wait_ms: 0, hard_timeout_ms: SHELL_HARD_TIMEOUT_MS_MAX },
    ]) {
      mock.executeCalls.length = 0;
      const r = await cap.tools()[0].execute(input, makeFakeContext());
      expect(r.isError).not.toBe(true);
      expect(mock.executeCalls.length).toBeGreaterThan(0);
      expect(JSON.parse(r.content as string)).not.toHaveProperty('input_clamped');
    }
  });
});
