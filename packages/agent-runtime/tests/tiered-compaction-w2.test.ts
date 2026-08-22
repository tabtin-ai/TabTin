/**
 *  第二波 — 单次长任务分级压缩的专项测试。
 *
 * 覆盖：
 *   1. 摘要输入瘦身（slimMessagesForSummaryInput）——白名单/保留窗/图片/
 *      不动真实历史四条不变量。
 *   2. 摘要请求"提示过长"重试链——瘦身重试 → 按轮次截头 ×3 → 分块兜底；
 *      非超长错误原样上抛。
 *   3. 部分压缩保尾（computePartialKeepLastN）——大窗口保尾扩大、小窗口回落、
 *      头部至少留可摘消息。
 *   4. 待办回放（extractLatestUnfinishedTodos）——merge 语义 + 只留未完成。
 *   5. 任务连续性注入——计划指针 + 待办插入 summary 消息的 marker 之前。
 *   6. 复用坐标系修复——keptTailCount 填充 + orchestrator 把 msgsCovered
 *      存成压缩后新数组坐标。
 */

import { describe, it, expect } from 'vitest';
import {
  compactConversation,
  extractLatestUnfinishedTodos,
} from '../src/compact/compact.js';
import {
  slimMessagesForSummaryInput,
} from '../src/compact/summary-input-slim.js';
import {
  SUMMARY_INPUT_TOOL_RESULT_OMITTED,
  SUMMARY_INPUT_IMAGE_OMITTED,
} from '../src/prompts/compact/summary-input-slim.js';
import { computePartialKeepLastN } from '../src/compact/auto-compact.js';
import {
  runCompactionPhase,
  initOrchestratorState,
} from '../src/compact/compaction-orchestrator.js';
import type {
  Message,
  ToolResultBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMRequest,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  AutoCompactParams,
  CompactResult,
} from '../src/engine/contracts/context-capability.js';
import {
  DEFAULT_CONTEXT_BUDGET,
} from '../src/engine/contracts/context-capability.js';
import { validateToolPairing } from '../src/engine/context/message-normalizer.js';

// ─── Helpers ─────────────────────────────────────────────────────────

const VALID_SUMMARY = [
  '1. **User Requests**: long task',
  '2. **Key Decisions**: tiered compaction',
  '3. **Current Status**: in progress',
].join('\n');

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: text };
}

/** 一轮工具调用：assistant(tool_use) + user(tool_result)。 */
function toolRound(id: string, toolName: string, resultContent: string): Message[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `calling ${toolName}` },
        { type: 'tool_use', id, name: toolName, input: { path: `/tmp/${id}.txt` } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: resultContent }],
    },
  ];
}

function longConversation(rounds: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    out.push(textMsg('user', `question-${i}: ${'x'.repeat(200)}`));
    out.push(textMsg('assistant', `answer-${i}: ${'y'.repeat(200)}`));
  }
  return out;
}

function makeSummaryCallModel(summary: string): (req: LLMRequest) => AsyncIterable<LLMResponseChunk> {
  return () => (async function* () {
    yield { type: 'text_delta' as const, text: summary };
    yield { type: 'stop' as const, stopReason: 'end_turn' as const };
  })();
}

// ─── 1. 摘要输入瘦身 ─────────────────────────────────────────────────

describe('#3229 摘要输入瘦身 — slimMessagesForSummaryInput', () => {
  it('白名单工具旧 result 换占位，保留最近 keepRecent 条原文', () => {
    const messages: Message[] = [
      ...toolRound('t1', 'read_file', 'old-content-1'),
      ...toolRound('t2', 'read_file', 'old-content-2'),
      ...toolRound('t3', 'read_file', 'recent-content-3'),
      ...toolRound('t4', 'run_terminal_command', 'recent-content-4'),
    ];

    const { messages: slimmed, slimmedToolResults } = slimMessagesForSummaryInput(messages, {
      keepRecent: 2,
    });

    expect(slimmedToolResults).toBe(2);
    const results = slimmed
      .filter((m) => m.role === 'user' && typeof m.content !== 'string')
      .flatMap((m) => (m.content as Array<{ type: string; content?: string }>))
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.content);
    expect(results[0]).toBe(SUMMARY_INPUT_TOOL_RESULT_OMITTED);
    expect(results[1]).toBe(SUMMARY_INPUT_TOOL_RESULT_OMITTED);
    expect(results[2]).toBe('recent-content-3');
    expect(results[3]).toBe('recent-content-4');
  });

  it('非白名单工具的 result 永不动', () => {
    const messages: Message[] = [
      ...toolRound('t1', 'todo', 'decision-record-1'),
      ...toolRound('t2', 'ask_question', 'decision-record-2'),
      ...toolRound('t3', 'read_file', 'file-content'),
      ...toolRound('t4', 'read_file', 'file-content-2'),
    ];

    const { messages: slimmed } = slimMessagesForSummaryInput(messages, { keepRecent: 0 });

    const byId = new Map<string, string>();
    for (const msg of slimmed) {
      if (msg.role !== 'user' || typeof msg.content === 'string') continue;
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          byId.set(block.tool_use_id, block.content as string);
        }
      }
    }
    expect(byId.get('t1')).toBe('decision-record-1');
    expect(byId.get('t2')).toBe('decision-record-2');
    expect(byId.get('t3')).toBe(SUMMARY_INPUT_TOOL_RESULT_OMITTED);
    expect(byId.get('t4')).toBe(SUMMARY_INPUT_TOOL_RESULT_OMITTED);
  });

  it('图片块替换为占位文本块', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ];

    const { messages: slimmed, slimmedImages } = slimMessagesForSummaryInput(messages);

    expect(slimmedImages).toBe(1);
    const blocks = slimmed[0].content as Array<{ type: string; text?: string }>;
    expect(blocks[1].type).toBe('text');
    expect(blocks[1].text).toBe(SUMMARY_INPUT_IMAGE_OMITTED);
  });

  it('tool_result 内嵌图片也替换为占位（截图类工具的常见形态）', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 's1', name: 'take_screenshot', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 's1',
            content: [
              { type: 'text', text: 'screenshot taken' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
            ],
          },
        ],
      },
    ];
    const snapshot = JSON.stringify(messages);

    const { messages: slimmed, slimmedImages } = slimMessagesForSummaryInput(messages);

    expect(slimmedImages).toBe(1);
    const block = (slimmed[1].content as ToolResultBlock[])[0];
    const inner = block.content as Array<{ type: string; text?: string }>;
    expect(inner[0].text).toBe('screenshot taken');
    expect(inner[1].type).toBe('text');
    expect(inner[1].text).toBe(SUMMARY_INPUT_IMAGE_OMITTED);
    // 原历史不动
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it('不动真实历史：原数组与原消息对象内容不变，tool_use 块原样', () => {
    const messages: Message[] = [
      ...toolRound('t1', 'read_file', 'original-content'),
      ...toolRound('t2', 'read_file', 'original-content-2'),
    ];
    const snapshot = JSON.stringify(messages);

    const { messages: slimmed } = slimMessagesForSummaryInput(messages, { keepRecent: 0 });

    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(slimmed).not.toBe(messages);
    // tool_use 块（id / name / input）在瘦身拷贝里也一字不改
    const toolUses = slimmed
      .filter((m) => m.role === 'assistant' && typeof m.content !== 'string')
      .flatMap((m) => (m.content as Array<{ type: string; id?: string; name?: string }>))
      .filter((b) => b.type === 'tool_use');
    expect(toolUses.map((b) => b.id)).toEqual(['t1', 't2']);
    expect(toolUses.map((b) => b.name)).toEqual(['read_file', 'read_file']);
  });
});

// ─── 2. 摘要请求超长重试链 ───────────────────────────────────────────

describe('#3229 摘要请求超长重试链', () => {
  function makePtlThenSuccessCallModel(ptlTimes: number, summary: string): {
    callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
    calls: () => number;
  } {
    let count = 0;
    const callModel = (): AsyncIterable<LLMResponseChunk> => {
      count++;
      if (count <= ptlTimes) {
        throw new Error('413: prompt is too long');
      }
      return (async function* () {
        yield { type: 'text_delta' as const, text: summary };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      })();
    };
    return { callModel, calls: () => count };
  }

  it('首次缓存友好调用超长 → 瘦身重试成功返回摘要', async () => {
    const messages = [
      ...longConversation(8),
      ...toolRound('t1', 'read_file', 'z'.repeat(500)),
      ...longConversation(2),
    ];
    const { callModel, calls } = makePtlThenSuccessCallModel(1, VALID_SUMMARY);

    const result = await compactConversation({
      messages,
      systemPrompt: 'sys',
      model: 'm',
      callModel,
      keepLastN: 2,
    });

    expect(result.summary).toContain('tiered compaction');
    // 1 次缓存友好（超长）+ 1 次瘦身重试
    expect(calls()).toBe(2);
  });

  it('截头重试发出的消息 tool 配对完整（不会被 provider 拒 400）', async () => {
    // 工具循环形态：user(tool_result) 与下一个 assistant(tool_use) 跨轮次组，
    // truncateHead 按组删除必然拆开配对——修复后发给模型的消息必须仍然合法。
    const rounds: Message[] = [];
    for (let i = 0; i < 10; i++) {
      rounds.push(...toolRound(`t${i}`, 'read_file', 'r'.repeat(120)));
    }
    const messages = [textMsg('user', 'start the long task'), ...rounds];

    let count = 0;
    const captured: Message[][] = [];
    const callModel = (req: LLMRequest): AsyncIterable<LLMResponseChunk> => {
      count++;
      // 第 1 次缓存友好 + 第 2 次瘦身重试都超长；第 3 次（截头后）成功
      if (count <= 2) throw new Error('413: prompt is too long');
      captured.push(req.messages);
      return (async function* () {
        yield { type: 'text_delta' as const, text: VALID_SUMMARY };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      })();
    };

    const result = await compactConversation({
      messages,
      systemPrompt: 'sys',
      model: 'm',
      callModel,
      keepLastN: 2,
    });

    expect(result.summary).toContain('tiered compaction');
    expect(captured.length).toBeGreaterThan(0);
    // 截头确实发生（发出的消息比原始头部少）
    expect(captured[0].length).toBeLessThan(messages.length);
    // 修复核心：孤儿 tool_use / tool_result 已被修复，配对校验通过
    expect(validateToolPairing(captured[0])).toBe(true);
  });

  it('连续超长耗尽重试 → 回落分块摘要仍产出结果', async () => {
    const messages = longConversation(12);
    // 缓存友好 1 次 + 重试 3 次全部超长；之后 chunked 的调用成功
    const { callModel } = makePtlThenSuccessCallModel(4, VALID_SUMMARY);

    const result = await compactConversation({
      messages,
      systemPrompt: 'sys',
      model: 'm',
      callModel,
      keepLastN: 2,
    });

    // 分块路径拼出的 summary 含每块结果
    expect(result.summary).toContain('tiered compaction');
    expect(result.compactedMessages.length).toBeLessThan(messages.length);
  });

  it('非超长错误原样上抛（不吞错误）', async () => {
    const messages = longConversation(8);
    const callModel = (): AsyncIterable<LLMResponseChunk> => {
      throw new Error('500 internal server error');
    };

    await expect(
      compactConversation({
        messages,
        systemPrompt: 'sys',
        model: 'm',
        callModel,
        keepLastN: 2,
      }),
    ).rejects.toThrow('500');
  });
});

// ─── 3. 部分压缩保尾 ─────────────────────────────────────────────────

describe('#3229 部分压缩 — computePartialKeepLastN', () => {
  it('大窗口下保尾条数远大于旧固定值 6', () => {
    const messages = longConversation(50); // 100 条，每条 ~210 chars
    const keep = computePartialKeepLastN({
      messages,
      systemPrompt: 'sys',
      contextWindowTokens: 200_000,
      targetAfterCompact: 0.7,
    });

    // 200k * 0.7 - 摘要预留 后尾部预算充裕；头部至少留 4 条可摘
    expect(keep).toBeGreaterThan(6);
    expect(keep).toBeLessThanOrEqual(messages.length - 4);
  });

  it('小窗口预算归零时回落最小保尾 6', () => {
    const messages = longConversation(20);
    const keep = computePartialKeepLastN({
      messages,
      systemPrompt: 's'.repeat(40_000), // system 吃掉大部分预算
      contextWindowTokens: 10_000,
      targetAfterCompact: 0.7,
    });

    expect(keep).toBe(6);
  });

  it('消息很少时头部仍至少留出可摘部分', () => {
    const messages = longConversation(6); // 12 条
    const keep = computePartialKeepLastN({
      messages,
      systemPrompt: 'sys',
      contextWindowTokens: 200_000,
      targetAfterCompact: 0.7,
    });

    expect(keep).toBeLessThanOrEqual(messages.length - 4);
  });
});

// ─── 4. 待办回放 ─────────────────────────────────────────────────────

describe('#3229 待办回放 — extractLatestUnfinishedTodos', () => {
  function todoWriteMsg(merge: boolean, todos: Array<{ id: string; content: string; status: string }>): Message {
    return {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: `todo-${Math.random()}`, name: 'todo', input: { action: 'open', items: todos } },
      ],
    };
  }

  it('merge=false 整体替换，merge=true 按 id 增量更新，只留未完成', () => {
    const messages: Message[] = [
      todoWriteMsg(false, [
        { id: 'a', content: '第一步', status: 'in_progress' },
        { id: 'b', content: '第二步', status: 'pending' },
      ]),
      todoWriteMsg(true, [
        { id: 'a', content: '第一步', status: 'completed' },
        { id: 'c', content: '第三步', status: 'pending' },
      ]),
    ];

    const todos = extractLatestUnfinishedTodos(messages);

    expect(todos.map((t) => t.id).sort()).toEqual(['b', 'c']);
  });

  it('merge=false 清掉之前的所有待办', () => {
    const messages: Message[] = [
      todoWriteMsg(false, [{ id: 'a', content: '旧任务', status: 'pending' }]),
      todoWriteMsg(false, [{ id: 'z', content: '新任务', status: 'in_progress' }]),
    ];

    const todos = extractLatestUnfinishedTodos(messages);

    expect(todos).toEqual([{ id: 'z', content: '新任务', status: 'in_progress' }]);
  });

  it('无 todo 历史返回空数组', () => {
    expect(extractLatestUnfinishedTodos(longConversation(3))).toEqual([]);
  });
});

// ─── 5. 任务连续性注入 ───────────────────────────────────────────────

describe('#3229 任务连续性注入', () => {
  it('压缩后 summary 消息含计划指针与未完成待办，且在 [最近对话如下] 之前', async () => {
    const messages: Message[] = [
      ...longConversation(6),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'td-1', name: 'todo', input: { action: 'open', items: [
              { id: 's1', content: '改造压缩管线', status: 'in_progress' },
              { id: 's2', content: '补单测', status: 'pending' },
              { id: 's0', content: '调研', status: 'completed' },
            ],
          } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'td-1', content: 'ok' }] },
      ...longConversation(2),
    ];

    const result = await compactConversation({
      messages,
      systemPrompt: 'sys',
      model: 'm',
      callModel: makeSummaryCallModel(VALID_SUMMARY),
      keepLastN: 2,
      activePlanRef: { kind: 'file', target: '' },
    });

    const summaryMsg = result.compactedMessages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[对话摘要]'),
    );
    expect(summaryMsg).toBeDefined();
    const content = summaryMsg!.content as string;
    expect(content).toContain('[任务连续性——压缩时正在进行的计划与待办]');
    expect(content).toContain('');
    expect(content).toContain('改造压缩管线');
    expect(content).toContain('补单测');
    expect(content).not.toContain('调研'); // completed 不注入
    // 插入在 [最近对话如下] marker 之前
    expect(content.indexOf('[任务连续性')).toBeLessThan(content.indexOf('[最近对话如下]'));
  });

  it('无计划也无待办时不注入连续性段', async () => {
    const result = await compactConversation({
      messages: longConversation(8),
      systemPrompt: 'sys',
      model: 'm',
      callModel: makeSummaryCallModel(VALID_SUMMARY),
      keepLastN: 2,
    });

    const summaryMsg = result.compactedMessages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[对话摘要]'),
    );
    expect(summaryMsg!.content as string).not.toContain('[任务连续性');
  });
});

// ─── 6. 复用坐标系修复 ───────────────────────────────────────────────

describe('#3229 复用坐标系 — keptTailCount 与 msgsCovered 新坐标', () => {
  it('compactConversation 返回 keptTailCount = 保留尾部条数', async () => {
    const messages = longConversation(10);
    const result = await compactConversation({
      messages,
      systemPrompt: 'sys',
      model: 'm',
      callModel: makeSummaryCallModel(VALID_SUMMARY),
      keepLastN: 2,
    });

    expect(result.keptTailCount).toBeGreaterThanOrEqual(2);
    // compactedMessages = [summary(, ack)?, ...tail]
    const headCount = result.compactedMessages.length - result.keptTailCount!;
    expect(headCount === 1 || headCount === 2).toBe(true);
  });

  it('orchestrator 把 msgsCovered 存成压缩后新数组坐标（summary+ack 前缀条数）', async () => {
    interface MockState {
      messages: Message[];
      model: string;
      systemPrompt: string;
      iteration: number;
      [key: string]: unknown;
    }

    const keptTail = longConversation(2); // 4 条尾部
    const compactedMessages: Message[] = [
      { role: 'user', content: '[对话摘要]\n\n' + VALID_SUMMARY },
      ...keptTail,
    ];
    const mockAutoCompact = async (_params: AutoCompactParams): Promise<CompactResult | null> => ({
      compactedMessages,
      summary: VALID_SUMMARY,
      tokensFreed: 1_000,
      mode: 'auto',
      keptTailCount: keptTail.length,
      reuseInfo: { reused: false, fallbackReason: 'no_previous_summary' },
    });

    const state: MockState = {
      messages: longConversation(15),
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 1,
    };

    const orchestratorState = initOrchestratorState();
    await runCompactionPhase(
      state,
      orchestratorState,
      {
        budget: { ...DEFAULT_CONTEXT_BUDGET, compactThreshold: 0.001, blockingReserveTokens: 0 },
        contextWindowTokens: 1_000,
        maxOutputTokens: 100,
      },
      mockAutoCompact,
    );

    // 新坐标：msgsCovered = compactedMessages.length - keptTailCount = 1（仅 summary 消息）
    expect(orchestratorState.lastSummary?.msgsCovered).toBe(compactedMessages.length - keptTail.length);
  });

  it('兜底占位摘要不写入 lastSummary（summaryIsPlaceholder 防护）', async () => {
    interface MockState {
      messages: Message[];
      model: string;
      systemPrompt: string;
      iteration: number;
      [key: string]: unknown;
    }

    const mockAutoCompact = async (_params: AutoCompactParams): Promise<CompactResult | null> => ({
      compactedMessages: longConversation(2),
      summary: '[Context truncated due to length. Older messages were removed.]',
      tokensFreed: 1_000,
      mode: 'auto',
      summaryIsPlaceholder: true,
    });

    const state: MockState = {
      messages: longConversation(15),
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 1,
    };

    const orchestratorState = initOrchestratorState();
    await runCompactionPhase(
      state,
      orchestratorState,
      {
        budget: { ...DEFAULT_CONTEXT_BUDGET, compactThreshold: 0.001, blockingReserveTokens: 0 },
        contextWindowTokens: 1_000,
        maxOutputTokens: 100,
      },
      mockAutoCompact,
    );

    // 占位文案若被缓存，下一轮增量复用会把"已截断"当作前情提要拼进新摘要
    expect(orchestratorState.lastSummary).toBeUndefined();
  });

  it('#3351 override 的 pressureThresholds 作为 autoCompact 触发线（AdminDash/env > 默认 budget）', async () => {
    interface MockState {
      messages: Message[];
      model: string;
      systemPrompt: string;
      iteration: number;
      [key: string]: unknown;
    }

    const captured: AutoCompactParams[] = [];
    const mockAutoCompact = async (params: AutoCompactParams): Promise<CompactResult | null> => {
      captured.push(params);
      // 返回 null 只为捕获触发线入参，不改写 state。
      return null;
    };

    const state: MockState = {
      messages: longConversation(15),
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 1,
    };

    await runCompactionPhase(
      state,
      initOrchestratorState(),
      {
        // budget 保持默认 compactThreshold=0.85 / emergencyThreshold=0.95
        budget: { ...DEFAULT_CONTEXT_BUDGET, blockingReserveTokens: 0 },
        contextWindowTokens: 1_000,
        maxOutputTokens: 100,
        // AdminDash 云端 / env 旋钮覆盖：把摘要档触发线压到 0.05、紧急档 0.90。
        pressureThresholds: { microCompactStart: 0.02, llmSummaryStart: 0.05, emergencyStart: 0.90 },
      },
      mockAutoCompact,
    );

    expect(captured.length).toBeGreaterThan(0);
    // 修复前锚死 budget.compactThreshold=0.85 / emergencyThreshold=0.95；
    // 修复后应传解析后的 override（llmSummaryStart=0.05 / emergencyStart=0.90），
    // 让云端 / env 调参真正作用于压缩触发时机。
    for (const params of captured) {
      expect(params.compactThreshold).toBe(0.05);
      expect(params.emergencyThreshold).toBe(0.90);
    }
  });

  it('#3351 无 override 时触发线回落 budget 原值（默认对齐、行为不变）', async () => {
    interface MockState {
      messages: Message[];
      model: string;
      systemPrompt: string;
      iteration: number;
      [key: string]: unknown;
    }

    const captured: AutoCompactParams[] = [];
    const mockAutoCompact = async (params: AutoCompactParams): Promise<CompactResult | null> => {
      captured.push(params);
      return null;
    };

    const state: MockState = {
      messages: longConversation(15),
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 1,
    };

    await runCompactionPhase(
      state,
      initOrchestratorState(),
      {
        budget: { ...DEFAULT_CONTEXT_BUDGET, blockingReserveTokens: 0 },
        contextWindowTokens: 1_000,
        maxOutputTokens: 100,
        // 不传 pressureThresholds → resolvePressureThresholds 回落 budget 值。
      },
      mockAutoCompact,
    );

    expect(captured.length).toBeGreaterThan(0);
    for (const params of captured) {
      expect(params.compactThreshold).toBe(DEFAULT_CONTEXT_BUDGET.compactThreshold);
      expect(params.emergencyThreshold).toBe(DEFAULT_CONTEXT_BUDGET.emergencyThreshold);
    }
  });
});
