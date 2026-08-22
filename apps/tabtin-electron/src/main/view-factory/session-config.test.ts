import { describe, expect, it, vi } from 'vitest'
import { SessionConfigFactory } from '../config/SessionConfigFactory'
import { buildSessionConfigForView } from './session-config'

describe('buildSessionConfigForView', () => {
  it('保留 temp- 显式 partition 的非持久语义，供一次性登录接力清理', () => {
    const result = buildSessionConfigForView({
      id: 'login-relay-1',
      profile: 'agent-workspace',
      partition: 'temp-login-relay-1',
      sessionMode: 'inherit',
    } as never, SessionConfigFactory, vi.fn())

    expect(result).toMatchObject({ partition: 'temp-login-relay-1' })
  })

  it('接受已带 persist: 的 Electron session 名称，不重复添加前缀', () => {
    const result = buildSessionConfigForView({
      id: 'organization-browser',
      profile: 'agent-workspace',
      partition: 'persist:tabtin:organization:org-1:browser',
      sessionMode: 'inherit',
    } as never, SessionConfigFactory, vi.fn())

    expect(result).toMatchObject({ partition: 'persist:tabtin:organization:org-1:browser' })
  })
})
