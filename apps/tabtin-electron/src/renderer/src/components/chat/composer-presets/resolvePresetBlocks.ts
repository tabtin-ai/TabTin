/**
 * resolvePresetBlocks — 将 _composer_preset_pending blocks 解析为 final composer_preset blocks
 *
 * 从 sendMessageAction 中提取的纯函数，便于独立测试。
 */

import type { ChatAttachment } from '../types'
import { getComposerPreset, defaultSerializeForSend } from './registry/composerPresetRegistry'
import { COMPOSER_PRESET_PENDING_TYPE } from './registry/types'

export async function resolvePresetBlocks(
  contextBlocks: Array<Record<string, unknown>>,
  uploadedAttachments: ChatAttachment[],
): Promise<Array<Record<string, unknown>>> {
  const resolved: Array<Record<string, unknown>> = []

  for (const block of contextBlocks) {
    if (block.type !== COMPOSER_PRESET_PENDING_TYPE) {
      resolved.push(block)
      continue
    }

    const instanceId = block.instance_id as string
    const presetId = block.preset_id as string
    const state = (block.state ?? {}) as Record<string, unknown>
    const triggerContext = block.trigger_context as Record<string, unknown> | undefined
    const slotKeys = (block.slot_keys ?? []) as string[]

    const uploadedSlots: Record<string, Array<{ url: string; fileId: string }>> = {}
    for (const slotKey of slotKeys) {
      const matched = uploadedAttachments.filter(
        a => a.presetSlotKey === slotKey && a.presetInstanceId === instanceId,
      )
      const items = matched
        .filter(a => a.remoteUrl && a.fileId)
        .map(a => ({ url: a.remoteUrl!, fileId: a.fileId! }))
      if (items.length > 0) {
        uploadedSlots[slotKey] = items
      }
    }

    const descriptor = getComposerPreset(presetId)
    const serialize =
      descriptor?.serializeForSend ??
      ((s: Record<string, unknown>, slots: Record<string, Array<{ url: string; fileId: string }>>, ctx?: Record<string, unknown>) =>
        defaultSerializeForSend(presetId, s, slots, ctx))

    const finalBlock = serialize(state, uploadedSlots, triggerContext)
    resolved.push(finalBlock as unknown as Record<string, unknown>)
  }

  return resolved
}
