/**
 * Preset 描述符注册表
 *
 * 动态注册模式：Preset 可能来自不同模块包，运行时注入。
 * 与 toolCardRegistry 对称。
 */

import type { ComposerPresetDescriptor, ComposerPresetBlock } from './types'

const COMPOSER_PRESETS: Record<string, ComposerPresetDescriptor> = {}

export function registerComposerPreset(preset: ComposerPresetDescriptor): void {
  if (!preset.fields && !preset.renderer && !preset.promptTemplate) {
    console.warn(`[ComposerPreset] ${preset.id}: must provide fields, renderer, or promptTemplate`)
  }
  COMPOSER_PRESETS[preset.id] = preset
}

export function getComposerPreset(id: string): ComposerPresetDescriptor | null {
  return COMPOSER_PRESETS[id] ?? null
}

export function getPresetsByCategory(category: string): ComposerPresetDescriptor[] {
  return Object.values(COMPOSER_PRESETS).filter(p => p.category === category)
}

export function getAllPresets(): ComposerPresetDescriptor[] {
  return Object.values(COMPOSER_PRESETS)
}

/**
 * 默认的 serializeForSend 实现：
 * 将 state 中有值的字段直接作为 params，upload 类型字段替换为上传后的 URL。
 */
export function defaultSerializeForSend(
  presetId: string,
  state: Record<string, unknown>,
  uploadedSlots: Record<string, Array<{ url: string; fileId: string }>>,
  triggerContext?: Record<string, unknown>,
): ComposerPresetBlock {
  const params: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(state)) {
    if (value === undefined || value === null || value === '') continue
    const slotItems = uploadedSlots[key]
    if (slotItems && slotItems.length > 0) {
      if (slotItems.length === 1) {
        params[key] = slotItems[0].url
        params[`${key}_file_id`] = slotItems[0].fileId
      } else {
        params[key] = slotItems.map(s => s.url)
        params[`${key}_file_ids`] = slotItems.map(s => s.fileId)
      }
    } else {
      params[key] = value
    }
  }

  return {
    type: 'composer_preset',
    preset_id: presetId,
    params,
    ...(triggerContext && Object.keys(triggerContext).length > 0
      ? { trigger_context: triggerContext }
      : {}),
  }
}

/** @internal 仅测试用：清空注册表 */
export function __resetPresetsForTesting(): void {
  for (const key of Object.keys(COMPOSER_PRESETS)) {
    delete COMPOSER_PRESETS[key]
  }
}
