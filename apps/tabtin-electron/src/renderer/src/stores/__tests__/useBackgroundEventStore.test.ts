import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  useBackgroundEventStore,
  routeEnvelopeToBackgroundBucket,
  onForegroundOrganizationChanged,
  registerBackgroundOrganizationIdResolver,
  resolveEnvelopeOrganizationId,
  __resetBackgroundEventListenersForTest,
  type BackgroundEnvelope,
} from '../useBackgroundEventStore'

/**
 * 默认使用 `agent.stream.approval_requested` —— Wave 3 修复后只有"低频高价值"事件
 * 会入桶（agent.stream.assistant 之类流式 delta 故意不缓存，让出配额）。
 */
function buildEnvelope(overrides: Partial<BackgroundEnvelope>): BackgroundEnvelope {
  return {
    type: 'agent.stream.approval_requested',
    payload: { content: 'hello' },
    organization_id: 'ws-A',
    event_id: 'evt-1',
    ...overrides,
  }
}

beforeEach(() => {
  useBackgroundEventStore.getState().clearAll()
  __resetBackgroundEventListenersForTest()
  registerBackgroundOrganizationIdResolver(null)
})

describe('useBackgroundEventStore', () => {
  it('enqueue 将事件按 organization 分桶', () => {
    const store = useBackgroundEventStore.getState()
    store.enqueue('ws-A', buildEnvelope({ event_id: 'a1' }))
    store.enqueue('ws-B', buildEnvelope({ organization_id: 'ws-B', event_id: 'b1' }))
    store.enqueue('ws-A', buildEnvelope({ event_id: 'a2' }))

    expect(store.count('ws-A')).toBe(2)
    expect(store.count('ws-B')).toBe(1)
    expect(store.peek('ws-A').map((e) => e.event_id)).toEqual(['a1', 'a2'])
  })

  it('enqueue 过滤非白名单事件类型', () => {
    const store = useBackgroundEventStore.getState()
    store.enqueue('ws-A', buildEnvelope({ type: 'heartbeat.ping' }))
    store.enqueue('ws-A', buildEnvelope({ type: 'resume.cursor.update' }))
    expect(store.count('ws-A')).toBe(0)
  })

  it('agent.stream 流式 delta 故意不入桶（让出配额给关键事件）', () => {
    const store = useBackgroundEventStore.getState()
    // W4.5 第三波 C1（2026-05-13）：原 case 用 ASSISTANT/REASONING/TOOL/CHUNK
    // 老协议字面量构造测试，常量已物理删；改用 ContentBlock 6 件套字面量做
    // "高频 stream delta 不入桶"反向断言，断言意图等价。
    store.enqueue('ws-A', buildEnvelope({ type: 'agent.stream.message_start' }))
    store.enqueue('ws-A', buildEnvelope({ type: 'agent.stream.message_delta' }))
    store.enqueue('ws-A', buildEnvelope({ type: 'agent.stream.content_block_start' }))
    store.enqueue('ws-A', buildEnvelope({ type: 'agent.stream.content_block_delta' }))
    store.enqueue('ws-A', buildEnvelope({ type: 'agent.stream.content_block_stop' }))
    expect(store.count('ws-A')).toBe(0)
  })

  it('关键事件类型按真实后端事件名入桶（不是 topic 名）', () => {
    const store = useBackgroundEventStore.getState()
    // ✅ 真实 envelope.type（来自后端 AgentStreamEvent / AgentActionEvent / TrackerEvent）
    // W4 (2026-05-11): ask 三件套合一为 ask_user_required，多选问答 HITL。
    store.enqueue('ws-A', buildEnvelope({ type: 'agent.stream.approval_requested', event_id: 'e1' }))
    store.enqueue('ws-A', buildEnvelope({ type: 'agent.stream.ask_user_required', event_id: 'e2' }))
    store.enqueue('ws-A', buildEnvelope({ type: 'tracker.run.failed', event_id: 'e6' }))
    store.enqueue('ws-A', buildEnvelope({ type: 'tracker.run.completed', event_id: 'e7' }))
    // Tracker 重构清理：原 scheduler.job.finished 入桶用例改为 billing.usage.updated（scheduler 子系统已下线）。
    store.enqueue('ws-A', buildEnvelope({ type: 'billing.usage.updated', event_id: 'e8' }))
    store.enqueue('ws-A', buildEnvelope({ type: 'table.events.create', event_id: 'e9' }))
    store.enqueue('ws-A', buildEnvelope({ type: 'organization.membership_changed', event_id: 'e10' }))
    // W4 (2026-05-11): ask 三件套合一为 ask_user_required，原 10 条减为 8 条（删 e3/e4 两条）。
    expect(store.count('ws-A')).toBe(7)
  })

  it('enqueue 超过 100 条时按 FIFO 截断，保留最新', () => {
    const store = useBackgroundEventStore.getState()
    for (let i = 0; i < 120; i += 1) {
      store.enqueue('ws-A', buildEnvelope({ event_id: `e-${i}` }))
    }
    const buf = store.peek('ws-A')
    expect(buf.length).toBe(100)
    // 最早 20 条被截断
    expect(buf[0].event_id).toBe('e-20')
    expect(buf[99].event_id).toBe('e-119')
  })

  it('drain 返回快照并清空桶', () => {
    const store = useBackgroundEventStore.getState()
    store.enqueue('ws-A', buildEnvelope({ event_id: 'a1' }))
    store.enqueue('ws-A', buildEnvelope({ event_id: 'a2' }))

    const drained = store.drain('ws-A')
    expect(drained.map((e) => e.event_id)).toEqual(['a1', 'a2'])
    expect(store.count('ws-A')).toBe(0)
  })

  it('clearOrganization / clearAll 按需清理', () => {
    const store = useBackgroundEventStore.getState()
    store.enqueue('ws-A', buildEnvelope({ event_id: 'a1' }))
    store.enqueue('ws-B', buildEnvelope({ organization_id: 'ws-B', event_id: 'b1' }))

    store.clearOrganization('ws-A')
    expect(store.count('ws-A')).toBe(0)
    expect(store.count('ws-B')).toBe(1)

    store.clearAll()
    expect(store.count('ws-B')).toBe(0)
  })

  it('subscribe 在 enqueue 时触发', () => {
    const store = useBackgroundEventStore.getState()
    const spy = vi.fn()
    const unsub = store.subscribe(spy)

    store.enqueue('ws-A', buildEnvelope({ event_id: 'a1' }))
    expect(spy).toHaveBeenCalledWith('ws-A', expect.objectContaining({ event_id: 'a1' }))

    unsub()
    store.enqueue('ws-A', buildEnvelope({ event_id: 'a2' }))
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('routeEnvelopeToBackgroundBucket', () => {
  it('前台 organization 事件不入队', () => {
    const routed = routeEnvelopeToBackgroundBucket(
      buildEnvelope({ organization_id: 'ws-A' }),
      'ws-A',
    )
    expect(routed).toBe(false)
    expect(useBackgroundEventStore.getState().count('ws-A')).toBe(0)
  })

  it('非前台 organization 事件入队', () => {
    const routed = routeEnvelopeToBackgroundBucket(
      buildEnvelope({ organization_id: 'ws-B', event_id: 'b1' }),
      'ws-A',
    )
    expect(routed).toBe(true)
    expect(useBackgroundEventStore.getState().count('ws-B')).toBe(1)
  })

  it('顶层 envelope.organization_id 缺失时 fallback 到 payload.organization_id', () => {
    const routed = routeEnvelopeToBackgroundBucket(
      buildEnvelope({
        organization_id: null,
        payload: { organization_id: 'ws-B', content: 'from-payload' },
      }),
      'ws-A',
    )
    expect(routed).toBe(true)
    expect(useBackgroundEventStore.getState().count('ws-B')).toBe(1)
  })

  it('payload 也没 organization_id 时 fallback 到外部 resolver', () => {
    const resolverSpy = vi.fn().mockReturnValue('ws-C')
    registerBackgroundOrganizationIdResolver(resolverSpy)
    const envelope = buildEnvelope({
      organization_id: null,
      payload: { content: 'needs resolver' },
      thread_id: 'chat-session-123',
    })
    const routed = routeEnvelopeToBackgroundBucket(envelope, 'ws-A')
    expect(routed).toBe(true)
    expect(resolverSpy).toHaveBeenCalledWith(envelope)
    expect(useBackgroundEventStore.getState().count('ws-C')).toBe(1)
  })

  it('resolver 抛错不影响主流程，记作未解析', () => {
    registerBackgroundOrganizationIdResolver(() => {
      throw new Error('boom')
    })
    const routed = routeEnvelopeToBackgroundBucket(
      buildEnvelope({ organization_id: null, payload: null }),
      'ws-A',
    )
    expect(routed).toBe(false)
  })

  it('三级 fallback 都失败时不入队', () => {
    const routed = routeEnvelopeToBackgroundBucket(
      buildEnvelope({ organization_id: null, payload: null }),
      'ws-A',
    )
    expect(routed).toBe(false)
  })
})

describe('resolveEnvelopeOrganizationId', () => {
  it('优先读顶层 envelope.organization_id', () => {
    expect(
      resolveEnvelopeOrganizationId(
        buildEnvelope({ organization_id: 'ws-top', payload: { organization_id: 'ws-payload' } }),
      ),
    ).toBe('ws-top')
  })

  it('次选 envelope.payload.organization_id', () => {
    expect(
      resolveEnvelopeOrganizationId(
        buildEnvelope({ organization_id: null, payload: { organization_id: 'ws-payload' } }),
      ),
    ).toBe('ws-payload')
  })

  it('顶层空字符串不算有效', () => {
    expect(
      resolveEnvelopeOrganizationId(
        buildEnvelope({ organization_id: '', payload: { organization_id: 'ws-payload' } }),
      ),
    ).toBe('ws-payload')
  })
})

describe('onForegroundOrganizationChanged', () => {
  it('切换时 drain 新前台桶', () => {
    const store = useBackgroundEventStore.getState()
    store.enqueue('ws-B', buildEnvelope({ organization_id: 'ws-B', event_id: 'b1' }))
    store.enqueue('ws-B', buildEnvelope({ organization_id: 'ws-B', event_id: 'b2' }))

    const drained = onForegroundOrganizationChanged('ws-A', 'ws-B')
    expect(drained.map((e) => e.event_id)).toEqual(['b1', 'b2'])
    expect(store.count('ws-B')).toBe(0)
  })

  it('切换到 null 时 no-op', () => {
    const store = useBackgroundEventStore.getState()
    store.enqueue('ws-A', buildEnvelope({ event_id: 'a1' }))

    const drained = onForegroundOrganizationChanged('ws-A', null)
    expect(drained).toEqual([])
    expect(store.count('ws-A')).toBe(1)
  })
})
