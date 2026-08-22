import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadOrganizationDeviceModelPreferences,
  readCachedOrganizationDeviceModelPreferences,
  resetOrganizationDeviceModelPreferenceCache,
  saveOrganizationDeviceModelPreferences,
} from '../organizationDeviceModelPreference'

describe('organizationDeviceModelPreference', () => {
  const getDeviceModelPreferences = vi.fn()
  const setDeviceModelPreferences = vi.fn()

  beforeEach(() => {
    resetOrganizationDeviceModelPreferenceCache()
    getDeviceModelPreferences.mockReset()
    setDeviceModelPreferences.mockReset()
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        agentEngine: {
          getDeviceModelPreferences,
          setDeviceModelPreferences,
        },
      },
    })
  })

  it('按 Organization 加载并缓存本机 ChatGPT 默认', async () => {
    getDeviceModelPreferences.mockResolvedValue({
      preferences: {
        mainModelId: 'gpt-5.6-sol',
        subagentModelId: 'gpt-5.6-terra',
      },
    })

    await expect(loadOrganizationDeviceModelPreferences('org-1')).resolves.toEqual({
      mainModelId: 'gpt-5.6-sol',
      subagentModelId: 'gpt-5.6-terra',
    })
    expect(readCachedOrganizationDeviceModelPreferences('org-1')).toEqual({
      mainModelId: 'gpt-5.6-sol',
      subagentModelId: 'gpt-5.6-terra',
    })
    expect(readCachedOrganizationDeviceModelPreferences('org-2')).toEqual({})
  })

  it('拒绝把平台 UUID 或未知字符串写进本机偏好', async () => {
    setDeviceModelPreferences.mockImplementation(async (_organizationId, preferences) => ({
      preferences,
    }))

    await expect(saveOrganizationDeviceModelPreferences('org-1', {
      mainModelId: '42ae58c8-feea-4098-b80b-9a0aedc35007',
      subagentModelId: 'unknown-model',
    })).resolves.toEqual({})
    expect(setDeviceModelPreferences).toHaveBeenCalledWith('org-1', {})
  })
})
