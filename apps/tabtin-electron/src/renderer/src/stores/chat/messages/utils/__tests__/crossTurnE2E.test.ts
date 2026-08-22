/**
 * Wave 连续对话成熟化 P · 端到端场景测试（方案 §五 用户场景）。
 *
 * 分两侧覆盖 3 个用户场景：
 *   - **本文件（renderer 装填层）**：场景 1（"你刚才用什么工具"）、场景 2（中断）
 *   - **runtime 侧 `engine-message-normalizer.test.ts` 的 ensureToolResultPairing
 *     套件**：场景 3（并行 tool_use 跨 resume），因为 `allSeenToolUseIds` 去重
 *     逻辑是 engine 内部最末闸，测试直接在 engine 包里做更贴近实际链路
 *
 * ### 与 unit 测试的区分
 *
 * `selectRecentHistoryForRuntime.test.ts` / `filterUnresolvedToolUses.test.ts`
 * 是函数级单测；本文件是"renderer 用户视角端到端"：
 *   - 构造一个真实用户对话的 `ChatMessage[]`
 *   - 通过 `selectRecentHistoryForRuntime` + `filterUnresolvedToolUses` 链路
 *     产出 `initialMessages` 形态
 *   - 断言产物符合下一轮 Agent 能精确回指"上次调了什么工具"的期望
 */

import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessageBlock } from '@tabtin/chat-client'
import { selectRecentHistoryForRuntime, filterUnresolvedToolUses } from '@tabtin/agent-runtime/history'
import type { RuntimeHistoryMessage } from '@tabtin/agent-runtime/history'

/**
 * W4c：测试模拟"sendMessageAction 映射后传入 daemon"的形态——daemon
 * `HistorySourceMessage` 仍用 `blocks_json` 字段名（must-not-touch 范围）。
 * renderer ChatMessage.content_blocks_json 由 sendMessageAction 做跨边界映射。
 */
type MkOverrides = Partial<ChatMessage> & { blocks_json?: MessageBlock[] }

function mkUser(id: string, text: string, extra: MkOverrides = {}): ChatMessage {
  return {
    id,
    role: 'user',
    content: text,
    created_at: '2026-04-19T00:00:00Z',
    ...extra,
  } as unknown as ChatMessage
}

function mkAsstWithTool(
  id: string,
  text: string,
  toolCallId: string,
  toolName: string,
  input: unknown,
  output: unknown,
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: text,
    created_at: '2026-04-19T00:00:00Z',
    blocks_json: [
      { type: 'text', text } as MessageBlock,
      {
        type: 'tool_call',
        tool_name: toolName,
        tool_call_id: toolCallId,
        input,
        output,
      } as unknown as MessageBlock,
    ],
  } as unknown as ChatMessage
}

describe('E2E 场景 1 · "你刚才用什么工具查的"', () => {
  it('多轮 tool_call 历史被装填后，Agent 下一轮能看到完整 tool 链（tool_use_id 严格保留）', () => {
    const history: ChatMessage[] = [
      mkUser('u1', '帮我查一下北京天气'),
      mkAsstWithTool(
        'a1',
        '我来查一下。',
        'toolu_weather_abc',
        'web_search',
        { q: '北京天气' },
        { temp: 25, weather: '晴' },
      ),
      mkUser('u2', '那上海呢？'),
      mkAsstWithTool(
        'a2',
        '我再查上海。',
        'toolu_weather_def',
        'web_search',
        { q: '上海天气' },
        { temp: 22, weather: '多云' },
      ),
    ]

    const runtimeHist = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })

    // 拼上本轮 user（Agent 问 "你刚才查北京用什么工具？"）
    const userPrompt: RuntimeHistoryMessage = {
      role: 'user',
      content: '你刚才查北京天气用的什么工具？',
    }
    const initialMessages = [...runtimeHist, userPrompt]

    // 装填产物：4 条 ChatMessage → 6 条 runtime message（2 轮 assistant 各展开成 2 条）
    // 加本轮 user = 7 条
    expect(initialMessages).toHaveLength(7)

    // 断言 tool_use block 出现在 assistant 消息里，id === LLM 原生 id（严格保留）
    const toolUseIds: string[] = []
    const toolUseNames: string[] = []
    for (const msg of initialMessages) {
      if (msg.role !== 'assistant' || typeof msg.content === 'string') continue
      for (const block of msg.content) {
        if ((block as { type: string }).type === 'tool_use') {
          toolUseIds.push((block as { id: string }).id)
          toolUseNames.push((block as { name: string }).name)
        }
      }
    }
    expect(toolUseIds).toEqual(['toolu_weather_abc', 'toolu_weather_def'])
    expect(toolUseNames).toEqual(['web_search', 'web_search'])

    // 断言 tool_result.tool_use_id === 对应 tool_use.id（配对完整）
    const toolResultIds: string[] = []
    const toolResultContents: string[] = []
    for (const msg of initialMessages) {
      if (msg.role !== 'user' || typeof msg.content === 'string') continue
      for (const block of msg.content as Array<{ type?: string; tool_use_id?: string; content?: string }>) {
        if (block && block.type === 'tool_result') {
          toolResultIds.push(block.tool_use_id!)
          toolResultContents.push(block.content!)
        }
      }
    }
    expect(toolResultIds.sort()).toEqual(['toolu_weather_abc', 'toolu_weather_def'].sort())
    // output 被 JSON 字符串化（天气对象）
    expect(toolResultContents.some((c) => c.includes('temp') && c.includes('25'))).toBe(true)
    expect(toolResultContents.some((c) => c.includes('temp') && c.includes('22'))).toBe(true)
  })

  it('含 tool 链的 assistant 与紧跟的 user(tool_result) 顺序正确（满足 Anthropic API wire 形态）', () => {
    const history: ChatMessage[] = [
      mkUser('u1', 'query'),
      mkAsstWithTool('a1', '正在查询。', 'toolu_1', 'grep', { pattern: 'foo' }, 'match1'),
    ]
    const runtimeHist = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })

    // 期望顺序：user → assistant(text+tool_use) → user(tool_result)
    expect(runtimeHist).toHaveLength(3)
    expect(runtimeHist[0]!.role).toBe('user')
    expect(runtimeHist[1]!.role).toBe('assistant')
    expect(runtimeHist[2]!.role).toBe('user')
    expect(Array.isArray(runtimeHist[1]!.content)).toBe(true)
    expect(Array.isArray(runtimeHist[2]!.content)).toBe(true)
  })
})

describe('E2E 场景 2 · 中断后再发下一条', () => {
  it('手动构造"半拉子 assistant(tool_use)"的 runtime history → filterUnresolvedToolUses 整条丢', () => {
    // 模拟 content_blocks_json 升级 / Django 回填异常导致装填展开后 assistant 的 tool_use
    // 没对应的 tool_result。装填层的 filterUnresolvedToolUses 兜底过滤。
    const halfBrokenMessages: RuntimeHistoryMessage[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '让我调个工具。' },
          { type: 'tool_use', id: 'interrupted_use', name: 'grep', input: {} },
        ],
      },
      // 缺 tool_result —— 模拟被用户 Ctrl+C 打断
      { role: 'user', content: '新问题：请直接回答' },
    ]

    const filtered = filterUnresolvedToolUses(halfBrokenMessages)
    expect(filtered).toHaveLength(2)
    expect(filtered[0]).toEqual({ role: 'user', content: 'q1' })
    expect(filtered[1]).toEqual({ role: 'user', content: '新问题：请直接回答' })
  })

  it('部分 tool_use 有 result 部分没：保留整条 assistant（engine 侧 ensureToolResultPairing 再补占位）', () => {
    // 同语义：`toolUseBlockIds.every(id => unresolvedIds.has(id))` 为 false 时整条留。
    const halfBrokenMessages: RuntimeHistoryMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'ok', name: 'grep', input: {} },
          { type: 'tool_use', id: 'missing', name: 'grep', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'ok', content: 'match' }],
      },
    ]
    const filtered = filterUnresolvedToolUses(halfBrokenMessages)
    expect(filtered).toEqual(halfBrokenMessages)
  })

  it('装填链路完整 E2E：真实 ChatMessage 带 tool_call（闭环）→ filter 不误伤', () => {
    const history: ChatMessage[] = [
      mkUser('u', 'q'),
      mkAsstWithTool('a', '', 'tc_ok', 'grep', {}, 'match'),
    ]
    const hist = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })
    // 闭环 → filter 不丢任何消息
    expect(hist.some((m) => m.role === 'assistant')).toBe(true)
    expect(
      hist.some(
        (m) =>
          m.role === 'user'
          && Array.isArray(m.content)
          && (m.content as Array<{ type?: string }>).some((b) => b.type === 'tool_result'),
      ),
    ).toBe(true)
  })
})

// ─── E2E 场景 3 · W4.3.2 dogfood "用户同时请求两件事" ──────────────────
//
// 严格对照 dogfood session 3596343a 现场——从 messagesBySessionId 出发跑完整
// 装填链路（selectRecentHistoryForRuntime → buildInitialMessages → 模拟
// context-injector beforeIteration → mergeConsecutiveMessages），断言：
//
//   修复前：merge 后 messages.length === 1，content 是 3 个 text blocks 合并
//          → LLM 看到这条会输出 thinking "用户想要我：1. 列出 2. 阅读"。
//
//   修复后：merge 后保持 5 条独立（contextMsg / turn 1 user / turn 1 ai /
//          turn 1 tool_result / turn 2 user）→ LLM 能正确区分轮次。

import { buildInitialMessages, buildUserMessageWithAttachments } from '@tabtin/agent-runtime/history'
import type { Message } from '@tabtin/agent-runtime/engine'
import {
  mergeConsecutiveMessages,
  normalizeMessages,
} from '@tabtin/agent-runtime/engine/message-normalizer'

const CONTEXT_INJECTION_MARKER = '__context_injector__'

function setContextInjectionMarker(message: Message): Message {
  (message as unknown as Record<string, unknown>)[CONTEXT_INJECTION_MARKER] = true
  return message
}

function hasContextInjectionMarker(message: Message): boolean {
  return (message as unknown as Record<string, unknown>)[CONTEXT_INJECTION_MARKER] === true
}

describe('E2E 场景 3 · W4.3.2 dogfood "用户同时请求两件事" P0 真根因端到端', () => {
  it('dogfood 现场重放：turn 1 user/ai 是 temp-* id（server sync 没回）→ 修复后 LLM 看到完整 5 条独立 messages', () => {
    // === Step 1: 重建 dogfood 现场 messagesBySessionId[sessionId] ===
    // 现场两个事实（events.jsonl + Snapshot 3 verified）：
    //   - turn 1 完成（events lifecycle.end）但 server sync 还没回填 server_id
    //     → turn 1 user/ai message id 都还是 temp-*
    //   - turn 2 user (id=temp-user-CURRENT) 已 push 到数组
    //   - turn 2 ai placeholder (id=temp-ai-CURRENT, content='') 已 push
    const dogfoodChatMessages: ChatMessage[] = [
      mkUser('temp-user-T1-PREV', 'ls 列出来我的当前文件夹'),
      mkAsstWithTool(
        'temp-ai-T1-PREV',
        '当前文件夹包含...',
        'list_directory:0',
        'list_directory',
        { path: '/Users/developer/dev/TabTin/TabTinAgent/packages/skills/bundled/platform/device/operations' },
        '{"success":true,"entries":["SKILL.md"]}',
      ),
      mkUser('temp-user-T2-CURRENT', '那你阅读一下这个 skill'),
      // 注：sendMessageAction line 726 push 空 ai placeholder——这里也加上模拟现实形态
      {
        id: 'temp-ai-T2-CURRENT',
        role: 'assistant',
        content: '',
        created_at: '2026-04-19T00:00:00Z',
      } as ChatMessage,
    ]

    // === Step 2: selectRecentHistoryForRuntime ===
    // sendMessageAction line 1008-1013：传 currentUserMessageId 排除本轮 user
    const history = selectRecentHistoryForRuntime(dogfoodChatMessages, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'temp-user-T2-CURRENT',
    })

    // 修复后期望：history 有 turn 1 完整 [user "ls", assistant tool_use, user tool_result]
    // 修复前（旧 isCurrentTurnPlaceholder startsWith 'temp-'）：history.length === 0
    expect(history.length).toBeGreaterThanOrEqual(3)
    expect(history[0]).toEqual({ role: 'user', content: 'ls 列出来我的当前文件夹' })
    expect(history[1]!.role).toBe('assistant')
    const t1AsstBlocks = history[1]!.content as Array<{ type?: string }>
    expect(t1AsstBlocks.some(b => b.type === 'tool_use')).toBe(true)
    expect(history[2]!.role).toBe('user')
    const t1TrBlocks = history[2]!.content as Array<{ type?: string }>
    expect(t1TrBlocks.some(b => b.type === 'tool_result')).toBe(true)

    // === Step 3: buildInitialMessages + currentUserMessage ===
    const currentUserMsg = buildUserMessageWithAttachments('那你阅读一下这个 skill')
    const initialMessages = buildInitialMessages(history, currentUserMsg)
    expect(initialMessages).toBeDefined()
    // history 3 + currentUser 1 = 4 条
    expect(initialMessages!.length).toBe(4)
    // 末尾是当前 user
    const lastMsg = initialMessages![initialMessages!.length - 1]!
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content).toBe('那你阅读一下这个 skill')

    // === Step 4: 模拟 runtime.query state.messages.push initialMessages → 加 context-injector beforeIteration prepend ===
    // 复刻 hooks/context-injector.ts:97 行为
    const contextMsg: Message = setContextInjectionMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context>\ncurrent_datetime: 2026-04-28 15:15:29 UTC\nfocused_app: tabsettings\n</context>' }],
      },
    )
    // initialMessages 转 Message[]（content 已是 string | ContentBlock[]）
    const stateMessages: Message[] = [
      contextMsg,
      ...initialMessages!.map(m => ({ role: m.role, content: m.content })) as Message[],
    ]
    expect(stateMessages.length).toBe(5)

    // === Step 5: 模拟 normalizeMessages（含 mergeConsecutiveMessages user）→ 这是发 LLM 前的最末闸 ===
    const normalized = normalizeMessages(stateMessages)

    // ✅ 修复后核心断言：5 条 messages 全部独立保留
    //   修复前：normalized.length === 1, merged_user === 4
    //   修复后：normalized.length === 5, merged_user === 0
    expect(normalized.changes.merged_user).toBe(0)
    expect(normalized.messages.length).toBe(5)

    // 各角色顺序与内容逐项断言
    expect(normalized.messages[0]!.role).toBe('user')
    expect(hasContextInjectionMarker(normalized.messages[0]!)).toBe(true)

    expect(normalized.messages[1]!.role).toBe('user')
    expect(normalized.messages[1]!.content).toBe('ls 列出来我的当前文件夹')

    expect(normalized.messages[2]!.role).toBe('assistant')
    const a2Blocks = normalized.messages[2]!.content as Array<{ type?: string }>
    expect(a2Blocks.some(b => b.type === 'tool_use')).toBe(true)

    expect(normalized.messages[3]!.role).toBe('user')
    const u3Blocks = normalized.messages[3]!.content as Array<{ type?: string }>
    expect(u3Blocks.some(b => b.type === 'tool_result')).toBe(true)

    expect(normalized.messages[4]!.role).toBe('user')
    expect(normalized.messages[4]!.content).toBe('那你阅读一下这个 skill')
  })

  it('dogfood 复发对照：如果 isCurrentTurnPlaceholder 仍按 startsWith temp-* 兜底 → history 全空 + merge 误合并', () => {
    // 对照实验：手动模拟"旧实现 isCurrentTurnPlaceholder 把 turn 1 全排除"
    // 验证修复链路成立——单层 fix（任何一层）都能挡住 P0
    //
    // 这里直接构造"history.length === 0"的最坏情形（模拟旧实现真根因 2 触发）
    // 然后断言 W4.3.2 真根因 1（context_injection 分类）也能挡住合并
    const emptyHistory: RuntimeHistoryMessage[] = []
    const currentUserMsg = buildUserMessageWithAttachments('那你阅读一下这个 skill')
    const initialMessages = buildInitialMessages(emptyHistory, currentUserMsg)
    // history 空 → buildInitialMessages 返回 undefined（旧约定）
    expect(initialMessages).toBeUndefined()

    // runtime.query 见 initialMessages=undefined → state.messages = [currentUser]
    const stateMessagesAfterFallback: Message[] = [currentUserMsg]
    // context-injector prepend
    const contextMsg: Message = setContextInjectionMarker(
      {
        role: 'user',
        content: [{ type: 'text', text: '<context>\nfocused_app: tabsettings\n</context>' }],
      },
    )
    const stateMessages: Message[] = [contextMsg, ...stateMessagesAfterFallback]

    const merged = mergeConsecutiveMessages(stateMessages, 'user')
    // ✅ 即使 history 没装填到（真根因 2 仍未修），真根因 1 的 fix 也挡住了
    //   contextMsg 跟 user "那你阅读" 的合并 → LLM 看到 2 条独立 messages
    expect(merged.merged).toBe(0)
    expect(merged.messages.length).toBe(2)
    expect(hasContextInjectionMarker(merged.messages[0]!)).toBe(true)
    expect(merged.messages[1]!.content).toBe('那你阅读一下这个 skill')
  })
})
