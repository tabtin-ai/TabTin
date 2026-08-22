import { describe, expect, it } from 'vitest'

import type { IMMessage } from './contracts'
import {
  decodeTabTinMessageReference,
  encodeTabTinMessageReference,
  hydrateTabTinReferenceMessages,
  getTabTinMessageReference,
  isTabTinMessageId,
  mergeHydratedTabTinMessage,
} from './tabtinReferenceMessages'

const MESSAGE_REF = '018f4b30-a7ad-7b32-b946-827ea2a26983'
const TABTIN_MESSAGE_ID = '9223372036854775807'
const PROJECTION_REVISION = '019f4b30-a7ad-7b32-b946-827ea2a26984'

function message(overrides: Partial<IMMessage> = {}): IMMessage {
  return {
    id: 0,
    conversation_id: 'conversation-a',
    sender_id: 'agent-a',
    sender_type: 'agent',
    content: '',
    message_type: 1,
    reply_to_id: null,
    has_attachment: false,
    metadata: {},
    created_at: '2026-07-31T00:00:00.000Z',
    ...overrides,
  }
}

describe('TabTin message references', () => {
  it('keeps the PostgreSQL identity as a decimal string', () => {
    const encoded = encodeTabTinMessageReference({
      messageRef: MESSAGE_REF,
      tabtinMessageId: TABTIN_MESSAGE_ID,
    })

    expect(JSON.parse(encoded)).toEqual({
      schema: 'tabtin.im.ref.v1',
      message_ref: MESSAGE_REF,
      tabtin_message_id: TABTIN_MESSAGE_ID,
    })
    expect(decodeTabTinMessageReference(encoded)).toEqual({
      status: 'valid',
      reference: {
        messageRef: MESSAGE_REF,
        tabtinMessageId: TABTIN_MESSAGE_ID,
      },
    })
    expect(isTabTinMessageId(TABTIN_MESSAGE_ID)).toBe(true)
    expect(isTabTinMessageId(Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  it('rejects numeric IDs and extra pointer fields', () => {
    expect(decodeTabTinMessageReference(JSON.stringify({
      schema: 'tabtin.im.ref.v1',
      message_ref: MESSAGE_REF,
      tabtin_message_id: 42,
    }))).toEqual({ status: 'invalid' })
    expect(decodeTabTinMessageReference(JSON.stringify({
      schema: 'tabtin.im.ref.v1',
      message_ref: MESSAGE_REF,
      tabtin_message_id: '42',
      content: 'must not cross Tencent',
    }))).toEqual({ status: 'invalid' })
    expect(getTabTinMessageReference({
      kind: 'tabtin_ref',
      message_ref: MESSAGE_REF,
      tabtin_message_id: TABTIN_MESSAGE_ID,
      business_projection_revision: 'not-a-uuid',
    })).toBeNull()
  })

  it('round-trips an optional business projection revision', () => {
    const encoded = encodeTabTinMessageReference({
      messageRef: MESSAGE_REF,
      tabtinMessageId: TABTIN_MESSAGE_ID,
      businessProjectionRevision: PROJECTION_REVISION,
    })

    expect(decodeTabTinMessageReference(encoded)).toEqual({
      status: 'valid',
      reference: {
        messageRef: MESSAGE_REF,
        tabtinMessageId: TABTIN_MESSAGE_ID,
        businessProjectionRevision: PROJECTION_REVISION,
      },
    })
    expect(decodeTabTinMessageReference(JSON.stringify({
      schema: 'tabtin.im.ref.v1',
      message_ref: MESSAGE_REF,
      tabtin_message_id: TABTIN_MESSAGE_ID,
      business_projection_revision: 'not-a-uuid',
    }))).toEqual({ status: 'invalid' })
  })

  it('hydrates content while retaining the Tencent ordering identity', () => {
    const pointer = message({
      id: 700,
      seq: 700,
      metadata: {
        kind: 'tabtin_ref',
        message_ref: MESSAGE_REF,
        tabtin_message_id: TABTIN_MESSAGE_ID,
      },
    })
    const hydrated = message({
      content: 'resolved Agent response',
      metadata: {
        message_ref: MESSAGE_REF,
        tabtin_message_id: TABTIN_MESSAGE_ID,
      },
    })

    expect(mergeHydratedTabTinMessage(pointer, hydrated)).toEqual(
      expect.objectContaining({
        id: 700,
        seq: 700,
        content: 'resolved Agent response',
        metadata: expect.objectContaining({
          kind: 'tabtin_ref',
          tabtin_message_id: TABTIN_MESSAGE_ID,
        }),
      }),
    )
    expect(hydrateTabTinReferenceMessages([pointer], [hydrated])[0]?.id).toBe(700)
  })

  it('does not coerce a numeric message id into a TabTin reference', () => {
    const pointer = message({
      id: 700,
      seq: 700,
      metadata: {
        kind: 'tabtin_ref',
        message_ref: MESSAGE_REF,
        tabtin_message_id: TABTIN_MESSAGE_ID,
      },
    })
    const hydratedWithoutStringId = message({
      id: Number.MAX_SAFE_INTEGER,
      content: 'must not hydrate',
      metadata: { message_ref: MESSAGE_REF },
    })

    expect(hydrateTabTinReferenceMessages(
      [pointer],
      [hydratedWithoutStringId],
    )).toEqual([pointer])
  })
})
