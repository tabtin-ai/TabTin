/**
 *  幻影压力 + 语义保全阶梯 回归测试。
 *
 * Live 取证背景（会话 02406c33，64k 窗口 deepseek-v4-pro）：provider 实报
 * 26k–34k（约 50% 窗口），估算器虚估 75k–115k → 每轮 emergency_blocking
 * hardTrim 砍到 5 条（todo 被删）→ freed=0 → 下一轮重砍，死循环；
 * `active-todos` 从 iter5 起永久消失。
 *
 * 覆盖：
 *   1. P0 锚钳制：裁剪后失效锚的 inputSide 作为估算上界（幻影压力消失）。
 *   2. P0 校准口径：estimateFull(含 system+tools) ↔ 整请求实报同口径。
 *   3. P1 钉锚截断：hardTrim / truncateHead 传任务状态段时告示带锚；
 *      truncateHead 有锚时不再保护首轮（任务真相由锚承载）。
 *   4. P1 emergency 阶梯：摘要输入保留 todo（softTrim 不删消息）；
 *      摘要失败的兜底 hardTrim 告示钉锚。
 */

import { describe, it, expect } from 'vitest';
import {
  estimateFullContextTokens,
  estimateTokens,
  hardTrim,
  truncateHead,
  TokenEstimator,
} from '../src/engine/context/token-budget.js';
import type { UsageAnchor } from '../src/engine/context/token-budget.js';
import { autoCompactIfNeeded } from '../src/compact/auto-compact.js';
import {
  runCompactionPhase,
  initOrchestratorState,
} from '../src/compact/compaction-orchestrator.js';
import { buildTruncationTaskStateSection } from '../src/prompts/compact/truncation-task-state.js';
import { DEFAULT_CONTEXT_BUDGET } from '../src/engine/contracts/context-capability.js';
import type { AutoCompactParams, CompactResult } from '../src/engine/contracts/context-capability.js';
import type { Message } from '../src/engine/contracts/conversation.js';
import type {
  LLMRequest,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';

type AutoCompactFn = (params: AutoCompactParams) => Promise<CompactResult | null>;

// ─── fixtures ────────────────────────────────────────────────────────

/** 中文重内容消息——CJK 悲观系数下字符估算显著虚高的典型形态。 */
let cjkSeq = 0;
function cjkMessage(role: 'user' | 'assistant', chars: number): Message {
  cjkSeq += 1;
  const body = `【第${cjkSeq}段】融资事件采集与分析报告，覆盖人工智能领域最新动态。`;
  return { role, content: body.repeat(Math.ceil(chars / body.length)).slice(0, chars) };
}

function todoWriteMessage(todos: Array<{ id: string; content: string; status: string }>): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'tu-todo', name: 'todo', input: { action: 'open', items: todos } },
    ],
  };
}

const SAMPLE_TODOS = [
  { id: '1', content: '搜索采集最近7天AI融资项目数据', status: 'completed' },
  { id: '2', content: '将融资数据导入多维表', status: 'in_progress' },
  { id: '3', content: '分析最值得关注的5个趋势', status: 'pending' },
];

// ─── 1. P0 锚钳制 ────────────────────────────────────────────────────

describe('#5449 P0 · 失效锚钳制幻影压力', () => {
  it('裁剪后（anchor.messageCount > messages.length）估算被实报上界钳住', () => {
    const messages = [cjkMessage('user', 8000), cjkMessage('assistant', 8000)];
    // 复刻 live 形态：上次实报整请求 30k，锚建在 13 条消息时（现已被砍到 2 条）。
    const staleAnchor: UsageAnchor = {
      inputTokens: 5_000,
      cacheReadTokens: 25_000,
      messageCount: 13,
      timestamp: Date.now(),
    };
    const hugeCjkSystem = '系统提示：中文内容占位。'.repeat(2_000);
    const raw = estimateFullContextTokens(messages, hugeCjkSystem, undefined, undefined);
    const clamped = estimateFullContextTokens(messages, hugeCjkSystem, undefined, staleAnchor);
    expect(clamped).toBeLessThanOrEqual(30_000);
    expect(clamped).toBeLessThan(raw); // 裸估算（含大 system）远高于实报上界
  });

  it('锚有效（messageCount ≤ messages.length）仍走精确前缀+增量路径，不受钳制影响', () => {
    const messages = [cjkMessage('user', 800), cjkMessage('assistant', 800), cjkMessage('user', 800)];
    const anchor: UsageAnchor = { inputTokens: 10_000, messageCount: 2, timestamp: Date.now() };
    const estimated = estimateFullContextTokens(messages, undefined, undefined, anchor);
    // anchorInputSide(10k) + 第 3 条消息增量 > 10k
    expect(estimated).toBeGreaterThan(10_000);
  });

  it('无锚（首轮）行为不变：纯字符估算', () => {
    const messages = [cjkMessage('user', 400)];
    const noAnchor = estimateFullContextTokens(messages, 'sys', undefined, undefined);
    expect(noAnchor).toBeGreaterThan(0);
  });
});

// ─── 2. P0 校准口径 ──────────────────────────────────────────────────

describe('#5449 P0 · 校准同口径（estimateFull ↔ 整请求实报）', () => {
  it('factor 学习「整请求估算→整请求实报」映射，不再被固定开销打爆', () => {
    const estimator = new TokenEstimator();
    const messages = [cjkMessage('user', 1000)];
    const system = 'S'.repeat(40_000);
    const tools = [{ name: 't1', description: 'D'.repeat(20_000), input_schema: { type: 'object' } }];

    // 同口径：estimateFull(messages+system+tools) 对齐整请求实报。
    const fullEstimate = estimator.estimateFull(messages, system, tools);
    estimator.calibrate(fullEstimate, fullEstimate); // 实报恰等于估算 → factor 应保持 ~1
    expect(estimator.getCalibrationFactor()).toBeGreaterThan(0.9);
    expect(estimator.getCalibrationFactor()).toBeLessThan(1.1);

    // 旧口径复刻（仅 messages 对齐整请求）会把 factor 拉到数倍——守住不回归：
    const messagesOnly = estimator.estimateMessages(messages);
    expect(fullEstimate / Math.max(messagesOnly, 1)).toBeGreaterThan(2);
  });
});

// ─── 3. P1 钉锚截断 ──────────────────────────────────────────────────

describe('#5449 P1 · hardTrim/truncateHead 钉「当前任务状态」锚', () => {
  const notice = buildTruncationTaskStateSection({ todos: SAMPLE_TODOS });

  it('任务状态段包含全量合并态（含已完成/进行中/待办标记）', () => {
    expect(notice).toContain('当前任务状态');
    expect(notice).toContain('[已完成] 搜索采集最近7天AI融资项目数据');
    expect(notice).toContain('[进行中] 将融资数据导入多维表');
    expect(notice).toContain('[待办] 分析最值得关注的5个趋势');
  });

  it('无 todo 无 plan → 空串（调用方保持裸告示）', () => {
    expect(buildTruncationTaskStateSection({})).toBe('');
  });

  it('hardTrim 带锚：截断告示携带任务状态；不带锚保持旧文案', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 12; i++) messages.push(cjkMessage(i % 2 === 0 ? 'user' : 'assistant', 3000));

    const pinned = hardTrim(messages, 1_000, undefined, notice);
    expect(pinned.length).toBeLessThan(messages.length);
    const head = pinned[0]!;
    expect(typeof head.content === 'string' && head.content).toContain('已被截断');
    expect(head.content as string).toContain('[进行中] 将融资数据导入多维表');

    const bare = hardTrim(messages, 1_000);
    expect(bare[0]!.content as string).not.toContain('当前任务状态');
  });

  it('truncateHead 带锚：不再保护首轮 + 告示钉锚 + 保持 user 开头', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) messages.push(cjkMessage(i % 2 === 0 ? 'user' : 'assistant', 3000));
    const firstUserContent = messages[0]!.content;

    const pinned = truncateHead(messages, 20_000, undefined, notice);
    expect(pinned[0]!.role).toBe('user');
    expect(pinned[0]!.content as string).toContain('当前任务状态');
    // 有锚时首轮可被移除（任务真相由锚承载，首条指令可能已过时）
    const stillHasFirstUser = pinned.some(m => m.content === firstUserContent);
    expect(stillHasFirstUser).toBe(false);

    // 无锚：保留首轮的旧行为不变
    const bare = truncateHead(messages, 20_000);
    expect(bare.some(m => m.content === firstUserContent)).toBe(true);
  });
});

// ─── 4. P1 emergency 阶梯 ────────────────────────────────────────────

describe('#5449 P1 · emergency 语义保全阶梯', () => {
  function buildEmergencyMessages(): Message[] {
    // 体量放在**纯文本消息**里：layeredPrune / softTrim 只裁 tool_result，
    // 对纯文本无能为力——强迫阶梯走到 ③LLM 摘要 / ④hardTrim 兜底。
    // 规模控制在 emergency 阈值（0.95×47616≈45k）之上、chunked 切换线
    // （MAX_SUMMARY_INPUT_TOKENS=100k）之下——走单次全量摘要路径，
    // 摘要失败才会真正抛出（chunked 路径会按 chunk 吞错误降级返回）。
    const messages: Message[] = [cjkMessage('user', 2000), todoWriteMessage(SAMPLE_TODOS)];
    for (let i = 0; i < 5; i++) {
      messages.push(cjkMessage('user', 6_000));
      messages.push(cjkMessage('assistant', 6_000));
    }
    return messages;
  }

  it('LLM 摘要收到的输入保留 todo（softTrim 不删消息）', async () => {
    const seen: LLMRequest[] = [];
    async function* fakeModel(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
      seen.push(req);
      yield { type: 'text_delta', text: '摘要：任务进行中。' } as LLMResponseChunk;
      yield { type: 'stop', stopReason: 'end_turn' } as LLMResponseChunk;
    }
    const messages = buildEmergencyMessages();
    const result = await autoCompactIfNeeded({
      messages,
      systemPrompt: 'sys',
      model: 'test-model',
      contextWindowTokens: 47_616, // live 同款有效窗口
      callModel: fakeModel,
    });
    expect(result).not.toBeNull();
    // 摘要请求的消息里 todo 块仍在（阶梯②不删消息，只占位改写 tool_result）
    const summarizeReq = seen[0];
    expect(summarizeReq).toBeDefined();
    const hasTodoWrite = JSON.stringify(summarizeReq!.messages).includes('todo');
    expect(hasTodoWrite).toBe(true);
  });

  it('摘要失败 → hardTrim 兜底且截断告示钉任务状态锚', async () => {
    async function* failingModel(): AsyncIterable<LLMResponseChunk> {
      throw new Error('summary LLM unavailable');
    }
    const messages = buildEmergencyMessages();
    const result = await autoCompactIfNeeded({
      messages,
      systemPrompt: 'sys',
      model: 'test-model',
      contextWindowTokens: 47_616,
      callModel: failingModel as unknown as (req: LLMRequest) => AsyncIterable<LLMResponseChunk>,
    });
    expect(result).not.toBeNull();
    expect(result!.summaryIsPlaceholder).toBe(true);
    const head = result!.compactedMessages[0]!;
    const headText = typeof head.content === 'string'
      ? head.content
      : JSON.stringify(head.content);
    expect(headText).toContain('当前任务状态');
    expect(headText).toContain('[进行中] 将融资数据导入多维表');
  });

  it('压力不足阈值 → no-op（实报锚钳制后 live 场景应走到这里）', async () => {
    const messages = buildEmergencyMessages();
    // 实报 30k / 47.6k 窗口 ≈ 0.63 < 0.85 → null
    const anchor: UsageAnchor = {
      inputTokens: 5_000,
      cacheReadTokens: 25_000,
      messageCount: messages.length + 5, // 裁剪后失效形态
      timestamp: Date.now(),
    };
    async function* neverCalled(): AsyncIterable<LLMResponseChunk> {
      throw new Error('should not be called');
    }
    const result = await autoCompactIfNeeded({
      messages,
      systemPrompt: 'sys',
      model: 'test-model',
      contextWindowTokens: 47_616,
      usageAnchor: anchor,
      callModel: neverCalled as unknown as (req: LLMRequest) => AsyncIterable<LLMResponseChunk>,
    });
    expect(result).toBeNull();
  });
});

// ─── 5. 死循环终结（组合行为）────────────────────────────────────────

describe('#5449 · live 死循环场景组合验证', () => {
  it('裁剪后下一轮：实报锚钳制 → 压力回到真实水平，不再重复 emergency', () => {
    // 复刻 live iter5 之后：消息被砍到 5 条，锚建在 13 条时、实报 30k。
    const trimmed: Message[] = [
      { role: 'user', content: '[对话历史因长度限制已被截断。之前的 5 条消息已移除。]' },
      cjkMessage('assistant', 900),
      cjkMessage('user', 4400),
      cjkMessage('assistant', 800),
      cjkMessage('user', 4500),
    ];
    const staleAnchor: UsageAnchor = {
      inputTokens: 5_000,
      cacheReadTokens: 25_000,
      messageCount: 13,
      timestamp: Date.now(),
    };
    const hugeSystem = '中文系统提示。'.repeat(3_000);
    const bigTools = Array.from({ length: 35 }, (_, i) => ({
      name: `tool_${i}`,
      description: 'tool description '.repeat(100),
      input_schema: { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(500) } } },
    }));

    const estimated = estimateFullContextTokens(trimmed, hugeSystem, bigTools, staleAnchor);
    const effectiveWindow = 47_616;
    const pressure = estimated / effectiveWindow;
    // 钳制后 ≤ 实报 30k → 压力 ≤ 0.63，远低于 0.85 压缩阈值——死循环终结。
    expect(pressure).toBeLessThan(0.85);

    // 反向：没有钳制（无锚）时同样输入的裸估算确实会虚高越过 emergency 线
    const raw = estimateFullContextTokens(trimmed, hugeSystem, bigTools, undefined);
    expect(raw / effectiveWindow).toBeGreaterThan(0.95);
  });

  it('messages-only 口径守恒：estimateTokens 不受钳制影响（hardTrim/softTrim 目标口径）', () => {
    const messages = [cjkMessage('user', 1000)];
    expect(estimateTokens(messages)).toBeGreaterThan(0);
  });
});

// ─── 6. P2 防抖：连续无进展诚实终止（不被 autoCompact reset 清掉）──────

describe('#5449 P2 · emergency 连续无进展 → 诚实终止', () => {
  // 窗口设极小 → 每轮 blocking guard 必触发 emergency；autoCompact mock 恒返回
  // freed=0（复刻 live 死循环）。验证独立计数 emergencyNoProgressStreak 累积到
  // 阈值后 result.terminate=true——而非被 autoCompact 的 consecutiveFailures reset
  // 清掉后永远累积不起来。
  function makeState() {
    return {
      messages: [
        { role: 'user' as const, content: '任务请求' },
        { role: 'assistant' as const, content: '执行中' },
      ],
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 1,
    };
  }
  const tinyWindowConfig = {
    budget: { ...DEFAULT_CONTEXT_BUDGET, compactThreshold: 0.999, emergencyThreshold: 1.0, blockingReserveTokens: 0 },
    contextWindowTokens: 1,
    maxOutputTokens: 0,
  };
  const freedZero: AutoCompactFn = async () => ({
    compactedMessages: [{ role: 'user', content: '任务请求' }, { role: 'assistant', content: '执行中' }],
    summary: 'noop',
    tokensFreed: 0,
    mode: 'emergency_blocking',
  });

  it('连续 2 轮 freed=0 → 第 2 轮 terminate；有进展则清零', async () => {
    const orch = initOrchestratorState();
    const s1 = makeState();
    const r1 = await runCompactionPhase(s1, orch, tinyWindowConfig, freedZero);
    expect(orch.emergencyNoProgressStreak).toBe(1);
    expect(r1.terminate).toBe(false);

    const s2 = makeState();
    const r2 = await runCompactionPhase(s2, orch, tinyWindowConfig, freedZero);
    expect(orch.emergencyNoProgressStreak).toBe(2);
    expect(r2.terminate).toBe(true); // 诚实终止，不再无限重砍

    // 有进展（freed>0）→ 计数清零
    const freedSome: AutoCompactFn = async () => ({
      compactedMessages: [{ role: 'user', content: 'x' }],
      summary: 's',
      tokensFreed: 5,
      mode: 'emergency_blocking',
    });
    const s3 = makeState();
    await runCompactionPhase(s3, orch, tinyWindowConfig, freedSome);
    expect(orch.emergencyNoProgressStreak).toBe(0);
  });
});
