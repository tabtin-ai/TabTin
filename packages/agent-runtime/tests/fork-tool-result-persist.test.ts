/**
 * W2.1（子 session 持久化 tool_result，2026-05-30）端到端测试。
 *
 * 北极星：让子 session 也持久化**子自己产出的 tool_result**，使 resume 后
 * `restoreMessages()` 读回的历史包含**真实工具结果**，而不是 W2 时的
 * `[Tool result missing due to internal error]` 占位符。
 *
 * 关键不变量：
 *   1. （北极星）spawn 一个会调用工具的子 → 子历史含真实 tool_result →
 *      resume → restore 读回真实 tool_result 内容（非占位）→ 真实结果进入子上下文。
 *   2. 继承上下文 / <active-directive> / <inherited-context> 不被误落进子
 *      历史；resume 后 restore 不含重复框定噪声。
 *   3. canonical tool_result 正常落盘无损；超过 storage 灾难保护阈值时才截断，
 *      且 restoreMessages 读回仍是合法 tool_result（content 仍 string、tool_use_id 仍匹配）。
 *   4. 多轮工具调用：所有 tool_result 按序持久化，restore 后 tool_use ↔ tool_result
 *      配对完整。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { forkQuery } from '../src/subagent/fork-query.js';
import { SessionStorage } from '../src/session/storage.js';
import {
  createMockPermissionHandler,
  createMockProvider,
  createMockToolProvider,
} from './test-utils.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  ContentBlock,
  Message,
  MessageParam,
  ToolResultBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMProvider,
  LLMRequest,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';

const PARENT_THREAD = 'parent-w2.1';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2.1-toolresult-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 子 session 的 SessionStorage 配置（与 forkQuery 内部拼法一致）。 */
function childStorageConfig(childId: string) {
  return {
    sessionDir: path.join(tmpDir, PARENT_THREAD, 'subagents'),
    threadId: `agent-${childId}`,
  };
}

async function drainFork(gen: AsyncGenerator<StreamEvent, string>): Promise<string> {
  let n = await gen.next();
  while (!n.done) n = await gen.next();
  return n.value;
}

/** 捕获第一次 createStream 收到的 messages 的 provider（验证 resume 子上下文装填）。 */
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

function makeTool(name: string, execute: Tool['execute']): Tool {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    isReadOnly: true,
    execute,
  };
}

function createLegacyToolRiskPolicy() {
  return createTestToolRiskPolicyPort({
    buildEffectivePolicy: () => undefined,
    memoStore: { lookup: async () => undefined } as never,
  });
}

/** 从一组 message 里收集所有 tool_result block。 */
function collectToolResults(messages: Message[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as ContentBlock[]) {
      if ((block as { type?: string }).type === 'tool_result') {
        out.push(block as ToolResultBlock);
      }
    }
  }
  return out;
}

describe('W2.1 子 session 持久化 tool_result', () => {
  it('子 sidechain persist 写失败不阻断父线程主事件流', async () => {
    const childId = 'sidechain-failsoft-0008';
    const appendSpy = vi.spyOn(SessionStorage.prototype, 'appendStreamEvent')
      .mockRejectedValueOnce(new Error('sidechain unavailable'));
    try {
      const summary = await drainFork(forkQuery({
        childId,
        parentMessages: [],
        taskPrompt: 'RUN_WITH_BROKEN_SIDECHAIN',
        systemPrompt: '',
        provider: createMockProvider([
          [{ type: 'text_delta', text: 'SIDECHAIN_FAILSOFT_DONE' }, { type: 'stop', stopReason: 'end_turn' }],
        ]),
        tools: createMockToolProvider([]),
        permissionHandler: createMockPermissionHandler(),
        toolRiskPolicy: createLegacyToolRiskPolicy(),
        model: 'sonnet',
        sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
      }));

      expect(summary).toContain('SIDECHAIN_FAILSOFT_DONE');
    } finally {
      appendSpy.mockRestore();
    }
  });

  it('北极星：spawn 带工具的子 → 落盘真实 tool_result → resume 读回真实结果（非占位）', async () => {
    const childId = 'northstar-0001';
    const REAL_RESULT = 'REAL_TOOL_RESULT_CONTENT_8f3a 这是工具真实返回';

    const fetchTool = makeTool('fetch_notes', async () => ({ content: REAL_RESULT }));

    // ── 1) spawn：子调用一次工具后给最终回复 ──
    const spawnGen = forkQuery({
      childId,
      parentMessages: [],
      taskPrompt: 'SPAWN_TASK 调研笔记',
      systemPrompt: '',
      provider: createMockProvider([
        [
          { type: 'tool_use', toolUse: { id: 'tu_fetch_1', name: 'fetch_notes', input: { path: 'notes.txt' } } },
          { type: 'stop', stopReason: 'tool_use' },
        ],
        [
          { type: 'text_delta', text: 'CHILD_FINAL_ANSWER 调研完成' },
          { type: 'stop', stopReason: 'end_turn' },
        ],
      ]),
      tools: createMockToolProvider([fetchTool]),
      permissionHandler: createMockPermissionHandler(),
      toolRiskPolicy: createLegacyToolRiskPolicy(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
    });
    const spawnSummary = await drainFork(spawnGen);
    expect(spawnSummary).toContain('CHILD_FINAL_ANSWER');

    // ── 2) 子历史已落盘，且 restore 读回**真实** tool_result ──
    const restored = await new SessionStorage(childStorageConfig(childId)).restoreMessages();

    const toolResults = collectToolResults(restored);
    expect(toolResults, 'restore 应含至少一条 tool_result').toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe('tu_fetch_1');
    expect(toolResults[0].content).toContain(REAL_RESULT);
    // 北极星断言：绝不是 W2 时的占位符
    expect(JSON.stringify(restored)).not.toContain('[Tool result missing');
    // 完整链路：assistant(tool_use) + tool_result + 最终 assistant 都在
    expect(JSON.stringify(restored)).toContain('tu_fetch_1');
    expect(JSON.stringify(restored)).toContain('CHILD_FINAL_ANSWER');

    // ── 3) resume：真实工具结果进入子上下文（喂给 provider 的 messages） ──
    const { provider, getFirstMessages } = capturingProvider('RESUME_DONE');
    await drainFork(forkQuery({
      resume: true,
      childId,
      parentMessages: [],
      taskPrompt: 'RESUME_DIRECTIVE 基于刚才结果继续',
      systemPrompt: '',
      provider,
      tools: createMockToolProvider([fetchTool]),
      permissionHandler: createMockPermissionHandler(),
      toolRiskPolicy: createLegacyToolRiskPolicy(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
    }));

    // 断言落在 tool_result **block** 上而非整段 JSON——RESUMED_CONTEXT_NOTICE
    // 框定文案本身举例提到了占位符字样，整段 not.toContain 会误伤。
    const captured = getFirstMessages()!;
    const useIds = new Set<string>();
    const resIds = new Set<string>();
    const toolResultContents: string[] = [];
    for (const m of captured) {
      const content = (m as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_use' && typeof b.id === 'string') useIds.add(b.id);
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          resIds.add(b.tool_use_id as string);
          if (typeof b.content === 'string') toolResultContents.push(b.content);
        }
      }
    }
    // 子上下文里真实工具结果在某条 tool_result block 里
    expect(toolResultContents.some((c) => c.includes(REAL_RESULT)), 'tool_result block 应含真实结果').toBe(true);
    // 没有任何 tool_result block 被合成成占位符（北极星：不是 W2 的 missing 占位）
    for (const c of toolResultContents) {
      expect(c, 'tool_result block 不应是占位符').not.toContain('[Tool result missing');
    }
    // 配对完整：每个 tool_use 都有匹配 tool_result
    for (const id of useIds) {
      expect(resIds.has(id), `tool_use ${id} 应有匹配 tool_result`).toBe(true);
    }
  });

  it('suspendRun 收尾：wait 类工具结果在无下一轮时仍落入子历史', async () => {
    const childId = 'suspend-wait-0005';
    const WAIT_RESULT = 'WAIT_AGENT_IDS_RESULT_CHILD_DONE';
    const waitTool = makeTool('agent', async () => ({
      content: WAIT_RESULT,
      signals: {
        suspendRun: {
          reason: 'awaiting_subagents',
          pendingSubagentIds: ['grandchild-1'],
        },
      },
    }));

    const summary = await drainFork(forkQuery({
      childId,
      parentMessages: [],
      taskPrompt: 'SPAWN_TASK 等后台孙代理',
      systemPrompt: '',
      provider: createMockProvider([
        [
          {
            type: 'tool_use',
            toolUse: {
              id: 'tu_wait_agent_ids_1',
              name: 'agent',
              input: { wait_agent_ids: ['grandchild-1'] },
            },
          },
          { type: 'stop', stopReason: 'tool_use' },
        ],
      ]),
      tools: createMockToolProvider([waitTool]),
      permissionHandler: createMockPermissionHandler(),
      toolRiskPolicy: createLegacyToolRiskPolicy(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
    }));

    expect(summary).toBe('(child agent produced no output)');

    const restored = await new SessionStorage(childStorageConfig(childId)).restoreMessages();
    const restoredJson = JSON.stringify(restored);
    expect(restoredJson).toContain('tu_wait_agent_ids_1');
    expect(restoredJson).toContain(WAIT_RESULT);
    expect(restoredJson).not.toContain('[Tool result missing');

    const toolResults = collectToolResults(restored);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe('tu_wait_agent_ids_1');
    expect(toolResults[0].content).toContain(WAIT_RESULT);
  });

  it('继承上下文 / directive 不被误落进子历史（spawn full 继承父 assistant）', async () => {
    const childId = 'no-leak-0002';
    const fetchTool = makeTool('fetch_notes', async () => ({ content: 'TOOL_OUT' }));

    await drainFork(forkQuery({
      childId,
      parentMessages: [
        { role: 'user', content: 'PARENT_USER_MARKER 父原始任务' },
        { role: 'assistant', content: [{ type: 'text', text: 'PARENT_ASSISTANT_MARKER 我来派子' }] },
      ],
      // full 继承会把父 assistant（text）灌进子上下文；sidechain 持久化必须只吃
      // 子 runtime 自己 emit 的 persist_message，不能把 initialMessages 当产出落盘。
      inheritMode: 'full',
      taskPrompt: 'SPAWN_DIRECTIVE_MARKER 干这件事',
      systemPrompt: '',
      provider: createMockProvider([
        [
          { type: 'tool_use', toolUse: { id: 'tu_x', name: 'fetch_notes', input: {} } },
          { type: 'stop', stopReason: 'tool_use' },
        ],
        [
          { type: 'text_delta', text: 'CHILD_PRODUCED_TEXT' },
          { type: 'stop', stopReason: 'end_turn' },
        ],
      ]),
      tools: createMockToolProvider([fetchTool]),
      permissionHandler: createMockPermissionHandler(),
      toolRiskPolicy: createLegacyToolRiskPolicy(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
    }));

    const restored = await new SessionStorage(childStorageConfig(childId)).restoreMessages();
    const restoredJson = JSON.stringify(restored);
    // 子产出的确落盘
    expect(restoredJson).toContain('CHILD_PRODUCED_TEXT');
    expect(restoredJson).toContain('TOOL_OUT');
    // 继承/框定内容**绝不**落盘
    expect(restoredJson, '父 user 不该落盘').not.toContain('PARENT_USER_MARKER');
    expect(restoredJson, '父 assistant 不该落盘').not.toContain('PARENT_ASSISTANT_MARKER');
    expect(restoredJson, 'spawn directive 不该落盘').not.toContain('SPAWN_DIRECTIVE_MARKER');
    expect(restoredJson).not.toContain('inherited-context');
    expect(restoredJson).not.toContain('active-directive');
    expect(restoredJson).not.toContain('fork-boilerplate');
  });

  it('多轮工具调用：所有 tool_result 按序持久化 + restore 配对完整', async () => {
    const childId = 'multi-tool-0003';
    let call = 0;
    const tool = makeTool('step_tool', async () => ({ content: `STEP_RESULT_${call}` }));

    await drainFork(forkQuery({
      childId,
      parentMessages: [],
      taskPrompt: 'do two steps',
      systemPrompt: '',
      provider: {
        async *createStream() {
          call += 1;
          if (call === 1) {
            yield { type: 'tool_use' as const, toolUse: { id: 'tu_a', name: 'step_tool', input: {} } };
            yield { type: 'stop' as const, stopReason: 'tool_use' as const };
          } else if (call === 2) {
            yield { type: 'tool_use' as const, toolUse: { id: 'tu_b', name: 'step_tool', input: {} } };
            yield { type: 'stop' as const, stopReason: 'tool_use' as const };
          } else {
            yield { type: 'text_delta' as const, text: 'TWO_STEPS_DONE' };
            yield { type: 'stop' as const, stopReason: 'end_turn' as const };
          }
        },
      },
      tools: createMockToolProvider([tool]),
      permissionHandler: createMockPermissionHandler(),
      toolRiskPolicy: createLegacyToolRiskPolicy(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
    }));

    const restored = await new SessionStorage(childStorageConfig(childId)).restoreMessages();
    const toolResults = collectToolResults(restored);
    const resultIds = toolResults.map((r) => r.tool_use_id);
    // 两轮工具结果都持久化、按序
    expect(resultIds).toEqual(['tu_a', 'tu_b']);
    // 每个 tool_use 都能在历史里找到匹配 tool_result
    const useIds = new Set<string>();
    for (const m of restored) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as ContentBlock[]) {
        if ((b as { type?: string }).type === 'tool_use') useIds.add((b as { id: string }).id);
      }
    }
    expect([...useIds].sort()).toEqual(['tu_a', 'tu_b']);
    for (const id of useIds) {
      expect(resultIds).toContain(id);
    }
    expect(JSON.stringify(restored)).toContain('TWO_STEPS_DONE');
  });

  it('多轮 resume 不累积：每轮只增量落本轮新产出，读回历史无重复', async () => {
    // 钉死「无累积」——预标记 / 首轮基线若失效，每次 resume 会把读回的整段历史又写一遍。
    const childId = 'no-accum-0006';
    const base = {
      systemPrompt: '',
      tools: createMockToolProvider([makeTool('fetch_notes', async () => ({ content: 'R' }))]),
      permissionHandler: createMockPermissionHandler(),
      toolRiskPolicy: createLegacyToolRiskPolicy(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
    };

    // spawn（run1）：1 条 assistant
    await drainFork(forkQuery({
      ...base, childId, parentMessages: [], taskPrompt: 'RUN1',
      provider: createMockProvider([[{ type: 'text_delta', text: 'OUT_RUN1' }, { type: 'stop', stopReason: 'end_turn' }]]),
    }));
    // resume run2、run3：各 1 条 assistant
    for (const [tag, out] of [['RUN2', 'OUT_RUN2'], ['RUN3', 'OUT_RUN3']] as const) {
      await drainFork(forkQuery({
        ...base, resume: true, childId, parentMessages: [], taskPrompt: tag,
        provider: createMockProvider([[{ type: 'text_delta', text: out }, { type: 'stop', stopReason: 'end_turn' }]]),
      }));
    }

    const restored = await new SessionStorage(childStorageConfig(childId)).restoreMessages();
    // 恰好 3 条子 assistant（run1/2/3 各一），无重复累积
    const assistantTexts = restored
      .filter((m) => m.role === 'assistant')
      .map((m) => JSON.stringify(m.content));
    expect(assistantTexts).toHaveLength(3);
    expect(assistantTexts.filter((t) => t.includes('OUT_RUN1'))).toHaveLength(1);
    expect(assistantTexts.filter((t) => t.includes('OUT_RUN2'))).toHaveLength(1);
    expect(assistantTexts.filter((t) => t.includes('OUT_RUN3'))).toHaveLength(1);
    // 框定噪声不入历史
    const restoredJson = JSON.stringify(restored);
    expect(restoredJson).not.toContain('fork-boilerplate');
    expect(restoredJson).not.toContain('resumed-context');
  });

  it('parent mid-flight 指引进入 block 权威历史，resume 时不被 legacy transcript 优先级吞掉', async () => {
    const childId = 'midflight-block-0007';
    const MIDFLIGHT_GUIDANCE = 'MIDFLIGHT_GUIDANCE_KEEP_ME_42';
    let drained = false;

    await drainFork(forkQuery({
      childId,
      parentMessages: [],
      taskPrompt: 'RUN_WITH_PARENT_MIDFLIGHT',
      systemPrompt: '',
      provider: createMockProvider([
        [{ type: 'text_delta', text: 'MIDFLIGHT_CHILD_DONE' }, { type: 'stop', stopReason: 'end_turn' }],
      ]),
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler(),
      toolRiskPolicy: createLegacyToolRiskPolicy(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
      drainParentMidflightMessages: () => {
        if (drained) return [];
        drained = true;
        return [MIDFLIGHT_GUIDANCE];
      },
    }));

    const restored = await new SessionStorage(childStorageConfig(childId)).restoreMessages();
    const restoredJson = JSON.stringify(restored);
    expect(restoredJson).toContain(MIDFLIGHT_GUIDANCE);
    expect(restoredJson).toContain('MIDFLIGHT_CHILD_DONE');

    const { provider, getFirstMessages } = capturingProvider('MIDFLIGHT_RESUME_DONE');
    await drainFork(forkQuery({
      resume: true,
      childId,
      parentMessages: [],
      taskPrompt: 'RESUME_AFTER_PARENT_MIDFLIGHT',
      systemPrompt: '',
      provider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler(),
      toolRiskPolicy: createLegacyToolRiskPolicy(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
    }));

    expect(JSON.stringify(getFirstMessages())).toContain(MIDFLIGHT_GUIDANCE);
  });

  it('resume-after-orphan：被 pairing 折叠的 <active-directive> 不泄漏进子历史', async () => {
    // 复现 W2.1 review 找到的边界：子上一轮末尾是 orphan tool_use（最后一条 tool_result
    // 没轮到落盘就结束）。resume 装填期 query.ts 的 ensureToolResultPairing 会把合成占位
    // result 折叠进紧邻的 <active-directive> user → directive 变成新对象 + 含 tool_result。
    // 旧实现（预 seed forkedMessages 原引用）会把这条改写后的 directive 误落进 jsonl，
    // 泄漏 boilerplate + 指令原文且跨 resume 累积。本测钉住「首轮基线用真身」修复。
    const childId = 'orphan-resume-0005';

    // 预置子历史：以 orphan tool_use 收尾（真实 spawn 在末尾工具执行后被 maxTurns/abort
    // 截断时的形态）
    const seed = new SessionStorage(childStorageConfig(childId));
    await seed.recordAssistantMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'SEED_ORPHAN_MARKER 我调了个工具但结果没存上' },
        { type: 'tool_use', id: 'tu_orphan', name: 'fetch_notes', input: {} },
      ],
    });
    await seed.dispose();

    const { provider } = capturingProvider('ORPHAN_RESUME_REPLY');
    await drainFork(forkQuery({
      resume: true,
      childId,
      parentMessages: [],
      taskPrompt: 'RESUME_AFTER_ORPHAN_DIRECTIVE 继续干活',
      systemPrompt: '',
      provider,
      tools: createMockToolProvider([makeTool('fetch_notes', async () => ({ content: 'x' }))]),
      permissionHandler: createMockPermissionHandler(),
      toolRiskPolicy: createLegacyToolRiskPolicy(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: PARENT_THREAD },
    }));

    const restored = await new SessionStorage(childStorageConfig(childId)).restoreMessages();
    const restoredJson = JSON.stringify(restored);
    // 新产出落盘
    expect(restoredJson).toContain('ORPHAN_RESUME_REPLY');
    // 框定段绝不泄漏进历史
    expect(restoredJson, 'fork-boilerplate 不该泄漏').not.toContain('fork-boilerplate');
    expect(restoredJson, 'active-directive 不该泄漏').not.toContain('active-directive');
    expect(restoredJson, 'resume directive 原文不该泄漏').not.toContain('RESUME_AFTER_ORPHAN_DIRECTIVE');

    // 再 resume 一次：restore 不应读回任何重复框定噪声（跨 resume 不累积）
    expect(restoredJson).toContain('ORPHAN_RESUME_REPLY');
    expect(restoredJson).not.toContain('fork-boilerplate');
    expect(restoredJson).not.toContain('RESUME_AFTER_ORPHAN_DIRECTIVE');
  });

  it('大 tool_result（60k，工具边界合法产物）落盘无损，restore 字节不变', async () => {
    const childId = 'big-result-0004';
    const cfg = childStorageConfig(childId);
    const big = 'B'.repeat(60_000);

    const storage = new SessionStorage(cfg);
    await storage.recordUserMessage({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_big', content: big } as ToolResultBlock],
    });
    await storage.dispose();

    const restored = await new SessionStorage(cfg).restoreMessages();
    const toolResults = collectToolResults(restored);
    expect(toolResults).toHaveLength(1);
    const tr = toolResults[0];
    expect(tr.tool_use_id).toBe('tu_big');
    // canonical result 契约：工具边界已限长一次（终端 envelope ≤150K），落盘
    // 不再二次改写——本轮所见 = 落盘 = 下轮恢复，前缀字节稳定。
    expect(tr.content).toBe(big);
  });

  it('超 400K 灾难上限的 tool_result 保头 + 尾注截断，restore 仍是合法 tool_result', async () => {
    const childId = 'big-result-0005';
    const cfg = childStorageConfig(childId);
    const huge = 'H'.repeat(410_000);

    const storage = new SessionStorage(cfg);
    await storage.recordUserMessage({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_huge', content: huge } as ToolResultBlock],
    });
    await storage.dispose();

    const restored = await new SessionStorage(cfg).restoreMessages();
    const toolResults = collectToolResults(restored);
    expect(toolResults).toHaveLength(1);
    const tr = toolResults[0];
    expect(tr.tool_use_id).toBe('tu_huge');
    expect(typeof tr.content).toBe('string');
    const content = tr.content as string;
    // 保头（不做中段挖空）+ 尾注；长度 < 原长
    expect(content.startsWith('H'.repeat(1000))).toBe(true);
    expect(content).toContain('tool result truncated for storage');
    expect(content.length).toBeLessThan(410_000 + 100);
    expect(content.length).toBeGreaterThan(400_000);
  });
});
