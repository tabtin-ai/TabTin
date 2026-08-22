/**
 * W2（resume 续跑/追发，2026-05-30）：主 Agent 用子 Agent 返回的 [子 Agent ID]
 * 续跑那个子 Agent 的端到端测试。
 *
 * W2 建立在 W1（childId 回传）之上：主 Agent 先从 tool_result 拿到稳定 childId，
 * 再用 `resume_agent_id` 续跑——复用同一 childId 定位已有子 session，读回子自己
 * 上一轮的产出历史 + append 新 `<active-directive>`，经 initialMessages 通道喂入。
 *
 * 关键不变量：
 *   1. resume 真的**读回**子上一轮的历史（restoreMessages），而不是从父快照重建。
 *   2. 新 directive **生效**（taskPrompt 作为 <active-directive> 进入子上下文）。
 *   3. resume 分支**跳过 buildForkedMessages**——parentMessages 不会泄漏进子上下文。
 *   4. tool-pairing：读回历史里未配对的 tool_use 被 query.ts 的
 *      ensureToolResultPairing 自动兜底（合成占位 tool_result），不产生 API 非法形态。
 *   5. resume 一个**不存在**的 childId → 显式 isError「会话不存在或已失效」，不静默跑空。
 *   6. agent 工具层：spawn 拿到 [子 Agent ID] → resume 同 id → SUBAGENT_STARTED 标 resumed
 *      + 终态正常 + 仍回传同一 childId（W1 链路一致）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createAgentTool } from '../src/subagent/agent-tool.js';
import { forkQuery } from '../src/subagent/fork-query.js';
import { SessionStorage } from '../src/session/storage.js';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import {
  createMockPermissionHandler,
  createMockProvider,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
  MessageParam,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMProvider,
  LLMRequest,
} from '../src/engine/contracts/model-llm.js';
import type {
  ToolContext,
} from '../src/engine/contracts/tools.js';

const PARENT_THREAD = 'parent-w2-resume';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-resume-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    threadId: PARENT_THREAD,
    runtimeId: 'test-session',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    ...overrides,
  } as ToolContext;
}

/** 子 session 的 SessionStorage 配置（与 forkQuery 内部拼法一致）。 */
function childStorageConfig(childId: string) {
  return {
    sessionDir: path.join(tmpDir, PARENT_THREAD, 'subagents'),
    threadId: `agent-${childId}`,
  };
}

/** drain 一整条 forkQuery generator 并返回最终 summary。 */
async function drainFork(gen: AsyncGenerator<StreamEvent, string>): Promise<string> {
  let n = await gen.next();
  while (!n.done) n = await gen.next();
  return n.value;
}

/** 捕获第一次 createStream 收到的 messages 的 provider（验证子上下文实际装填）。 */
function capturingProvider(finalText: string): {
  provider: LLMProvider;
  getFirstMessages: () => MessageParam[] | undefined;
} {
  let first: MessageParam[] | undefined;
  const provider: LLMProvider = {
    async *createStream(request: LLMRequest) {
      if (!first) first = request.messages;
      yield { type: 'text_delta' as const, text: finalText };
      yield { type: 'stop' as const, stopReason: 'end_turn' as const };
    },
  };
  return { provider, getFirstMessages: () => first };
}

describe('W2 forkQuery resume 分支', () => {
  it('真实 spawn → resume：读回子历史 + 新 directive 生效 + 不泄漏 parentMessages', async () => {
    const childId = 'round-trip-0001';

    // ── 1) 真实 spawn 一个子，产出可识别的 assistant 历史 ──
    const spawnGen = forkQuery({
      childId,
      parentMessages: [],
      taskPrompt: 'SPAWN_TASK_MARKER',
      systemPrompt: '',
      provider: createMockProvider([
        [
          { type: 'text_delta', text: 'SPAWN_OUTPUT_MARKER 调研已完成' },
          { type: 'stop', stopReason: 'end_turn' },
        ],
      ]),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
    });
    const spawnSummary = await drainFork(spawnGen);
    expect(spawnSummary).toContain('SPAWN_OUTPUT_MARKER');

    // 子历史已落盘到 sidechain，并可恢复给后续 resume。
    const restoredAfterSpawn = await new SessionStorage(childStorageConfig(childId)).restoreMessages();
    expect(JSON.stringify(restoredAfterSpawn)).toContain('SPAWN_OUTPUT_MARKER');

    // ── 2) resume 同一 childId + 新 directive ──
    const { provider, getFirstMessages } = capturingProvider('RESUME_OUTPUT_MARKER 续跑完成');
    const resumeGen = forkQuery({
      resume: true,
      childId,
      // 故意塞一条 parentMessages marker——resume 应跳过 buildForkedMessages，不泄漏它。
      parentMessages: [{ role: 'user', content: 'PARENT_LEAK_MARKER 不该出现在子上下文' }],
      taskPrompt: 'RESUME_DIRECTIVE_MARKER 请基于之前的结果继续',
      systemPrompt: '',
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
    });
    const resumeSummary = await drainFork(resumeGen);

    // 续跑产出
    expect(resumeSummary).toContain('RESUME_OUTPUT_MARKER');

    // 子上下文装填断言
    const captured = getFirstMessages();
    expect(captured, 'resume query 应实际调用 provider').toBeTruthy();
    const capturedJson = JSON.stringify(captured);
    // ① 读回了子上一轮的产出历史
    expect(capturedJson, '应读回子上一轮 assistant 历史').toContain('SPAWN_OUTPUT_MARKER');
    // ② 新 directive 生效
    expect(capturedJson, '新 directive 应进入子上下文').toContain('RESUME_DIRECTIVE_MARKER');
    // ③ 跳过 buildForkedMessages：parentMessages 不泄漏
    expect(capturedJson, 'resume 不应泄漏 parentMessages').not.toContain('PARENT_LEAK_MARKER');
    // 首条是 user（resumed-context 框定），满足 provider 首条角色预期
    expect(captured![0].role).toBe('user');
  });

  it('多轮 resume：第二次 resume 能读回 run1 + run2 累积的全部历史', async () => {
    const childId = 'multi-resume-0003';
    const base = {
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
      systemPrompt: '',
    };

    // run1 spawn
    await drainFork(forkQuery({
      ...base,
      childId,
      parentMessages: [],
      taskPrompt: 'RUN1_TASK',
      provider: createMockProvider([
        [{ type: 'text_delta', text: 'RUN1_OUTPUT_MARKER' }, { type: 'stop', stopReason: 'end_turn' }],
      ]),
    }));

    // run2 resume
    await drainFork(forkQuery({
      ...base,
      resume: true,
      childId,
      parentMessages: [],
      taskPrompt: 'RUN2_TASK',
      provider: createMockProvider([
        [{ type: 'text_delta', text: 'RUN2_OUTPUT_MARKER' }, { type: 'stop', stopReason: 'end_turn' }],
      ]),
    }));

    // run3 resume：捕获装填，应同时含 run1 + run2 的产出
    const { provider, getFirstMessages } = capturingProvider('RUN3_OUTPUT_MARKER');
    await drainFork(forkQuery({
      ...base,
      resume: true,
      childId,
      parentMessages: [],
      taskPrompt: 'RUN3_TASK',
      provider,
    }));

    const capturedJson = JSON.stringify(getFirstMessages());
    expect(capturedJson, 'run3 应读回 run1 历史').toContain('RUN1_OUTPUT_MARKER');
    expect(capturedJson, 'run3 应读回 run2 历史').toContain('RUN2_OUTPUT_MARKER');
    expect(capturedJson, 'run3 新 directive 生效').toContain('RUN3_TASK');

    // 索引：subagents.jsonl 应有 3 组 started（run1/2/3）+ 折叠到 runSeq=3
    const indexPath = path.join(tmpDir, PARENT_THREAD, 'subagents.jsonl');
    const lines = fs.readFileSync(indexPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const starts = lines.filter((l) => l.phase === 'started' && l.subSessionId === `agent-${childId}`);
    expect(starts).toHaveLength(3);
    expect(starts.map((s) => s.runSeq).sort()).toEqual([1, 2, 3]);
  });

  it('tool-pairing：读回历史里未配对的 tool_use 被 ensureToolResultPairing 兜底', async () => {
    const childId = 'pairing-0002';

    // 预置子历史：一条**末尾 orphan tool_use** 的 assistant。W2.1 后子 messages.jsonl
    // 已落 assistant + tool_result；这种「tool_use 无配对 result」只在罕见边界出现
    // （最后一条 result 没轮到落盘就被 maxTurns/abort 截断），仍需 ensureToolResultPairing
    // 兜底配对——本用例锁这条兜底路径。
    const cfg = childStorageConfig(childId);
    const seed = new SessionStorage(cfg);
    await seed.recordAssistantMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'PAIRING_HISTORY_MARKER 我调了一个工具' },
        { type: 'tool_use', id: 'tu_orphan_1', name: 'read_file', input: { path: 'a.txt' } },
      ],
    });
    await seed.dispose();

    const { provider, getFirstMessages } = capturingProvider('PAIRING_RESUME_DONE');
    const gen = forkQuery({
      resume: true,
      childId,
      parentMessages: [],
      taskPrompt: 'RESUME_AFTER_TOOL',
      systemPrompt: '',
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
    });
    await drainFork(gen);

    const captured = getFirstMessages();
    expect(captured).toBeTruthy();

    // 收集 tool_use / tool_result id：每个 tool_use 必须有匹配的 tool_result
    // （ensureToolResultPairing 会为 orphan tool_use 合成 is_error 占位 result）。
    const useIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of captured!) {
      const content = (m as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use' && typeof block.id === 'string') useIds.add(block.id);
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          resultIds.add(block.tool_use_id as string);
        }
      }
    }
    // orphan tool_use 被兜底配对（没有"裸 tool_use 无 result"）
    for (const id of useIds) {
      expect(resultIds.has(id), `tool_use ${id} 应有匹配的 tool_result`).toBe(true);
    }
    // 历史的确读回了（含那条 tool_use 的文本）
    expect(JSON.stringify(captured)).toContain('PAIRING_HISTORY_MARKER');
  });

  it('resume 不存在的子 session（空目录）→ 抛 SubagentResumeNotFoundError', async () => {
    const gen = forkQuery({
      resume: true,
      childId: 'never-existed-9999',
      parentMessages: [],
      taskPrompt: '续跑一个不存在的子',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
    });

    await expect(drainFork(gen)).rejects.toThrow(/会话不存在或已失效/);
  });
});

describe('W2 agent 工具层 resume', () => {
  it('spawn → resume_agent_id 续跑：标 resumed + 终态正常 + 回传同一 childId', async () => {
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
      model: 'claude-sonnet-4-20250514',
    });

    const AGENT_ID_RE = /\[子 Agent ID: ([0-9a-zA-Z-]+)\]/;

    // ── spawn ──
    const spawnEvents: StreamEvent[] = [];
    const spawnResult = await tool.execute(
      { prompt: '先做一轮调研' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => spawnEvents.push(e) }),
    );
    expect(spawnResult.isError).toBeFalsy();
    const m = String(spawnResult.content).match(AGENT_ID_RE);
    expect(m, 'spawn 结果应带 [子 Agent ID]').toBeTruthy();
    const childId = m![1];

    // ── resume 同一 childId ──
    const resumeEvents: StreamEvent[] = [];
    const resumeResult = await tool.execute(
      { prompt: '基于刚才的结果继续追问', resume_agent_id: childId },
      makeContext({ emitStreamEvent: (e: StreamEvent) => resumeEvents.push(e) }),
    );

    expect(resumeResult.isError).toBeFalsy();
    // SUBAGENT_STARTED 标 resumed: true
    const started = resumeEvents.find((e) => e.type === StreamEvents.SUBAGENT_STARTED);
    expect(started, 'resume 应 emit SUBAGENT_STARTED').toBeTruthy();
    expect((started!.payload as { resumed?: boolean }).resumed, 'STARTED 应标 resumed').toBe(true);
    expect((started!.payload as { subagent_run_id?: string }).subagent_run_id).toBe(childId);
    // 终态回传同一 childId（W1 链路一致）
    const m2 = String(resumeResult.content).match(AGENT_ID_RE);
    expect(m2, 'resume 结果也应带 [子 Agent ID]').toBeTruthy();
    expect(m2![1], 'resume 回传的 childId 应与原子一致').toBe(childId);
    // 完成事件
    expect(resumeEvents.find((e) => e.type === StreamEvents.SUBAGENT_COMPLETED)).toBeTruthy();
  });

  it('并发续跑同一 childId（同回复并行 resume）→ 第二个被 in-flight 守门拒绝', async () => {
    // 先 spawn 一个子产出可读回的历史
    const spawnTool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
      model: 'claude-sonnet-4-20250514',
    });
    const AGENT_ID_RE = /\[子 Agent ID: ([0-9a-zA-Z-]+)\]/;
    const spawnResult = await spawnTool.execute({ prompt: '先跑一轮' }, makeContext());
    const childId = String(spawnResult.content).match(AGENT_ID_RE)![1];

    // 用一个会卡住的 provider 让 resume 的第一个 run 停在运行中（占住 activeChildren），
    // 这样第二个并发 resume 的 in-flight 守门能确定性命中。
    let releaseBlock!: () => void;
    const blockPromise = new Promise<void>((resolve) => { releaseBlock = resolve; });
    const blockingProvider: LLMProvider = {
      async *createStream() {
        yield { type: 'text_delta' as const, text: '续跑中' };
        await blockPromise;
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };
    const resumeTool = createAgentTool({
      provider: blockingProvider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
      model: 'claude-sonnet-4-20250514',
    });

    // 第一个 resume：启动后卡住（不 await 完成）
    const firstEvents: StreamEvent[] = [];
    const firstPromise = resumeTool.execute(
      { prompt: '续跑 A', resume_agent_id: childId },
      makeContext({ emitStreamEvent: (e: StreamEvent) => firstEvents.push(e) }),
    );
    // 等第一个真正进入运行（SUBAGENT_STARTED → activeChildren 已登记）
    await new Promise((r) => setTimeout(r, 20));
    expect(firstEvents.find((e) => e.type === StreamEvents.SUBAGENT_STARTED)).toBeTruthy();

    // 第二个并发 resume 同一 childId：应被 in-flight 守门拒绝
    const secondResult = await resumeTool.execute(
      { prompt: '续跑 B（并发）', resume_agent_id: childId },
      makeContext(),
    );
    expect(secondResult.isError).toBe(true);
    expect(String(secondResult.content)).toContain('正在运行中');
    expect(String(secondResult.content)).not.toMatch(/子 Agent ID/);

    // 放行第一个，确认它正常完成（守门没误伤正在跑的那个）
    releaseBlock();
    const firstResult = await firstPromise;
    expect(firstResult.isError).toBeFalsy();
  });

  it('resume 不存在的 childId → 显式 isError，不 emit STARTED', async () => {
    const events: StreamEvent[] = [];
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute(
      { prompt: '续跑一个根本不存在的子', resume_agent_id: 'ghost-child-id-xyz' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('该子 Agent 会话不存在或已失效');
    // 幽灵 resume 不该消耗调度 / 不 emit STARTED
    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED)).toBeUndefined();
    // 也不该回传 [子 Agent ID]（无执行状态）
    expect(String(result.content)).not.toMatch(/子 Agent ID/);
  });
});
