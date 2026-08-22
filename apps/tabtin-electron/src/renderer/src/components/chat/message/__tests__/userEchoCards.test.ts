import { describe, expect, it } from 'vitest'
import type { MessageBlock } from '@tabtin/chat-client'
import {
  ASK_USER_REPLY_PRESET_BLOCK_ID,
  deriveUserEchoCards,
  isAskUserComposerBlock,
} from '@stores/chat/presentation/messageBubble/userEchoCards'

describe('userEchoCards', () => {
  it('识别 ask_user composer preset', () => {
    expect(isAskUserComposerBlock({
      type: 'composer_preset',
      preset_id: ASK_USER_REPLY_PRESET_BLOCK_ID,
    })).toBe(true)
    expect(isAskUserComposerBlock({
      type: 'composer_preset',
      preset_id: 'other',
      source: 'ask_user',
    })).toBe(true)
  })

  it('从 composer_preset / pending / ask_user_fields 派生 echo cards', () => {
    const blocks = [
      {
        type: 'composer_preset',
        preset_id: 'weather',
        params: { city: 'Shanghai' },
      },
      {
        type: '_composer_preset_pending',
        preset_id: 'draft',
        state: { step: 1 },
      },
      {
        type: 'ask_user_fields',
        field_values: { name: 'Alice' },
      },
    ] as MessageBlock[]

    const cards = deriveUserEchoCards(blocks, {})
    expect(cards).toHaveLength(3)
    expect(cards[0]).toMatchObject({ presetId: 'weather', source: 'preset' })
    expect(cards[1]).toMatchObject({ presetId: 'draft', source: 'preset' })
    expect(cards[2]).toMatchObject({
      presetId: ASK_USER_REPLY_PRESET_BLOCK_ID,
      source: 'ask_user',
      params: { name: 'Alice' },
    })
  })

  it('metadata.ask_user_field_values 在无 ask_user block 时兜底', () => {
    const cards = deriveUserEchoCards([], {
      ask_user_field_values: { choice: 'yes' },
    })
    expect(cards).toHaveLength(1)
    expect(cards[0]?.source).toBe('ask_user')
    expect(cards[0]?.params).toEqual({ choice: 'yes' })
  })
})
