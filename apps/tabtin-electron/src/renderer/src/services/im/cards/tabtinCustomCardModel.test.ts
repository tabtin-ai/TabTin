import { describe, expect, it } from 'vitest'
import {
  TABTIN_CUSTOM_CARD_TYPES,
  canForwardTabTinCustomCard,
  isTabTinCustomCardContent,
  isSystemManagedTabTinCard,
  parseTabTinCustomCard,
  type TabTinCustomCardType,
} from './tabtinCustomCardModel'

const SHARED_TASK = {
  schema_version: 1,
  version: 1,
  object_id: 'object-1',
  title_snapshot: '共享任务',
  sender_id: 'user-1',
  recipient_id: 'user-2',
} as const

const VALID_CARDS: Record<TabTinCustomCardType, Record<string, unknown>> = {
  space: { type: 'space' },
  agent_space: { type: 'agent_space' },
  table: { type: 'table' },
  document: { type: 'document' },
  contact: { type: 'contact', user_id: 'user-1' },
  handoff: { type: 'handoff', handoff_id: 'handoff-1' },
  prompt: { type: 'prompt', prompt_text: '执行这条指令' },
  session_share: { type: 'session_share', share_id: 'share-1' },
  session_share_v2: { type: 'session_share_v2', ...SHARED_TASK },
  session_continuation: { type: 'session_continuation', ...SHARED_TASK },
  codex_session: {
    type: 'codex_session',
    schema_version: 1,
    codex_session_id: 'session-1',
    codex_session_name: 'Imported session',
  },
}

describe('TabTin custom card model', () => {
  it('keeps the supported type list and parser in sync', () => {
    expect(Object.keys(VALID_CARDS)).toEqual(TABTIN_CUSTOM_CARD_TYPES)
    for (const card of Object.values(VALID_CARDS)) {
      expect(parseTabTinCustomCard(card)).toMatchObject({ kind: 'supported' })
      expect(isTabTinCustomCardContent(card)).toBe(true)
    }
  })

  it.each([
    { type: 'contact' },
    { type: 'handoff' },
    { type: 'prompt' },
    { type: 'session_share' },
    { type: 'session_share_v2', ...SHARED_TASK, version: 0 },
    { type: 'session_continuation', ...SHARED_TASK, object_id: '' },
    { type: 'codex_session', schema_version: 1, codex_session_id: 'session-1' },
  ])('rejects a known malformed $type card', (card) => {
    expect(parseTabTinCustomCard(card)).toEqual({ kind: 'invalid', type: card.type })
    expect(isTabTinCustomCardContent(card)).toBe(true)
  })

  it('uses the upgrade fallback for a future shared-task schema', () => {
    expect(parseTabTinCustomCard({
      type: 'session_share_v2',
      ...SHARED_TASK,
      schema_version: 2,
    })).toEqual({ kind: 'unsupported', type: 'session_share_v2' })
  })

  it('keeps unknown cards available for the client-upgrade fallback', () => {
    const card = { type: 'project_digest_v2', future_field: true }

    expect(parseTabTinCustomCard(card)).toEqual({
      kind: 'unsupported',
      type: 'project_digest_v2',
    })
    expect(isTabTinCustomCardContent(card)).toBe(true)
    expect(canForwardTabTinCustomCard(card)).toBe(true)
  })

  it('only blocks forwarding for conversation-scoped authorization cards', () => {
    expect(canForwardTabTinCustomCard({ type: 'handoff' })).toBe(false)
    expect(canForwardTabTinCustomCard({ type: 'session_share' })).toBe(false)
    expect(canForwardTabTinCustomCard({ type: 'session_share_v2' })).toBe(false)
    expect(canForwardTabTinCustomCard({ type: 'session_continuation' })).toBe(false)
    expect(canForwardTabTinCustomCard({ type: 'document' })).toBe(true)
    expect(canForwardTabTinCustomCard(null)).toBe(true)
  })

  it('marks shared-task messages as system managed', () => {
    expect(isSystemManagedTabTinCard({ type: 'session_share' })).toBe(true)
    expect(isSystemManagedTabTinCard({ type: 'session_share_v2' })).toBe(true)
    expect(isSystemManagedTabTinCard({ type: 'session_continuation' })).toBe(true)
    expect(isSystemManagedTabTinCard({ type: 'document' })).toBe(false)
  })
})
