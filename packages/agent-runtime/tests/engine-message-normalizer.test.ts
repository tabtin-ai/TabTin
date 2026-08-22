/**
 * FR-03 — Unified `normalizeMessages` entry point.
 *
 * These tests lock the contract between `message-normalizer.ts` and
 * the call site in `query.ts` (per-iteration, after FR-04 size budget,
 * before `llmRequest` build). They cover:
 *
 *   - individual sub-steps (`validateToolPairing`,
 *     `mergeConsecutiveMessages`, `repairOrphanToolCalls`,
 *     `filterOrphanedThinkingOnlyMessages`)
 *   - `normalizeMessages` level semantics (`off` / `conservative` / `full`)
 *   - collaboration with FR-04 truncation (thinking-only messages
 *     produced by size-budget squeezing must still be dropped)
 *   - collaboration with compaction (synthesising orphans in the exact
 *     shape `compact.ts findSplitPoint` can produce)
 *
 * The suite is pure — no LLM / no tool execution — so it runs in < 50 ms.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  normalizeMessages,
  validateToolPairing,
  mergeConsecutiveMessages,
  repairOrphanToolCalls,
  filterOrphanedThinkingOnlyMessages,
  hasAnyChange,
  keepLatestAgentProfileRuntimeMessages,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  DEFAULT_NORMALIZATION_LEVEL,
  ensureToolResultPairing,
  classifyUserMessageForMerge,
} from '../src/engine/context/message-normalizer.js';
import type { NormalizeChanges } from '../src/engine/context/message-normalizer.js';
import type {
  ContentBlock,
  Message,
  ToolResultBlock,
} from '../src/engine/contracts/conversation.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
} from '../src/engine/contracts/conversation.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function userText(text: string): Message {
  return { role: 'user', content: text };
}

function userBlocks(...blocks: ContentBlock[]): Message {
  return { role: 'user', content: blocks };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function assistantBlocks(...blocks: ContentBlock[]): Message {
  return { role: 'assistant', content: blocks };
}

function toolUse(id: string, name: string, input: unknown = {}): ContentBlock {
  return { type: 'tool_use', id, name, input };
}

function toolResult(
  toolUseId: string,
  content: string | ContentBlock[] = 'ok',
): ContentBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content };
}

function thinking(text: string): ContentBlock {
  return { type: 'thinking', thinking: text };
}

// ─── 1. validateToolPairing ──────────────────────────────────────────

describe('validateToolPairing', () => {
  it('returns true on an empty message array', () => {
    expect(validateToolPairing([])).toBe(true);
  });

  it('returns true when every tool_use has a matching tool_result', () => {
    const msgs: Message[] = [
      userText('hi'),
      assistantBlocks(toolUse('a', 'ls')),
      userBlocks(toolResult('a')),
    ];
    expect(validateToolPairing(msgs)).toBe(true);
  });

  it('returns false when tool_use has no matching tool_result', () => {
    const msgs: Message[] = [
      assistantBlocks(toolUse('a', 'ls')),
    ];
    expect(validateToolPairing(msgs)).toBe(false);
  });

  it('returns false when tool_result has no matching tool_use', () => {
    const msgs: Message[] = [
      userBlocks(toolResult('ghost')),
    ];
    expect(validateToolPairing(msgs)).toBe(false);
  });

  it('ignores messages whose content is a string', () => {
    const msgs: Message[] = [
      userText('just text'),
      assistantText('just text reply'),
    ];
    expect(validateToolPairing(msgs)).toBe(true);
  });

  it('handles multiple pairs in mixed order', () => {
    const msgs: Message[] = [
      assistantBlocks(toolUse('a', 't1'), toolUse('b', 't2')),
      userBlocks(toolResult('b'), toolResult('a')),
    ];
    expect(validateToolPairing(msgs)).toBe(true);
  });
});

// ─── 2. mergeConsecutiveMessages ─────────────────────────────────────

describe('mergeConsecutiveMessages', () => {
  it('returns unchanged when there are < 2 messages', () => {
    const msgs: Message[] = [userText('hi')];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toBe(msgs); // no copy when early-out
  });

  it('merges two consecutive user messages (string+string)', () => {
    const msgs: Message[] = [userText('first'), userText('second')];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(1);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.content).toBe('first\n\nsecond');
  });

  it('merges three consecutive user turns into one (array content)', () => {
    const msgs: Message[] = [
      userBlocks({ type: 'text', text: 'one' }),
      userBlocks({ type: 'text', text: 'two' }),
      userBlocks({ type: 'text', text: 'three' }),
    ];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(2);
    expect(out.messages).toHaveLength(1);
    expect(Array.isArray(out.messages[0]!.content)).toBe(true);
    const blocks = out.messages[0]!.content as ContentBlock[];
    expect(blocks.map((b) => (b.type === 'text' ? b.text : ''))).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('does not merge different roles', () => {
    const msgs: Message[] = [userText('hello'), assistantText('world')];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
  });

  it('merges string + array content by promoting string to text block', () => {
    const msgs: Message[] = [
      userText('intro'),
      userBlocks({ type: 'text', text: 'body' }, { type: 'text', text: 'tail' }),
    ];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(1);
    const blocks = out.messages[0]!.content as ContentBlock[];
    expect(blocks.map((b) => (b.type === 'text' ? b.text : ''))).toEqual([
      'intro',
      'body',
      'tail',
    ]);
  });

  it('preserves spread fields (forward-compat for future `id` / `timestamp`)', () => {
    // Simulate a future Message field via cast so this test locks the
    // shape even though Message type today has no extras.
    type FutureMessage = Message & { id?: string };
    const first: FutureMessage = { role: 'user', content: 'a', id: 'm1' };
    const second: FutureMessage = { role: 'user', content: 'b', id: 'm2' };
    const out = mergeConsecutiveMessages([first, second] as Message[], 'user');
    expect(out.merged).toBe(1);
    expect((out.messages[0] as FutureMessage).id).toBe('m1');
  });

  it('merges consecutive assistant messages on request', () => {
    const msgs: Message[] = [
      assistantText('alpha'),
      assistantText('beta'),
      userText('interrupt'),
      assistantText('gamma'),
    ];
    const out = mergeConsecutiveMessages(msgs, 'assistant');
    expect(out.merged).toBe(1);
    expect(out.messages).toHaveLength(3);
    const merged = out.messages[0]!.content as ContentBlock[];
    expect(merged.map((b) => (b.type === 'text' ? b.text : ''))).toEqual([
      'alpha',
      'beta',
    ]);
  });

  // ── W4.3 P0 跨语义保护：tool_result-only vs text-only user 不合并 ──

  it('W4.3：tool_result-only user + text-only user → 不合并（保护跨轮 user 不被吞）', () => {
    const msgs: Message[] = [
      userBlocks(toolResult('tc1', 'output of file1')),
      userText('读 file2 / 一句话概括'),
    ];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'tc1', content: 'output of file1' },
    ]);
    expect(out.messages[1]!.content).toBe('读 file2 / 一句话概括');
  });

  it('W4.3：两条 tool_result-only user → 仍合并（multi-tool 跨 user 拆分场景）', () => {
    const msgs: Message[] = [
      userBlocks(toolResult('tc1', 'r1')),
      userBlocks(toolResult('tc2', 'r2')),
    ];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(1);
    expect(out.messages).toHaveLength(1);
    const blocks = out.messages[0]!.content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe('tool_result');
    expect(blocks[1]!.type).toBe('tool_result');
  });

  it('W4.3：两条 text-only user (string content) → 仍合并（人类连发短消息）', () => {
    const msgs: Message[] = [userText('first'), userText('second')];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(1);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.content).toBe('first\n\nsecond');
  });

  it('W4.3：text-only user + tool_result-only user → 不合并（反向也保护）', () => {
    const msgs: Message[] = [
      userText('text input first'),
      userBlocks(toolResult('tc1', 'tool output')),
    ];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
  });

  it('W4.3：mixed user message（含 text + tool_result）算 "other" → 不会跟 tool_result-only 合并', () => {
    const msgs: Message[] = [
      userBlocks(toolResult('tc1', 'r1'), { type: 'text', text: 'note' }),  // mixed = other
      userBlocks(toolResult('tc2', 'r2')),  // tool_result_only
    ];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
  });

  it('W4.3：3 条 user [tool_result_only, text_only, tool_result_only] → 不合并任何相邻', () => {
    const msgs: Message[] = [
      userBlocks(toolResult('tc1', 'r1')),
      userText('user input'),
      userBlocks(toolResult('tc2', 'r2')),
    ];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(3);
  });

  it('W4.3：保护仅作用于 user role；assistant merge 逻辑不变（不分类）', () => {
    // assistant 没有"工具结果消息"概念——assistant 的 tool_use 块跟 text 块是同语义产物，
    // 仍按原行为合并。
    const msgs: Message[] = [
      assistantBlocks({ type: 'text', text: 'a' }),
      assistantBlocks({ type: 'tool_use', id: 'x', name: 'f', input: {} }),
    ];
    const out = mergeConsecutiveMessages(msgs, 'assistant');
    expect(out.merged).toBe(1);
    expect(out.messages).toHaveLength(1);
    const blocks = out.messages[0]!.content as ContentBlock[];
    expect(blocks).toHaveLength(2);
  });

  // ── W4.3.2 P0 跨语义保护：context_injection / continuation 也不合并 ──
  //
  // 真根因：dogfood W4 第二轮 thinking "用户想要我：1. 列出 2. 阅读" 显形——
  // context-injector hook 注入的 contextMsg 跟用户真实输入 user "那你阅读" 在
  // 旧 W4.3 二分类眼里都是 'other'，被合并成一条 user [<context>, "ls", "那你阅读"]
  // → LLM 把 turn 1 + turn 2 混为同一次请求。
  //
  // 修法：classifyUserMessage 扩四分类（tool_result_only / context_injection /
  // continuation / other），任意两 kind 不同都不合并。

  it('W4.3.2：context-injection user + 普通 user → 不合并（dogfood P0 真根因）', () => {
    const contextMsg: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context>\ncurrent_datetime: 2026-04-28 ...\n</context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
    );
    const msgs: Message[] = [contextMsg, userText('那你阅读一下这个 skill')];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
    // contextMsg 仍带 marker（merge 不发生 → 引用保留）
    expect(hasInternalMarker(out.messages[0]!, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)).toBe(true);
  });

  it('W4.3.2：dogfood 现场三连 [contextMsg + user "ls" + user "那你阅读"] → 不合并', () => {
    // 复现 dogfood Snapshot 3：turn 2 iter=0 时 LLM 收到 1 条 user
    // 内含 [<context>, "ls 列出来", "那你阅读"] 3 个 text blocks——P0 真现场。
    // 修复后期望 3 条独立保留。
    const contextMsg: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context>\nfocused_app: tabsettings\n</context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
    );
    const msgs: Message[] = [
      contextMsg,
      userText('ls 列出来我的当前文件夹'),
      userText('那你阅读一下这个 skill'),
    ];
    const out = mergeConsecutiveMessages(msgs, 'user');
    // contextMsg (context_injection) + user "ls" (other) → 不合并
    // user "ls" (other) + user "那你阅读" (other) → 仍合并（同 kind）
    // 结果：2 条 message
    expect(out.merged).toBe(1);
    expect(out.messages).toHaveLength(2);
    expect(hasInternalMarker(out.messages[0]!, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)).toBe(true);
    // 第二条是合并的两个 user
    expect(out.messages[1]!.content).toBe('ls 列出来我的当前文件夹\n\n那你阅读一下这个 skill');
  });

  it('W4.3.2：continuation user (max_tokens) + 后续用户 user → 不合并', () => {
    const contMsg: Message = setInternalMarker(
      { role: 'user', content: 'Your response was cut off. Continue exactly...' },
      INTERNAL_MESSAGE_MARKERS.CONTINUATION,
    );
    const msgs: Message[] = [contMsg, userText('请改成中文')];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
  });

  it('W4.3.2：context_injection + tool_result_only + continuation + other 四类两两都不合并', () => {
    // 极限场景：四类相邻——任意两 kind 不同都不合并
    const contextMsg: Message = setInternalMarker(
      { role: 'user', content: [{ type: 'text', text: '<context>...</context>' }] },
      INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
    );
    const continueMsg: Message = setInternalMarker(
      { role: 'user', content: 'Continue exactly...' },
      INTERNAL_MESSAGE_MARKERS.CONTINUATION,
    );
    const msgs: Message[] = [
      contextMsg,
      userBlocks(toolResult('tc1', 'r1')),
      continueMsg,
      userText('please continue with this'),
    ];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(4);
  });

  it('W4.3.2：两条 context_injection user → 仍合并（同 kind）', () => {
    // 理论上 hook 不应该 prepend 两次 context_injection（filter 已防止），
    // 但若发生（语义同 kind）应仍合并以维持原行为契约。
    const c1: Message = setInternalMarker(
      { role: 'user', content: [{ type: 'text', text: '<context>v1</context>' }] },
      INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
    );
    const c2: Message = setInternalMarker(
      { role: 'user', content: [{ type: 'text', text: '<context>v2</context>' }] },
      INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
    );
    const msgs: Message[] = [c1, c2];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(1);
    expect(out.messages).toHaveLength(1);
  });

  it('W4.3.2：classifyUserMessage marker 优先级高于结构检测', () => {
    // 一条带 CONTEXT_INJECTION marker 的 user，content 是 tool_result-only 形态
    // （理论不该出现，但若 hook bug 制造了畸形也应按 marker 分类，避免误合并到
    //  邻近的真 tool_result-only user）。
    const weirdMsg: Message = setInternalMarker(
      { role: 'user', content: [toolResult('tc1', 'r1')] },
      INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
    );
    const trMsg = userBlocks(toolResult('tc2', 'r2'));
    const msgs: Message[] = [weirdMsg, trMsg];
    const out = mergeConsecutiveMessages(msgs, 'user');
    // marker 优先 → weirdMsg = context_injection, trMsg = tool_result_only → 不合并
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
  });

  // ─── 阶段 6 议题 2：3 个新 marker kind 都不合并 ───────────────────
  //
  // 议题 2 给 normalizer 补齐 3 类 marker：
  //   - MEMORY_INJECTION → kind 'memory_recall'
  //   - LSP_DIAGNOSTICS_INJECTION → kind 'lsp_diagnostics'
  //   - TOOL_EVICTION_NOTICE → kind 'tool_eviction_notice'
  //
  // dogfood W4 撞过的 P0 是同型契约漏洞：合成 user 没 marker → normalizer
  // 归 'other' → 跟相邻真用户 user 合并 → LLM 误解。下面 3 个 case 锁定
  // 每个新 marker 都跟相邻 'other' user 不合并。

  it('阶段 6 议题 2：MEMORY_INJECTION marker → 不与相邻 user 合并', () => {
    const memMsg: Message = setInternalMarker(
      { role: 'user', content: [{ type: 'text', text: '<context type="memory-recall">memo 1</context>' }] },
      INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION,
    );
    const msgs: Message[] = [memMsg, userText('帮我导出 csv')];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
    expect(hasInternalMarker(out.messages[0]!, INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION)).toBe(true);
  });

  it('阶段 6 议题 2：LSP_DIAGNOSTICS_INJECTION marker → 不与相邻 user 合并', () => {
    const lspMsg: Message = setInternalMarker(
      { role: 'user', content: [{ type: 'text', text: '<context type="lsp-diagnostic"><new-diagnostics>...</new-diagnostics></context>' }] },
      INTERNAL_MESSAGE_MARKERS.LSP_DIAGNOSTICS_INJECTION,
    );
    const msgs: Message[] = [lspMsg, userText('修一下')];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
    expect(hasInternalMarker(out.messages[0]!, INTERNAL_MESSAGE_MARKERS.LSP_DIAGNOSTICS_INJECTION)).toBe(true);
  });

  it('阶段 6 议题 2：TOOL_EVICTION_NOTICE marker → 不与相邻 user 合并', () => {
    const evictMsg: Message = setInternalMarker(
      { role: 'user', content: [{ type: 'text', text: '<context type="tool-eviction">[system] 工具已下线</context>' }] },
      INTERNAL_MESSAGE_MARKERS.TOOL_EVICTION_NOTICE,
    );
    const msgs: Message[] = [evictMsg, userText('继续')];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
    expect(hasInternalMarker(out.messages[0]!, INTERNAL_MESSAGE_MARKERS.TOOL_EVICTION_NOTICE)).toBe(true);
  });

  it('阶段 6 议题 2：6 类 marker 两两都不合并（context + memory_recall + lsp + tool_eviction + continuation + other）', () => {
    // 极限场景：把所有 5 种 marker + 普通 user 排成一摞——任意两个 kind 不同都不合并。
    const ctxMsg: Message = setInternalMarker(
      { role: 'user', content: [{ type: 'text', text: '<context type="environment">...</context>' }] },
      INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
    );
    const memMsg: Message = setInternalMarker(
      { role: 'user', content: [{ type: 'text', text: '<context type="memory-recall">...</context>' }] },
      INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION,
    );
    const lspMsg: Message = setInternalMarker(
      { role: 'user', content: [{ type: 'text', text: '<context type="lsp-diagnostic">...</context>' }] },
      INTERNAL_MESSAGE_MARKERS.LSP_DIAGNOSTICS_INJECTION,
    );
    const evictMsg: Message = setInternalMarker(
      { role: 'user', content: [{ type: 'text', text: '<context type="tool-eviction">...</context>' }] },
      INTERNAL_MESSAGE_MARKERS.TOOL_EVICTION_NOTICE,
    );
    const contMsg: Message = setInternalMarker(
      { role: 'user', content: 'Continue exactly...' },
      INTERNAL_MESSAGE_MARKERS.CONTINUATION,
    );
    const userPlain = userText('请改成中文');

    const msgs = [ctxMsg, memMsg, lspMsg, evictMsg, contMsg, userPlain];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(6);
  });

  // ── 技术债修复（2026-05-29）：MODE_TRANSITION_REMINDER 漏注册 → 合并 bug ──
  //
  // 根因：mode-reminder-injector 在 plan→agent 切换后把 mode_transition_reminder
  // 插在最后一条真用户消息之后（splice insertAfter+1）；classifyUserMessage
  // 漏注册该 marker → 落 'other' → 与相邻真用户输入合并；query.ts:2589 写回
  // state.messages 永久污染历史、reminder 永不消失。与 dogfood W4 P0 同型。
  // 修复 = classifyUserMessage 加 mode_transition_reminder 分支。

  it('MODE_TRANSITION_REMINDER marker → 不与相邻真用户合并（修复 2026-05-29 P0 同型 bug）', () => {
    const exitMsg: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context type="mode-transition-reminder"><system-reminder>已从 ask 模式切换到 agent 模式</system-reminder></context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.MODE_TRANSITION_REMINDER,
    );
    // 现场顺序：真用户消息在前，exit reminder 紧随其后（injector splice 行为）
    const msgs: Message[] = [userText('开始执行吧'), exitMsg];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]!.content).toBe('开始执行吧');
    expect(hasInternalMarker(out.messages[1]!, INTERNAL_MESSAGE_MARKERS.MODE_TRANSITION_REMINDER)).toBe(true);
  });

  // ── 项目规则自动加载（AGENTS.md MVP）：PROJECT_RULES_INJECTION 不合并 ──
  //
  // rules-injector 每轮把 <project_rules> unshift 到 messages 最前；该 user
  // 跟相邻真用户输入合并会让 LLM 把"项目规约"误当用户当前请求的一部分——
  // 与 dogfood W4 P0 同型。穷尽契约测试已自动覆盖注册，本用例锁定现场形态。

  it('PROJECT_RULES_INJECTION marker → 不与相邻真用户合并', () => {
    const rulesMsg: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<project_rules source="AGENTS.md">本项目用 TS</project_rules>' }],
      },
      INTERNAL_MESSAGE_MARKERS.PROJECT_RULES_INJECTION,
    );
    // 现场顺序：rules 在 messages 最前，真用户输入紧随其后（unshift 行为）
    const msgs: Message[] = [rulesMsg, userText('帮我重构这个模块')];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
    expect(hasInternalMarker(out.messages[0]!, INTERNAL_MESSAGE_MARKERS.PROJECT_RULES_INJECTION)).toBe(true);
    expect(out.messages[1]!.content).toBe('帮我重构这个模块');
  });

  it('PROJECT_RULES_INJECTION + CONTEXT_INJECTION 相邻 → 不合并（装配顺序现场）', () => {
    // 末位装配后稳态形态：[project_rules, context, ...]——两条注入 user 相邻，
    // kind 不同应不合并。
    const rulesMsg: Message = setInternalMarker(
      { role: 'user', content: [{ type: 'text', text: '<project_rules source="AGENTS.md">r</project_rules>' }] },
      INTERNAL_MESSAGE_MARKERS.PROJECT_RULES_INJECTION,
    );
    const ctxMsg: Message = setInternalMarker(
      { role: 'user', content: [{ type: 'text', text: '<context type="environment">e</context>' }] },
      INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
    );
    const msgs: Message[] = [rulesMsg, ctxMsg, userText('真用户输入')];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(3);
  });

  // ── ：HISTORICAL_AGENT_PROFILE 漏注册曾导致与真 user 合并 ──

  it('HISTORICAL_AGENT_PROFILE marker → 不与相邻真用户合并', () => {
    const profileMsg: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context type="agent-profile">\n你是test。\n</context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE,
    );
    const msgs: Message[] = [userText('第一轮用户话'), profileMsg];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.merged).toBe(0);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]!.content).toBe('第一轮用户话');
    expect(hasInternalMarker(out.messages[1]!, INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE)).toBe(true);
  });

  it('AGENT_PROFILE_INJECTION + HISTORICAL_AGENT_PROFILE 相邻 → 不与真用户合并（同 kind 可互并）', () => {
    const historical: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context type="agent-profile">\nold\n</context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE,
    );
    const fresh: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context type="agent-profile">\nnew\n</context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION,
    );
    // 同 kind=agent_profile 相邻时可合并——normalize 会先 keep-latest 再 merge，
    // 此处只断言它们都不与真用户合并。
    const msgs: Message[] = [historical, fresh, userText('本轮提问')];
    const out = mergeConsecutiveMessages(msgs, 'user');
    expect(out.messages[out.messages.length - 1]!.content).toBe('本轮提问');
    expect(
      out.messages.some((m) => typeof m.content === 'string' && m.content.includes('本轮提问') && m.content.includes('agent-profile')),
    ).toBe(false);
  });
});

describe('keepLatestAgentProfileRuntimeMessages ', () => {
  it('历史多份 + 本轮 fresh 只保留最新一份', () => {
    const oldHistorical: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context type="agent-profile">\nv1\n</context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE,
    );
    const midHistorical: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context type="agent-profile">\nv2\n</context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE,
    );
    const fresh: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context type="agent-profile">\nv3-fresh\n</context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION,
    );
    const msgs: Message[] = [
      userText('u1'),
      oldHistorical,
      assistantText('a1'),
      userText('u2'),
      midHistorical,
      assistantText('a2'),
      fresh,
      userText('u3'),
    ];
    const out = keepLatestAgentProfileRuntimeMessages(msgs);
    expect(out.dropped).toBe(2);
    const profiles = out.messages.filter((m) =>
      hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION)
      || hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE),
    );
    expect(profiles).toHaveLength(1);
    expect(firstMessageTextForTest(profiles[0]!)).toContain('v3-fresh');
  });

  it('normalizeMessages 在 merge 前 keep-latest，且 hasAnyChange 计入 dropped', () => {
    const oldProfile: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context type="agent-profile">\nold\n</context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE,
    );
    const newProfile: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context type="agent-profile">\nnew\n</context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION,
    );
    const msgs: Message[] = [
      userText('hi'),
      oldProfile,
      assistantText('ok'),
      newProfile,
      userText('again'),
    ];
    const out = normalizeMessages(msgs, { level: 'conservative' });
    expect(out.changes.agent_profile_dropped).toBe(1);
    expect(hasAnyChange(out.changes)).toBe(true);
    const profileTexts = out.messages
      .filter((m) => m.role === 'user')
      .map((m) => firstMessageTextForTest(m))
      .filter((t) => t.includes('type="agent-profile"'));
    expect(profileTexts).toHaveLength(1);
    expect(profileTexts[0]).toContain('new');
    expect(profileTexts[0]).not.toContain('old');
  });

  it('level=off 仍执行 agent-profile keep-latest', () => {
    const p1: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context type="agent-profile">\na\n</context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE,
    );
    const p2: Message = setInternalMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context type="agent-profile">\nb\n</context>' }],
      },
      INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE,
    );
    const out = normalizeMessages(
      [userText('u1'), p1, assistantText('a1'), p2, userText('u2')],
      { level: 'off' },
    );
    expect(out.changes.agent_profile_dropped).toBe(1);
    expect(hasAnyChange(out.changes)).toBe(true);
    const profileTexts = out.messages
      .map((m) => firstMessageTextForTest(m))
      .filter((t) => t.includes('type="agent-profile"'));
    expect(profileTexts).toEqual([expect.stringContaining('b')]);
  });
});

function firstMessageTextForTest(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  for (const block of msg.content) {
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return '';
}

// ─── marker 注册机器约束（2026-05-29 技术债）──────────────────────────
//
// 根治"注入合成 user message 的 marker 漏在 classifyUserMessage 注册"这类
// 反复出现的契约漏洞（mode_transition_reminder / tool_eviction 都曾漏过）。遍历
// INTERNAL_MESSAGE_MARKERS 全集，断言每个 marker 都被 classify 成非 'other'。
// 新增 marker 漏注册即此用例红——把"靠人记注释 + code review"升级为"CI 拦截"。

describe('marker 注册契约（穷尽）', () => {
  // 明确不需要 classify 的 marker（非"注入合成 user message"类）。目前为空：
  // 所有 marker 都是注入 user message。未来若新增非 user-injection marker，
  // 必须显式登记到此 allowlist —— 强制开发者对每个新 marker 做出选择，而不是
  // 默默落 'other'。
  const NON_USER_INJECTION_MARKERS = new Set<string>([]);

  it('每个 INTERNAL_MESSAGE_MARKER 都在 classifyUserMessage 注册（或显式豁免）', () => {
    const unregistered: string[] = [];
    for (const marker of Object.values(INTERNAL_MESSAGE_MARKERS)) {
      if (NON_USER_INJECTION_MARKERS.has(marker)) continue;
      const msg: Message = setInternalMarker(
        { role: 'user', content: [{ type: 'text', text: 'x' }] },
        marker,
      );
      if (classifyUserMessageForMerge(msg) === 'other') {
        unregistered.push(marker);
      }
    }
    expect(
      unregistered,
      `以下 marker 未在 classifyUserMessage 注册（会落 'other' → 与真用户输入合并，重蹈 dogfood W4 P0）：${unregistered.join(', ')}`,
    ).toEqual([]);
  });
});

// ─── 3. filterOrphanedThinkingOnlyMessages ───────────────────────────

describe('filterOrphanedThinkingOnlyMessages', () => {
  it('drops an assistant message whose content is only thinking', () => {
    const msgs: Message[] = [
      userText('hi'),
      assistantBlocks(thinking('ruminating…')),
      assistantText('answer'),
    ];
    const out = filterOrphanedThinkingOnlyMessages(msgs);
    expect(out.filtered).toBe(1);
    expect(out.messages).toHaveLength(2);
    expect(out.messages.every((m) => m.content !== msgs[1]!.content)).toBe(true);
  });

  it('keeps an assistant message with thinking + text', () => {
    const msgs: Message[] = [
      assistantBlocks(thinking('x'), { type: 'text', text: 'real answer' }),
    ];
    const out = filterOrphanedThinkingOnlyMessages(msgs);
    expect(out.filtered).toBe(0);
    expect(out.messages).toHaveLength(1);
  });

  it('leaves plain-string assistant content untouched', () => {
    const msgs: Message[] = [{ role: 'assistant', content: 'plain text' }];
    const out = filterOrphanedThinkingOnlyMessages(msgs);
    expect(out.filtered).toBe(0);
    // Impl may copy for simplicity; logical equality is the contract.
    expect(out.messages).toEqual(msgs);
  });

  it('leaves an empty-array assistant message for ensureNonEmptyContent to clean up', () => {
    const msgs: Message[] = [assistantBlocks()];
    const out = filterOrphanedThinkingOnlyMessages(msgs);
    expect(out.filtered).toBe(0); // this pass isn't responsible for empty content
    expect(out.messages).toHaveLength(1);
  });
});

// ─── 4. repairOrphanToolCalls ────────────────────────────────────────

describe('repairOrphanToolCalls', () => {
  it('inserts a synthetic tool_result for an orphan tool_use', () => {
    const msgs: Message[] = [
      userText('run a'),
      assistantBlocks(toolUse('a', 'ls')),
    ];
    const out = repairOrphanToolCalls(msgs);
    expect(out.orphan_tool_use_fixed).toBe(1);
    expect(out.orphan_tool_result_fixed).toBe(0);
    expect(out.messages).toHaveLength(3);
    const tail = out.messages[2]!;
    expect(tail.role).toBe('user');
    expect(Array.isArray(tail.content)).toBe(true);
    const blocks = tail.content as ContentBlock[];
    expect(blocks).toHaveLength(1);
    const synthetic = blocks[0]! as ToolResultBlock;
    expect(synthetic.tool_use_id).toBe('a');
    expect(synthetic.is_error).toBe(true);
    expect(synthetic.content).toBe(SYNTHETIC_TOOL_RESULT_PLACEHOLDER);
  });

  it('absorbs the synthetic tool_result into an existing next user turn', () => {
    const msgs: Message[] = [
      assistantBlocks(toolUse('a', 'ls')),
      userText('what about the other thing?'),
    ];
    const out = repairOrphanToolCalls(msgs);
    expect(out.orphan_tool_use_fixed).toBe(1);
    expect(out.messages).toHaveLength(2);
    const mergedUser = out.messages[1]!;
    expect(mergedUser.role).toBe('user');
    const blocks = mergedUser.content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe('tool_result');
    expect(blocks[1]!.type).toBe('text');
    // No fresh user/user sandwich was introduced.
    expect(out.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('drops an orphan tool_result whose tool_use is missing', () => {
    const msgs: Message[] = [
      assistantText('setting up'),
      userBlocks(toolResult('ghost'), { type: 'text', text: 'follow-up' }),
    ];
    const out = repairOrphanToolCalls(msgs);
    expect(out.orphan_tool_result_fixed).toBe(1);
    expect(out.orphan_tool_use_fixed).toBe(0);
    expect(out.empty_dropped).toBe(0);
    const userMsg = out.messages[1]!;
    const blocks = userMsg.content as ContentBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
  });

  it('drops the whole message when stripping orphan tool_result leaves no content', () => {
    const msgs: Message[] = [
      assistantText('setting up'),
      userBlocks(toolResult('ghost')),
      userText('anything else?'),
    ];
    const out = repairOrphanToolCalls(msgs);
    expect(out.orphan_tool_result_fixed).toBe(1);
    expect(out.empty_dropped).toBe(1);
    expect(out.messages).toHaveLength(2); // only assistant + followup user
    expect(out.messages[1]!.role).toBe('user');
  });

  it('leaves legitimate tool_use/tool_result pairs untouched', () => {
    const msgs: Message[] = [
      assistantBlocks(toolUse('a', 'ls')),
      userBlocks(toolResult('a', 'ok')),
    ];
    const out = repairOrphanToolCalls(msgs);
    expect(out.fixed).toBe(0);
    expect(out.messages).toEqual(msgs);
  });

  it('handles assistant with mixed orphan + paired tool_uses', () => {
    const msgs: Message[] = [
      assistantBlocks(toolUse('a', 'ls'), toolUse('b', 'pwd')),
      userBlocks(toolResult('a')),
    ];
    const out = repairOrphanToolCalls(msgs);
    expect(out.orphan_tool_use_fixed).toBe(1);
    expect(out.messages).toHaveLength(2);
    const user = out.messages[1]!;
    const blocks = user.content as ContentBlock[];
    // synthetic tool_result for 'b' must come before the real one for 'a'
    // (insertion prepends the stub; test both are present regardless of
    // order by id).
    const ids = blocks
      .filter((b): b is ToolResultBlock => b.type === 'tool_result')
      .map((b) => b.tool_use_id);
    expect(ids.sort()).toEqual(['a', 'b']);
    const synthetic = blocks.find(
      (b) => b.type === 'tool_result' && b.tool_use_id === 'b',
    ) as ToolResultBlock;
    expect(synthetic.is_error).toBe(true);
  });
});

// ─── 5. normalizeMessages (integrated) ───────────────────────────────

describe('normalizeMessages — level semantics', () => {
  it("'off' 无 agent-profile 时可返回原引用且零 changes（不跑结构清理）", () => {
    // 有多份 agent-profile 时 off 仍会 keep-latest（见上方  用例）。
    const msgs: Message[] = [userText('a'), userText('b')];
    const out = normalizeMessages(msgs, { level: 'off' });
    expect(out.messages).toBe(msgs);
    expect(hasAnyChange(out.changes)).toBe(false);
  });

  it("default level is 'conservative' when options is omitted", () => {
    const msgs: Message[] = [userText('one'), userText('two')];
    const out = normalizeMessages(msgs);
    expect(out.changes.merged_user).toBe(1);
    expect(DEFAULT_NORMALIZATION_LEVEL).toBe('conservative');
  });

  it("'conservative' merges users, repairs orphans, filters thinking-only, and drops empty", () => {
    const msgs: Message[] = [
      userText('start'),
      userText('kick off task'), // consecutive user — will merge
      assistantBlocks(toolUse('a', 'ls')), // orphan tool_use → repair
      assistantBlocks(thinking('idle')), // thinking-only → drop
      userBlocks(toolResult('ghost')), // orphan tool_result → drop, empty msg
    ];
    const out = normalizeMessages(msgs, { level: 'conservative' });
    expect(out.changes.merged_user).toBeGreaterThanOrEqual(1);
    expect(out.changes.orphan_tool_use_fixed).toBe(1);
    expect(out.changes.orphan_tool_result_fixed).toBe(1);
    expect(out.changes.thinking_filtered).toBe(1);
    // orphan tool_result dropped, then whole msg becomes empty
    expect(out.changes.empty_dropped).toBeGreaterThanOrEqual(1);
    // After repair, pairing must be clean.
    expect(validateToolPairing(out.messages)).toBe(true);
    expect(out.changes.pairing_violations).toBe(0);
  });

  it('#11022 conservative 丢掉夹在错误卡之间的空白 user', () => {
    const msgs: Message[] = [
      userText('问天气'),
      assistantText('[LLM_ERROR] 网络连接不稳定'),
      userText(''),
      assistantText('[LLM_RATE_LIMIT] 服务繁忙'),
      userBlocks({ type: 'text', text: '   ' }),
      assistantText('占位'),
      userText('看下是什么'),
    ];
    const out = normalizeMessages(msgs, { level: 'conservative' });
    expect(out.changes.empty_dropped).toBeGreaterThanOrEqual(2);
    expect(out.messages.filter((msg) => msg.role === 'user').map((msg) => msg.content)).toEqual([
      '问天气',
      '看下是什么',
    ]);
  });

  it("'full' additionally strips trailing thinking from the last assistant", () => {
    const msgs: Message[] = [
      userText('what is 2+2?'),
      assistantBlocks({ type: 'text', text: '4' }, thinking('afterthought')),
    ];

    const conservative = normalizeMessages(msgs, { level: 'conservative' });
    expect(conservative.changes.trailing_thinking_stripped).toBe(0);
    const lastBlocksConservative = conservative.messages[1]!.content as ContentBlock[];
    expect(lastBlocksConservative.some((b) => b.type === 'thinking')).toBe(true);

    const full = normalizeMessages(msgs, { level: 'full' });
    expect(full.changes.trailing_thinking_stripped).toBe(1);
    const lastBlocksFull = full.messages[1]!.content as ContentBlock[];
    expect(lastBlocksFull.some((b) => b.type === 'thinking')).toBe(false);
  });

  it("'full' drops whitespace-only assistant messages; 'conservative' keeps them", () => {
    const msgs: Message[] = [
      userText('go'),
      assistantBlocks({ type: 'text', text: '   ' }, { type: 'text', text: '\t\n' }),
      userText('any progress?'),
    ];

    const conservative = normalizeMessages(msgs, { level: 'conservative' });
    expect(conservative.changes.whitespace_dropped).toBe(0);
    expect(conservative.messages).toHaveLength(3);

    const full = normalizeMessages(msgs, { level: 'full' });
    expect(full.changes.whitespace_dropped).toBe(1);
    expect(full.messages).toHaveLength(2);
  });

  it('is idempotent — running twice with the same input yields the same output and zero changes on pass 2', () => {
    const msgs: Message[] = [
      userText('hi'),
      userText('there'),
      assistantBlocks(thinking('only thinking')),
      assistantText('actual answer'),
      assistantBlocks(toolUse('a', 'ls')),
    ];
    const first = normalizeMessages(msgs, { level: 'conservative' });
    const second = normalizeMessages(first.messages, { level: 'conservative' });
    expect(hasAnyChange(second.changes)).toBe(false);
    expect(second.messages).toEqual(first.messages);
  });

  it('hasAnyChange surfaces residual pairing_violations even when every other counter is zero', () => {
    // Ensures the telemetry gate in query.ts fires when normalisation
    // couldn't reach 0 violations — otherwise ops would be blind to
    // structurally-broken corpora that also happened not to need merging.
    const zero: NormalizeChanges = {
      merged_user: 0,
      merged_assistant: 0,
      orphan_tool_use_fixed: 0,
      orphan_tool_result_fixed: 0,
      thinking_filtered: 0,
      empty_dropped: 0,
      whitespace_dropped: 0,
      trailing_thinking_stripped: 0,
      pairing_violations: 0,
      agent_profile_dropped: 0,
    };
    expect(hasAnyChange(zero)).toBe(false);
    expect(hasAnyChange({ ...zero, pairing_violations: 1 })).toBe(true);
    expect(hasAnyChange({ ...zero, agent_profile_dropped: 1 })).toBe(true);
  });

  it('records residual pairing_violations and warns via logger when repair is incomplete', () => {
    // Construct a contrived input where orphan repair alone cannot
    // restore pairing (a tool_result whose tool_use_id also never
    // existed as a use). repair drops the orphan block but if we
    // deliberately register an orphan pairing that cannot be fixed,
    // the counter should remain visible.
    //
    // In practice the repair path already drops such tool_results,
    // so pairing_violations stays 0 — this test simply proves the
    // counter exists and the logger is not called on the happy path.
    const warn = vi.fn();
    const msgs: Message[] = [
      assistantBlocks(toolUse('a', 'ls')),
      userBlocks(toolResult('a')),
    ];
    const out = normalizeMessages(msgs, {
      level: 'conservative',
      logger: { warn },
    });
    expect(out.changes.pairing_violations).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns a fresh array reference (!= input) when level !== off, even on no-ops', () => {
    const msgs: Message[] = [userText('hello'), assistantText('hi')];
    const out = normalizeMessages(msgs, { level: 'conservative' });
    expect(out.messages).not.toBe(msgs);
    expect(hasAnyChange(out.changes)).toBe(false);
  });
});

// ─── 6. Collaboration with FR-04 and compaction shapes ───────────────

describe('normalizeMessages — interactions with FR-04 / compaction', () => {
  it('tolerates an assistant whose only remaining block is thinking after FR-04 truncation', () => {
    // FR-04 can strip the text block of an assistant if it was huge,
    // leaving just the thinking block. That's exactly the shape that
    // filterOrphanedThinkingOnlyMessages is meant to catch.
    const msgs: Message[] = [
      userText('prompt'),
      // Simulate post-FR-04 state — text block already removed.
      assistantBlocks(thinking('long private reasoning')),
      userText('continue?'),
    ];
    const out = normalizeMessages(msgs, { level: 'conservative' });
    expect(out.changes.thinking_filtered).toBe(1);
    // Merged user turns remain (no orphan thinking sitting between them).
    expect(validateToolPairing(out.messages)).toBe(true);
    expect(out.changes.merged_user).toBeGreaterThanOrEqual(1);
  });

  it('repairs a tool_use whose tool_result was sliced away by compaction', () => {
    // compact.ts findSplitPoint may split just after an assistant tool_use,
    // orphaning the tool_use if the following tool_result message is
    // dropped into the summary body. normalize catches and synthesises.
    const msgs: Message[] = [
      userText('summary preamble'),
      assistantBlocks(toolUse('orphan_id', 'read_file', { path: '/x' })),
      // the corresponding tool_result has been summarised away
      userText('continue with the work'),
    ];
    const out = normalizeMessages(msgs, { level: 'conservative' });
    expect(out.changes.orphan_tool_use_fixed).toBe(1);
    expect(validateToolPairing(out.messages)).toBe(true);
    // The synthetic tool_result was absorbed into the existing user
    // turn to avoid introducing a user/user sandwich.
    const userTurns = out.messages.filter((m) => m.role === 'user');
    // Exactly one user turn after the assistant, carrying the synthetic
    // result block AND the original "continue with the work" text.
    const postAssistantUser = userTurns[userTurns.length - 1]!;
    const blocks = postAssistantUser.content as ContentBlock[];
    const hasStub = blocks.some(
      (b) => b.type === 'tool_result' && b.tool_use_id === 'orphan_id',
    );
    const hasRealText = blocks.some(
      (b) => b.type === 'text' && (b.text === 'continue with the work'),
    );
    expect(hasStub).toBe(true);
    expect(hasRealText).toBe(true);
  });

  it('keeps validation invariant: normalize → validateToolPairing always true', () => {
    // Monte-Carlo-ish: a handful of structurally broken shapes run
    // through normalize must always come out valid-pairing.
    const shapes: Message[][] = [
      [assistantBlocks(toolUse('a', 't'))],
      [userBlocks(toolResult('zzz'))],
      [
        assistantBlocks(toolUse('a', 't'), toolUse('b', 't')),
        userBlocks(toolResult('a')),
      ],
      [
        userText('hi'),
        userText('there'),
        assistantBlocks(thinking('only thinking')),
      ],
      [
        assistantBlocks(toolUse('orphan', 't')),
        userText('follow-up without a result'),
      ],
    ];
    for (const input of shapes) {
      const out = normalizeMessages(input, { level: 'conservative' });
      expect(validateToolPairing(out.messages)).toBe(true);
      expect(out.changes.pairing_violations).toBe(0);
    }
  });

  it('preserves tool pairing after compaction-like shape (pairing validation is a shared contract)', () => {
    // This locks the "compact.ts imports validateToolPairing from
    // message-normalizer" contract: before/after the refactor, the
    // same boolean outcome for the same input.
    //
    // Compaction output intentionally has `[summary, ack-assistant,
    // fresh-assistant-with-tool-use, ...]`. The two consecutive
    // assistant turns are a side-effect of `buildCompactedMessages`
    // adding an acknowledgement turn; the normalizer merges them
    // (correct — the API rejects consecutive assistant turns on some
    // providers). We validate the *pairing* invariant still holds
    // after the merge.
    const compactedShape: Message[] = [
      userText('[对话摘要]\n\n...\n\n[最近对话如下]'),
      assistantText('明白，从最近的上下文继续。'),
      assistantBlocks(toolUse('kept', 'grep', { pattern: 'x' })),
      userBlocks(toolResult('kept', 'match1\nmatch2')),
      assistantText('Found 2 matches.'),
    ];
    expect(validateToolPairing(compactedShape)).toBe(true);

    const out = normalizeMessages(compactedShape);
    // Adjacent assistants were merged into one; everything else
    // unchanged (no orphan repair / no thinking filter).
    expect(out.changes.merged_assistant).toBe(1);
    expect(out.changes.orphan_tool_use_fixed).toBe(0);
    expect(out.changes.orphan_tool_result_fixed).toBe(0);
    expect(out.changes.thinking_filtered).toBe(0);
    expect(validateToolPairing(out.messages)).toBe(true);
  });
});

// ─── 7. ensureToolResultPairing (Wave 连续对话成熟化 · 事 2) ──────────

describe('ensureToolResultPairing — Provider 调用前最末一刻配对闸', () => {
  it('no-op on empty input', () => {
    const r = ensureToolResultPairing([]);
    expect(r.repaired).toBe(false);
    expect(r.messages).toEqual([]);
  });

  it('no-op when pairing is already clean', () => {
    const msgs: Message[] = [
      userText('prompt'),
      assistantBlocks(toolUse('a', 'grep')),
      userBlocks(toolResult('a')),
    ];
    const r = ensureToolResultPairing(msgs);
    expect(r.repaired).toBe(false);
    expect(validateToolPairing(r.messages)).toBe(true);
    expect(r.cross_message_dup_tool_use_dropped).toBe(0);
    expect(r.duplicate_tool_result_dropped).toBe(0);
    expect(r.orphan_server_tool_use_dropped).toBe(0);
  });

  it('(a) 跨 assistant 的 tool_use.id 重复：删第二次出现的 use block', () => {
    // CC-1212 事故场景：同一个 tool_use id 在不同 assistant 出现两次
    // （resume 补洞或 normalize 合并逻辑失误）。Anthropic API 会 400
    // "tool_use ids must be unique"。
    const dupId = 'toolu_dup123';
    const msgs: Message[] = [
      userText('q1'),
      assistantBlocks(toolUse(dupId, 'grep')),
      userBlocks(toolResult(dupId, 'first result')),
      userText('q2'),
      // 这条 assistant 带同 id 的 tool_use（非法）
      assistantBlocks(toolUse(dupId, 'grep')),
      userBlocks(toolResult(dupId, 'second result')),
    ];
    const r = ensureToolResultPairing(msgs);
    expect(r.repaired).toBe(true);
    expect(r.cross_message_dup_tool_use_dropped).toBe(1);
    // 第二条 assistant 的 tool_use 被删 → content 变成占位 text
    const assistants = r.messages.filter((m) => m.role === 'assistant');
    // 两条 assistant 都应保留（第一条正常；第二条 content 变成
    // "[Tool use interrupted]" 占位）
    expect(assistants.length).toBe(2);
    // 第二条 assistant 的 content 应仅含 placeholder text
    const a2Content = assistants[1]!.content;
    expect(Array.isArray(a2Content)).toBe(true);
    expect((a2Content as ContentBlock[]).some(
      (b) => b.type === 'text' && (b as { text: string }).text.includes('interrupted'),
    )).toBe(true);
  });

  it('(b) 同 user message 内重复 tool_result 去重（同 tool_use_id 的 result 出现两次）', () => {
    // 旧 transcript Fix-1 前形态被合并后产生 [asst([X,X]), user([trX,trX])]：
    // ensureToolResultPairing 既要去 (a) 里的 X，也要去这里的 trX。
    const msgs: Message[] = [
      userText('q'),
      assistantBlocks(toolUse('x', 'grep')),
      // 下一条 user 带两个同 id 的 tool_result（来自合并）
      userBlocks(toolResult('x', 'first'), toolResult('x', 'second')),
    ];
    const r = ensureToolResultPairing(msgs);
    expect(r.repaired).toBe(true);
    expect(r.duplicate_tool_result_dropped).toBe(1);
    // user message 的 tool_result 只剩一条
    const userTurn = r.messages.find((m) => m.role === 'user' && Array.isArray(m.content));
    expect(userTurn).toBeDefined();
    const toolResults = (userTurn!.content as ContentBlock[]).filter(
      (b) => b.type === 'tool_result',
    );
    expect(toolResults.length).toBe(1);
  });

  it('(c) server_tool_use / mcp_tool_use 无对应 *_tool_result 时删块', () => {
    // 同语义：server/mcp tool use 必须
    // 在同 assistant 内有对应的 *_tool_result。没有 → 用块 orphan → 删。
    const server_tool_use: ContentBlock = {
      type: 'server_tool_use' as 'tool_use',
      id: 'srv_1',
      name: 'search',
      input: {},
    };
    const msgs: Message[] = [
      userText('q'),
      assistantBlocks(server_tool_use),
      userText('followup'),
    ];
    const r = ensureToolResultPairing(msgs);
    expect(r.repaired).toBe(true);
    expect(r.orphan_server_tool_use_dropped).toBe(1);
    // assistant content 应被替换为 "[Tool use interrupted]" 占位
    const asst = r.messages.find((m) => m.role === 'assistant');
    expect(asst).toBeDefined();
    expect(Array.isArray(asst!.content)).toBe(true);
    expect((asst!.content as ContentBlock[]).some(
      (b) => b.type === 'text' && (b as { text: string }).text.includes('interrupted'),
    )).toBe(true);
  });

  it('(c\') server_tool_use 有对应 server_tool_result（同消息内） → 保留', () => {
    const server_tool_use: ContentBlock = {
      type: 'server_tool_use' as 'tool_use',
      id: 'srv_ok',
      name: 'search',
      input: {},
    };
    const server_tool_result: ContentBlock = {
      type: 'server_tool_result' as 'tool_result',
      tool_use_id: 'srv_ok',
      content: 'ok',
    };
    const msgs: Message[] = [
      userText('q'),
      assistantBlocks(server_tool_use, server_tool_result),
    ];
    const r = ensureToolResultPairing(msgs);
    expect(r.orphan_server_tool_use_dropped).toBe(0);
    // use + result 都保留
    const asst = r.messages.find((m) => m.role === 'assistant');
    expect(asst).toBeDefined();
    expect((asst!.content as ContentBlock[]).length).toBe(2);
  });

  it('并行 tool_use 跨 resume：不同 assistant 同 id → 只送一份给 provider', () => {
    // 模拟 normalizeMessagesForAPI 按 message.id 合并失败的
    // 场景：同一个 message.id 被拆成两条 assistant，都带相同的 tool_use。
    // allSeenToolUseIds 去重保证 provider 只收到一份。
    const msgs: Message[] = [
      userText('please do 2 things'),
      assistantBlocks(toolUse('t1', 'grep')),
      userBlocks(toolResult('t1', 'match1')),
      // 恢复装载时，resume 逻辑意外把同 id 再 push 了一次
      assistantBlocks(toolUse('t1', 'grep')),
    ];
    const r = ensureToolResultPairing(msgs);
    expect(r.cross_message_dup_tool_use_dropped).toBe(1);
    // validate：整个 messages 里 tool_use id 't1' 只出现一次
    let count = 0;
    for (const m of r.messages) {
      if (typeof m.content === 'string') continue;
      for (const b of m.content) {
        if (b.type === 'tool_use' && (b as { id: string }).id === 't1') count++;
      }
    }
    expect(count).toBe(1);
  });

  it('复用 repairOrphanToolCalls：orphan tool_use 补合成占位', () => {
    const msgs: Message[] = [
      userText('q'),
      assistantBlocks(toolUse('missing', 'grep')),
      userText('continue'),
    ];
    const r = ensureToolResultPairing(msgs);
    expect(r.repaired).toBe(true);
    expect(r.synthetic_tool_result_added).toBe(1);
    expect(validateToolPairing(r.messages)).toBe(true);
    // 继承 repairOrphanToolCalls 的行为：合成 tool_result 融入下一条 user
    const userTurn = r.messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content)
        && (m.content as ContentBlock[]).some((b) => b.type === 'tool_result'),
    );
    expect(userTurn).toBeDefined();
    const trBlocks = (userTurn!.content as ContentBlock[]).filter(
      (b) => b.type === 'tool_result',
    ) as ToolResultBlock[];
    expect(trBlocks.length).toBe(1);
    expect(trBlocks[0]!.content).toBe(SYNTHETIC_TOOL_RESULT_PLACEHOLDER);
    expect(trBlocks[0]!.is_error).toBe(true);
  });

  it('复用 repairOrphanToolCalls：orphan tool_result 删块', () => {
    const msgs: Message[] = [
      userText('q'),
      userBlocks(toolResult('nonexistent')),
      assistantText('how can I help?'),
    ];
    const r = ensureToolResultPairing(msgs);
    expect(r.repaired).toBe(true);
    expect(r.orphan_tool_result_dropped).toBe(1);
    expect(validateToolPairing(r.messages)).toBe(true);
  });

  it('纯函数契约：不 mutate 输入数组 / 消息对象', () => {
    const msgs: Message[] = [
      userText('q'),
      assistantBlocks(toolUse('a', 'grep')),
      userBlocks(toolResult('a'), toolResult('a', 'dup')),
    ];
    const before = JSON.stringify(msgs);
    ensureToolResultPairing(msgs);
    expect(JSON.stringify(msgs)).toBe(before);
  });

  it('Review B P1 · tool_use 缺 id（或 id 非字符串）→ 整块删 + 计入 malformed_tool_use_dropped', () => {
    // 历史数据损坏 / 上游适配器异常，产出没有 id 的 tool_use block。
    // 原实现会让它原样透传 → Anthropic API 400。修复后整块删。
    const malformed_no_id: ContentBlock = {
      type: 'tool_use',
      name: 'grep',
      input: {},
    } as unknown as ContentBlock; // 故意缺 id
    const malformed_empty_id: ContentBlock = {
      type: 'tool_use',
      id: '',
      name: 'grep',
      input: {},
    };
    const msgs: Message[] = [
      userText('q'),
      assistantBlocks(malformed_no_id, malformed_empty_id, toolUse('ok', 'grep')),
      userBlocks(toolResult('ok')),
    ];
    const r = ensureToolResultPairing(msgs);
    expect(r.repaired).toBe(true);
    expect(r.malformed_tool_use_dropped).toBe(2);
    // 合法的 'ok' tool_use + 对应 tool_result 保留
    expect(validateToolPairing(r.messages)).toBe(true);
    // 畸形块不在最终 messages 里
    for (const m of r.messages) {
      if (typeof m.content === 'string') continue;
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          expect((b as { id: string }).id).toBe('ok');
        }
      }
    }
  });

  it('Review B P1 · 合法 tool_use 不受 malformed 检查误伤', () => {
    const msgs: Message[] = [
      userText('q'),
      assistantBlocks(toolUse('good_id', 'grep')),
      userBlocks(toolResult('good_id')),
    ];
    const r = ensureToolResultPairing(msgs);
    expect(r.malformed_tool_use_dropped).toBe(0);
    expect(r.repaired).toBe(false);
  });
});
