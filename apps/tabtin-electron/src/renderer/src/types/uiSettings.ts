/**
 * 设置 IA Phase 2 —— 个人偏好跨设备同步的共享契约类型（renderer 侧）。
 *
 * 与后端 2A 单元严格一致：
 *   - GET  /auth/profile/ui-settings → `{ settings: { <namespace>: { value, updatedAt } } }`
 *   - PUT  /auth/profile/ui-settings  body `{ settings: { <namespace>: { value, updatedAt } } }`（增量）
 *   - envelope `{ value, updatedAt(ms) }`；后端 per-namespace last-write-wins；
 *     写后 WS `ui_settings_changed` 回灌。
 *
 * 6 个 namespace 里 5 个由 renderer store 消费（commit 1），`notificationPrefs`
 * 由 Electron 主进程消费（commit 2）。本文件全部走 `import type`，无运行时
 * 依赖（仅 `UI_SETTINGS_NAMESPACES` 是运行时常量），可被 apiService / store /
 * 同步层安全引用而不产生循环。
 */

import type { ThemeMode } from '@tabtin/app-shell'
import type { ColorSchemeId } from '@/constants/color-schemes'
import type { UIFontSize } from '@/stores/useUIStore'
import type { ReplacementRule } from '@/stores/useVoiceSettingsStore'

export const UI_SETTINGS_NAMESPACES = [
  'theme',
  'fontSize',
  'colorScheme',
  'notificationPrefs',
  'voiceHotwords',
  'resourceOpenPrefs',
] as const

export type UISettingsNamespace = (typeof UI_SETTINGS_NAMESPACES)[number]

/** 单个 namespace 的同步信封：值 + 毫秒时间戳（用于 per-namespace LWW 合并）。 */
export interface UISettingEnvelope<T = unknown> {
  value: T
  updatedAt: number
}

/**
 * `voiceHotwords` namespace 的值。语音热词 / 替换规则是用户长期资产，合并时
 * 对列表做并集（见 `useVoiceSettingsStore.syncFromServer`），标量按 updatedAt LWW。
 */
export interface VoiceHotwordsPayload {
  customHotwords: string[]
  replacementRules: ReplacementRule[]
  voiceShortcut: string
  enableAppContext: boolean
  enableDialogContext: boolean
  enabled: boolean
}

/** `resourceOpenPrefs` namespace 的值：pointerKey → carrier appId。 */
export type ResourceOpenPrefsPayload = Record<string, string>

/** 每个 namespace 的值类型表。`notificationPrefs` 由主进程消费，这里留宽类型。 */
export interface UISettingsValueMap {
  theme: ThemeMode
  fontSize: UIFontSize
  colorScheme: ColorSchemeId
  notificationPrefs: Record<string, unknown>
  voiceHotwords: VoiceHotwordsPayload
  resourceOpenPrefs: ResourceOpenPrefsPayload
}

export type UISettingsMap = {
  [K in UISettingsNamespace]?: UISettingEnvelope<UISettingsValueMap[K]>
}

export interface UISettingsResponse {
  settings: UISettingsMap
}

export interface UISettingsUpdateRequest {
  settings: UISettingsMap
}
