import { describe, expect, it } from 'vitest'
import { resolveSessionAccessComposerDisabledReason } from '../useSessionAccessComposer'

describe('resolveSessionAccessComposerDisabledReason', () => {
  it('共享任务授权尚未就绪时显示共享任务初始化文案', () => {
    expect(resolveSessionAccessComposerDisabledReason({
      activeGrant: false,
      canSendSharedChat: false,
      offline: false,
    })).toBe('shared_initializing')
  })

  it('只读共享任务显示只读原因，而不是初始化文案', () => {
    expect(resolveSessionAccessComposerDisabledReason({
      activeGrant: true,
      canSendSharedChat: false,
      offline: false,
    })).toBe('shared_read_only')
  })

  it('协作权限可发送时不禁用输入框', () => {
    expect(resolveSessionAccessComposerDisabledReason({
      activeGrant: true,
      canSendSharedChat: true,
      offline: false,
    })).toBeUndefined()
  })

  it('执行设备离线优先显示离线原因', () => {
    expect(resolveSessionAccessComposerDisabledReason({
      activeGrant: true,
      canSendSharedChat: true,
      offline: true,
    })).toBe('remote_device_offline')
  })
})
