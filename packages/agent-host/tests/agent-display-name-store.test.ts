import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AttributionStore,
  bindAttributionStore,
  unbindAttributionStoreForTests,
  clearAgentDisplayNamesForTests,
  rememberAgentDisplayName,
  resolveAgentDisplayName,
  clearMessageAgentAttributionsForTests,
  rememberMessageAgentAttribution,
} from '../src/state/index.js'
import { injectTurnIdentity } from '../src/conversation/inject-turn-identity.js'
import type { ContentBlock, MessageBlockRecord } from '@tabtin/agent-runtime'
import { INTERNAL_MESSAGE_MARKERS, hasInternalMarker } from '@tabtin/agent-runtime/engine'

const testAttribution = new AttributionStore()

beforeEach(() => {
  testAttribution.clearForTests()
  bindAttributionStore(() => testAttribution)
})

afterEach(() => {
  clearAgentDisplayNamesForTests()
  clearMessageAgentAttributionsForTests()
  unbindAttributionStoreForTests()
})

describe('agent-display-name-store ', () => {
  it('记住后可按 agentId 解析，供 inject 写入 system-reminder', () => {
    rememberAgentDisplayName('agent-a', '默认 Space 执行身份')
    rememberMessageAgentAttribution('a1', 'agent-a')
    expect(resolveAgentDisplayName('agent-a')).toBe('默认 Space 执行身份')

    const records: MessageBlockRecord[] = [{
      v: 1,
      recorded_at: '2026-08-01T00:00:00.000Z',
      message_id: 'a1',
      role: 'assistant',
      message_kind: 'llm',
      blocks_json: [{ type: 'text', text: '旧回复' } as ContentBlock],
    }]
    const messages = injectTurnIdentity(
      [{ role: 'assistant', content: [{ type: 'text', text: '旧回复' }] }],
      records,
      { currentAgentId: 'agent-b', resolveAgentName: resolveAgentDisplayName },
    )
    const reminder = messages[0]!
    expect(hasInternalMarker(reminder, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT)).toBe(true)
    const text = (reminder.content as ContentBlock[])[0] as { text: string }
    expect(text.text).toContain('「默认 Space 执行身份」')
  })

  it('未缓存展示名时回落通用文案', () => {
    rememberMessageAgentAttribution('a1', 'unknown')
    const records: MessageBlockRecord[] = [{
      v: 1,
      recorded_at: '2026-08-01T00:00:00.000Z',
      message_id: 'a1',
      role: 'assistant',
      message_kind: 'llm',
      blocks_json: [{ type: 'text', text: '旧回复' } as ContentBlock],
    }]
    const messages = injectTurnIdentity(
      [{ role: 'assistant', content: [{ type: 'text', text: '旧回复' }] }],
      records,
      { currentAgentId: 'agent-b', resolveAgentName: resolveAgentDisplayName },
    )
    const text = (messages[0]!.content as ContentBlock[])[0] as { text: string }
    expect(text.text).toContain('另一位 Agent')
  })
})
