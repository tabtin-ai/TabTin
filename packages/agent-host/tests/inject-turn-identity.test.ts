import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ContentBlock, Message, MessageBlockRecord } from '@tabtin/agent-runtime'
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
} from '@tabtin/agent-runtime/engine'
import { mergeConsecutiveMessages } from '@tabtin/agent-runtime/engine/message-normalizer'
import { reconstructMessagesFromBlockRecords } from '@tabtin/agent-runtime'
import { buildReplayHistoryFromTranscript } from '@tabtin/agent-runtime/history'
import { buildInitialMessages } from '@tabtin/agent-runtime'
import { injectTurnIdentity } from '../src/conversation/inject-turn-identity.js'
import {
  AttributionStore,
  bindAttributionStore,
  unbindAttributionStoreForTests,
  clearMessageAgentAttributionsForTests,
  rememberMessageAgentAttribution,
} from '../src/state/index.js'

const testAttribution = new AttributionStore()

beforeEach(() => {
  testAttribution.clearForTests()
  bindAttributionStore(() => testAttribution)
})

afterEach(() => {
  clearMessageAgentAttributionsForTests()
  unbindAttributionStoreForTests()
})

function record(
  overrides: Partial<MessageBlockRecord> & { message_id: string },
): MessageBlockRecord {
  return {
    v: 1,
    recorded_at: '2026-08-01T00:00:00.000Z',
    role: 'assistant',
    message_kind: 'llm',
    blocks_json: [],
    ...overrides,
  }
}

/** 模拟 pipeline：restore → replay → buildInitial → inject（归属来自 host store）。 */
function buildInitialThenInject(
  records: MessageBlockRecord[],
  currentAgentId: string,
  nextUser = '下一轮',
  resolveAgentName?: (agentId: string) => string | undefined,
): Message[] {
  const restored = reconstructMessagesFromBlockRecords(records)
  const history = buildReplayHistoryFromTranscript(restored)
  const initial = buildInitialMessages(history, { role: 'user', content: nextUser })!
  return injectTurnIdentity(initial, records, { currentAgentId, resolveAgentName })
}

describe('injectTurnIdentity ', () => {
  it('异 Agent assistant 前插入独立 reminder；名称来自 resolveAgentName', () => {
    rememberMessageAgentAttribution('a1', '029bec5e-b398-4111-96bc-ddef11282e78')
    const records = [
      record({
        message_id: 'u1',
        role: 'user',
        blocks_json: [{ type: 'text', text: '用户问题' } as ContentBlock],
      }),
      record({
        message_id: 'a1',
        blocks_json: [{ type: 'text', text: '我是上一轮的回答' } as ContentBlock],
      }),
    ]
    const messages = buildInitialThenInject(
      records,
      'agent-b',
      '下一轮',
      (id) => (id === '029bec5e-b398-4111-96bc-ddef11282e78' ? '默认 Space 执行身份' : undefined),
    )

    expect(messages).toHaveLength(4)
    expect(messages[1]?.role).toBe('user')
    expect(hasInternalMarker(messages[1]!, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT)).toBe(true)
    const reminderText = (messages[1]!.content as ContentBlock[])[0] as { text: string }
    expect(reminderText.text).toContain('<system-reminder>')
    expect(reminderText.text).toContain('「默认 Space 执行身份」')
    expect(reminderText.text).toContain('不代表当前执行者身份')
    expect(reminderText.text).not.toContain('029bec5e')
    expect(reminderText.text).not.toContain('<turn_identity')
    expect(messages[2]?.role).toBe('assistant')
  })

  it('当前执行者相同时不注入', () => {
    rememberMessageAgentAttribution('a1', 'agent-a')
    const records = [
      record({
        message_id: 'u1',
        role: 'user',
        blocks_json: [{ type: 'text', text: 'q' } as ContentBlock],
      }),
      record({
        message_id: 'a1',
        blocks_json: [{ type: 'text', text: '同 Agent' } as ContentBlock],
      }),
    ]
    const restored = reconstructMessagesFromBlockRecords(records)
    const history = buildReplayHistoryFromTranscript(restored)
    const initial = buildInitialMessages(history, { role: 'user', content: '下一轮' })!
    const messages = injectTurnIdentity(initial, records, { currentAgentId: 'agent-a' })
    expect(messages).toEqual(initial)
  })

  it('无 resolveAgentName 时用通用文案', () => {
    rememberMessageAgentAttribution('a1', 'agent-x')
    const records = [
      record({
        message_id: 'a1',
        blocks_json: [{ type: 'text', text: '旧盘' } as ContentBlock],
      }),
    ]
    const messages = buildInitialThenInject(records, 'agent-b')
    const reminder = messages.find((m) =>
      hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT),
    )
    const reminderText = (reminder!.content as ContentBlock[])[0] as { text: string }
    expect(reminderText.text).toContain('另一位 Agent')
  })

  it('compaction 边界后丢弃压缩前插入点，只给压缩后异 Agent 注解', () => {
    rememberMessageAgentAttribution('a-old', 'agent-old')
    rememberMessageAgentAttribution('a-new', 'agent-new')
    const records = [
      record({
        message_id: 'a-old',
        blocks_json: [{ type: 'text', text: '压缩前回复' } as ContentBlock],
      }),
      record({
        message_id: 'compact-1',
        role: 'user',
        message_kind: 'compaction_summary',
        compaction_boundary: true,
        blocks_json: [{ type: 'text', text: '摘要' } as ContentBlock],
      }),
      record({
        message_id: 'a-new',
        blocks_json: [{ type: 'text', text: '压缩后回复' } as ContentBlock],
      }),
    ]
    const messages = buildInitialThenInject(
      records,
      'agent-b',
      '下一轮',
      (id) => (id === 'agent-new' ? '新 Agent' : id === 'agent-old' ? '旧 Agent' : undefined),
    )
    const reminders = messages.filter((m) =>
      hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT),
    )
    expect(reminders).toHaveLength(1)
    const reminderText = (reminders[0]!.content as ContentBlock[])[0] as { text: string }
    expect(reminderText.text).toContain('「新 Agent」')
    expect(reminderText.text).not.toContain('旧 Agent')
  })

  it('与真 user 相邻时 normalize 不合成一条', () => {
    rememberMessageAgentAttribution('a1', 'agent-a')
    const records = [
      record({
        message_id: 'u1',
        role: 'user',
        blocks_json: [{ type: 'text', text: '用户问题' } as ContentBlock],
      }),
      record({
        message_id: 'a1',
        blocks_json: [{ type: 'text', text: '他的回答' } as ContentBlock],
      }),
    ]
    const initial = buildInitialThenInject(records, 'agent-b')
    const merged = mergeConsecutiveMessages(initial, 'user')

    expect(merged.merged).toBe(0)
    expect(
      merged.messages.some((m) => hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT)),
    ).toBe(true)
  })

  it('thinking-only 被 replay 丢弃后 host 可见性过滤对齐，不误标当前 Agent', () => {
    // records 序：异 Agent 文本 → 纯 thinking（replay 丢）→ 当前 Agent 文本
    // host 收集 meta 时跳过 thinking-only，与 initialMessages assistant 序一致。
    rememberMessageAgentAttribution('a-other', 'agent-other')
    rememberMessageAgentAttribution('a-think', 'agent-other')
    rememberMessageAgentAttribution('a-self', 'agent-self')
    const records = [
      record({
        message_id: 'a-other',
        blocks_json: [{ type: 'text', text: '别人的回答' } as ContentBlock],
      }),
      record({
        message_id: 'a-think',
        blocks_json: [{ type: 'thinking', thinking: '仅思考' } as ContentBlock],
      }),
      record({
        message_id: 'a-self',
        blocks_json: [{ type: 'text', text: '我自己的回答' } as ContentBlock],
      }),
    ]
    const messages = buildInitialThenInject(
      records,
      'agent-self',
      '下一轮',
      (id) => (id === 'agent-other' ? '别人' : id === 'agent-self' ? '自己' : undefined),
    )

    const reminders = messages.filter((m) =>
      hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT),
    )
    expect(reminders).toHaveLength(1)
    const reminderText = (reminders[0]!.content as ContentBlock[])[0] as { text: string }
    expect(reminderText.text).toContain('「别人」')
    expect(reminderText.text).not.toContain('「自己」')

    const otherIdx = messages.findIndex(
      (m) => m.role === 'assistant'
        && Array.isArray(m.content)
        && (m.content as ContentBlock[]).some(
          (b) => b.type === 'text' && (b as { text: string }).text === '别人的回答',
        ),
    )
    const selfIdx = messages.findIndex(
      (m) => m.role === 'assistant'
        && Array.isArray(m.content)
        && (m.content as ContentBlock[]).some(
          (b) => b.type === 'text' && (b as { text: string }).text === '我自己的回答',
        ),
    )
    expect(otherIdx).toBeGreaterThan(0)
    expect(messages[otherIdx - 1]).toBe(reminders[0])
    expect(selfIdx).toBeGreaterThan(otherIdx)
    expect(hasInternalMarker(messages[selfIdx - 1]!, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT)).toBe(false)
  })

  it('meta 与 assistant 条数不一致时 fail-closed：整批不注入', () => {
    rememberMessageAgentAttribution('a1', 'agent-a')
    rememberMessageAgentAttribution('a2', 'agent-a')
    const records = [
      record({
        message_id: 'a1',
        blocks_json: [{ type: 'text', text: '一' } as ContentBlock],
      }),
      record({
        message_id: 'a2',
        blocks_json: [{ type: 'text', text: '二' } as ContentBlock],
      }),
    ]
    // 故意只给一条 assistant，制造条数不一致
    const bare: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: '一' } as ContentBlock] },
      { role: 'user', content: '下一轮' },
    ]
    const messages = injectTurnIdentity(bare, records, { currentAgentId: 'agent-b' })
    expect(messages).toEqual(bare)
    expect(
      messages.some((m) => hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT)),
    ).toBe(false)
  })
})
