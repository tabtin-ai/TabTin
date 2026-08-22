/**
 * Organization 下当前设备的模型默认偏好。
 *
 * ChatGPT/Codex 登录凭据与 Provider 都只存在 Electron 本机，不能伪装成
 * Django 的 Organization 模型 UUID。这里缓存主进程持久化结果，让设置页与
 * 新任务创建链路共享同一份设备级意图。
 */

import { isOpenAICodexModel } from '../../../../../shared/openai-codex-models'

export interface OrganizationDeviceModelPreferences {
  mainModelId?: string
  subagentModelId?: string
}

const cache = new Map<string, OrganizationDeviceModelPreferences>()

function normalize(
  preferences: OrganizationDeviceModelPreferences | null | undefined,
): OrganizationDeviceModelPreferences {
  const mainModelId = preferences?.mainModelId?.trim()
  const subagentModelId = preferences?.subagentModelId?.trim()
  return {
    ...(mainModelId && isOpenAICodexModel(mainModelId) ? { mainModelId } : {}),
    ...(subagentModelId && isOpenAICodexModel(subagentModelId) ? { subagentModelId } : {}),
  }
}

export function readCachedOrganizationDeviceModelPreferences(
  organizationId: string | null | undefined,
): OrganizationDeviceModelPreferences {
  const id = organizationId?.trim()
  return id ? cache.get(id) ?? {} : {}
}

export async function loadOrganizationDeviceModelPreferences(
  organizationId: string,
): Promise<OrganizationDeviceModelPreferences> {
  const id = organizationId.trim()
  if (!id) return {}
  const bridge = window.tabtin?.agentEngine?.getDeviceModelPreferences
  if (typeof bridge !== 'function') return readCachedOrganizationDeviceModelPreferences(id)
  const result = await bridge(id)
  const preferences = normalize(result.preferences)
  cache.set(id, preferences)
  return preferences
}

export async function saveOrganizationDeviceModelPreferences(
  organizationId: string,
  preferences: OrganizationDeviceModelPreferences,
): Promise<OrganizationDeviceModelPreferences> {
  const id = organizationId.trim()
  if (!id) throw new Error('organizationId is required')
  const bridge = window.tabtin?.agentEngine?.setDeviceModelPreferences
  if (typeof bridge !== 'function') throw new Error('Device model preferences are unavailable')
  const result = await bridge(id, normalize(preferences))
  const saved = normalize(result.preferences)
  cache.set(id, saved)
  return saved
}

/** @internal 测试与登出重置使用。 */
export function resetOrganizationDeviceModelPreferenceCache(): void {
  cache.clear()
}

import { registerResetAction } from '@/stores/sessionResetRegistry'
registerResetAction(
  'organization-device-model-preference',
  'reset',
  resetOrganizationDeviceModelPreferenceCache,
)
