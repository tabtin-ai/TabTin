/**
 * W4.3.2 dogfood P0 端到端值流测试。
 *
 * **复现现场**：用户跟"小豆子" Agent 多轮对话——dogfood session
 * `3596343a-25da-4da3-9703-cd6651053342`：
 *   turn 1 user: "ls 列出来我的当前文件夹"
 *   turn 1 assistant: thinking + tool_use(list_directory)
 *   turn 1 user (tool_result): list_directory 输出
 *   turn 1 assistant: thinking + text "当前文件夹包含..."
 *   turn 2 user: "那你阅读一下这个 skill"
 *   turn 2 assistant thinking 输出："**用户想要我：1. 列出当前文件夹的内容
 *      2. 然后阅读一个 skill。但是用户没有指定要阅读哪个 skill...**"
 *
 * **bug**：Agent 把 turn 1 + turn 2 两个独立的 user 请求**合并解读为同一次"同时请求"**。
 *
 * **真根因**：harness trace + 用户截图 + dogfood snapshots.jsonl 三方证实是
 *
 *   1. **真根因层 1**：context-injector hook 在 beforeIteration prepend 的
 *      `{role:'user', content:[<context>...]}` 跟用户真实输入 `{role:'user',
 *      content:'那你阅读...'}` 在 W4.3 二分类（tool_result_only / other）眼里
 *      都是 'other'，被 mergeConsecutiveMessages 合并。
 *   2. **真根因层 2**：select-recent-history `isCurrentTurnPlaceholder` 旧实现
 *      第 (2) 条规则 `id.startsWith('temp-')` 把 turn N-1 还没收到 server_id
 *      ack 的 `temp-user-*` / `temp-ai-*` 整轮当本轮占位剔除——history.length
 *      归零 → 只剩 turn N currentUser → 被 contextMsg 合并。
 *
 * **W4.3.2 修复**：
 *   - classifyUserMessage 扩四分类（tool_result_only / context_injection /
 *     continuation / other），任意两 kind 不同都不合并
 *   - context-injector 在 contextMessage 上打 INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION
 *   - query.ts continuation 路径在 user message 上打 INTERNAL_MESSAGE_MARKERS.CONTINUATION
 *   - select-recent-history.isCurrentTurnPlaceholder 删除 `temp-` startsWith 兜底
 *
 * 本测试是端到端值流验证（F8 教训）：单测只能验证函数级行为，端到端测试
 * 才能验证整条链路（messagesBySessionId → selectRecentHistoryForRuntime →
 * buildInitialMessages → state.messages.push → context-injector beforeIteration
 * → normalizeMessages → 最终 LLM messages）真没回归。
 */

import { describe, it, expect } from 'vitest';
import {
  selectRecentHistoryForRuntime,
  buildInitialMessages,
  buildUserMessageWithAttachments,
  type HistorySourceMessage,
} from '@tabtin/agent-runtime';
import { buildContextHook } from '../src/hooks/index.js';
import { createAppMetaFormatter } from '../src/delivery/app-meta-formatter.js';
import {
  normalizeMessages,
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  type Message,
  type EngineState,
} from '@tabtin/agent-runtime/engine';

// ── Helpers ─────────────────────────────────────────────────────────

function getMessageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((block) => (typeof block === 'object' && block && 'text' in block ? String(block.text) : ''))
    .join('\n');
}

function getContextInjectionText(messages: Message[]): string {
  return messages
    .filter((m) => hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION))
    .map(getMessageText)
    .join('\n');
}

/**
 * 构造 dogfood session 真实形态的 HistorySourceMessage 序列。
 *
 * 严格还原 `~/Library/Application Support/tabtin-electron/agent-sessions/
 * 3596343a-25da-4da3-9703-cd6651053342/messages.jsonl` 的数据形态——
 * turn 1 完整一轮（user → assistant 含 tool_use → user 含 tool_result →
 * assistant final answer），turn 2 起手 user。
 *
 * 所有 message id 都是 `temp-*` 形态——模拟 dogfood 现场 server_id ack 还
 * 没回填的状态。这是 W4.3.2 真根因层 2 修复要保护的边界场景。
 */
function buildDogfoodMessagesBySessionId(): HistorySourceMessage[] {
  return [
    // turn 1 user
    {
      id: 'temp-user-T1',
      role: 'user',
      content: 'ls 列出来我的当前文件夹',
    },
    // turn 1 assistant: thinking + tool_use
    {
      id: 'temp-ai-T1',
      role: 'assistant',
      content: '',
      blocks_json: [
        {
          type: 'thinking',
          thinking: '用户想要列出当前文件夹的内容。',
        },
        {
          type: 'tool_call',
          tool_call_id: 'list_directory:0',
          tool_name: 'list_directory',
          input: {
            path: '/Users/developer/dev/TabTin/TabTinAgent/packages/skills/bundled/platform/device/operations',
          },
          output: '{"success":true,"path":"/.../operations","count":1,"entries":["SKILL.md"]}',
        },
      ],
    },
    // turn 1 assistant: thinking + text "final answer"
    {
      id: 'temp-ai-T1-final',
      role: 'assistant',
      content: '当前文件夹包含以下内容：\n\n- SKILL.md',
      blocks_json: [
        {
          type: 'thinking',
          thinking: '目录中只有一个文件：SKILL.md。',
        },
        {
          type: 'text',
          text: '当前文件夹包含以下内容：\n\n- SKILL.md',
        },
      ],
    },
    // turn 2 user (current turn)
    {
      id: 'temp-user-T2',
      role: 'user',
      content: '那你阅读一下这个 skill',
    },
    // turn 2 assistant placeholder（content 空，blocks_json 空）
    {
      id: 'temp-ai-T2',
      role: 'assistant',
      content: '',
    },
  ];
}

// ── 端到端值流测试主体 ─────────────────────────────────────────────

describe('W4.3.2 dogfood P0 — context-injection + cross-turn history 端到端值流', () => {
  it('完整链路 verify：history 装填 → buildInitialMessages → context-injector beforeIteration → normalizeMessages → 最终 messages 形态', async () => {
    // ── 步骤 1：模拟 sendMessageAction 装填 history ──
    const messagesBySessionId = buildDogfoodMessagesBySessionId();
    const currentUserMessageId = 'temp-user-T2';

    const history = selectRecentHistoryForRuntime(messagesBySessionId, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId,
      sessionId: 'sess-dogfood',
    });

    // ✅ Stage 3 修复 verify：history 必须包含 turn 1 完整 4 段（旧实现会丢光）
    //   - user "ls 列出来"
    //   - assistant [tool_use(list_directory)]（thinking 被丢，符合 Anthropic 签名要求）
    //   - user [tool_result]
    //   - assistant [text "当前文件夹包含..."]
    expect(history.length).toBeGreaterThanOrEqual(4);

    // 检查 turn 1 user 还在
    const turn1User = history.find(
      (m) => m.role === 'user' && m.content === 'ls 列出来我的当前文件夹',
    );
    expect(turn1User).toBeDefined();

    // 检查 turn 1 assistant 含 tool_use
    const turn1AssistantToolUse = history.find(
      (m) =>
        m.role === 'assistant'
        && Array.isArray(m.content)
        && m.content.some((b: Record<string, unknown>) => b.type === 'tool_use'),
    );
    expect(turn1AssistantToolUse).toBeDefined();

    // 检查 turn 1 user(tool_result) 还在
    const turn1ToolResult = history.find(
      (m) =>
        m.role === 'user'
        && Array.isArray(m.content)
        && m.content.some((b: Record<string, unknown>) => b.type === 'tool_result'),
    );
    expect(turn1ToolResult).toBeDefined();

    // 检查 turn 1 final assistant text 还在
    const turn1FinalAssistant = history.find(
      (m) =>
        m.role === 'assistant'
        && (typeof m.content === 'string'
          ? m.content.includes('当前文件夹包含')
          : Array.isArray(m.content)
            && m.content.some(
              (b: Record<string, unknown>) =>
                b.type === 'text'
                && typeof b.text === 'string'
                && b.text.includes('当前文件夹包含'),
            )),
    );
    expect(turn1FinalAssistant).toBeDefined();

    // 检查 turn 2 currentUser 没误入 history
    const turn2InHistory = history.find(
      (m) => m.role === 'user' && m.content === '那你阅读一下这个 skill',
    );
    expect(turn2InHistory).toBeUndefined();

    // ── 步骤 2：buildInitialMessages 构造 [...history, currentUserMsg] ──
    const turn2UserPrompt = '那你阅读一下这个 skill';
    const turn2UserMessage = buildUserMessageWithAttachments(turn2UserPrompt);
    const initialMessages = buildInitialMessages(history, turn2UserMessage);

    expect(initialMessages).toBeDefined();
    expect(initialMessages!.length).toBeGreaterThanOrEqual(5);
    expect(initialMessages![initialMessages!.length - 1]).toEqual(turn2UserMessage);

    // ── 步骤 3：模拟 runtime.query 把 initialMessages 灌入 state.messages ──
    const stateMessages: Message[] = [...initialMessages!];

    // ── 步骤 4：模拟 context-injector hook beforeIteration 注入 contextMsg ──
    let captured: Message[] = [];
    const hook = buildContextHook({
      getAppContext: async () => ({
        appType: 'tabsettings',
        spaceId: '98b91af3-c18e-4f8d-92ca-27c7ba403e1f',
        appMeta: { focused_panel: 'agent_management' },
        openTabs: [
          { type: 'tabsettings', title: 'Agent 管理', active: true },
          { type: 'apphome', title: '云资源', active: false },
        ],
      }),
    });

    // 用一个最小 mock state 喂给 hook（hook 只读写 state.messages）
    const mockState = {
      messages: stateMessages,
    } as unknown as EngineState;

    await hook.beforeIteration!({ state: mockState, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    captured = mockState.messages;

    // ✅ context-injector 注入后必有一条带 marker 的 contextMsg；#2072 后它注入到
    //    当前 user（turn2 user）之前，故落在倒数第二位，而非 messages[0]。
    expect(captured.length).toBeGreaterThanOrEqual(6);
    const ctxIdx = captured.findIndex((m) =>
      hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION),
    );
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(captured[ctxIdx]!.role).toBe('system');
    expect(ctxIdx).toBe(captured.length - 2);
    expect(captured[captured.length - 1]).toEqual(turn2UserMessage);

    // 阶段 6 议题 2：contextMsg 内容统一走 SSoT wrapper `<context type="environment">...`。
    // ：context-injector 注入 string content（与历史重建形态统一）。
    const ctxText = captured[ctxIdx]!.content as string;
    expect(typeof ctxText).toBe('string');
    expect(ctxText).toContain('<context type="environment">');
    // 2026-05-14 拆段重构后：旧 `focused_app: <internal_key>` 行被 `focused:
    // <display_name>「<title>」` 取代。这条 dogfood 测试只关心 hook 装配后
    // 上下文内的事实：active tab 是 tabsettings；不再断言裸 internal key 出现。
    expect(ctxText).toMatch(/focused: /);

    // ── 步骤 5：normalizeMessages 跑 mergeConsecutiveMessages 'user' 跨语义保护 ──
    const normResult = normalizeMessages(captured, { level: 'conservative' });
    const finalMessages = normResult.messages;

    // ✅ 关键 P0 断言：消息数量没塌陷到 1（修复前 dogfood 现场 Snapshot 3
    //    messages.length === 1，所有 user 全合并；修复后必须保留 ≥ 5 条
    //    独立 message：context + 4 段 turn 1 history + turn 2 user）
    expect(finalMessages.length).toBeGreaterThanOrEqual(5);

    // ✅ contextMsg 仍存在且仍带 marker（ 后位置在当前 user 之前，非首条）
    const ctxAfterNorm = finalMessages.findIndex((m) =>
      hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION),
    );
    expect(ctxAfterNorm).toBeGreaterThanOrEqual(0);
    expect(finalMessages[ctxAfterNorm]!.role).toBe('system');

    // ✅ turn 1 user "ls 列出来" 没被合并到 contextMsg 也没被合并到 turn 2 user
    const turn1UserAfterNorm = finalMessages.find(
      (m) =>
        m.role === 'user'
        && (m.content === 'ls 列出来我的当前文件夹'
          || (Array.isArray(m.content)
            && m.content.some(
              (b: Record<string, unknown>) =>
                b.type === 'text'
                && typeof b.text === 'string'
                && b.text === 'ls 列出来我的当前文件夹',
            ))),
    );
    expect(turn1UserAfterNorm).toBeDefined();

    // ✅ turn 2 user "那你阅读" 独立保留为最后一条 user message（不跟前面任何 user 合并）
    const lastMessage = finalMessages[finalMessages.length - 1]!;
    expect(lastMessage.role).toBe('user');
    if (typeof lastMessage.content === 'string') {
      expect(lastMessage.content).toBe(turn2UserPrompt);
    } else {
      expect(Array.isArray(lastMessage.content)).toBe(true);
      expect(
        lastMessage.content.some(
          (b: Record<string, unknown>) =>
            b.type === 'text'
            && typeof b.text === 'string'
            && b.text === turn2UserPrompt,
        ),
      ).toBe(true);
    }

    // ✅ turn 1 assistant tool_use 跟 user(tool_result) 配对完整
    const toolUseMsg = finalMessages.find(
      (m) =>
        m.role === 'assistant'
        && Array.isArray(m.content)
        && m.content.some((b: Record<string, unknown>) => b.type === 'tool_use'),
    );
    expect(toolUseMsg).toBeDefined();
    const toolResultMsg = finalMessages.find(
      (m) =>
        m.role === 'user'
        && Array.isArray(m.content)
        && m.content.some((b: Record<string, unknown>) => b.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();

    // ✅ pairing_violations === 0（normalize 后必须配对完整）
    expect(normResult.changes.pairing_violations).toBe(0);

    // ✅ 关键回归 guard：finalMessages 中所有 user message 不应该被合并成
    //    [contextBlock, "ls", "那你阅读"] 一条（dogfood 现场表象）
    //
    //    具体表象：如果有任何一条 user message 同时包含 <context> XML
    //    + "ls 列出来" + "那你阅读" 三段 text，说明 P0 复现了。
    for (const m of finalMessages) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      const allText = m.content
        .filter((b: Record<string, unknown>) => b.type === 'text')
        .map((b: Record<string, unknown>) => (b as { text: string }).text)
        .join('|');
      // 阶段 6 议题 2：context wrapper 形态升级为 `<context type="environment">`
      const hasCtx = allText.includes('<context type="environment">');
      const hasLsText = allText.includes('ls 列出来');
      const hasReadText = allText.includes('那你阅读');
      const dogfoodPattern = hasCtx && hasLsText && hasReadText;
      expect(
        dogfoodPattern,
        '❌ dogfood P0 现场重现：一条 user message 同时含 <context type="environment"> + "ls 列出来" + "那你阅读" 三段 text → 修复回归',
      ).toBe(false);
    }
  });

  it('完整链路（无 history 装填，纯单轮）：context-injector + 单条 user → 不合并', async () => {
    // 边界：第一轮对话（history 为空），只有当前 user。context-injector 注入
    // 后期望 [contextMsg, user "新输入"] 2 条，不能合并成 1 条。
    const turn1UserMessage = buildUserMessageWithAttachments('第一轮提问');
    const initial = buildInitialMessages(undefined, turn1UserMessage);
    // history undefined → buildInitialMessages 返回 undefined → 调用方手动 push currentUser
    expect(initial).toBeUndefined();

    const stateMessages: Message[] = [turn1UserMessage];

    const hook = buildContextHook({
      // ：去掉 current_datetime 后，无 tab/焦点信息的 context 会渲染为空 → 不注入。
      // 这里给一个 active tab 让 context 非空，保持本测试「context + user 不合并」的本意。
      getAppContext: async () => ({
        appType: 'tabhome',
        spaceId: 'sp-1',
        openTabs: [{ type: 'tabhome', display_name: '首页', is_home: true, active: true }],
      }),
    });
    const mockState = { messages: stateMessages } as unknown as EngineState;
    await hook.beforeIteration!({ state: mockState, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // 注入后是 [contextMsg, currentUser]
    expect(mockState.messages.length).toBe(2);

    const norm = normalizeMessages(mockState.messages, { level: 'conservative' });
    expect(norm.messages.length).toBe(2);
    expect(
      hasInternalMarker(norm.messages[0]!, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION),
    ).toBe(true);
    expect(norm.messages[1]!.content).toBe('第一轮提问');
  });

  it('回归 guard：context-injector 第二次 beforeIteration 幂等跳过（不堆积、不改写）', async () => {
    // ：run 内幂等——首轮注入后，第二次 beforeIteration 检测到 CONTEXT marker
    // 仍在 → 直接返回，不重新拉 context、不替换。保证 run 内 messages byte 稳定、
    // 环境按 run 起点快照。本测试 lock 这个行为。
    const stateMessages: Message[] = [
      { role: 'user', content: 'turn 1 user' },
    ];

    let tableVersion = 1;
    const hook = buildContextHook({
      getAppContext: async () => ({
        // tabdata 的 current_table_id 作版本可观察 anchor——它走 details 块，
        // 输出 "current_table: ... (id: tbl-vN)"，用来验证第二轮是否重新注入。
        appType: 'tabdata',
        appMeta: { current_table_id: `tbl-v${tableVersion}`, current_table_name: '测试表' },
        spaceId: 'sp-1',
      }),
      // ：appMeta 详情段由宿主注入的 formatAppMeta 渲染（context hook 只
      // 持有中性框架）。生产 electron/daemon 均传 createAppMetaFormatter()；此处注入
      // 真实 formatter 让 current_table_id 渲染成 "current_table: ... (id: tbl-vN)"
      // 可观察 anchor，幂等断言才有意义。
      formatAppMeta: createAppMetaFormatter(),
    });

    const mockState = { messages: stateMessages } as unknown as EngineState;

    await hook.beforeIteration!({ state: mockState, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(mockState.messages.length).toBe(2);
    // ：context-injector 注入 string content（与历史重建形态统一）。
    const ctx1 = getContextInjectionText(mockState.messages);
    expect(ctx1).toContain('tbl-v1');

    // 即使环境变了（canvas 切到 v2），run 内也不重新注入 —— 幂等跳过
    tableVersion = 2;
    await hook.beforeIteration!({ state: mockState, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });
    // 数量仍是 2，且内容保持首轮的 cnv-v1（未被替换）
    expect(mockState.messages.length).toBe(2);
    const ctx2 = getContextInjectionText(mockState.messages);
    expect(ctx2).toContain('tbl-v1');
    expect(ctx2).not.toContain('tbl-v2');
  });
});

// ── dogfood Snapshot 对照表（assertion driven） ──────────────────────
//
// 数据来源：dogfood session 3596343a-25da-4da3-9703-cd6651053342
// snapshots.jsonl Snapshot 3 (turn 2 iter=0) 实测形态：messageCount=1，
// content 为 3 个 text blocks 合并 [<context>, "ls 列出来", "那你阅读"]。
//
// W4.3.2 修复后期望形态（每条独立保留）；#2072 后 context 注入到当前 user 之前：
//   [0] user — string "ls 列出来我的当前文件夹"
//   [1] assistant — tool_use(list_directory)
//   [2] user — tool_result(list_directory output)
//   [3] assistant — text "当前文件夹包含以下内容..."
//   [4] user (CONTEXT_INJECTION marker) — text "<context>..."（紧贴当前 user 之前）
//   [5] user — string "那你阅读一下这个 skill"

describe('W4.3.2 dogfood — Snapshot 3 修复形态精确锁定', () => {
  it('dogfood Snapshot 3：修复后 6 条 message 各类 role / marker / block 类型', async () => {
    const messagesBySessionId = buildDogfoodMessagesBySessionId();
    const history = selectRecentHistoryForRuntime(messagesBySessionId, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'temp-user-T2',
      sessionId: 'sess-dogfood',
    });
    const turn2UserMessage = buildUserMessageWithAttachments('那你阅读一下这个 skill');
    const initialMessages = buildInitialMessages(history, turn2UserMessage)!;
    const stateMessages = [...initialMessages];
    const hook = buildContextHook({
      // ：去掉 current_datetime 后需有 tab/焦点信息才非空——给 active tab。
      getAppContext: async () => ({
        appType: 'tabsettings',
        spaceId: 'sp-1',
        openTabs: [{ type: 'tabsettings', display_name: '设置', active: true }],
      }),
    });
    const mockState = { messages: stateMessages } as unknown as EngineState;
    await hook.beforeIteration!({ state: mockState, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    const norm = normalizeMessages(mockState.messages, { level: 'conservative' });

    // 修复前 dogfood 现场 messages.length === 1（合并塌陷），修复后必须独立 6 条
    expect(norm.messages.length).toBe(6);

    // [0] turn 1 user "ls 列出来"
    expect(norm.messages[0]!.role).toBe('user');
    expect(norm.messages[0]!.content).toBe('ls 列出来我的当前文件夹');

    // [1] turn 1 assistant 含 tool_use
    expect(norm.messages[1]!.role).toBe('assistant');
    expect(Array.isArray(norm.messages[1]!.content)).toBe(true);
    const m1Blocks = norm.messages[1]!.content as Array<Record<string, unknown>>;
    expect(m1Blocks.some((b) => b.type === 'tool_use')).toBe(true);

    // [2] turn 1 user 含 tool_result
    expect(norm.messages[2]!.role).toBe('user');
    expect(Array.isArray(norm.messages[2]!.content)).toBe(true);
    const m2Blocks = norm.messages[2]!.content as Array<Record<string, unknown>>;
    expect(m2Blocks.some((b) => b.type === 'tool_result')).toBe(true);

    // [3] turn 1 assistant final answer text
    expect(norm.messages[3]!.role).toBe('assistant');
    if (Array.isArray(norm.messages[3]!.content)) {
      const m3Blocks = norm.messages[3]!.content as Array<Record<string, unknown>>;
      const finalText = m3Blocks.find(
        (b) => b.type === 'text' && typeof b.text === 'string',
      );
      expect(finalText).toBeDefined();
      expect((finalText as { text: string }).text).toContain('当前文件夹包含');
    } else {
      expect(norm.messages[3]!.content as string).toContain('当前文件夹包含');
    }

    // [4] context_injection system（：注入到当前 user 之前；LLM 边界再投影为 user）
    expect(norm.messages[4]!.role).toBe('system');
    expect(
      hasInternalMarker(norm.messages[4]!, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION),
    ).toBe(true);

    // [5] turn 2 currentUser
    expect(norm.messages[5]!.role).toBe('user');
    expect(norm.messages[5]!.content).toBe('那你阅读一下这个 skill');
  });
});
