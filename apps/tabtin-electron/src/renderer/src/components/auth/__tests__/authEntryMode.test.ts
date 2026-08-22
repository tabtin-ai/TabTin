import { beforeEach, describe, expect, it } from 'vitest'
import { DEVICE_LOCAL_KEYS } from '@/stores/persist-key-registry'
import { resolveInitialAuthEntryMode } from '../authEntryMode'

describe('认证入口初始页面', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('新安装首次进入时展示注册页并记录设备已见', () => {
    expect(resolveInitialAuthEntryMode(localStorage)).toBe('register')
    expect(localStorage.getItem(DEVICE_LOCAL_KEYS.authEntrySeen)).toBe('1')
  })

  it('设备已经见过认证入口时展示登录页', () => {
    localStorage.setItem(DEVICE_LOCAL_KEYS.authEntrySeen, '1')

    expect(resolveInitialAuthEntryMode(localStorage)).toBe('login')
  })

  it('服务端渲染等无 localStorage 环境安全回退到登录页', () => {
    expect(resolveInitialAuthEntryMode(undefined)).toBe('login')
  })
})
