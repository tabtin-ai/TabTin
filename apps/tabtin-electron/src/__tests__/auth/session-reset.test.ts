/**
 * sessionReset 模块测试
 *
 * Round 2 之后，sessionReset 不再直接导入各 store，
 * 而是通过 sessionResetRegistry 统一调度各模块自注册的 reset action。
 * 本测试验证 registry 驱动的重置流程。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PERSIST_KEYS } from '@/stores/persist-key-registry'

let registerResetAction: typeof import('@/stores/sessionResetRegistry').registerResetAction
let resetSessionState: typeof import('@/stores/sessionReset').resetSessionState

beforeEach(async () => {
  vi.resetModules()
  const registry = await import('@/stores/sessionResetRegistry')
  registerResetAction = registry.registerResetAction
  const sessionReset = await import('@/stores/sessionReset')
  resetSessionState = sessionReset.resetSessionState
})

describe('resetSessionState', () => {
  it('应按 phase 顺序执行所有已注册的 reset action', async () => {
    const order: string[] = []
    registerResetAction('ws-conn', 'teardown', () => { order.push('teardown:ws') })
    registerResetAction('organization', 'reset', () => { order.push('reset:organization') })
    registerResetAction('chat', 'reset', () => { order.push('reset:chat') })
    registerResetAction('cache', 'cleanup', () => { order.push('cleanup:cache') })

    await resetSessionState('logout')

    expect(order).toEqual([
      'teardown:ws',
      'reset:organization',
      'reset:chat',
      'cleanup:cache',
    ])
  })

  it('单个 action 失败不影响其他 action 执行', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const order: string[] = []

    registerResetAction('ok-before', 'reset', () => { order.push('ok-before') })
    registerResetAction('broken', 'reset', () => { throw new Error('boom') })
    registerResetAction('ok-after', 'reset', () => { order.push('ok-after') })

    await expect(resetSessionState('manual')).resolves.toBeUndefined()
    expect(order).toEqual(['ok-before', 'ok-after'])
    consoleSpy.mockRestore()
  })

  it('logout 时清理 localStorage（保留白名单 key；ui/voice 改"跟人走"清除）', async () => {
    const { useOrganizationStore } = await import('@tabtin/app-shell')
    useOrganizationStore.setState({
      organizations: [{ id: 'team-last-opened', name: 'Last Opened', type: 'team' }],
      selectedOrganization: { id: 'team-last-opened', name: 'Last Opened', type: 'team' },
      lastOpenedOrganizationId: 'team-last-opened',
      currentUserRole: 'owner',
      members: [{ id: 'member-1', organization_id: 'team-last-opened', user_id: 'user-1', role: 'owner' }],
    })
    localStorage.setItem(PERSIST_KEYS.i18n, 'keep')
    localStorage.setItem(PERSIST_KEYS.browser, 'keep')
    // IA Phase 2：ui / voice 接后端同步后改"跟人走"——登出清本地、换人登录由
    // syncFromServer 重新拉取，避免共享设备上串账号。uiSettingsSync（updatedAt
    // 注册表）同样清除，防止旧账号时间戳压制新账号服务器值。
    localStorage.setItem(PERSIST_KEYS.ui, 'remove')
    localStorage.setItem(PERSIST_KEYS.voice, 'remove')
    localStorage.setItem(PERSIST_KEYS.uiSettingsSync, 'remove')
    localStorage.setItem('some-session-data', 'remove')
    localStorage.setItem('cached-table', 'remove')

    await resetSessionState('logout')

    const organizationPersisted = JSON.parse(localStorage.getItem(PERSIST_KEYS.organization) ?? '{}')
    expect(organizationPersisted.state).toMatchObject({
      organizations: [],
      selectedOrganization: null,
      lastOpenedOrganizationId: 'team-last-opened',
      currentUserRole: null,
    })
    expect(localStorage.getItem(PERSIST_KEYS.i18n)).toBe('keep')
    expect(localStorage.getItem(PERSIST_KEYS.browser)).toBe('keep')
    expect(localStorage.getItem(PERSIST_KEYS.ui)).toBeNull()
    expect(localStorage.getItem(PERSIST_KEYS.voice)).toBeNull()
    expect(localStorage.getItem(PERSIST_KEYS.uiSettingsSync)).toBeNull()
    expect(localStorage.getItem('some-session-data')).toBeNull()
    expect(localStorage.getItem('cached-table')).toBeNull()
  })

  it('logout 保留 organization key 前会清洗旧团队详情快照', async () => {
    localStorage.setItem(PERSIST_KEYS.organization, JSON.stringify({
      state: {
        organizations: [{ id: 'team-stale', name: 'Stale Team', type: 'team' }],
        selectedOrganization: { id: 'team-stale', name: 'Stale Team', type: 'team' },
        currentUserRole: 'owner',
      },
      version: 2,
    }))

    await resetSessionState('logout')

    const organizationPersisted = JSON.parse(localStorage.getItem(PERSIST_KEYS.organization) ?? '{}')
    expect(organizationPersisted.state).toEqual({
      organizations: [],
      selectedOrganization: null,
      lastOpenedOrganizationId: 'team-stale',
      currentUserRole: null,
    })
  })

  it('manual reset 不清理 localStorage', async () => {
    localStorage.setItem('some-data', 'value')

    await resetSessionState('manual')

    expect(localStorage.getItem('some-data')).toBe('value')
  })
})
