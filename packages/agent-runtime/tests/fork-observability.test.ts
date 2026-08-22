/**
 * fork-observability.test.ts — 阶段 8 子 Agent 可观测性端到端验证
 *
 * 跑真实的 `forkQuery`，让真实 SnapshotStorage / EventStorage / SubagentIndexWriter
 * 落盘到临时目录，然后扫文件断言三件套都被写入。
 *
 * 不 mock `engine/query.js` —— 子 runtime 走真实主循环，能 emit `agent.stream.llm_request`，
 * 走真实 fork-query 的拦截路径写入子 snapshots.jsonl。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { forkQuery } from '../src/subagent/fork-query.js';
import { SessionStorage } from '../src/session/storage.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';

const PARENT_SESSION_ID = 'parent-session-fork-obs';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-obs-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readJsonLines(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parentSessionDir(): string {
  return path.join(tmpDir, PARENT_SESSION_ID);
}

function listChildSessionDirs(): string[] {
  const subagentsRoot = path.join(parentSessionDir(), 'subagents');
  if (!fs.existsSync(subagentsRoot)) return [];
  return fs
    .readdirSync(subagentsRoot)
    .filter((name) => name.startsWith('agent-'))
    .map((name) => path.join(subagentsRoot, name));
}

async function restoreChildMessages(childDir: string): Promise<Message[]> {
  return new SessionStorage({
    sessionDir: path.dirname(childDir),
    threadId: path.basename(childDir),
  }).restoreMessages();
}

describe('forkQuery — 子 Agent 可观测性落盘（阶段 8）', () => {
  it('子 LLM_REQUEST 写入 {sub}/snapshots.jsonl，父写入 subagents.jsonl 两条索引', async () => {
    const provider = createMockProvider([
      [
        { type: 'text_delta', text: 'child done' },
        { type: 'usage', usage: { input_tokens: 7, output_tokens: 3 } },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: '帮我跑一个调研',
      systemPrompt: '',
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_SESSION_ID },
    });

    // drain 整条 generator 让 finally 段执行
    for await (const _ of gen) {
      void _;
    }

    // 1. 子 session 目录存在，子 snapshots / events 文件存在
    const childDirs = listChildSessionDirs();
    expect(childDirs).toHaveLength(1);
    const childDir = childDirs[0];

    const snapshotsPath = path.join(childDir, 'snapshots.jsonl');
    const eventsPath = path.join(childDir, 'events.jsonl');
    expect(fs.existsSync(snapshotsPath)).toBe(true);
    expect(fs.existsSync(eventsPath)).toBe(true);

    // 2. snapshots.jsonl 至少含一条 LLMCallSnapshot（payload.runId / payload.model 字段）
    const snapshots = readJsonLines(snapshotsPath) as Array<Record<string, unknown>>;
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const first = snapshots[0];
    expect(typeof first.runId).toBe('string');
    expect(first.model).toBe('sonnet');
    expect(typeof first.iteration).toBe('number');
    // system / messages / tools 三个区段都应有结构性字段
    expect(first.system).toBeDefined();
    expect(first.messages).toBeDefined();
    expect(first.tools).toBeDefined();

    // 3. events.jsonl 含若干 stream event（至少包含 lifecycle / llm_request / done）
    const events = readJsonLines(eventsPath) as Array<{ type: string }>;
    const types = events.map((e) => e.type);
    expect(types).toContain('agent.stream.llm_request');
    expect(types).toContain('agent.stream.done');

    // 6. 子 sidechain 历史落盘子 Agent 自己的 assistant 产出
    const childMessages = await restoreChildMessages(childDir);
    expect(childMessages.length).toBeGreaterThan(0);

    // 4. 父 subagents.jsonl 索引含 started + ended，paths 是相对路径（Review fix）
    const indexLines = readJsonLines(path.join(parentSessionDir(), 'subagents.jsonl')) as Array<
      Record<string, unknown>
    >;
    expect(indexLines).toHaveLength(2);
    const started = indexLines[0] as {
      phase: string;
      parentSessionId: string;
      task: string;
      model: string;
      childId: string;
      paths: Record<string, string>;
      parentToolCallId?: string;
    };
    const ended = indexLines[1] as {
      phase: string;
      status: string;
      durationMs: number;
      finalTextLength: number;
      childId: string;
    };
    expect(started.phase).toBe('started');
    expect(ended.phase).toBe('ended');
    expect(started.parentSessionId).toBe(PARENT_SESSION_ID);
    expect(started.task).toBe('帮我跑一个调研');
    expect(started.model).toBe('sonnet');
    expect(typeof started.childId).toBe('string');
    expect(started.childId.length).toBeGreaterThan(0);

    // paths 相对父 session 目录（review fix #4）：消费方按 parentSessionDir + 字段拼
    expect(started.paths.snapshotsPath).toBe(path.join('subagents', `agent-${started.childId}`, 'snapshots.jsonl'));
    expect(started.paths.eventsPath).toBe(path.join('subagents', `agent-${started.childId}`, 'events.jsonl'));
    expect(started.paths.messagesPath).toBe(path.join('subagents', `agent-${started.childId}`, 'messages.jsonl'));
    expect(started.paths.messageBlocksPath).toBe(path.join('subagents', `agent-${started.childId}`, 'message-blocks.jsonl'));
    // 消费方 join 出来的绝对路径必须能命中实际文件
    expect(fs.existsSync(path.join(parentSessionDir(), started.paths.snapshotsPath))).toBe(true);
    expect(fs.existsSync(path.join(parentSessionDir(), started.paths.eventsPath))).toBe(true);
    expect(fs.existsSync(path.join(parentSessionDir(), started.paths.messageBlocksPath))).toBe(true);

    // 此用例 caller 不带 parentToolCallId（直接调 forkQuery 模拟），字段缺省
    expect('parentToolCallId' in started).toBe(false);

    // 5. ended 行附带最终状态 + duration + 与 started.childId 同源
    expect(ended.status).toBe('completed');
    expect(typeof ended.durationMs).toBe('number');
    expect(ended.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof ended.finalTextLength).toBe('number');
    expect(ended.childId).toBe(started.childId);
  });

  it('继承父历史的子 Agent：轮内 message 规整缩短不导致漏写子历史（回归）', async () => {
    // 回归「子 Agent 详情冷路径 file_missing」根因：旧实现 recordChildAssistant
    // 用 index 游标（recordedUpToIndex），baseline 在 beforeIteration 采样。但
    //   - parentMessages 非空 → buildForkedMessages 会在最前 unshift 一条
    //     <inherited-context> user notice，与继承的首条 user 形成「连续 user」；
    //   - 轮内 normalizeMessages（beforeIteration 之后、assistant push 之前）把
    //     连续 user 合并 → state.messages 比 baseline 短。
    // 于是 afterIteration 的 `for (i = baseline; i < length)` 空转，子 assistant
    // 一条都不落盘——messages.jsonl 根本不会被创建（dogfood 实测）。
    //
    // 对照组 `parentMessages: []`（本文件首个用例）没有 unshift、无连续 user、
    // 无缩短，所以一直是绿的、掩盖了本 bug。这里用「非空父历史」精确复现。
    const provider = createMockProvider([
      [
        { type: 'text_delta', text: 'child-reply-42' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const parentMessages: Message[] = [
      { role: 'user', content: '子agent的dogfood验证，派两个子agent回复1和2' },
      { role: 'assistant', content: [{ type: 'text', text: '好的，我来派子 agent' }] },
    ];

    const gen = forkQuery({
      parentMessages,
      taskPrompt: '请回复数字：1',
      systemPrompt: '',
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_SESSION_ID },
    });
    for await (const _ of gen) {
      void _;
    }

    const childDirs = listChildSessionDirs();
    expect(childDirs).toHaveLength(1);
    const childMessages = await restoreChildMessages(childDirs[0]);
    expect(childMessages.length).toBeGreaterThan(0);
    // 子 assistant 真实产出（child-reply-42）必须落盘
    expect(JSON.stringify(childMessages)).toContain('child-reply-42');
  });

  it('父 hooks.afterIteration 在 readonly / 非 readonly 两路都只被调一次（收口回归）', async () => {
    // 旧实现：recordChildAssistant 内部 `await parentHooks.afterIteration` 给非
    // readonly 的 spread override 补 chain；但 readonly 用 composeHooks 已把
    // parentHooks 串进列表，于是 readonly 路径父钩子每轮触发两次（CostCap 按轮
    // 累加 / telemetry 等副作用翻倍）。收口后两路都只在 composeHooks 串一次。
    async function countAfterIteration(readonlySubagent: boolean): Promise<number> {
      let calls = 0;
      const provider = createMockProvider([
        [
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ],
      ]);
      const gen = forkQuery({
        parentMessages: [],
        taskPrompt: 'count parent afterIteration',
        systemPrompt: '',
        provider,
        tools: createMockToolProvider(),
        permissionHandler: createMockPermissionHandler(),
        model: 'sonnet',
        sessionConfig: { sessionDir: tmpDir, threadId: PARENT_SESSION_ID },
        hooks: {
          afterIteration: async () => {
            calls += 1;
          },
        },
        readonlySubagent,
      });
      for await (const _ of gen) {
        void _;
      }
      return calls;
    }

    const nonReadonlyCalls = await countAfterIteration(false);
    const readonlyCalls = await countAfterIteration(true);

    // 单轮 mock（end_turn 无工具）→ 1 次迭代 → 父钩子恒定 1 次；两路对称。
    expect(nonReadonlyCalls).toBe(1);
    expect(readonlyCalls).toBe(1);
    expect(readonlyCalls).toBe(nonReadonlyCalls);
  });

  it('signal.aborted=true 时抛错 → ended 行 status=cancelled', async () => {
    // 关键路径：`fork-query.ts` 的 catch 段读 `config.signal?.aborted` 来区分
    // cancelled vs failed。query.ts 内部 `addEventListener('abort', once)` 注册
    // 在 createStream 调用之前——预先 abort 的 signal 加 listener 不会重放事件，
    // 所以这里让 provider 在 createStream 入口同步 abort + throw，模拟"运行
    // 中被取消"的真实时序（cancelSubagent / Electron handleQuery 主动 abort 同款）。
    const controller = new AbortController();
    const provider = {
      async *createStream(): AsyncIterable<{ type: string }> {
        controller.abort();
        // signal.aborted 为 true 后再抛错，让 fork-query catch 看到 aborted=true
        // → 走 cancelled 分支而非 failed。
        throw new Error('aborted mid-stream');
      },
    };

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'cancel-me',
      systemPrompt: '',
      provider: provider as unknown as Parameters<typeof forkQuery>[0]['provider'],
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_SESSION_ID },
      signal: controller.signal,
    });

    try {
      for await (const _ of gen) {
        void _;
      }
    } catch {
      // forkQuery rethrow —— 预期路径
    }

    const indexLines = readJsonLines(path.join(parentSessionDir(), 'subagents.jsonl')) as Array<
      Record<string, unknown>
    >;
    const ended = indexLines.find((l) => l.phase === 'ended') as Record<string, unknown> | undefined;
    expect(ended).toBeDefined();
    expect(ended!.status).toBe('cancelled');
  });

  it('优雅 abort（引擎 emit error DONE 不抛，2026-06-04 dogfood 复现）→ forkQuery 转抛 + ended=cancelled', async () => {
    // 复现根因：用户 stop 子 Agent 时，引擎走 abort grace 路径——emit 一条
    // `done{error:true,error_class:'ABORT'}` 后**正常结束** for-await（不抛）。
    // 修前 forkQuery 因 generator 正常返回 → endStatus 停在默认 'completed'，
    // 把「被 stop」误记成完成（subagents.jsonl status=completed、live 也显示完成、
    // chip 不翻终态 → 用户感知「stop 不了」）。本用例锁：优雅 abort 必须落 cancelled。
    //
    // 触发手法同 engine-error-class.test 的 ABORT 用例：工具 execute 内 abort 信号，
    // 工具返回后 query 下一次 checkAbort 命中 → 内部抛 ABORT → grace DONE → 正常返回。
    const controller = new AbortController();
    const aborter: Tool = {
      name: 'aborter',
      description: 'abort the run mid-flight',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true, // readonly：免权限门，专注验证 abort 收口
      execute: async () => {
        controller.abort();
        return { content: 'aborted-now' };
      },
    };
    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'c1', name: 'aborter', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
    ]);

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'cancel-me-gracefully',
      systemPrompt: '',
      provider,
      tools: createMockToolProvider([aborter]),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_SESSION_ID },
      signal: controller.signal,
    });

    let threw = false;
    let sawGracefulErrorDone = false;
    try {
      for await (const ev of gen) {
        if (ev.type === 'agent.stream.done') {
          const p = ev.payload as { error?: boolean; error_class?: string };
          if (p?.error && p.error_class === 'ABORT') sawGracefulErrorDone = true;
        }
      }
    } catch {
      threw = true; // 修复点：forkQuery 把优雅 abort 主动转抛
    }

    // 1. 确证复现到「优雅 error DONE」路径（不是 provider 抛错那条），否则测的是别的 bug
    expect(sawGracefulErrorDone).toBe(true);
    // 2. forkQuery 现在对优雅 abort 主动转抛（喂给 agent-tool catch 做终态分类）
    expect(threw).toBe(true);
    // 3. 落盘状态 = cancelled（修前是 'completed' —— 本用例正是回归保护）
    const indexLines = readJsonLines(path.join(parentSessionDir(), 'subagents.jsonl')) as Array<
      Record<string, unknown>
    >;
    const ended = indexLines.find((l) => l.phase === 'ended') as Record<string, unknown> | undefined;
    expect(ended).toBeDefined();
    expect(ended!.status).toBe('cancelled');
  });

  it('failed 子 Agent 也会在 subagents.jsonl 留下 ended 行', async () => {
    // provider 主动抛错模拟子 query 异常路径——验证 fork-query 的 try/catch/finally
    // 仍会写一条 phase=ended + status=failed 的索引。
    const provider = {
      async *createStream(): AsyncIterable<{ type: string }> {
        // 一边吐 chunk 一边抛 —— 让主循环至少进过 LLM_REQUEST yield，再被异常打断
        yield { type: 'text_delta' as const };
        throw new Error('boom from provider');
      },
    };

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'failing task',
      systemPrompt: '',
      provider: provider as unknown as Parameters<typeof forkQuery>[0]['provider'],
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_SESSION_ID },
    });

    try {
      for await (const _ of gen) {
        void _;
      }
    } catch {
      // forkQuery rethrow —— 预期路径
    }

    const indexLines = readJsonLines(path.join(parentSessionDir(), 'subagents.jsonl')) as Array<
      Record<string, unknown>
    >;
    expect(indexLines.length).toBeGreaterThanOrEqual(2);
    const ended = indexLines.find((l) => l.phase === 'ended') as Record<string, unknown> | undefined;
    expect(ended).toBeDefined();
    // 异常路径 → status = failed；cancelled 仅在 signal.aborted=true 时出现，
    // 本测不带 signal，所以确定走 failed 分支。
    expect(ended!.status).toBe('failed');
    const endedTyped = ended as { errorMessage?: string };
    expect(typeof endedTyped.errorMessage).toBe('string');
    expect(endedTyped.errorMessage!.length).toBeGreaterThan(0);
  });

  it('parentToolCallId 透传：started 行带 ID，可反向定位父 messages.jsonl 上的 tool_use', async () => {
    const provider = createMockProvider([
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'reverse-link',
      systemPrompt: '',
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_SESSION_ID },
      parentToolCallId: 'toolu_parent_xyz',
    });

    for await (const _ of gen) {
      void _;
    }

    const indexLines = readJsonLines(path.join(parentSessionDir(), 'subagents.jsonl')) as Array<
      Record<string, unknown>
    >;
    const started = indexLines.find((l) => l.phase === 'started') as { parentToolCallId?: string };
    expect(started?.parentToolCallId).toBe('toolu_parent_xyz');
  });

  it('并发 fork：N 个子 Agent 同时跑，subagents.jsonl 有 2N 行 + 所有 JSON 可解析', async () => {
    const N = 4;
    const provider = createMockProvider(
      Array.from({ length: N }, () => [
        { type: 'text_delta', text: 'p' },
        { type: 'stop', stopReason: 'end_turn' as const },
      ]),
    );

    await Promise.all(
      Array.from({ length: N }, () =>
        (async () => {
          const gen = forkQuery({
            parentMessages: [],
            taskPrompt: 'concurrent task',
            systemPrompt: '',
            provider,
            tools: createMockToolProvider(),
            permissionHandler: createMockPermissionHandler(),
            model: 'sonnet',
            sessionConfig: { sessionDir: tmpDir, threadId: PARENT_SESSION_ID },
          });
          for await (const _ of gen) {
            void _;
          }
        })(),
      ),
    );

    const indexFile = path.join(parentSessionDir(), 'subagents.jsonl');
    expect(fs.existsSync(indexFile)).toBe(true);
    // 用 readJsonLines（内部 JSON.parse）—— 全部能 parse 即说明并发 appendFile 没撞坏行。
    const indexLines = readJsonLines(indexFile) as Array<{ phase: string; childId: string }>;
    expect(indexLines).toHaveLength(2 * N);
    expect(indexLines.filter((l) => l.phase === 'started')).toHaveLength(N);
    expect(indexLines.filter((l) => l.phase === 'ended')).toHaveLength(N);
    const childIds = new Set(indexLines.map((l) => l.childId));
    expect(childIds.size).toBe(N);
    // 每个子目录都真实存在 + snapshots.jsonl 非空
    const childDirs = listChildSessionDirs();
    expect(childDirs).toHaveLength(N);
    for (const dir of childDirs) {
      const sn = readJsonLines(path.join(dir, 'snapshots.jsonl'));
      expect(sn.length).toBeGreaterThanOrEqual(1);
    }
  });
});
