/** @store-category prefs */

/**
 * uiSettingsLoginSync —— IA Phase 2 个人偏好同步的登录注入 / WS 回灌编排（renderer）。
 *
 * 单独成文件而非塞进 useAuthStore：避免 useAuthStore ↔ 各 prefs store 的
 * 循环依赖（本文件 import 三个 store，三个 store 不 import 本文件）。供
 * `AppGlobalEffects` 在登录 / 启动恢复 effect 里调用：
 *   - `syncUISettingsFromServer()`：GET 一次，分发到 5 个 renderer store 的
 *     syncFromServer（notificationPrefs 由主进程单独消费，见 commit 2）。
 *   - `applyRemoteUISettingsFromEnvelope()`：WS `ui_settings_changed` 回灌。
 */

import apiService from '@/services/api'
import { createLogger } from '@/utils/logger'
import { extractRemoteSettings } from './uiSettingsSync'
import { useUIStore } from './useUIStore'
import { useVoiceSettingsStore } from './useVoiceSettingsStore'
import { useResourceOpenPreferences } from './useResourceOpenPreferences'
import type { UISettingsMap } from '@/types/uiSettings'

const log = createLogger('UISettingsSync')

/** 把一份归一后的远端设置分发到 5 个 renderer store（各自只取自己的 namespace）。 */
export function applyRemoteUISettings(map: UISettingsMap): void {
  useUIStore.getState().syncFromServer(map) // theme / fontSize / colorScheme
  useVoiceSettingsStore.getState().syncFromServer(map) // voiceHotwords
  useResourceOpenPreferences.getState().syncFromServer(map) // resourceOpenPrefs
}

/** 登录 / 启动恢复后拉取一次服务器偏好并合并（fire-and-forget，不阻塞 authReady）。 */
export async function syncUISettingsFromServer(): Promise<void> {
  if (!apiService.isAuthenticated()) return
  try {
    const resp = await apiService.getUISettings()
    applyRemoteUISettings(extractRemoteSettings(resp))
  } catch (error) {
    log.warn('GET ui-settings 失败（不阻塞登录）：', error)
  }
}

/** WS `ui_settings_changed` 回灌：归一 envelope 后分发到各 store。 */
export function applyRemoteUISettingsFromEnvelope(envelope: unknown): void {
  applyRemoteUISettings(extractRemoteSettings(envelope))
}
