/**
 * Composer Presets 模块接入 SDK
 *
 * 各内嵌 App 包（tabvideo/tabslide 等）通过此 helper 触发 Composer Preset，
 * 无需关心 Window API 的挂载细节和路径差异。
 *
 * @example
 * import { activatePreset } from '@tabtin/shared/composer-presets'
 *
 * // 素材面板「AI 生成」按钮
 * activatePreset('tabvideo.generateClip')
 *
 * // 时间线右键「在此生成片段」
 * activatePreset('tabvideo.generateClip', { insert_at: currentTime })
 */

interface ComposerPresetsAPI {
  activate?: (opts: { presetId: string; triggerContext?: Record<string, unknown> }) => void
  get?: (presetId: string) => unknown
  list?: (category?: string) => unknown[]
}

function getAPI(): ComposerPresetsAPI | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as Record<string, unknown>).tabtinComposerPresets as ComposerPresetsAPI | null
}

/**
 * 触发一个 Composer Preset — 在聊天输入框中打开对应的结构化表单卡片。
 *
 * @param presetId - Preset 标识（如 'tabvideo.generateClip'）
 * @param triggerContext - 触发上下文（如 { insert_at: 12.5 }），不含 app_id 等 Agent 已知信息
 */
export function activatePreset(presetId: string, triggerContext?: Record<string, unknown>): void {
  const api = getAPI()
  if (!api?.activate) {
    console.warn(`[ComposerPreset] API not available, preset "${presetId}" not activated`)
    return
  }
  api.activate({ presetId, triggerContext })
}

/**
 * 查询某个 Preset 是否已注册。
 */
export function isPresetAvailable(presetId: string): boolean {
  return getAPI()?.get?.(presetId) != null
}

/**
 * 获取指定分类下的已注册 Preset 数量。
 */
export function getPresetCount(category?: string): number {
  return getAPI()?.list?.(category)?.length ?? 0
}
