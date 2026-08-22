import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sessionResetRegistry', () => ({
  runAllResetActions: vi.fn().mockResolvedValue(undefined),
}))

import { resetSessionState } from '../sessionReset'
import { DEVICE_LOCAL_KEYS, PERSIST_KEYS } from '../persist-key-registry'
import { resolveInitialAuthEntryMode } from '../../components/auth/authEntryMode'

describe('resetSessionState logout 持久化清理', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('保留认证入口已见状态，同时继续清除账号态数据', async () => {
    localStorage.setItem(DEVICE_LOCAL_KEYS.authEntrySeen, '1')
    localStorage.setItem(DEVICE_LOCAL_KEYS.deviceId, 'device-1')
    localStorage.setItem(PERSIST_KEYS.auth, '{"state":{"user":{"id":"user-1"}}}')
    localStorage.setItem(PERSIST_KEYS.chat, '{"state":{"sessions":["session-1"]}}')
    localStorage.setItem(PERSIST_KEYS.sessionReadAccounts, '{"version":1,"accounts":{"user-1":{}}}')

    await resetSessionState('logout')

    expect(localStorage.getItem(DEVICE_LOCAL_KEYS.authEntrySeen)).toBe('1')
    expect(localStorage.getItem(DEVICE_LOCAL_KEYS.deviceId)).toBe('device-1')
    expect(localStorage.getItem(PERSIST_KEYS.auth)).toBeNull()
    expect(localStorage.getItem(PERSIST_KEYS.chat)).toBeNull()
    expect(localStorage.getItem(PERSIST_KEYS.sessionReadAccounts)).not.toBeNull()
    expect(resolveInitialAuthEntryMode(localStorage)).toBe('login')
  })
})
