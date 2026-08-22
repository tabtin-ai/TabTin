import { describe, expect, it } from 'vitest'
import { PtyEventRouter } from '../PtyEventRouter'

describe('PtyEventRouter', () => {
  it('只向订阅指定 session 的订阅者路由事件', () => {
    const router = new PtyEventRouter()

    router.subscribe('data', 11, 'session-a')
    router.subscribe('data', 22, 'session-b')

    expect(router.getSubscriberIds('data', 'session-a')).toEqual([11])
    expect(router.getSubscriberIds('data', 'session-b')).toEqual([22])
  })

  it('合并全局订阅与 session 订阅，且去重', () => {
    const router = new PtyEventRouter()

    router.subscribe('data', 11)
    router.subscribe('data', 11, 'session-a')
    router.subscribe('data', 22, 'session-a')

    expect(router.getSubscriberIds('data', 'session-a').sort((a, b) => a - b)).toEqual([11, 22])
    expect(router.getSubscriberIds('data', 'session-b')).toEqual([11])
  })

  it('支持取消订阅和销毁 webContents 后清理所有事件绑定', () => {
    const router = new PtyEventRouter()

    router.subscribe('data', 11, 'session-a')
    router.subscribe('exit', 11, 'session-a')
    router.subscribe('data', 22)

    router.unsubscribe('data', 11, 'session-a')
    expect(router.getSubscriberIds('data', 'session-a')).toEqual([22])

    router.removeWebContents(22)
    expect(router.getSubscriberIds('data', 'session-a')).toEqual([])
    expect(router.getSubscriberIds('exit', 'session-a')).toEqual([11])

    router.removeWebContents(11)
    expect(router.getSubscriberIds('exit', 'session-a')).toEqual([])
  })

  it('支持按 spaceId 路由 agent session 事件，并兼容全局订阅', () => {
    // WP2 P1-H：'agent-session-title' 已退役（agent-bridge.ts L168-174 硬契约）。
    // 这里改用 agent-session-closed 验同款 spaceId 路由行为。
    const router = new PtyEventRouter()

    router.subscribe('agent-session-created', 31, 'space-a')
    router.subscribe('agent-session-created', 41)
    router.subscribe('agent-session-closed', 51, 'space-b')

    expect(router.getSubscriberIds('agent-session-created', 'space-a').sort((a, b) => a - b)).toEqual([31, 41])
    expect(router.getSubscriberIds('agent-session-created', 'space-b')).toEqual([41])
    expect(router.getSubscriberIds('agent-session-closed', 'space-b')).toEqual([51])
    expect(router.getSubscriberIds('agent-session-closed', 'space-a')).toEqual([])
  })

  it('支持按 spaceId 路由 auto-respond 事件，并在无 spaceId 时只保留全局订阅', () => {
    const router = new PtyEventRouter()

    router.subscribe('auto-respond-triggered', 61, 'space-a')
    router.subscribe('auto-respond-triggered', 71)

    expect(router.getSubscriberIds('auto-respond-triggered', 'space-a').sort((a, b) => a - b)).toEqual([61, 71])
    expect(router.getSubscriberIds('auto-respond-triggered', '')).toEqual([71])
  })
})
