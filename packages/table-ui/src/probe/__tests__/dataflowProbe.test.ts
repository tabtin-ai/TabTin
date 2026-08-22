/**
 * TabData 交互数据流探针回归测试（对标 doc-editor/src/__tests__/dataflowProbe.test.ts）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  enableDataflowProbe,
  isDataflowProbeEnabled,
  recordProbeEvent,
  dumpProbeEvents,
  registerProbeIntent,
  fireProbeIntent,
  listProbeIntents,
  setProbeSink,
  resetDataflowProbe,
  getProbeSessionId,
  type ProbeEvent,
} from '../dataflowProbe'

describe('tabdata dataflowProbe', () => {
  beforeEach(() => {
    resetDataflowProbe()
  })

  it('未启用时 record 为 no-op', () => {
    expect(isDataflowProbeEnabled()).toBe(false)
    recordProbeEvent({ component: 'http', event: 'http.request' })
    expect(dumpProbeEvents()).toHaveLength(0)
  })

  it('启用后记录事件并补全默认字段', () => {
    enableDataflowProbe({ host: 'electron' })
    recordProbeEvent({
      component: 'editing',
      event: 'cell.commitOk',
      tableId: 'tbl_1',
      recordId: 'rec_1',
      payload: { version: 3 },
    })
    const events = dumpProbeEvents()
    expect(events).toHaveLength(1)
    expect(events[0].origin).toBe('user')
    expect(events[0].host).toBe('electron')
    expect(events[0].tableId).toBe('tbl_1')
    expect(events[0].recordId).toBe('rec_1')
    expect(events[0].sessionId).toBe(getProbeSessionId())
    expect(typeof events[0].ts).toBe('number')
  })

  it('ring buffer 不超过上限', () => {
    enableDataflowProbe({ bufferLimit: 5, flushIntervalMs: 0 })
    for (let i = 0; i < 20; i += 1) {
      recordProbeEvent({ component: 'editing', event: `e${i}` })
    }
    const events = dumpProbeEvents()
    expect(events).toHaveLength(5)
    expect(events[events.length - 1].event).toBe('e19')
  })

  it('fireIntent 期间事件标 origin=agent，结束后回到 user', async () => {
    enableDataflowProbe({ flushIntervalMs: 0 })
    registerProbeIntent('tabdata.editCell', async () => {
      recordProbeEvent({ component: 'editing', event: 'cell.commit' })
    })
    expect(listProbeIntents().map((i) => i.name)).toContain('tabdata.editCell')
    await fireProbeIntent('tabdata.editCell')
    recordProbeEvent({ component: 'dataset', event: 'after' })

    const agentEvents = dumpProbeEvents({ origin: 'agent' })
    expect(agentEvents.some((e) => e.event === 'cell.commit')).toBe(true)
    expect(agentEvents.some((e) => e.event === 'intent.start')).toBe(true)
    // 意图结束后记录的事件应回到 user
    expect(dumpProbeEvents({ origin: 'user' }).some((e) => e.event === 'after')).toBe(true)
  })

  it('dump 可按 tableId / recordId 过滤', () => {
    enableDataflowProbe({ flushIntervalMs: 0 })
    recordProbeEvent({ component: 'editing', event: 'a', tableId: 'tbl_1', recordId: 'rec_1' })
    recordProbeEvent({ component: 'editing', event: 'b', tableId: 'tbl_2', recordId: 'rec_2' })
    expect(dumpProbeEvents({ tableId: 'tbl_1' }).map((e) => e.event)).toEqual(['a'])
    expect(dumpProbeEvents({ recordId: 'rec_2' }).map((e) => e.event)).toEqual(['b'])
  })

  it('sink 收到上送事件', () => {
    const received: ProbeEvent[] = []
    enableDataflowProbe({ flushIntervalMs: 0 })
    setProbeSink((batch) => received.push(...batch))
    recordProbeEvent({ component: 'http', event: 'http.request', traceId: 't1' })
    expect(received).toHaveLength(1)
    expect(received[0].traceId).toBe('t1')
  })

  it('未知 intent 抛错', async () => {
    enableDataflowProbe()
    await expect(fireProbeIntent('nope')).rejects.toThrow(/未知 intent/)
  })
})
