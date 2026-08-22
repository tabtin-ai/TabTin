/**
 *  — 摘要输入统一整备闸（sanitizeSummaryInput）契约测试。
 *
 * 背景：compact 摘要请求直发 provider，不经过主循环 beforeModel 的
 * message-governance 治理。此前截头 / 分块 / 增量切片产生的孤儿
 * tool_use / tool_result 靠各路径"记得手动调 repairOrphanToolCalls"兜底。
 * 现在收口为所有摘要 LLM 出口入口统一过 sanitizeSummaryInput
 * （normalizeMessages conservative + ensureToolResultPairing）。
 *
 * 锁定三条契约：
 *   1. 截头拆散 tool_use/tool_result 配对后，整备产出通过 validateToolPairing；
 *   2. 已治理（normalize+pairing 过）输入整备后内容等价——
 *      callCacheFriendlyFullSummary 的 prompt cache 前缀不被破坏；
 *   3. 末条为 user 时 ack / 摘要指令的 append 行为不变（整备在 scaffolding
 *      之前，不会把指令消息合并进历史）。
 */

import { describe, it, expect } from 'vitest';
import { compactConversation, sanitizeSummaryInput } from '../compact.js';
import { truncateHead } from '../../engine/context/token-budget.js';
import {
  ensureToolResultPairing,
  normalizeMessages,
  validateToolPairing,
} from '../../engine/context/message-normalizer.js';
import { CONTINUING_ACK } from '../../prompts/compact/inline-acks.js';
import { COMPACT_USER_PROMPT } from '../../prompts/compact/user.js';
import type {
  Message,
} from '../../engine/contracts/conversation.js';
import type {
  LLMRequest,
  LLMResponseChunk,
} from '../../engine/contracts/model-llm.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}

function asstMsg(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function toolUseMsg(id: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'read_file', input: { path: `/tmp/${id}.txt` } }],
  };
}

function toolResultMsg(toolUseId: string, content = 'x'.repeat(200)): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
  };
}

/** user 起步 + N 组 tool_use/tool_result 轮 + assistant 收尾。 */
function buildToolLoopConversation(pairs: number): Message[] {
  const msgs: Message[] = [userMsg('开始执行任务，请逐个读取文件')];
  for (let i = 0; i < pairs; i++) {
    msgs.push(toolUseMsg(`tu_${i}`));
    msgs.push(toolResultMsg(`tu_${i}`));
  }
  msgs.push(asstMsg('全部处理完成'));
  return msgs;
}

function makeCapturingCallModel(
  captured: LLMRequest[],
  responder?: (req: LLMRequest, callIndex: number) => void,
): (req: LLMRequest) => AsyncIterable<LLMResponseChunk> {
  return (req: LLMRequest) => {
    const callIndex = captured.length;
    captured.push(req);
    return (async function* (): AsyncIterable<LLMResponseChunk> {
      responder?.(req, callIndex);
      yield { type: 'text_delta', text: '这是摘要\n包含多行内容以通过质量检查' };
      yield { type: 'stop', stopReason: 'end_turn' };
    })();
  };
}

// ─── 1. 截头拆散配对 → 整备后通过配对校验 ────────────────────────────

describe('sanitizeSummaryInput — 截头产生的孤儿配对修复', () => {
  it('truncateHead 拆散 tool_use/tool_result 配对后，整备产出通过 validateToolPairing', () => {
    const msgs = buildToolLoopConversation(8);
    const truncated = truncateHead(msgs.slice(0, 14));

    // 前置确认：截头确实拆散了配对（否则本用例失去意义）
    expect(validateToolPairing(truncated)).toBe(false);

    const sanitized = sanitizeSummaryInput(truncated);
    expect(validateToolPairing(sanitized)).toBe(true);
  });

  it('切片边界的孤儿 tool_use（result 落在保留尾部）也被修复', () => {
    const msgs = buildToolLoopConversation(4);
    // 切在 tool_use 之后、tool_result 之前 → 切片末尾是无回执 tool_use
    const slice = msgs.slice(0, 2); // [user, assistant(tool_use tu_0)]
    expect(validateToolPairing(slice)).toBe(false);

    const sanitized = sanitizeSummaryInput(slice);
    expect(validateToolPairing(sanitized)).toBe(true);
  });
});

// ─── 2. 已治理输入 → 整备后内容等价（prompt cache 前缀不破坏） ────────

describe('sanitizeSummaryInput — 幂等性（cache 前缀关切）', () => {
  it('对已 normalize+pairing 的输入，整备产出内容深度相等', () => {
    const raw = buildToolLoopConversation(3);
    // 模拟主循环 beforeModel 治理后的 state.messages
    const governed = ensureToolResultPairing(
      normalizeMessages(raw, { level: 'conservative' }).messages,
    ).messages;

    const sanitized = sanitizeSummaryInput(governed);
    expect(sanitized).toEqual(governed);
    // byte 级等价：序列化结果一致才能保证 provider 侧 prompt cache 前缀命中
    expect(JSON.stringify(sanitized)).toBe(JSON.stringify(governed));
  });

  it('整备本身幂等：连续过两遍产出一致', () => {
    const msgs = truncateHead(buildToolLoopConversation(8).slice(0, 14));
    const once = sanitizeSummaryInput(msgs);
    const twice = sanitizeSummaryInput(once);
    expect(twice).toEqual(once);
  });
});

// ─── 3. scaffolding append 行为不变（整备在 ack/指令之前） ────────────

describe('compactConversation — 整备不改变 ack/摘要指令的 append 行为', () => {
  it('末条为 user 时：历史前缀原样保留，随后 append CONTINUING_ACK + 摘要指令', async () => {
    const input: Message[] = [
      userMsg('任务开始，请分析这个仓库'),
      asstMsg('好的，我先看目录结构'),
      userMsg('继续，重点看 compact 模块'),
      asstMsg('compact 模块的入口在 compact.ts'),
      userMsg('那配对修复逻辑呢'),
      asstMsg('在 message-normalizer.ts 里'),
      userMsg('总结一下目前的发现'),
    ];
    const captured: LLMRequest[] = [];

    await compactConversation({
      messages: input,
      systemPrompt: 'system prompt',
      model: 'test-model',
      callModel: makeCapturingCallModel(captured),
      keepLastN: 2,
    });

    expect(captured.length).toBeGreaterThan(0);
    const req = captured[0]!;
    // 历史前缀内容等价（缓存前缀不破坏）
    expect(req.messages.slice(0, input.length)).toEqual(input);
    // 末条 user → append assistant ack 维持 role alternation
    const ack = req.messages[input.length]!;
    expect(ack.role).toBe('assistant');
    expect(JSON.stringify(ack.content)).toContain(CONTINUING_ACK);
    // 摘要指令是独立的末尾 user 消息，没有被 normalize 合并进历史
    const instruction = req.messages[input.length + 1]!;
    expect(instruction.role).toBe('user');
    expect(String(instruction.content)).toContain(COMPACT_USER_PROMPT.slice(0, 20));
    expect(req.messages.length).toBe(input.length + 2);
  });

  it('末条为 assistant 时：不加 ack，摘要指令直接 append', async () => {
    const input: Message[] = [
      userMsg('任务开始'),
      asstMsg('收到'),
      userMsg('第二轮'),
      asstMsg('第二轮完成'),
      userMsg('第三轮'),
      asstMsg('第三轮完成'),
    ];
    const captured: LLMRequest[] = [];

    await compactConversation({
      messages: input,
      systemPrompt: 'system prompt',
      model: 'test-model',
      callModel: makeCapturingCallModel(captured),
      keepLastN: 2,
    });

    const req = captured[0]!;
    expect(req.messages.slice(0, input.length)).toEqual(input);
    const instruction = req.messages[input.length]!;
    expect(instruction.role).toBe('user');
    expect(String(instruction.content)).toContain(COMPACT_USER_PROMPT.slice(0, 20));
    expect(req.messages.length).toBe(input.length + 1);
  });
});

// ─── 4. PTL 截头重试链集成：无路径专用兜底也不会发孤儿给 provider ────

describe('retrySummaryAfterPromptTooLong — 统一整备闸替代手动 repair', () => {
  it('两次 PTL 后截头重试，发给 provider 的请求通过配对校验', async () => {
    const input = buildToolLoopConversation(10);
    const captured: LLMRequest[] = [];
    const callModel = makeCapturingCallModel(captured, (_req, callIndex) => {
      // 第 1 次（cache-friendly 全量）与第 2 次（仅瘦身重试）都报 PTL，
      // 逼出第 3 次的截头重试路径。
      if (callIndex < 2) throw new Error('prompt is too long');
    });

    const result = await compactConversation({
      messages: input,
      systemPrompt: 'system prompt',
      model: 'test-model',
      callModel,
    });

    expect(captured.length).toBe(3);
    const retryReq = captured[2]!;
    // 截头必然拆散过配对；统一整备闸保证发出去的请求结构合法
    expect(validateToolPairing(retryReq.messages)).toBe(true);
    expect(result.summary).toContain('这是摘要');
  });
});
