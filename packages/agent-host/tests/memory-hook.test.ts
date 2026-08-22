/**
 * memory-injector hook 单测 —— 覆盖 spec §5 Runtime 接回行为契约：
 *
 *   1. agentConfig.enabled=false → 跳过
 *   2. agentConfig.injection.auto_inject=false → 跳过
 *   3. 正常路径（3 条 memo） → state.messages 头部插入带 marker 的 user message
 *   4. run 内幂等：已有 marker → 跳过（不重复召回、不替换）
 *   4b. compact 自愈：marker 被删后重新召回注入
 *   5. fetchMemories throw → 不阻断（hook 不抛 + 不注入）
 *   6. 渲染超 charBudget → 尾截 + 截断标记
 *   7. messages 里没有真用户 message → 跳过
 *
 * + 顺序：CONTEXT_INJECTION 存在时，memory_recall 插到它之后
 */

import { describe, it, expect, vi } from 'vitest';
import { buildMemoryHook, type MemoryRecallSummary } from '../src/hooks/index.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
  type Message,
  type EngineState,
} from '@tabtin/agent-runtime/engine';

const MEMORY_MARKER = INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION;
const CONTEXT_MARKER = INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION;

function makeState(messages: Message[] = []): EngineState {
  return {
    messages,
    iteration: 0,
    pendingThinking: [],
    pendingToolUses: [],
  } as unknown as EngineState;
}

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function contextMsg(text = '<context>focused: 多维表「营销表」</context>'): Message {
  return setInternalMarker(
    { role: 'user', content: [{ type: 'text', text }] },
    CONTEXT_MARKER,
  );
}

function memoryMsg(text = '<memory_recall>old</memory_recall>'): Message {
  return setInternalMarker(
    { role: 'user', content: [{ type: 'text', text }] },
    MEMORY_MARKER,
  );
}

function sampleMemos(count = 3): MemoryRecallSummary[] {
  const result: MemoryRecallSummary[] = [];
  for (let i = 0; i < count; i += 1) {
    result.push({
      id: `m-${i}`,
      content: `用户喜欢用 Tab 缩进（第 ${i + 1} 条）`,
      memo_type: 'about_you',
      created_at: `2026-05-${10 + i}`,
    });
  }
  return result;
}

describe('buildMemoryHook', () => {
  it('案例 1：enabled=false → 跳过，state.messages 无 memory_recall', async () => {
    const fetchMemories = vi.fn().mockResolvedValue(sampleMemos());
    const hook = buildMemoryHook({
      fetchAgentConfig: () => ({ enabled: false, injection: { auto_inject: true } }),
      fetchMemories,
    });
    const state = makeState([userMsg('帮我把这个表导出 csv')]);

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(fetchMemories).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(1);
    expect(state.messages.find((m) => hasInternalMarker(m, MEMORY_MARKER))).toBeUndefined();
  });

  it('案例 2：injection.auto_inject=false → 跳过', async () => {
    const fetchMemories = vi.fn().mockResolvedValue(sampleMemos());
    const hook = buildMemoryHook({
      fetchAgentConfig: () => ({ enabled: true, injection: { auto_inject: false } }),
      fetchMemories,
    });
    const state = makeState([userMsg('hello')]);

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(fetchMemories).not.toHaveBeenCalled();
    expect(state.messages.find((m) => hasInternalMarker(m, MEMORY_MARKER))).toBeUndefined();
  });

  it('案例 3：正常路径 3 条 memo → 注入 marker message，content 含 SSoT `<context type="memory-recall">` 外壳 + 紧挨 context 之后（阶段 6 议题 2）', async () => {
    const fetchMemories = vi.fn().mockResolvedValue(sampleMemos());
    const hook = buildMemoryHook({
      fetchAgentConfig: () => ({ enabled: true, injection: { auto_inject: true } }),
      fetchMemories,
    });
    const original = userMsg('帮我导出 csv');
    const state = makeState([contextMsg(), original]);

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // fetchMemories 用最近 user message 当 query
    expect(fetchMemories).toHaveBeenCalledWith('帮我导出 csv', 5);

    // 顺序：[context, memory_recall, original]
    expect(state.messages).toHaveLength(3);
    expect(hasInternalMarker(state.messages[0]!, CONTEXT_MARKER)).toBe(true);
    expect(hasInternalMarker(state.messages[1]!, MEMORY_MARKER)).toBe(true);
    expect(state.messages[2]).toBe(original);

    // 阶段 6 议题 2：注入内容套统一 SSoT wrapper（替代老的 <memory_recall>...）
    const injected = state.messages[1]!;
    const text = Array.isArray(injected.content)
      ? (injected.content[0] as { type: 'text'; text: string }).text
      : '';
    expect(text).toMatch(/^<context type="memory-recall">/);
    expect(text).toMatch(/<\/context>$/);
    expect(text).toContain('[about_you]');
    expect(text).toContain('用户喜欢用 Tab 缩进（第 1 条）');
    expect(text).toContain('用户喜欢用 Tab 缩进（第 3 条）');
  });

  it('案例 4：run 内幂等 —— 已有 memory marker 则跳过，不重复召回、不替换', async () => {
    const fetchMemories = vi.fn().mockResolvedValue(sampleMemos(1));
    const hook = buildMemoryHook({
      fetchAgentConfig: () => ({ enabled: true, injection: { auto_inject: true } }),
      fetchMemories,
    });
    // 起点 state 已有本 run 注入的 memory_recall marker（模拟第 N 轮入口）
    const state = makeState([contextMsg(), memoryMsg('<memory_recall>old</memory_recall>'), userMsg('再问一个')]);

    await hook.beforeIteration!({ state: state, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });

    // 幂等闸门：marker 仍在 → 直接返回，不调 fetchMemories、不替换旧块
    expect(fetchMemories).not.toHaveBeenCalled();
    const markers = state.messages.filter((m) => hasInternalMarker(m, MEMORY_MARKER));
    expect(markers).toHaveLength(1);
    const text = Array.isArray(markers[0]!.content)
      ? (markers[0]!.content[0] as { type: 'text'; text: string }).text
      : '';
    expect(text).toContain('old');
  });

  it('案例 4b：compact 自愈 —— marker 被 compact 吃掉后重新召回注入', async () => {
    const fetchMemories = vi.fn().mockResolvedValue(sampleMemos(1));
    const hook = buildMemoryHook({
      fetchAgentConfig: () => ({ enabled: true, injection: { auto_inject: true } }),
      fetchMemories,
    });
    const original = userMsg('帮我导出 csv');
    const state = makeState([original]);

    // 首轮注入
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(fetchMemories).toHaveBeenCalledTimes(1);
    expect(state.messages.filter((m) => hasInternalMarker(m, MEMORY_MARKER))).toHaveLength(1);

    // 模拟 compact 把 memory 注入块摘要/裁剪掉（marker 随之消失）
    state.messages = state.messages.filter((m) => !hasInternalMarker(m, MEMORY_MARKER));

    // 下一轮：闸门检测 marker 缺失 → 重新召回注入
    await hook.beforeIteration!({ state: state, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });
    expect(fetchMemories).toHaveBeenCalledTimes(2);
    expect(state.messages.filter((m) => hasInternalMarker(m, MEMORY_MARKER))).toHaveLength(1);
  });

  it('案例 5：fetchMemories throw → hook 不抛、不注入', async () => {
    const fetchMemories = vi.fn().mockRejectedValue(new Error('network 5xx'));
    const hook = buildMemoryHook({
      fetchAgentConfig: () => ({ enabled: true, injection: { auto_inject: true } }),
      fetchMemories,
    });
    const state = makeState([userMsg('找一下昨天的笔记')]);

    await expect(hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} })).resolves.toBeUndefined();
    expect(state.messages.find((m) => hasInternalMarker(m, MEMORY_MARKER))).toBeUndefined();
  });

  it('案例 6：渲染超 charBudget → 尾截 + 截断标记', async () => {
    // 5 条长 memo，每条 content 300 字符 → 渲染肯定超 100 字符 budget
    const longMemos: MemoryRecallSummary[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m-${i}`,
      content: 'X'.repeat(300),
      memo_type: 'insight',
      created_at: `2026-05-${10 + i}`,
    }));
    const fetchMemories = vi.fn().mockResolvedValue(longMemos);
    const hook = buildMemoryHook({
      fetchAgentConfig: () => ({ enabled: true, injection: { auto_inject: true } }),
      fetchMemories,
      charBudget: 100,
    });
    const state = makeState([userMsg('foo')]);

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    const injected = state.messages.find((m) => hasInternalMarker(m, MEMORY_MARKER))!;
    const text = Array.isArray(injected.content)
      ? (injected.content[0] as { type: 'text'; text: string }).text
      : '';
    expect(text).toContain('[memory recall truncated due to budget]');
    // 阶段 6 议题 2：charBudget 现在裁的是"body"，外层 SSoT wrapper
    // `<context type="memory-recall">\n...\n</context>` 是固定 42 字符开销。
    // 整体长度 = wrapper 头尾 + 100 + '\n[memory recall truncated due to budget]'。
    const wrapperOverhead = '<context type="memory-recall">\n\n</context>'.length;
    const truncationMarker = '\n[memory recall truncated due to budget]';
    expect(text.length).toBeLessThanOrEqual(
      wrapperOverhead + 100 + truncationMarker.length,
    );
  });

  it('案例 7：messages 里没有真用户 message → 跳过', async () => {
    const fetchMemories = vi.fn().mockResolvedValue(sampleMemos());
    const hook = buildMemoryHook({
      fetchAgentConfig: () => ({ enabled: true, injection: { auto_inject: true } }),
      fetchMemories,
    });
    // 只有 context-injection marker user message —— 不是真用户输入
    const state = makeState([contextMsg()]);

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(fetchMemories).not.toHaveBeenCalled();
    expect(state.messages.find((m) => hasInternalMarker(m, MEMORY_MARKER))).toBeUndefined();
  });

  it('补充：fetchMemories 返回空数组 → 不注入', async () => {
    const fetchMemories = vi.fn().mockResolvedValue([]);
    const hook = buildMemoryHook({
      fetchAgentConfig: () => ({ enabled: true, injection: { auto_inject: true } }),
      fetchMemories,
    });
    const state = makeState([userMsg('hello')]);

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(fetchMemories).toHaveBeenCalled();
    expect(state.messages.find((m) => hasInternalMarker(m, MEMORY_MARKER))).toBeUndefined();
  });

  it('补充：没有 CONTEXT_INJECTION marker → memory_recall unshift 到起首', async () => {
    const fetchMemories = vi.fn().mockResolvedValue(sampleMemos(1));
    const hook = buildMemoryHook({
      fetchAgentConfig: () => ({ enabled: true, injection: { auto_inject: true } }),
      fetchMemories,
    });
    const original = userMsg('foo');
    const state = makeState([original]);

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(state.messages).toHaveLength(2);
    expect(hasInternalMarker(state.messages[0]!, MEMORY_MARKER)).toBe(true);
    expect(state.messages[1]).toBe(original);
  });
});
