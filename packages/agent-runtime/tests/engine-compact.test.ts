import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  estimateTokens,
  estimateSystemTokens,
  estimateToolSchemaTokens,
  estimateFullContextTokens,
  estimateTokensWithAnchor,
  computeMessagesTargetFromFullTarget,
  hardTrim,
  TokenEstimator,
  estimateImageTokens,
  detectModelFamily,
} from '../src/engine/context/token-budget.js';
import type { ModelFamily } from '../src/engine/context/token-budget.js';
import { layeredPrune } from '../src/compact/layered-prune.js';
// W1：sessionMemoryCompact 已删除，对应 describe 区块已从本测试文件移除（C1 §2.4
// 修复方向 B：layered-prune 在 emergency 档已覆盖"非 LLM 事后压缩"语义，本层重叠）。
// W3 (2026-05-10): `auto-condense.ts` 整体删除（summarize_context 工具下线，
// 让 LLM 主动 condense 的机制全删；runtime auto-compact 自己处理高压）。
// 对应的 `describe('auto-condense state machine')` 区块在本文件下方一并删除。
// W3-recovery (2026-05-11): layeredPrune 恢复但只在 emergency 档（pressure ≥ 0.95）
// 由 auto-compact 内部调用——99 §4.1「保留 + 缩小爆炸半径」+ C1 §2.3 修复方向 B。
// 单元测试 describe 在本文件 §2 恢复；additionalProtectedTools 参数路径不恢复
// （emergency 内部用 layered-prune 内置 PROTECTED_TOOLS，不向外透传该参数）。
import { autoCompactIfNeeded, initCompactTracking } from '../src/compact/auto-compact.js';
import { compactConversation } from '../src/compact/compact.js';
import type {
  Message,
  ToolParam,
  ContentBlock,
  ImageBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMRequest,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  EngineState,
} from '../src/engine/contracts/kernel.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeUserMsg(text: string): Message {
  return { role: 'user', content: text };
}

function makeAssistantMsg(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function makeToolUse(id: string, name: string, input: unknown): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  };
}

function makeToolResult(toolUseId: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
  };
}

function makeEngineState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    messages: [],
    systemPrompt: '',
    model: 'test-model',
    iteration: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    _cachedInputTokens: 0,
    contextPressure: 0,
    creditsCharged: 0,
    abortController: new AbortController(),
    ...overrides,
  };
}

function makeMockCallModel(text = 'summary'): (req: LLMRequest) => AsyncIterable<LLMResponseChunk> {
  return async function* (_req: LLMRequest): AsyncIterable<LLMResponseChunk> {
    yield { type: 'text_delta', text };
    yield { type: 'stop', stopReason: 'end_turn' };
  };
}

function makeToolParam(name: string, desc = 'test tool'): ToolParam {
  return {
    name,
    description: desc,
    input_schema: { type: 'object', properties: {} },
  };
}

/**
 * Build a realistic conversation with interleaved tool_use/tool_result pairs.
 */
function buildConversation(pairs: number): Message[] {
  const msgs: Message[] = [makeUserMsg('Start the task')];
  for (let i = 0; i < pairs; i++) {
    msgs.push(makeToolUse(`tu_${i}`, `tool_${i}`, { arg: `value_${i}` }));
    msgs.push(makeToolResult(`tu_${i}`, 'x'.repeat(500)));
  }
  msgs.push(makeAssistantMsg('Done'));
  return msgs;
}

// ─── 1. Token 估算口径一致性 ──────────────────────────────────────────

describe('Token estimation — calibration consistency', () => {
  it('estimateTokens returns rawTokens × 4/3 when no estimator (factor=1)', () => {
    const msg = makeUserMsg('hello world'); // 11 chars → raw = ceil(11/4)+4 = 7 → ×4/3 = ceil(9.33) = 10
    const tokens = estimateTokens([msg]);
    // raw per message = 4 (overhead) + ceil(11/4) = 4 + 3 = 7
    // result = ceil(7 * 4/3 * 1.0) = ceil(9.33) = 10
    expect(tokens).toBe(10);
  });

  it('estimateSystemTokens applies 4/3 with factor=1', () => {
    const system = 'a'.repeat(120); // 120 chars → raw = ceil(120/4) = 30 → ×4/3 = 40
    const tokens = estimateSystemTokens(system);
    expect(tokens).toBe(40);
  });

  it('estimateToolSchemaTokens applies 4/3 with factor=1', () => {
    const tool = makeToolParam('my_tool', 'does things');
    const tokens = estimateToolSchemaTokens([tool]);
    // chars = 'my_tool'.length(7) + 'does things'.length(11) + JSON.stringify({type:'object',properties:{}}).length(33)
    // = 51 → raw = ceil(51/4) = 13 → ×4/3 = ceil(17.33) = 18
    expect(tokens).toBe(18);
  });

  it('TokenEstimator calibration affects all three estimators uniformly', () => {
    const estimator = new TokenEstimator();
    const msgs = [makeUserMsg('x'.repeat(400))];
    const system = 'y'.repeat(400);
    const tools = [makeToolParam('t', 'z'.repeat(400))];

    const before = {
      msg: estimateTokens(msgs),
      sys: estimateSystemTokens(system),
      tool: estimateToolSchemaTokens(tools),
    };

    // Simulate calibration: estimated=100, actual=150 → ratio=1.5
    // new factor = 1.0*0.8 + 1.5*0.2 = 1.1
    estimator.calibrate(100, 150);
    expect(estimator.getCalibrationFactor()).toBeCloseTo(1.1, 5);

    const after = {
      msg: estimateTokens(msgs, estimator),
      sys: estimateSystemTokens(system, estimator),
      tool: estimateToolSchemaTokens(tools, estimator),
    };

    const msgRatio = after.msg / before.msg;
    const sysRatio = after.sys / before.sys;
    const toolRatio = after.tool / before.tool;

    expect(msgRatio).toBeGreaterThan(1.0);
    expect(sysRatio).toBeGreaterThan(1.0);
    expect(toolRatio).toBeGreaterThan(1.0);
    expect(Math.abs(msgRatio - sysRatio)).toBeLessThan(0.05);
  });

  it('estimateFullContextTokens = messages + system + tools', () => {
    const msgs = [makeUserMsg('test message content')];
    const system = 'system prompt text';
    const tools = [makeToolParam('read_file', 'reads a file')];

    const full = estimateFullContextTokens(msgs, system, tools);
    const sum = estimateTokens(msgs) + estimateSystemTokens(system) + estimateToolSchemaTokens(tools);
    expect(full).toBe(sum);
  });

  it('estimateSystemTokens handles SystemBlock[] input', () => {
    const blocks = [
      { type: 'text' as const, text: 'a'.repeat(80) },
      { type: 'text' as const, text: 'b'.repeat(40) },
    ];
    const tokens = estimateSystemTokens(blocks);
    // raw = ceil(80/4) + ceil(40/4) = 20 + 10 = 30 → ×4/3 = 40
    expect(tokens).toBe(40);
  });

  it('estimateSystemTokens returns 0 for undefined input', () => {
    expect(estimateSystemTokens(undefined)).toBe(0);
  });

  it('estimateToolSchemaTokens returns 0 for empty array', () => {
    expect(estimateToolSchemaTokens([])).toBe(0);
    expect(estimateToolSchemaTokens(undefined)).toBe(0);
  });

  // ─── W4.2 Bug 1：anchor 路径不再叠加 system + tools ─────────────────
  describe('W4.2 — estimateFullContextTokens anchor path no double-counting', () => {
    it('valid anchor: 仅返回 anchor.inputTokens（不再叠加 system + tools）', () => {
      const msgs = [makeUserMsg('m1'), makeAssistantMsg('a1')];
      const system = 'system prompt content';
      const tools = [makeToolParam('read_file'), makeToolParam('write_file')];
      const anchor = { inputTokens: 47_000, messageCount: 2, timestamp: Date.now() };

      const full = estimateFullContextTokens(msgs, system, tools, anchor);
      // anchor.messageCount === messages.length → estimateTokensWithAnchor 直接返回
      // anchor.inputTokens；修复前还要加 system + tools 估算 → 双算 → 现在不再加。
      expect(full).toBe(47_000);
    });

    it('valid anchor + new messages: anchor.inputTokens + 仅新增消息增量（不叠 system + tools）', () => {
      const olderMsgs = [makeUserMsg('m1'), makeAssistantMsg('a1')];
      const newMsgs = [...olderMsgs, makeUserMsg('m2 added after anchor')];
      const system = 'system prompt';
      const tools = [makeToolParam('read_file')];
      const anchor = { inputTokens: 50_000, messageCount: 2, timestamp: Date.now() };

      const full = estimateFullContextTokens(newMsgs, system, tools, anchor);
      // estimateTokensWithAnchor 内部用同公式：anchor.inputTokens + 新增消息估算。
      // 单条消息估算用同一 estimator 与 estimateTokens([newMsg]) 等价。
      const incrementalOnly = estimateTokens([newMsgs[2]!]);
      expect(full).toBe(50_000 + incrementalOnly);
    });

    it('修复前 vs 修复后对照（dogfood 现场场景，5 条消息 + 大 system + 大 tools）', () => {
      // 模拟 dogfood W4.2 现场：5 条消息含 2 个 30KB tool_result，已建立 anchor=47k,
      // system 和 tools 都很大（系统 ~5k tokens / tools schema ~100k tokens）。
      // 修复前 anchor 路径会双算 system + tools 导致整体虚高 ≈ 152k；修复后正确返回 47k。
      const msgs: Message[] = [
        makeUserMsg('请帮我读两个文件'),
        makeToolUse('t1', 'read_file', { path: 'a.md' }),
        makeToolResult('t1', 'a'.repeat(30_000)),
        makeToolUse('t2', 'read_file', { path: 'b.md' }),
        makeToolResult('t2', 'b'.repeat(30_000)),
      ];
      const bigSystem = 'S'.repeat(20_000); // ASCII ~4 char/token → 5k tokens
      const bigTools: ToolParam[] = Array.from({ length: 50 }, (_, i) =>
        makeToolParam(`tool_${i}`, 'X'.repeat(8000)),
      );
      const anchor = { inputTokens: 47_000, messageCount: msgs.length, timestamp: Date.now() };

      const fixedFull = estimateFullContextTokens(msgs, bigSystem, bigTools, anchor);
      expect(fixedFull).toBe(47_000);

      // 反推修复前 buggy 行为：anchor.inputTokens + system + tools 估算（双算）
      const buggyAnchorPath = 47_000 + estimateSystemTokens(bigSystem) + estimateToolSchemaTokens(bigTools);
      expect(buggyAnchorPath).toBeGreaterThan(fixedFull * 3); // 修复前虚高至少 3 倍
      expect(buggyAnchorPath).toBeGreaterThan(100_000); // sanity：双算后 >100k
    });

    it('invalid anchor (messageCount > messages.length): 回落 fallback 加 system + tools', () => {
      const msgs = [makeUserMsg('only one msg')];
      const system = 'system prompt';
      const tools = [makeToolParam('tool_a')];
      const invalidAnchor = { inputTokens: 50_000, messageCount: 99, timestamp: Date.now() };

      const full = estimateFullContextTokens(msgs, system, tools, invalidAnchor);
      // anchor 失效 → 主动走 fallback 加 system + tools 避免低估。
      const expected = estimateTokens(msgs) + estimateSystemTokens(system) + estimateToolSchemaTokens(tools);
      expect(full).toBe(expected);
    });

    it('invalid anchor (messageCount = 0): 回落 fallback', () => {
      const msgs = [makeUserMsg('m1'), makeAssistantMsg('a1')];
      const zeroAnchor = { inputTokens: 50_000, messageCount: 0, timestamp: Date.now() };
      const full = estimateFullContextTokens(msgs, 'system', [makeToolParam('t')], zeroAnchor);
      const expected = estimateTokens(msgs)
        + estimateSystemTokens('system')
        + estimateToolSchemaTokens([makeToolParam('t')]);
      expect(full).toBe(expected);
    });

    it('TokenEstimator.estimateFull 同样应用 W4.2 修复（anchor 路径不双算）', () => {
      const est = new TokenEstimator();
      const msgs = [makeUserMsg('m1'), makeAssistantMsg('a1')];
      const anchor = { inputTokens: 47_000, messageCount: 2, timestamp: Date.now() };
      const full = est.estimateFull(msgs, 'huge system text '.repeat(1000), [makeToolParam('t')], anchor);
      expect(full).toBe(47_000);
    });
  });

  // ─── anchor 输入侧求和：cache 也占上下文窗口 ───────────────────────────
  describe('anchor 输入侧包含 cache（cache 也占窗口）', () => {
    it('estimateTokensWithAnchor: base = inputTokens + cacheRead + cacheCreation', () => {
      const msgs = [makeUserMsg('m1'), makeAssistantMsg('a1')];
      // provider 归一后 inputTokens 不含 cache，cache 独立分项。
      const anchor = {
        inputTokens: 2_000,
        cacheReadTokens: 8_000,
        cacheCreationTokens: 500,
        messageCount: 2,
        timestamp: Date.now(),
      };
      // messageCount === messages.length → 无新增消息，直接返回输入侧求和。
      expect(estimateTokensWithAnchor(msgs, anchor)).toBe(10_500);
    });

    it('estimateTokensWithAnchor: 输入侧求和 + 新增消息增量', () => {
      const olderMsgs = [makeUserMsg('m1'), makeAssistantMsg('a1')];
      const newMsgs = [...olderMsgs, makeUserMsg('m2 added after anchor')];
      const anchor = {
        inputTokens: 2_000,
        cacheReadTokens: 8_000,
        messageCount: 2,
        timestamp: Date.now(),
      };
      const incrementalOnly = estimateTokens([newMsgs[2]!]);
      // (2000 + 8000) + 新增消息增量
      expect(estimateTokensWithAnchor(newMsgs, anchor)).toBe(10_000 + incrementalOnly);
    });

    it('100% cache hit（inputTokens=0，全归 cacheRead）仍算完整上下文', () => {
      const msgs = [makeUserMsg('m1'), makeAssistantMsg('a1')];
      const anchor = {
        inputTokens: 0,
        cacheReadTokens: 1_500,
        messageCount: 2,
        timestamp: Date.now(),
      };
      expect(estimateTokensWithAnchor(msgs, anchor)).toBe(1_500);
    });

    it('无 cache 字段时退化为 inputTokens（向后兼容）', () => {
      const msgs = [makeUserMsg('m1'), makeAssistantMsg('a1')];
      const anchor = { inputTokens: 5_000, messageCount: 2, timestamp: Date.now() };
      expect(estimateTokensWithAnchor(msgs, anchor)).toBe(5_000);
    });

    it('TokenEstimator.estimateWithAnchor 同口径（求和 cache）', () => {
      const est = new TokenEstimator();
      const msgs = [makeUserMsg('m1'), makeAssistantMsg('a1')];
      const anchor = {
        inputTokens: 1_000,
        cacheReadTokens: 300,
        cacheCreationTokens: 100,
        messageCount: 2,
        timestamp: Date.now(),
      };
      expect(est.estimateWithAnchor(msgs, anchor)).toBe(1_400);
    });
  });
});

// ─── 2. layeredPrune (W3-recovery 2026-05-11) ────────────────────────
//
// 99 §4.1 决策矩阵明示「保留 + 缩小爆炸半径」+ C1 §2.3 修复方向 B：
// layered-prune 仅在 emergency 档（pressure ≥ 0.95）由 auto-compact 内部调用。
// 本 describe 测试 layeredPrune 函数自身行为，与 auto-compact 调用路径解耦。

describe('layeredPrune', () => {
  it('returns null when messages < 8', () => {
    const msgs = [
      makeUserMsg('hi'),
      makeAssistantMsg('hello'),
      makeUserMsg('bye'),
    ];
    expect(layeredPrune(msgs)).toBeNull();
  });

  it('returns null for exactly 7 messages', () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 4; i++) {
      msgs.push(makeUserMsg(`msg ${i}`));
      if (i < 3) msgs.push(makeAssistantMsg(`reply ${i}`));
    }
    expect(msgs).toHaveLength(7);
    expect(layeredPrune(msgs)).toBeNull();
  });

  it('protect window is clamped: min 8k tokens', () => {
    const msgs = buildConversation(10);
    const result = layeredPrune(msgs, {
      contextWindowTokens: 1000,
      minimumTokens: 0,
    });
    // With contextWindowTokens=1000, 20% = 200 tokens, but clamped to min 8000
    // So protectChars = 8000*4 = 32000, which likely protects all messages → null
    // (the conversation is too short relative to 8k protect window)
    expect(result).toBeNull();
  });

  it('recent messages within protect window are not pruned', () => {
    const msgs = buildConversation(15);
    const result = layeredPrune(msgs, {
      protectTokens: 50000,
      minimumTokens: 0,
    });
    // Very large protect window → most messages protected → likely null
    expect(result).toBeNull();
  });

  it('PROTECTED_TOOLS outputs are never replaced', () => {
    // 用 PROTECTED_TOOLS 集合里实际存在的工具名（layered-prune.ts 第 47 行）：
    // 旧 fixture 用 `summarize_context`，但该工具 W3 退役后已从 PROTECTED_TOOLS
    // 移除——测试 fixture 跟着语义漂移要求"保护一个未被保护的工具"，逻辑矛盾。
    // 改用仍在 PROTECTED_TOOLS 里的 `todo` 让断言回到原本"保护机制确实生效"
    // 的契约语义。
    const msgs: Message[] = [makeUserMsg('start')];
    for (let i = 0; i < 10; i++) {
      const toolName = i === 3 ? 'todo' : `tool_${i}`;
      msgs.push(makeToolUse(`tu_${i}`, toolName, { arg: i }));
      msgs.push(makeToolResult(`tu_${i}`, 'x'.repeat(600)));
    }
    msgs.push(makeAssistantMsg('done'));

    const result = layeredPrune(msgs, {
      protectTokens: 100,
      minimumTokens: 0,
    });

    if (result) {
      const protectedResult = result.messages.find((m) => {
        if (typeof m.content === 'string') return false;
        return m.content.some(
          (b) => b.type === 'tool_result' && b.tool_use_id === 'tu_3',
        );
      });
      if (protectedResult && typeof protectedResult.content !== 'string') {
        const block = protectedResult.content.find(
          (b) => b.type === 'tool_result' && b.tool_use_id === 'tu_3',
        );
        if (block && block.type === 'tool_result') {
          expect(block.content).not.toContain('[已压缩：');
        }
      }
    }
  });

  it('returns null when freed tokens < minimumTokens', () => {
    const msgs = buildConversation(5);
    const result = layeredPrune(msgs, {
      protectTokens: 100,
      minimumTokens: 999_999,
    });
    expect(result).toBeNull();
  });

  it('replaces old tool_result with placeholder including tool name', () => {
    const msgs: Message[] = [makeUserMsg('begin')];
    for (let i = 0; i < 12; i++) {
      msgs.push(makeToolUse(`tu_${i}`, `read_file`, { path: `/file_${i}` }));
      msgs.push(makeToolResult(`tu_${i}`, 'content-' + 'x'.repeat(800)));
    }
    msgs.push(makeAssistantMsg('all done'));

    const result = layeredPrune(msgs, {
      protectTokens: 100,
      minimumTokens: 1,
    });

    expect(result).not.toBeNull();
    expect(result!.freedTokens).toBeGreaterThan(0);

    const pruned = result!.messages;
    let foundPlaceholder = false;
    for (const msg of pruned) {
      if (typeof msg.content === 'string') continue;
      for (const block of msg.content) {
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          if (block.content.includes('[已压缩：')) {
            expect(block.content).toContain('read_file');
            foundPlaceholder = true;
          }
        }
      }
    }
    expect(foundPlaceholder).toBe(true);
  });
});

// ─── 3. auto-condense 状态机 (REMOVED in W3) ──────────────────────────
//
// W3 (2026-05-10) deleted the auto-condense module along with the
// `summarize_context` tool. The trigger / wait / force / timeout / failure-
// counter / cleanupCondenseArtifacts surface no longer exists; runtime LLM
// summary in `auto-compact.ts` now handles every pressure tier without
// asking the model to call a tool.

// ─── 4. auto-compact 决策链 ──────────────────────────────────────────

describe('auto-compact decision chain', () => {
  it('pressure < compactThreshold → return null', async () => {
    const msgs = [makeUserMsg('short')];
    const result = await autoCompactIfNeeded({
      messages: msgs,
      systemPrompt: '',
      model: 'test',
      contextWindowTokens: 200_000,
      callModel: makeMockCallModel(),
    });
    expect(result).toBeNull();
  });

  it('tools parameter increases pressure (more tokens)', async () => {
    const msgs = [makeUserMsg('x'.repeat(1000))];
    const tools = Array.from({ length: 20 }, (_, i) =>
      makeToolParam(`tool_${i}`, 'description '.repeat(50)),
    );

    // With large tools array, the full context estimate is bigger
    const resultWithoutTools = await autoCompactIfNeeded({
      messages: msgs,
      systemPrompt: '',
      model: 'test',
      contextWindowTokens: 2000,
      callModel: makeMockCallModel(),
    });

    const resultWithTools = await autoCompactIfNeeded({
      messages: msgs,
      systemPrompt: '',
      model: 'test',
      contextWindowTokens: 2000,
      callModel: makeMockCallModel(),
      tools,
    });

    // With tools, pressure is higher → more likely to trigger compact
    // At least one should be non-null or both, but tools makes pressure higher
    if (resultWithoutTools === null) {
      expect(resultWithTools).not.toBeNull();
    }
  });

  it('custom thresholds are respected', async () => {
    const msgs = [makeUserMsg('x'.repeat(400))];

    // Very high threshold → no compact
    const result = await autoCompactIfNeeded({
      messages: msgs,
      systemPrompt: '',
      model: 'test',
      contextWindowTokens: 300,
      callModel: makeMockCallModel(),
      compactThreshold: 0.99,
    });
    expect(result).toBeNull();
  });

  it('low custom threshold triggers compaction', async () => {
    const msgs = [makeUserMsg('x'.repeat(400))];
    const result = await autoCompactIfNeeded({
      messages: msgs,
      systemPrompt: '',
      model: 'test',
      contextWindowTokens: 1000,
      callModel: makeMockCallModel('A multi-line\nsummary of the conversation\nwith details'),
      compactThreshold: 0.01,
    });
    expect(result).not.toBeNull();
  });

  it('3 consecutive failures → cooldown returns null', async () => {
    const tracking = initCompactTracking();
    tracking.consecutiveFailures = 3;
    tracking.lastFailureTime = Date.now();

    const msgs = [makeUserMsg('x'.repeat(4000))];
    const result = await autoCompactIfNeeded({
      messages: msgs,
      systemPrompt: '',
      model: 'test',
      contextWindowTokens: 500,
      callModel: makeMockCallModel(),
      tracking,
      compactThreshold: 0.01,
    });
    expect(result).toBeNull();
  });

  it('cooldown expires → failures reset and compact proceeds', async () => {
    const tracking = initCompactTracking();
    tracking.consecutiveFailures = 3;
    tracking.lastFailureTime = Date.now() - 120_000; // 2 min ago, cooldown is 60s

    const msgs = buildConversation(10);
    const result = await autoCompactIfNeeded({
      messages: msgs,
      systemPrompt: '',
      model: 'test',
      contextWindowTokens: 500,
      callModel: makeMockCallModel('A multi-line\nsummary\nof content'),
      tracking,
      compactThreshold: 0.01,
    });

    expect(tracking.consecutiveFailures).toBe(0);
    expect(result).not.toBeNull();
  });

  it('initCompactTracking returns zero-state', () => {
    const tracking = initCompactTracking();
    expect(tracking.consecutiveFailures).toBe(0);
    expect(tracking.lastFailureTime).toBe(0);
  });

  // ─── W4.2 Bug 2：emergency hardTrim 口径对齐 ──────────────────────────
  describe('W4.2 — computeMessagesTargetFromFullTarget + emergency hardTrim true-trim', () => {
    it('computeMessagesTargetFromFullTarget: 扣 system + tools overhead 后返回 messages 预算', () => {
      const fullTarget = 100_000;
      const system = 'S'.repeat(20_000); // ~5k tokens
      const tools = Array.from({ length: 20 }, (_, i) => makeToolParam(`tool_${i}`, 'X'.repeat(2000))); // ~10k tokens
      const overhead = estimateSystemTokens(system) + estimateToolSchemaTokens(tools);
      const messagesTarget = computeMessagesTargetFromFullTarget(fullTarget, system, tools);
      expect(messagesTarget).toBe(fullTarget - overhead);
      expect(messagesTarget).toBeLessThan(fullTarget); // 真有 overhead 扣掉
    });

    it('computeMessagesTargetFromFullTarget: overhead 太大时回落到 minMessagesFloor', () => {
      const fullTarget = 5000;
      const system = 'S'.repeat(100_000); // 远超 fullTarget
      const messagesTarget = computeMessagesTargetFromFullTarget(fullTarget, system, [], undefined, 1500);
      expect(messagesTarget).toBe(1500); // floor
    });

    it('computeMessagesTargetFromFullTarget: 无 system / tools 时与 fullTarget 一致', () => {
      const fullTarget = 80_000;
      const messagesTarget = computeMessagesTargetFromFullTarget(fullTarget, undefined, undefined);
      expect(messagesTarget).toBe(fullTarget);
    });

    it('emergency 路径: hardTrim 收到 messages-only target 后真砍消息（修复后）', async () => {
      // 模拟修复后 emergency 路径：caller 已用 helper 把 fullTarget 转成 messagesTarget
      const longMsgs = buildConversation(40); // 40 对 tool_use/result，足够大
      const messagesOnlyEstimate = estimateTokens(longMsgs);

      // 假设 emergency fullTarget=70k，扣掉 system+tools overhead 5k → messagesTarget=65k
      // 但当前 messages 估算可能 60k 也可能 80k——构造一个 target 强制要砍
      const messagesTarget = Math.floor(messagesOnlyEstimate * 0.5);
      const trimmed = hardTrim(longMsgs, messagesTarget);
      const trimmedEstimate = estimateTokens(trimmed);

      expect(trimmed.length).toBeLessThan(longMsgs.length); // 真砍了消息
      expect(trimmedEstimate).toBeLessThan(messagesOnlyEstimate); // 真减少了 token
    });

    it('修复前 vs 修复后：emergency 大窗口下行为对照', async () => {
      // dogfood 现场：5 条消息（含 2 个 30KB tool_result），messages-only ~50-100k
      const msgs: Message[] = [
        makeUserMsg('请帮我读两个文件'),
        makeToolUse('t1', 'read_file', { path: 'a.md' }),
        makeToolResult('t1', 'a'.repeat(30_000)),
        makeToolUse('t2', 'read_file', { path: 'b.md' }),
        makeToolResult('t2', 'b'.repeat(30_000)),
      ];
      const messagesOnly = estimateTokens(msgs);
      const contextWindowTokens = 1_000_000; // 1M 大窗口模型
      const targetPressure = 0.7;
      const fullTarget = Math.floor(contextWindowTokens * targetPressure); // 700k

      // ── 修复前行为：直接传 fullTarget=700k 给 hardTrim → messages-only ~50k < 700k → 不砍 ──
      const buggyResult = hardTrim(msgs, fullTarget);
      expect(buggyResult).toBe(msgs); // 修复前 hardTrim 返回原 messages（noop）

      // ── 修复后行为：caller 先转 messagesTarget。本场景 system/tools 假设较大 ──
      const bigSystem = 'S'.repeat(20_000);
      const bigTools: ToolParam[] = Array.from({ length: 50 }, (_, i) =>
        makeToolParam(`tool_${i}`, 'X'.repeat(8000)),
      );
      const messagesTarget = computeMessagesTargetFromFullTarget(fullTarget, bigSystem, bigTools);
      // 即便修复后转换：fullTarget 700k - overhead 100k = messagesTarget 600k
      // messages-only ~50k 仍 < 600k → 仍不砍。
      // 这是预期行为：1M 窗口模型 + 50k messages 本来就不该 emergency 砍。
      // 真问题是 anchor 双算让虚高 411k > 950k blocking limit 触发 emergency；
      // Bug 1 修复后 anchor 路径不虚高 → emergency 根本不会被触发。
      const fixedResult = hardTrim(msgs, messagesTarget);
      expect(fixedResult).toBe(msgs); // 大窗口 + 小消息：仍合理 noop
      // 但 messagesTarget 一定小于 fullTarget——证明 helper 至少把 system/tools overhead 扣掉
      expect(messagesTarget).toBeLessThan(fullTarget);
      expect(messagesOnly).toBeLessThan(messagesTarget); // sanity
    });

    it('小窗口模型 + 真满载场景：修复后 emergency 真砍（修复前会因 overhead 漏砍）', () => {
      // 200k 窗口模型，messages-only 真有 195k（接近窗口满），system+tools 30k
      // 修复前：fullTarget=140k vs messages 195k → hardTrim 砍到 messages=140k → full=170k 仍超 70%
      // 修复后：messagesTarget = 140k - 30k overhead = 110k → hardTrim 砍到 messages=110k → full=140k 正好 70%
      const longMsgs = buildConversation(80); // 大量消息让 messages 估算够大
      const contextWindowTokens = 200_000;
      const targetPressure = 0.7;
      const fullTarget = Math.floor(contextWindowTokens * targetPressure); // 140k

      const bigSystem = 'S'.repeat(80_000); // ~20k tokens
      const bigTools: ToolParam[] = Array.from({ length: 30 }, (_, i) =>
        makeToolParam(`tool_${i}`, 'X'.repeat(2000)),
      );
      const overhead = estimateSystemTokens(bigSystem) + estimateToolSchemaTokens(bigTools);

      const messagesTarget = computeMessagesTargetFromFullTarget(fullTarget, bigSystem, bigTools);
      expect(messagesTarget).toBeLessThan(fullTarget);
      expect(messagesTarget).toBe(Math.max(1000, fullTarget - overhead));

      // 修复后 hardTrim 收到 messagesTarget（更小），更可能真砍
      const trimmed = hardTrim(longMsgs, messagesTarget);
      const trimmedEstimate = estimateTokens(trimmed);
      const fullAfter = trimmedEstimate + overhead;
      // 真满载场景下 hardTrim 一定真砍（messages 长 → estimate > messagesTarget）
      // full context 在 trim 后应 ≤ 大约 fullTarget（受 hardTrim 内部 rawTarget 折扣影响略小）
      expect(fullAfter).toBeLessThanOrEqual(fullTarget * 1.1); // 容 10% 余量
    });
  });
});

// ─── 5. compact.ts — compactConversation 基本路径 ─────────────────────

describe('compactConversation', () => {
  it('messages <= keepLastN + 1 → returns original messages unchanged', async () => {
    const msgs = [
      makeUserMsg('hello'),
      makeAssistantMsg('hi'),
      makeUserMsg('bye'),
    ];
    const result = await compactConversation({
      messages: msgs,
      systemPrompt: 'test',
      model: 'test',
      callModel: makeMockCallModel(),
      keepLastN: 4,
    });

    expect(result.compactedMessages).toBe(msgs);
    expect(result.summary).toBe('');
    expect(result.tokensFreed).toBe(0);
  });

  it('does not split in the middle of tool_use/tool_result pair', async () => {
    const msgs: Message[] = [
      makeUserMsg('start'),
      makeAssistantMsg('ok'),
      makeUserMsg('do something'),
      makeAssistantMsg('working'),
      makeUserMsg('more input'),
      makeToolUse('tu_1', 'read_file', { path: '/a' }),
      makeToolResult('tu_1', 'file content'),
      makeAssistantMsg('got it'),
      makeUserMsg('continue'),
      makeAssistantMsg('continuing'),
    ];

    const result = await compactConversation({
      messages: msgs,
      systemPrompt: 'test',
      model: 'test',
      callModel: makeMockCallModel('A detailed\nmulti-line summary\nof the conversation'),
      keepLastN: 3,
    });

    // Verify tool pairing: every tool_result has a matching tool_use
    const useIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const msg of result.compactedMessages) {
      if (typeof msg.content === 'string') continue;
      for (const block of msg.content) {
        if (block.type === 'tool_use') useIds.add(block.id);
        if (block.type === 'tool_result') resultIds.add(block.tool_use_id);
      }
    }
    for (const id of resultIds) {
      expect(useIds.has(id)).toBe(true);
    }
  });

  it('includes transcript path reference in summary message', async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(makeUserMsg(`message ${i}`));
      msgs.push(makeAssistantMsg(`reply ${i}`));
    }

    const result = await compactConversation({
      messages: msgs,
      systemPrompt: 'test',
      model: 'test',
      callModel: makeMockCallModel('Detailed\nmulti-line\nsummary'),
      keepLastN: 4,
      transcriptPath: '/tmp/transcript.jsonl',
    });

    const summaryMsg = result.compactedMessages[0];
    expect(typeof summaryMsg.content).toBe('string');
    expect(summaryMsg.content as string).toContain('/tmp/transcript.jsonl');
  });

  it('compacted messages start with user role (valid alternation)', async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(makeUserMsg(`q${i}`));
      msgs.push(makeAssistantMsg(`a${i}`));
    }

    const result = await compactConversation({
      messages: msgs,
      systemPrompt: '',
      model: 'test',
      callModel: makeMockCallModel('A thorough\nmulti-line summary\nof everything'),
      keepLastN: 2,
    });

    expect(result.compactedMessages[0].role).toBe('user');
  });

  it('summary content is included in result', async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(makeUserMsg(`input ${i}`));
      msgs.push(makeAssistantMsg(`output ${i}`));
    }

    const result = await compactConversation({
      messages: msgs,
      systemPrompt: '',
      model: 'test',
      callModel: makeMockCallModel('Conversation covered topics A, B, C.\nUser requested X.\nDecision was Y.'),
      keepLastN: 2,
    });

    expect(result.summary).toContain('Conversation covered topics');
    expect(result.tokensFreed).toBeGreaterThan(0);
    expect(result.mode).toBe('native');
  });
});

// W1（压缩路径简化）：原 §6 sessionMemoryCompact 与
// §7 layeredPrune additionalProtectedTools 测试块已删除——对应模块文件
// 本身已删（C1 §2.3 / §2.4：自创"按层次裁剪"+ 命名误导的"中间档摘要"）。

// ─── 8. CJK-aware token estimation ──────────────────────────────────

describe('CJK-aware token estimation', () => {
  it('pure CJK text estimates ~1.3 chars per token', () => {
    const msg = makeUserMsg('这是一段中文测试文本'); // 10 个中文字符
    const tokens = estimateTokens([msg]);
    // raw = 4 (overhead) + ceil(10 / 1.3) = 4 + 8 = 12 → ×4/3 = ceil(16) = 16
    expect(tokens).toBe(16);
  });

  it('pure English text estimates ~4.0 chars per token (unchanged)', () => {
    const msg = makeUserMsg('hello world'); // 11 chars
    const tokens = estimateTokens([msg]);
    // raw = 4 + ceil(11/4.0) = 4 + 3 = 7 → ×4/3 = ceil(9.33) = 10
    expect(tokens).toBe(10);
  });

  it('mixed CJK/English estimates weighted average', () => {
    const msg = makeUserMsg('hello你好world'); // 5 English + 2 CJK + 5 English = 12 chars
    const tokens = estimateTokens([msg]);
    // CJK ratio = 2/12 ≈ 0.167, charsPerToken = 0.167*1.3 + 0.833*4.0 ≈ 3.55
    // raw = 4 + ceil(12 / 3.55) = 4 + 4 = 8 → ×4/3 = ceil(10.67) = 11
    expect(tokens).toBe(11);
  });

  it('CJK system prompt estimates higher tokens than English of same length', () => {
    const cjkSystem = '你好世界'; // 4 chars, all CJK
    const engSystem = 'abcd'; // 4 chars, all English
    const cjkTokens = estimateSystemTokens(cjkSystem);
    const engTokens = estimateSystemTokens(engSystem);
    expect(cjkTokens).toBeGreaterThan(engTokens);
  });
});

// ─── 9. Image token estimation ──────────────────────────────────────

describe('Image token estimation', () => {
  const makeImageBlock = (overrides: Partial<ImageBlock> = {}): ImageBlock => ({
    type: 'image',
    source: { type: 'url', url: 'https://example.com/img.png' },
    ...overrides,
  });

  describe('OpenAI / default family', () => {
    it('low detail → 85 tokens', () => {
      expect(estimateImageTokens(makeImageBlock({ detail: 'low' }))).toBe(85);
    });

    it('known dimensions → tile formula', () => {
      expect(estimateImageTokens(makeImageBlock({ width: 1024, height: 768 }))).toBe(765);
    });

    it('small image → 1 tile', () => {
      expect(estimateImageTokens(makeImageBlock({ width: 256, height: 256 }))).toBe(255);
    });

    it('large image gets scaled down', () => {
      expect(estimateImageTokens(makeImageBlock({ width: 4096, height: 3072 }))).toBe(765);
    });

    it('no dimensions → fallback 765', () => {
      expect(estimateImageTokens(makeImageBlock())).toBe(765);
    });
  });

  describe('Anthropic (Claude) family', () => {
    const family: ModelFamily = 'anthropic';

    it('known dimensions → pixel-based formula (w*h/750)', () => {
      // 1024x768 = 786432 pixels → ceil(786432/750) = 1049
      expect(estimateImageTokens(makeImageBlock({ width: 1024, height: 768 }), family)).toBe(1049);
    });

    it('large image scaled to 1568 max dimension', () => {
      // 4096x3072: scale = min(1568/4096, 1568/3072) = 0.383 → 1568x1176
      // 1568*1176 = 1843968 > 1.15M → pixel scale → ~1150000 pixels
      // ceil(1150000/750) ≈ 1534
      const tokens = estimateImageTokens(makeImageBlock({ width: 4096, height: 3072 }), family);
      expect(tokens).toBeGreaterThan(1000);
      expect(tokens).toBeLessThanOrEqual(1600);
    });

    it('small image → at least 100 tokens', () => {
      // 50x50 = 2500 pixels → ceil(2500/750) = 4, clamped to min 100
      expect(estimateImageTokens(makeImageBlock({ width: 50, height: 50 }), family)).toBe(100);
    });

    it('no dimensions → fallback 1600', () => {
      expect(estimateImageTokens(makeImageBlock(), family)).toBe(1600);
    });
  });

  describe('Google (Gemini) family', () => {
    it('fixed 258 tokens regardless of dimensions', () => {
      expect(estimateImageTokens(makeImageBlock({ width: 1024, height: 768 }), 'google')).toBe(258);
      expect(estimateImageTokens(makeImageBlock({ width: 4096, height: 3072 }), 'google')).toBe(258);
      expect(estimateImageTokens(makeImageBlock(), 'google')).toBe(258);
    });
  });

  it('image block in message contributes to token estimate', () => {
    const textMsg = makeUserMsg('describe this image');
    const imageMsg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        makeImageBlock({ width: 256, height: 256, detail: 'high' }),
      ],
    };
    const textOnly = estimateTokens([textMsg]);
    const withImage = estimateTokens([imageMsg]);
    expect(withImage).toBeGreaterThan(textOnly);
  });

  it('TokenEstimator with model set affects image token estimation', () => {
    const openaiEstimator = new TokenEstimator();
    openaiEstimator.setModel('gpt-4o');

    const claudeEstimator = new TokenEstimator();
    claudeEstimator.setModel('claude-sonnet-4-20250514');

    const geminiEstimator = new TokenEstimator();
    geminiEstimator.setModel('gemini-2.5-pro');

    const imageMsg: Message = {
      role: 'user',
      content: [makeImageBlock({ width: 1024, height: 768 })],
    };

    const openaiTokens = estimateTokens([imageMsg], openaiEstimator);
    const claudeTokens = estimateTokens([imageMsg], claudeEstimator);
    const geminiTokens = estimateTokens([imageMsg], geminiEstimator);

    expect(openaiTokens).not.toBe(claudeTokens);
    expect(openaiTokens).not.toBe(geminiTokens);
    expect(claudeTokens).not.toBe(geminiTokens);
  });
});

// ─── 10. TokenEstimator session isolation ────────────────────────────

describe('TokenEstimator session isolation', () => {
  it('two estimators have independent calibration factors', () => {
    const e1 = new TokenEstimator();
    const e2 = new TokenEstimator();

    e1.calibrate(100, 200);
    e2.calibrate(100, 50);

    expect(e1.getCalibrationFactor()).not.toBe(e2.getCalibrationFactor());
    expect(e1.getCalibrationFactor()).toBeGreaterThan(1.0);
    expect(e2.getCalibrationFactor()).toBeLessThan(1.0);
  });

  it('estimateTokens with estimator uses its factor, not default', () => {
    const estimator = new TokenEstimator();
    estimator.calibrate(100, 200); // factor > 1

    const msgs = [makeUserMsg('x'.repeat(400))];
    const withEstimator = estimateTokens(msgs, estimator);
    const withoutEstimator = estimateTokens(msgs);

    expect(withEstimator).toBeGreaterThan(withoutEstimator);
  });

  it('estimateFullContextTokens with estimator propagates to system and tools', () => {
    const estimator = new TokenEstimator();
    estimator.calibrate(100, 200);

    const msgs = [makeUserMsg('test')];
    const system = 'system prompt';
    const tools = [makeToolParam('tool_a', 'description')];

    const withEstimator = estimateFullContextTokens(msgs, system, tools, undefined, estimator);
    const withoutEstimator = estimateFullContextTokens(msgs, system, tools);

    expect(withEstimator).toBeGreaterThan(withoutEstimator);
  });

  it('setModel correctly detects model family', () => {
    const estimator = new TokenEstimator();

    estimator.setModel('claude-sonnet-4-20250514');
    expect(estimator.modelFamily).toBe('anthropic');

    estimator.setModel('gpt-4o');
    expect(estimator.modelFamily).toBe('openai');

    estimator.setModel('gemini-2.5-pro');
    expect(estimator.modelFamily).toBe('google');

    estimator.setModel('some-unknown-model');
    expect(estimator.modelFamily).toBe('unknown');
  });
});

// ─── 11. detectModelFamily ───────────────────────────────────────────

describe('detectModelFamily', () => {
  it('detects Anthropic models', () => {
    expect(detectModelFamily('claude-sonnet-4-20250514')).toBe('anthropic');
    expect(detectModelFamily('claude-3-opus')).toBe('anthropic');
    expect(detectModelFamily('anthropic/claude-3')).toBe('anthropic');
  });

  it('detects OpenAI models', () => {
    expect(detectModelFamily('gpt-4o')).toBe('openai');
    expect(detectModelFamily('gpt-4-turbo')).toBe('openai');
    expect(detectModelFamily('o1-preview')).toBe('openai');
    expect(detectModelFamily('o3-mini')).toBe('openai');
    expect(detectModelFamily('o4-mini')).toBe('openai');
    expect(detectModelFamily('chatgpt-4o-latest')).toBe('openai');
  });

  it('detects Google models', () => {
    expect(detectModelFamily('gemini-2.5-pro')).toBe('google');
    expect(detectModelFamily('gemini-2.0-flash')).toBe('google');
    expect(detectModelFamily('google/gemini-pro')).toBe('google');
  });

  it('returns unknown for unrecognized models', () => {
    expect(detectModelFamily('llama-3')).toBe('unknown');
    expect(detectModelFamily('mistral-7b')).toBe('unknown');
  });
});
