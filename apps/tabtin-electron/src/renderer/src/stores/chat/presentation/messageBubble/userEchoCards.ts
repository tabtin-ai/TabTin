import type { MessageBlock } from '@tabtin/chat-client'
import { COMPOSER_PRESET_PENDING_TYPE } from '@utils/chat/composerPresetBlocks'

/** 与后端 agent_api.ASK_USER_REPLY_PRESET_BLOCK_ID 一致 */
export const ASK_USER_REPLY_PRESET_BLOCK_ID = '__ask_user_reply__'

export type UserEchoCard = {
  key: string
  presetId: string
  params: Record<string, unknown>
  source: 'preset' | 'ask_user'
}

export function isAskUserComposerBlock(block: Record<string, unknown>): boolean {
  if (block.type !== 'composer_preset') return false
  return (
    block.preset_id === ASK_USER_REPLY_PRESET_BLOCK_ID
    || block.source === 'ask_user'
    || block.ask_user_reply === true
  )
}

export function deriveUserEchoCards(
  messageBlocks: MessageBlock[],
  metadata: Record<string, unknown> | null | undefined,
): UserEchoCard[] {
  const out: UserEchoCard[] = []
  messageBlocks.forEach((b, i) => {
    const br = b as Record<string, unknown>
    if (b.type === 'composer_preset') {
      out.push({
        key: `cp-${i}-${String(br.preset_id ?? '')}`,
        presetId: String(br.preset_id ?? ''),
        params: (br.params ?? {}) as Record<string, unknown>,
        source: isAskUserComposerBlock(br) ? 'ask_user' : 'preset',
      })
    } else if (br.type === COMPOSER_PRESET_PENDING_TYPE) {
      out.push({
        key: `cpp-${i}-${String(br.preset_id ?? '')}`,
        presetId: String(br.preset_id ?? ''),
        params: (br.state ?? {}) as Record<string, unknown>,
        source: 'preset',
      })
    } else if (
      b.type === 'ask_user_fields'
      && br.field_values
      && typeof br.field_values === 'object'
      && !Array.isArray(br.field_values)
    ) {
      out.push({
        key: `auf-${i}`,
        presetId: ASK_USER_REPLY_PRESET_BLOCK_ID,
        params: br.field_values as Record<string, unknown>,
        source: 'ask_user',
      })
    }
  })

  const metaFv = metadata?.ask_user_field_values
  if (
    metaFv
    && typeof metaFv === 'object'
    && !Array.isArray(metaFv)
    && !out.some(c => c.source === 'ask_user')
  ) {
    out.push({
      key: 'meta-ask-user-fv',
      presetId: ASK_USER_REPLY_PRESET_BLOCK_ID,
      params: metaFv as Record<string, unknown>,
      source: 'ask_user',
    })
  }

  return out
}
