import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import {
  clearAllSessionLocalModelPreferences,
  clearSessionLocalModelPreference,
  readSessionLocalModelPreference,
  restoreSessionLocalModelPreference,
  writeSessionLocalModelPreference,
} from '../sessionLocalModelPreference'

describe('sessionLocalModelPreference', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('应用重启后的 server list 可恢复本机 ChatGPT 模型', () => {
    writeSessionLocalModelPreference('session-1', 'gpt-5.6-sol')
    const server = {
      id: 'session-1',
      current_model_id: 'platform-model',
      context_tier_id: 'long',
    } as ChatSession

    expect(restoreSessionLocalModelPreference(server)).toMatchObject({
      current_model_id: 'gpt-5.6-sol',
      context_tier_id: null,
    })
  })

  it('不持久化非本机模型，切回平台后可清理', () => {
    writeSessionLocalModelPreference('session-1', 'platform-model')
    expect(readSessionLocalModelPreference('session-1')).toBeNull()

    writeSessionLocalModelPreference('session-1', 'gpt-5.6-terra')
    clearSessionLocalModelPreference('session-1')
    expect(readSessionLocalModelPreference('session-1')).toBeNull()
  })

  it('最多保留最近 500 个会话，避免本地偏好无界增长', () => {
    let now = 1
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    for (let i = 0; i < 505; i += 1) {
      writeSessionLocalModelPreference(`session-${i}`, 'gpt-5.6-sol')
    }

    expect(readSessionLocalModelPreference('session-0')).toBeNull()
    expect(readSessionLocalModelPreference('session-504')).toBe('gpt-5.6-sol')
  })

  it('ChatGPT 断开后一次清理所有会话的本机模型选择', () => {
    writeSessionLocalModelPreference('session-1', 'gpt-5.6-sol')
    writeSessionLocalModelPreference('session-2', 'gpt-5.6-terra')

    clearAllSessionLocalModelPreferences()

    expect(readSessionLocalModelPreference('session-1')).toBeNull()
    expect(readSessionLocalModelPreference('session-2')).toBeNull()
  })
})
