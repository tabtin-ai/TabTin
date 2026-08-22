/**
 *  · 单 HITL 断点恢复主北极星测试（与 crash-resume-batch.test.ts 对称）。
 *
 * 用例覆盖：
 *   1. status='resolved' 单条 → inject 用户答复 tool_result，无 interrupt 调用
 *   2. status='pending' 单条 → 走 interrupt.interrupt 重挂 + 用户新答复 → inject
 *   3. status='expired' → inject 兜底终态文案
 *   4. status='cancelled' → inject 兜底终态文案
 *   5. expires_at < now 但 status='pending' → 视为 expired 兜底
 *   6. interrupt unavailable + pending 条目 → fail-closed inject 跳过文案
 *   7. interrupt 抛错 → inject 超时兜底
 *   8. pendingSingleHitl 空数组 / undefined → no-op
 *   9. request_id 匹配：重挂事件透传原 payload.request_id
 *  10. decodeWirePendingSingleHitl 正常 + 容错
 */

import { describe, it, expect, vi } from 'vitest';
import {
  applyPendingSingleHitlRestore,
  decodeWirePendingSingleHitl,
  type PendingSingleHitlRestoreInput,
  type PendingSingleHitlInterrupt,
} from '../src/permissions/pending-single-hitl-restorer.js';
import type {
  SerializedPendingSingleHitl,
} from '../src/engine/contracts/hitl.js';
import type {
  ContentBlock,
  Message,
  ToolResultBlock,
} from '../src/engine/contracts/conversation.js';
import { ensureToolResultPairing } from '../src/engine/context/message-normalizer.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<SerializedPendingSingleHitl>): SerializedPendingSingleHitl {
  return {
    kind: 'ask_choice',
    requestKey: 'req-1',
    status: 'pending',
    payload: {
      request_id: 'req-1',
      tool_name: 'ask_user',
      questions: [{ id: 'q1', prompt: 'go?', header: 'GO', options: [{ id: 'y', label: 'Yes', description: 'go' }, { id: 'n', label: 'No', description: 'stop' }] }],
    },
    expiresAt: Date.now() + 60_000,
    runtimeMode: 'interactive',
    ...overrides,
  };
}

interface InterruptHarness {
  interrupt: PendingSingleHitlInterrupt;
  /** 记录每次 interrupt 调用（interruptId + emit 的事件类型 + timeoutMs） */
  calls: Array<{
    interruptId: string;
    eventType?: string;
    eventPayload?: Record<string, unknown>;
    timeoutMs?: number;
    kind: string;
  }>;
  /** stubbed decision by interruptId */
  answersByKey: Map<string, unknown>;
  /** stubbed throws by interruptId */
  throwsByKey: Map<string, string>;
  isAvailable: boolean;
}

function makeInterruptHarness(
  answers: Record<string, unknown> = {},
  throws: Record<string, string> = {},
): InterruptHarness {
  const calls: InterruptHarness['calls'] = [];
  const answersByKey = new Map<string, unknown>(Object.entries(answers));
  const throwsByKey = new Map<string, string>(Object.entries(throws));
  const harness: InterruptHarness = {
    isAvailable: true,
    calls,
    answersByKey,
    throwsByKey,
    interrupt: {
      isAvailable: () => harness.isAvailable,
      interrupt: vi.fn(async (req) => {
        const payload = req.requestEvent
          ? ((req.requestEvent as { payload?: Record<string, unknown> }).payload ?? {})
          : {};
        calls.push({
          interruptId: req.interruptId,
          eventType: req.requestEvent?.type,
          eventPayload: payload,
          timeoutMs: req.timeoutMs,
          kind: req.kind,
        });
        if (throwsByKey.has(req.interruptId)) {
          return { status: 'timeout', message: throwsByKey.get(req.interruptId)! };
        }
        if (answersByKey.has(req.interruptId)) {
          return { status: 'resolved', value: answersByKey.get(req.interruptId) };
        }
        return { status: 'timeout', message: 'no stub' };
      }),
    },
  };
  return harness;
}

function buildInput(
  entries: SerializedPendingSingleHitl[],
  opts: {
    harness?: InterruptHarness;
    onLog?: (level: 'info' | 'warn', message: string) => void;
    knownAssistantToolUseIds?: Set<string>;
  } = {},
): PendingSingleHitlRestoreInput {
  const harness = opts.harness ?? makeInterruptHarness();
  return {
    pendingSingleHitl: entries,
    interrupt: harness.interrupt,
    onLog: opts.onLog,
    knownAssistantToolUseIds: opts.knownAssistantToolUseIds,
  };
}

function getContent(block: ToolResultBlock): string {
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe(' · pending-single-hitl-restorer', () => {
  it('用例 1：status=resolved（用户已答复）→ 直接 inject tool_result，不调 interrupt', async () => {
    const harness = makeInterruptHarness();
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({
        kind: 'ask_choice',
        requestKey: 'req-A',
        status: 'resolved',
        result: {
          answers: [{ question_id: 'q1', selected_options: ['y'] }],
        },
        resolvedAt: Date.now(),
      }),
    ];

    const result = await applyPendingSingleHitlRestore(buildInput(entries, { harness }));

    expect(result.toolResultBlocks).toHaveLength(1);
    expect(result.injectedTerminalKeys).toEqual(['req-A']);
    expect(result.rehangedRequestKeys).toEqual([]);
    expect(harness.calls).toHaveLength(0);
    const block = result.toolResultBlocks[0]!;
    expect(block.tool_use_id).toBe('req-A');
    expect(block.is_error).toBe(true);
    expect(getContent(block)).toContain('用户已答复');
    expect(getContent(block)).toContain('ask_user');
  });

  it('用例 1b：status=resolved + result.skipped=true → 跳过文案', async () => {
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({
        kind: 'ask_form',
        requestKey: 'req-Skip',
        status: 'resolved',
        result: { skipped: true },
      }),
    ];
    const result = await applyPendingSingleHitlRestore(buildInput(entries));
    expect(result.toolResultBlocks).toHaveLength(1);
    expect(getContent(result.toolResultBlocks[0]!)).toContain('用户跳过了本次 ask_form');
  });

  it('用例 1c：status=resolved + result.text 非空 → 自由文本作答文案', async () => {
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({
        kind: 'permission_request',
        requestKey: 'req-Text',
        status: 'resolved',
        result: { text: '这是我的自由回答' },
      }),
    ];
    const result = await applyPendingSingleHitlRestore(buildInput(entries));
    expect(getContent(result.toolResultBlocks[0]!)).toContain('用户已答复本次 request_approval');
    expect(getContent(result.toolResultBlocks[0]!)).toContain('这是我的自由回答');
  });

  it('用例 2：status=pending 未过期 → interrupt 重挂 + 用户新答复 → inject', async () => {
    const harness = makeInterruptHarness({
      'req-B': { answers: [{ question_id: 'q1', selected_options: ['y'] }] },
    });
    const entries: SerializedPendingSingleHitl[] = [
      // 注意：payload.request_id 应与 requestKey 同值（生产中它们同源
      // 于同一 uuid，见 ask-tools.ts emitAndWait `requestPayload`）
      makeEntry({
        requestKey: 'req-B',
        status: 'pending',
        payload: {
          request_id: 'req-B',
          tool_name: 'ask_user',
          questions: [],
        },
      }),
    ];

    const result = await applyPendingSingleHitlRestore(buildInput(entries, { harness }));

    expect(result.rehangedRequestKeys).toEqual(['req-B']);
    expect(result.toolResultBlocks).toHaveLength(1);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.interruptId).toBe('req-B');
    expect(harness.calls[0]!.kind).toBe('ask_user');
    expect(harness.calls[0]!.eventType).toBe('agent.stream.ask_user_required');
    // 重挂事件透传原 payload.request_id（避免前端 dedup 命中新键）
    expect(harness.calls[0]!.eventPayload?.request_id).toBe('req-B');
    expect(getContent(result.toolResultBlocks[0]!)).toContain('用户已答复本次 ask_user');
  });

  it('用例 2a：payload.request_id 缺失时用 requestKey 兜底', async () => {
    const harness = makeInterruptHarness({
      'req-K': { answers: [] },
    });
    const entries: SerializedPendingSingleHitl[] = [
      {
        kind: 'ask_choice',
        requestKey: 'req-K',
        status: 'pending',
        payload: { tool_name: 'ask_user' }, // 缺 request_id
        expiresAt: Date.now() + 60_000,
      },
    ];
    await applyPendingSingleHitlRestore(buildInput(entries, { harness }));
    expect(harness.calls[0]!.eventPayload?.request_id).toBe('req-K');
  });

  it('用例 2b：status=pending ask_form → 重挂 ask_form_required 事件', async () => {
    const harness = makeInterruptHarness({
      'req-F': { field_values: { name: 'Alice' } },
    });
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({
        kind: 'ask_form',
        requestKey: 'req-F',
        status: 'pending',
        payload: {
          request_id: 'req-F',
          tool_name: 'ask_form',
          title: 'User info',
          fields: [{ label: 'Name', key: 'name', type: 'input' }],
        },
      }),
    ];
    const result = await applyPendingSingleHitlRestore(buildInput(entries, { harness }));
    expect(harness.calls[0]!.eventType).toBe('agent.stream.ask_form_required');
    expect(harness.calls[0]!.kind).toBe('ask_form');
    expect(result.toolResultBlocks).toHaveLength(1);
  });

  it('用例 2c：status=pending permission_request → 重挂 request_approval_required 事件', async () => {
    const harness = makeInterruptHarness({
      'req-P': { approved: true },
    });
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({
        kind: 'permission_request',
        requestKey: 'req-P',
        status: 'pending',
      }),
    ];
    await applyPendingSingleHitlRestore(buildInput(entries, { harness }));
    expect(harness.calls[0]!.eventType).toBe('agent.stream.request_approval_required');
    expect(harness.calls[0]!.kind).toBe('request_approval');
  });

  it('用例 3：status=expired → inject 兜底文案，不调 interrupt', async () => {
    const harness = makeInterruptHarness();
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({ requestKey: 'req-E', status: 'expired' }),
    ];
    const result = await applyPendingSingleHitlRestore(buildInput(entries, { harness }));

    expect(result.toolResultBlocks).toHaveLength(1);
    expect(harness.calls).toHaveLength(0);
    expect(getContent(result.toolResultBlocks[0]!)).toContain('已过期');
  });

  it('用例 4：status=cancelled → inject 取消文案', async () => {
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({ requestKey: 'req-C', status: 'cancelled' }),
    ];
    const result = await applyPendingSingleHitlRestore(buildInput(entries));
    expect(result.toolResultBlocks).toHaveLength(1);
    expect(getContent(result.toolResultBlocks[0]!)).toContain('已被取消');
  });

  it('用例 5：status=pending 但 expires_at < now → 按 expired 兜底 inject', async () => {
    const harness = makeInterruptHarness();
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({
        requestKey: 'req-EE',
        status: 'pending',
        expiresAt: Date.now() - 60_000,
      }),
    ];
    const result = await applyPendingSingleHitlRestore(buildInput(entries, { harness }));

    expect(result.toolResultBlocks).toHaveLength(1);
    expect(harness.calls).toHaveLength(0);
    expect(getContent(result.toolResultBlocks[0]!)).toContain('已过期');
  });

  it('用例 6：interrupt 不可用 + pending 条目 → fail-closed inject', async () => {
    const harness = makeInterruptHarness();
    harness.isAvailable = false;
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({ requestKey: 'req-N', status: 'pending' }),
    ];
    const result = await applyPendingSingleHitlRestore(buildInput(entries, { harness }));

    expect(result.toolResultBlocks).toHaveLength(1);
    expect(result.rehangedRequestKeys).toEqual([]);
    expect(getContent(result.toolResultBlocks[0]!)).toContain('交互通道不可用');
  });

  it('用例 7：interrupt 抛错 / 超时 → inject 超时兜底', async () => {
    const harness = makeInterruptHarness({}, { 'req-T': 'wait timed out' });
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({ requestKey: 'req-T', status: 'pending' }),
    ];
    const result = await applyPendingSingleHitlRestore(buildInput(entries, { harness }));

    expect(result.toolResultBlocks).toHaveLength(1);
    expect(result.rehangedRequestKeys).toEqual(['req-T']);
    expect(getContent(result.toolResultBlocks[0]!)).toContain('等待用户答复超时');
    expect(getContent(result.toolResultBlocks[0]!)).toContain('wait timed out');
  });

  it('用例 8：空数组 / undefined → no-op', async () => {
    const r1 = await applyPendingSingleHitlRestore(buildInput([]));
    expect(r1.toolResultBlocks).toHaveLength(0);
    expect(r1.restoredRequestKeys).toHaveLength(0);

    const r2 = await applyPendingSingleHitlRestore(
      buildInput((undefined as unknown) as SerializedPendingSingleHitl[]),
    );
    expect(r2.toolResultBlocks).toHaveLength(0);
  });

  it('用例 9：多条 mixed（resolved + pending + expired）分别处理', async () => {
    const harness = makeInterruptHarness({
      'req-P': { answers: [{ question_id: 'q1', selected_options: ['y'] }] },
    });
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({ requestKey: 'req-R', status: 'resolved', result: { answers: [] } }),
      makeEntry({ requestKey: 'req-P', status: 'pending' }),
      makeEntry({ requestKey: 'req-X', status: 'expired' }),
    ];
    const result = await applyPendingSingleHitlRestore(buildInput(entries, { harness }));

    expect(result.toolResultBlocks).toHaveLength(3);
    expect(result.rehangedRequestKeys).toEqual(['req-P']);
    expect(result.injectedTerminalKeys.sort()).toEqual(['req-R', 'req-X']);
  });

  it('用例 10：requestKey 空 → skip 单条 + warn', async () => {
    const warnings: string[] = [];
    const entries: SerializedPendingSingleHitl[] = [
      { ...makeEntry({}), requestKey: '' },
    ];
    const result = await applyPendingSingleHitlRestore(
      buildInput(entries, { onLog: (l, m) => l === 'warn' && warnings.push(m) }),
    );
    expect(result.toolResultBlocks).toHaveLength(0);
    expect(warnings.some(w => w.includes('empty requestKey'))).toBe(true);
  });
});

// ─── P0 修复：crash mid-await + payload.tool_use_id 配对 ────────────

describe(' · P0 修复：crash mid-await 后 tool_use / tool_result 配对', () => {
  it('挂起前 partial persist 已落 assistant tool_use（tuid） → restore inject 用 payload.tool_use_id 配对，不被 dropOrphan 丢', async () => {
    const harness = makeInterruptHarness();
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({
        kind: 'ask_choice',
        requestKey: 'req-mid-crash',
        status: 'resolved',
        payload: {
          request_id: 'req-mid-crash',
          // ask-tools.ts::emitAndWait 在 P0 修复后会把 LLM 的 tool_use.id
          // 一并透传进 payload，Django PendingInteraction.payload 存住 →
          // resume wire 出站带出来。restorer 拿这个字段作 tool_result 的
          // pairing key。
          tool_use_id: 'tuid-llm-abc',
          tool_name: 'ask_user',
          questions: [],
        },
        result: {
          answers: [{ question_id: 'q1', selected_options: ['y'] }],
        },
      }),
    ];

    // 模拟 partial persist 已发 → restoreMessages 载入 assistant with tool_use.id='tuid-llm-abc'
    // → run-prelude-phases 把它并入 knownAssistantToolUseIds 传给 restorer。
    const knownAssistantToolUseIds = new Set(['tuid-llm-abc']);

    const result = await applyPendingSingleHitlRestore(
      buildInput(entries, { harness, knownAssistantToolUseIds }),
    );

    expect(result.toolResultBlocks).toHaveLength(1);
    // 关键：tool_use_id 走 LLM 真实 id（tuid-llm-abc），不是 runtime 自生的 requestKey。
    expect(result.toolResultBlocks[0]!.tool_use_id).toBe('tuid-llm-abc');
    // Pairing 校验通过 → unpairedRequestKeys 为空 → 走 dropOrphan 不会丢。
    expect(result.unpairedRequestKeys).toEqual([]);
  });

  it('payload.tool_use_id 缺席（旧 pending 行） → fallback 到 requestKey', async () => {
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({
        kind: 'ask_choice',
        requestKey: 'req-old-legacy',
        status: 'resolved',
        payload: {
          // 无 tool_use_id 字段——历史 pending 行
          request_id: 'req-old-legacy',
          tool_name: 'ask_user',
        },
        result: { answers: [] },
      }),
    ];

    const result = await applyPendingSingleHitlRestore(buildInput(entries));

    expect(result.toolResultBlocks).toHaveLength(1);
    // 缺 payload.tool_use_id → 用 requestKey 兜底（保持向后兼容，不做破坏性升级）。
    expect(result.toolResultBlocks[0]!.tool_use_id).toBe('req-old-legacy');
  });

  it('Pairing 校验（fail-loud）：payload.tool_use_id 不在 knownAssistantToolUseIds → warn + unpairedRequestKeys 非空', async () => {
    // 模拟 P0 漏网：partial persist 没跑 / assistant 落库时丢了 tool_use。
    // restorer 必须 fail-loud（原「fail-soft」叙事被删）——否则 dropOrphan
    // 会静默丢 tool_result，用户答复静默消失。
    const warnings: string[] = [];
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({
        kind: 'ask_choice',
        requestKey: 'req-unpaired',
        status: 'resolved',
        payload: {
          request_id: 'req-unpaired',
          tool_use_id: 'tuid-ghost', // messages 里没这个 tool_use
          tool_name: 'ask_user',
        },
        result: { answers: [] },
      }),
    ];

    const result = await applyPendingSingleHitlRestore(
      buildInput(entries, {
        onLog: (level, msg) => level === 'warn' && warnings.push(msg),
        knownAssistantToolUseIds: new Set(['tuid-other-real']),
      }),
    );

    expect(result.toolResultBlocks).toHaveLength(1);
    // 关键断言：pairing 校验捕获到 orphan tool_result。
    expect(result.unpairedRequestKeys).toContain('tuid-ghost');
    expect(warnings.some(w => w.includes('pairing failure'))).toBe(true);
    expect(warnings.some(w => w.includes('tuid-ghost'))).toBe(true);
  });

  it('重挂 pending 的 payload 透传 tool_use_id 给前端（避免前端 dedup 漂移）', async () => {
    const harness = makeInterruptHarness({
      'req-rehang-tuid': { answers: [] },
    });
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({
        requestKey: 'req-rehang-tuid',
        status: 'pending',
        payload: {
          request_id: 'req-rehang-tuid',
          tool_use_id: 'tuid-rehang-1',
          tool_name: 'ask_user',
        },
      }),
    ];
    await applyPendingSingleHitlRestore(buildInput(entries, { harness }));

    expect(harness.calls[0]!.eventPayload?.tool_use_id).toBe('tuid-rehang-1');
    // 同时 request_id 也要透传（前端 dedup 缓存键）。
    expect(harness.calls[0]!.eventPayload?.request_id).toBe('req-rehang-tuid');
  });

  it('knownAssistantToolUseIds 缺省时不做 pairing 校验（单测独立运行 / legacy 路径）', async () => {
    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({
        kind: 'ask_choice',
        requestKey: 'req-no-check',
        status: 'resolved',
        payload: { tool_use_id: 'tuid-anything' },
        result: { answers: [] },
      }),
    ];
    const result = await applyPendingSingleHitlRestore(buildInput(entries));
    // 未传 knownAssistantToolUseIds → 跳过校验 → unpairedRequestKeys 为空。
    expect(result.unpairedRequestKeys).toEqual([]);
  });

  it('端到端配对：mid-await crash → partial persist assistant tool_use → restore inject tool_result → ensureToolResultPairing 不 drop orphan', async () => {
    // 场景：
    //   1. ask_user 工具走 emitAndWait 挂起前发了一次 partial persist_message
    //      → daemon 落 message-blocks.jsonl → restoreMessages 载入 assistant
    //      消息（含 tool_use.id='tuid-llm-real'）。
    //   2. runtime 崩，用户答完 ask 面板；Django `PendingInteraction` 已升到
    //      resolved（payload.tool_use_id='tuid-llm-real' 与 assistant 里同 id）。
    //   3. 新 runtime 起来 → run-prelude-phases 收集 tool_use.id 集合 → restorer
    //      inject tool_result.tool_use_id='tuid-llm-real'。
    //   4. **必须验**：把 restore 返回的 blocks push 进 state.messages，跑
    //      ensureToolResultPairing 后 orphan_tool_result_dropped === 0，tool_use
    //      与 tool_result 都还在最终 messages 里。
    const toolUseId = 'tuid-llm-real';

    const assistantMessage: Message = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'ask_user',
          input: { questions: [{ id: 'q1', prompt: 'go?', header: 'GO', options: [] }] },
        },
      ] as ContentBlock[],
    };
    const stateMessages: Message[] = [
      { role: 'user', content: 'please pick one' },
      assistantMessage,
    ];

    const entries: SerializedPendingSingleHitl[] = [
      makeEntry({
        kind: 'ask_choice',
        requestKey: 'req-mid-await-crash',
        status: 'resolved',
        payload: {
          request_id: 'req-mid-await-crash',
          tool_use_id: toolUseId,
          tool_name: 'ask_user',
          questions: [],
        },
        result: {
          answers: [{ question_id: 'q1', selected_options: ['y'] }],
        },
      }),
    ];

    // run-prelude-phases.ts 会从 state.messages 里扫这个集合再传进来。
    const knownAssistantToolUseIds = new Set<string>();
    for (const msg of stateMessages) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_use') knownAssistantToolUseIds.add(block.id);
      }
    }
    expect(knownAssistantToolUseIds.has(toolUseId)).toBe(true);

    const restoreResult = await applyPendingSingleHitlRestore(
      buildInput(entries, { knownAssistantToolUseIds }),
    );

    expect(restoreResult.toolResultBlocks).toHaveLength(1);
    expect(restoreResult.toolResultBlocks[0]!.tool_use_id).toBe(toolUseId);
    expect(restoreResult.unpairedRequestKeys).toEqual([]);

    // 与 `restorePendingApprovalsPhase` 同款 append + repair 逻辑：
    stateMessages.push({ role: 'user', content: restoreResult.toolResultBlocks });
    const pairing = ensureToolResultPairing(stateMessages);

    // 最关键：dropOrphan 一条都不能丢；synthetic 也不能补（否则说明 pairing 是靠占位补的，不是真配对）。
    expect(pairing.orphan_tool_result_dropped).toBe(0);
    expect(pairing.synthetic_tool_result_added).toBe(0);

    // tool_use 与 tool_result 都在最终 messages 里，且 id 一致。
    const finalMessages = pairing.messages;
    const flatToolUseIds: string[] = [];
    const flatToolResultIds: string[] = [];
    for (const msg of finalMessages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_use') flatToolUseIds.push(block.id);
        if (block.type === 'tool_result') flatToolResultIds.push(block.tool_use_id);
      }
    }
    expect(flatToolUseIds).toEqual([toolUseId]);
    expect(flatToolResultIds).toEqual([toolUseId]);
  });
});

// ─── decodeWirePendingSingleHitl 单测 ──────────────────────────────

describe(' · decodeWirePendingSingleHitl', () => {
  it('正常解码：wire snake_case → runtime camelCase', () => {
    const raw = [
      {
        kind: 'ask_choice',
        request_key: 'req-1',
        thread_id: 'chat-session-x',
        status: 'pending',
        payload: { request_id: 'req-1', questions: [] },
        expires_at: 1_700_000_000_000,
        created_at: 1_699_999_940_000,
        runtime_mode: 'solo',
      },
    ];
    const decoded = decodeWirePendingSingleHitl(raw);
    expect(decoded).toHaveLength(1);
    const e = decoded[0]!;
    expect(e.kind).toBe('ask_choice');
    expect(e.requestKey).toBe('req-1');
    expect(e.threadId).toBe('chat-session-x');
    expect(e.status).toBe('pending');
    expect(e.expiresAt).toBe(1_700_000_000_000);
    expect(e.runtimeMode).toBe('solo');
  });

  it('容错：非法 kind → skip + warn', () => {
    const warnings: string[] = [];
    const raw = [
      { kind: 'unknown', request_key: 'req-1', status: 'pending' },
      { kind: 'ask_form', request_key: 'req-2', status: 'pending' },
    ];
    const decoded = decodeWirePendingSingleHitl(raw, (level, msg) => {
      if (level === 'warn') warnings.push(msg);
    });
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.requestKey).toBe('req-2');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('容错：缺 request_key → skip + warn', () => {
    const raw = [{ kind: 'ask_choice', status: 'pending' }];
    const decoded = decodeWirePendingSingleHitl(raw);
    expect(decoded).toHaveLength(0);
  });

  it('容错：未知 status → 降级 pending', () => {
    const raw = [{ kind: 'ask_choice', request_key: 'req-1', status: 'garbage' }];
    const decoded = decodeWirePendingSingleHitl(raw);
    expect(decoded[0]!.status).toBe('pending');
  });

  it('容错：非数字 expires_at → undefined', () => {
    const raw = [{ kind: 'ask_choice', request_key: 'req-1', status: 'pending', expires_at: 'x' }];
    const decoded = decodeWirePendingSingleHitl(raw);
    expect(decoded[0]!.expiresAt).toBeUndefined();
  });

  it('空数组 / 非数组 → 空结果', () => {
    expect(decodeWirePendingSingleHitl([])).toEqual([]);
    expect(decodeWirePendingSingleHitl(null)).toEqual([]);
    expect(decodeWirePendingSingleHitl(undefined)).toEqual([]);
    expect(decodeWirePendingSingleHitl('not-array' as unknown)).toEqual([]);
  });
});
