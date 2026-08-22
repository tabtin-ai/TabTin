/**
 * session-run-queue.test.ts —  per-session 串行执行器 + FIFO 队列契约。
 */

import { describe, it, expect, vi } from 'vitest'
import { ConversationRunQueue } from '../src/conversation/conversation-run-queue.js'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const SID = 'sess-1'

describe('#4798 ConversationRunQueue', () => {
  it('空闲提交立即执行（started）', async () => {
    const q = new ConversationRunQueue()
    const ran: string[] = []
    const r = q.submit(SID, 'a', async () => { ran.push('a') })
    expect(r).toMatchObject({ status: 'started', position: 0 })
    await new Promise((res) => setTimeout(res, 0))
    expect(ran).toEqual(['a'])
    expect(q.isBusy(SID)).toBe(false)
  })

  it('忙时入队并在前一条 settle 后按 FIFO drain', async () => {
    const q = new ConversationRunQueue()
    const order: string[] = []
    const gateA = deferred()

    const r1 = q.submit(SID, 'a', async () => { order.push('a:start'); await gateA.promise; order.push('a:end') })
    expect(r1.status).toBe('started')
    // a 挂起中 → session 忙
    expect(q.isBusy(SID)).toBe(true)

    const r2 = q.submit(SID, 'b', async () => { order.push('b') })
    const r3 = q.submit(SID, 'c', async () => { order.push('c') })
    expect(r2).toMatchObject({ status: 'queued', position: 1 })
    expect(r3).toMatchObject({ status: 'queued', position: 2 })
    expect(q.queueDepth(SID)).toBe(2)

    // a 未 settle 前 b/c 不执行
    await Promise.resolve()
    expect(order).toEqual(['a:start'])

    gateA.resolve()
    await new Promise((r) => setTimeout(r, 0))
    // a 结束后按序 drain b、c
    expect(order).toEqual(['a:start', 'a:end', 'b', 'c'])
    expect(q.isBusy(SID)).toBe(false)
  })

  it('挂起态（如等审批）持续算 busy，后续消息一直排队', async () => {
    const q = new ConversationRunQueue()
    const gate = deferred()
    q.submit(SID, 'a', async () => { await gate.promise })
    q.submit(SID, 'b', async () => { /* noop */ })
    expect(q.isBusy(SID)).toBe(true)
    expect(q.queueDepth(SID)).toBe(1)
    await new Promise((r) => setTimeout(r, 0))
    // a 仍挂起 → b 不跑
    expect(q.queueDepth(SID)).toBe(1)
    gate.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(q.isBusy(SID)).toBe(false)
  })

  it('run 抛错不卡死队列，仍 drain 下一条', async () => {
    const q = new ConversationRunQueue()
    const ran: string[] = []
    q.submit(SID, 'a', async () => { ran.push('a'); throw new Error('boom') })
    q.submit(SID, 'b', async () => { ran.push('b') })
    await new Promise((r) => setTimeout(r, 0))
    expect(ran).toEqual(['a', 'b'])
    expect(q.isBusy(SID)).toBe(false)
  })

  it('clearQueued 丢弃未开始的排队项，不影响正在运行的', async () => {
    const q = new ConversationRunQueue()
    const ran: string[] = []
    const gate = deferred()
    q.submit(SID, 'a', async () => { ran.push('a'); await gate.promise })
    q.submit(SID, 'b', async () => { ran.push('b') })
    q.submit(SID, 'c', async () => { ran.push('c') })

    const dropped = q.clearQueued(SID)
    expect(dropped).toEqual(['b', 'c'])
    expect(q.queueDepth(SID)).toBe(0)

    gate.resolve()
    await new Promise((r) => setTimeout(r, 0))
    // a 仍跑完，b/c 被丢弃
    expect(ran).toEqual(['a'])
    expect(q.isBusy(SID)).toBe(false)
  })

  it('事件：onStarted(fromQueue) / onEnqueued / onIdle', async () => {
    const onEnqueued = vi.fn()
    const onStarted = vi.fn()
    const onIdle = vi.fn()
    const q = new ConversationRunQueue({ onEnqueued, onStarted, onIdle })
    const gate = deferred()

    q.submit(SID, 'a', async () => { await gate.promise })
    q.submit(SID, 'b', async () => { /* noop */ })

    expect(onStarted).toHaveBeenCalledWith(SID, 'a', false)
    expect(onEnqueued).toHaveBeenCalledWith(SID, 'b', 1)

    gate.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(onStarted).toHaveBeenCalledWith(SID, 'b', true)
    expect(onIdle).toHaveBeenCalledWith(SID)
  })

  it('submit().done 在本轮 run settle 后 resolve（保持发送返回语义）', async () => {
    const q = new ConversationRunQueue()
    const gateA = deferred()
    let bDone = false
    const a = q.submit(SID, 'a', async () => { await gateA.promise })
    const b = q.submit(SID, 'b', async () => { /* noop */ })
    void b.done.then(() => { bDone = true })
    // a 未完成 → b 排队中，b.done 未 resolve
    await new Promise((r) => setTimeout(r, 0))
    expect(bDone).toBe(false)
    gateA.resolve()
    await a.done
    await b.done
    expect(bDone).toBe(true)
  })

  it('clearQueued 释放被丢弃项的 done（不永久挂起）', async () => {
    const q = new ConversationRunQueue()
    const gate = deferred()
    q.submit(SID, 'a', async () => { await gate.promise })
    const b = q.submit(SID, 'b', async () => { /* 永不执行 */ })
    q.clearQueued(SID)
    // b 被丢弃，其 done 仍应 resolve
    await b.done
    gate.resolve()
  })

  it('busySessionIds 反映所有 running / 排队中的 session（ get-state 对账）', async () => {
    const q = new ConversationRunQueue()
    const gateA = deferred()
    expect(q.busySessionIds()).toEqual([])
    q.submit('s1', 'a', async () => { await gateA.promise })
    q.submit('s1', 'b', async () => { /* noop */ })
    q.submit('s2', 'x', async () => { /* noop */ })
    // s1 running+queued；s2 立即执行（同步返回时仍在 running 窗口内）
    expect(q.busySessionIds()).toContain('s1')
    gateA.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(q.busySessionIds()).toEqual([])
  })

  it('promote 将指定排队项移到队首，其它项相对顺序不变', async () => {
    const q = new ConversationRunQueue()
    const order: string[] = []
    const gateA = deferred()
    q.submit(SID, 'a', async () => { order.push('a'); await gateA.promise })
    q.submit(SID, 'b', async () => { order.push('b') })
    q.submit(SID, 'c', async () => { order.push('c') })
    q.submit(SID, 'd', async () => { order.push('d') })

    expect(q.promote(SID, 'd')).toEqual({ promoted: true, queuePosition: 1 })
    expect(q.queuedRunIds(SID)).toEqual(['d', 'b', 'c'])
    expect(q.promote(SID, 'missing')).toEqual({ promoted: false, queuePosition: 0 })

    gateA.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['a', 'd', 'b', 'c'])
  })

  it('dropQueued 只丢弃指定排队项，释放其 done，其它项顺序不变', async () => {
    const q = new ConversationRunQueue()
    const order: string[] = []
    const gateA = deferred()
    q.submit(SID, 'a', async () => { order.push('a'); await gateA.promise })
    const b = q.submit(SID, 'b', async () => { order.push('b') })
    q.submit(SID, 'c', async () => { order.push('c') })

    expect(q.dropQueued(SID, 'b')).toBe(true)
    expect(q.dropQueued(SID, 'missing')).toBe(false)
    expect(q.queuedRunIds(SID)).toEqual(['c'])
    await b.done
    expect(b.wasCancelled()).toBe(true)

    gateA.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['a', 'c'])
  })

  it('不同 session 互不影响（并行）', async () => {
    const q = new ConversationRunQueue()
    const ran: string[] = []
    const gateA = deferred()
    q.submit('s1', 'a', async () => { ran.push('s1:a'); await gateA.promise })
    const r = q.submit('s2', 'x', async () => { ran.push('s2:x') })
    // s2 空闲 → 立即执行，不受 s1 忙影响
    expect(r.status).toBe('started')
    await new Promise((res) => setTimeout(res, 0))
    expect(ran).toContain('s2:x')
    expect(q.isBusy('s1')).toBe(true)
    gateA.resolve()
    await new Promise((res) => setTimeout(res, 0))
    expect(q.isBusy('s1')).toBe(false)
  })
})
