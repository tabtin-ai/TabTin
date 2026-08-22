/**
 * Wave 6：fatal isDuplicate 累加 pendingDedupCount 行为单元测试。
 *
 * 业务背景：Wave 6 之前 errorReporter.ts 的 `isDuplicate` 在同 fingerprint 10s 内
 * 直接 return true → captureError 把事件丢弃 → admindash 看到的 event_count 严重
 * 低估真实严重性（React  死循环每秒触发 50 次只看到 1 条）。
 *
 * 修复：fatal 命中 dedup 时**不丢事件**——前端在 `consultDedup` 内部累加
 * `pendingDedupCount`，下次同 fingerprint **真正发出** 时随
 * `extra.frontend_dedup_count = N` 一并上报，后端 `_ingest_event` 把
 * `ClientErrorGroup.event_count += (1 + N)` 让 admindash 真实反映 burst 严重性。
 *
 * 本测试覆盖 `consultDedup` 的 7 个核心分支：
 *   1. 首次调用：duplicate=false, carriedDedupCount=0
 *   2. fatal 窗口内重复：duplicate=true, pendingDedupCount += 1
 *   3. fatal 窗口外重复：duplicate=false, carriedDedupCount = 之前累计的 N
 *   4. 非 fatal 窗口内重复：duplicate=true 但 pendingDedupCount **不**累加
 *   5. 不同 fingerprint 互不影响
 *   6. fingerprint LRU：频繁出现的 fingerprint 不会被 hard cap 误清理
 *   7. hard cap：超过 500 时按 FIFO 清理头部
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __TEST_ONLY_dedup,
  __TEST_ONLY_computeFingerprint,
  __TEST_ONLY_eventQueue,
  reportError,
} from '../errorReporter'

beforeEach(() => {
  vi.useFakeTimers()
  __TEST_ONLY_dedup.reset()
  __TEST_ONLY_eventQueue.clear()
})

afterEach(() => {
  __TEST_ONLY_dedup.reset()
  __TEST_ONLY_eventQueue.clear()
  vi.useRealTimers()
})

describe('consultDedup: fatal 累加 pendingDedupCount', () => {
  it('case 1: 首次调用不被 dedup', () => {
    const result = __TEST_ONLY_dedup.consult('fp_react_185', 'fatal')
    expect(result).toEqual({ duplicate: false, carriedDedupCount: 0 })
  })

  it('case 2: fatal 窗口内重复 duplicate=true 且 pendingDedupCount 累加', () => {
    __TEST_ONLY_dedup.consult('fp', 'fatal') // 首次入口
    expect(__TEST_ONLY_dedup.snapshot()[0][1].pendingDedupCount).toBe(0)

    // 同窗口内 50 次重复
    for (let i = 0; i < 50; i++) {
      const r = __TEST_ONLY_dedup.consult('fp', 'fatal')
      expect(r.duplicate).toBe(true)
      expect(r.carriedDedupCount).toBe(0) // duplicate 时 carriedDedupCount 始终 0
    }

    expect(__TEST_ONLY_dedup.snapshot()[0][1].pendingDedupCount).toBe(50)
  })

  it('case 3: fatal 窗口外的下次 emit 把累计的 pendingDedupCount 认领走', () => {
    __TEST_ONLY_dedup.consult('fp', 'fatal') // 第 1 次入口
    for (let i = 0; i < 50; i++) {
      __TEST_ONLY_dedup.consult('fp', 'fatal') // 累加到 50
    }

    // 推进时间到窗口外（11s > 10s 窗口）
    vi.advanceTimersByTime(__TEST_ONLY_dedup.windowMs + 1_000)

    const result = __TEST_ONLY_dedup.consult('fp', 'fatal')
    expect(result.duplicate).toBe(false)
    expect(result.carriedDedupCount).toBe(50)

    // 认领后 entry 重置为 0
    expect(__TEST_ONLY_dedup.snapshot()[0][1].pendingDedupCount).toBe(0)
  })

  it('case 4: 非 fatal 命中窗口 duplicate=true 但 pendingDedupCount 不累加', () => {
    __TEST_ONLY_dedup.consult('fp', 'error') // 首次入口（非 fatal）

    for (let i = 0; i < 10; i++) {
      const r = __TEST_ONLY_dedup.consult('fp', 'error')
      expect(r.duplicate).toBe(true)
    }

    // 非 fatal 不累加 → 仍然 0
    expect(__TEST_ONLY_dedup.snapshot()[0][1].pendingDedupCount).toBe(0)
  })

  it('case 4b: 非 fatal 不累加，但能"挑走"之前 fatal 累计的 pendingDedupCount', () => {
    // fatal 累加阶段
    __TEST_ONLY_dedup.consult('fp', 'fatal')
    for (let i = 0; i < 5; i++) {
      __TEST_ONLY_dedup.consult('fp', 'fatal')
    }
    expect(__TEST_ONLY_dedup.snapshot()[0][1].pendingDedupCount).toBe(5)

    // 窗口外 emit 一次 error（非 fatal）—— 把 5 挑走（避免 dedup_count 永久挂在 Map 里失踪）
    vi.advanceTimersByTime(__TEST_ONLY_dedup.windowMs + 1_000)
    const r = __TEST_ONLY_dedup.consult('fp', 'error')
    expect(r.duplicate).toBe(false)
    expect(r.carriedDedupCount).toBe(5)
    expect(__TEST_ONLY_dedup.snapshot()[0][1].pendingDedupCount).toBe(0)
  })

  it('case 5: 不同 fingerprint 互不影响', () => {
    __TEST_ONLY_dedup.consult('fp_a', 'fatal')
    for (let i = 0; i < 3; i++) __TEST_ONLY_dedup.consult('fp_a', 'fatal')

    __TEST_ONLY_dedup.consult('fp_b', 'fatal')
    for (let i = 0; i < 7; i++) __TEST_ONLY_dedup.consult('fp_b', 'fatal')

    const snap = new Map(__TEST_ONLY_dedup.snapshot())
    expect(snap.get('fp_a')?.pendingDedupCount).toBe(3)
    expect(snap.get('fp_b')?.pendingDedupCount).toBe(7)
  })
})

describe('computeFingerprint: 前后端分辨维度对齐（Wave 6 Round 2 P0-1）', () => {
  /**
   * 业务背景：Wave 2 之前后端 fingerprint 只看 stack 前 3 行，所有 React  死循环
   * 都被合到一个 group。Wave 2 后端升级到看 component_stack（去 anonymous 噪声）
   * + stack 5 行。前端 dedup 的 fingerprint 必须对齐，否则 bug A 与 bug B 在前端
   * 就被错误合并、被 dedup 黑洞吃掉永远不到后端。
   */

  it('两个不同 React component 但同 React 内部 stack 前 3 行 → 必须是不同 fingerprint', () => {
    // React 内部 stack 前 3 行总是相同（getRootForUpdatedFiber → enqueueConcurrentHookUpdate
    // → dispatchReducerAction），bug A 和 bug B 共享，不能因此被合并。
    const sharedReactStack = (
      'at getRootForUpdatedFiber (react-dom.js:1:1)\n'
      + 'at enqueueConcurrentHookUpdate (react-dom.js:2:2)\n'
      + 'at dispatchReducerAction (react-dom.js:3:3)\n'
    )
    const bugA = __TEST_ONLY_computeFingerprint('Error', sharedReactStack, 'Maximum update depth exceeded', {
      componentStack: '    at ChatPanel (at chat.tsx:10:5)\n    at div (<anonymous>)',
    })
    const bugB = __TEST_ONLY_computeFingerprint('Error', sharedReactStack, 'Maximum update depth exceeded', {
      componentStack: '    at SettingsForm (at settings.tsx:20:5)\n    at div (<anonymous>)',
    })
    expect(bugA).not.toBe(bugB)
  })

  it('component_stack 全 anonymous div 噪声 vs 完全没 cs → 应同 fingerprint', () => {
    const stack = 'at foo (file.js:1:1)'
    const noCs = __TEST_ONLY_computeFingerprint('Error', stack, 'msg')
    const allAnon = __TEST_ONLY_computeFingerprint('Error', stack, 'msg', {
      componentStack: '    at div (<anonymous>)\n    at div (<anonymous>)',
    })
    expect(noCs).toBe(allAnon)
  })

  it('支持 component_stack（下划线 key）与 componentStack（驼峰 key）两种', () => {
    const stack = 'at foo (file.js:1:1)'
    const camel = __TEST_ONLY_computeFingerprint('Error', stack, '', {
      componentStack: '    at MyComp (at app.tsx:1:1)',
    })
    const snake = __TEST_ONLY_computeFingerprint('Error', stack, '', {
      component_stack: '    at MyComp (at app.tsx:1:1)',
    })
    expect(camel).toBe(snake)
  })

  it('无 stack 无 cs 时退化到 message 区分度（不让所有"裸 throw"合并）', () => {
    const fpA = __TEST_ONLY_computeFingerprint('Error', '', 'Cannot read foo')
    const fpB = __TEST_ONLY_computeFingerprint('Error', '', 'Cannot read bar')
    expect(fpA).not.toBe(fpB)
  })

  it('Round 2 P0-1: caller 传 8KB+ extra（含 componentStack）时，event 顶层 component_stack 仍非空 + 与 caller 传入相同', () => {
    // 制造 9KB 的 componentStack：典型 React 19 深组件树 ~5-10KB
    const bigComponentStack = (
      '    at ChatPanel (at chat.tsx:100:5)\n'
      + '    at WorkbenchHost (at host.tsx:50:5)\n'
      + ('    at SomeWrapperComponent (at wrap.tsx:1:1)\n'.repeat(180))
    )
    expect(bigComponentStack.length).toBeGreaterThan(8000)

    // 业务 extra 4KB，让总和 > 8KB 触发 sanitize 截断
    const businessPayload = 'x'.repeat(4096)

    // 用 'error' level（fatal 会同步触发 flushErrors 清空 eventQueue）；顶层字段
    // 构造契约对所有 level 都生效，本测试只验证字段构造。
    reportError(new Error('Maximum update depth exceeded P0-1 big extra'), {
      componentStack: bigComponentStack,
      business_context: businessPayload,
    }, 'error')

    const events = __TEST_ONLY_eventQueue.drain()
    expect(events.length).toBe(1)
    const ev = events[0]

    // P0-1 核心断言：顶层 component_stack 字段非空 + 与 caller 传入完全一致
    expect(ev.component_stack).toBeDefined()
    expect(ev.component_stack.length).toBeGreaterThan(8000)
    expect(ev.component_stack).toBe(bigComponentStack)

    // 同时验证 extra 因 8KB 越界确实被 sanitize 替换为占位——**因此**走 extra 通道
    // 拿不到 cs，必须走顶层字段才能保证后端 fingerprint 算对。
    expect((ev.extra as Record<string, unknown>)._truncated).toBe(true)
    expect((ev.extra as Record<string, unknown>).size).toBeGreaterThan(8000)
  })

  it('Round 2 P0-1：小 extra 场景顶层字段同样工作', () => {
    reportError(new Error('small P0-1 case'), {
      componentStack: '    at SmallComp (at small.tsx:1:1)',
    }, 'error')
    const events = __TEST_ONLY_eventQueue.drain()
    expect(events.length).toBe(1)
    const ev = events[0]
    // 顶层字段是核心新契约
    expect(ev.component_stack).toBe('    at SmallComp (at small.tsx:1:1)')
    // extra 也保留 componentStack（兼容老 admindash 客户端）
    expect((ev.extra as Record<string, unknown>).componentStack).toBe(
      '    at SmallComp (at small.tsx:1:1)',
    )
  })
})

describe('consultDedup: 内存防护', () => {
  it('case 6: fatal 命中时把 entry 移到 LRU 末尾，不会被 hard cap 误清', () => {
    const cap = __TEST_ONLY_dedup.hardCap

    // 先填 cap-1 个 fill_fp，再写入 hot_fp 让 Map 刚好达到 cap（不触发 trim）
    for (let i = 0; i < cap - 1; i++) {
      __TEST_ONLY_dedup.consult(`fill_fp_${i}`, 'fatal')
    }
    __TEST_ONLY_dedup.consult('hot_fp', 'fatal')

    // hot_fp 现在在 Map 末尾（最新插入）。窗口内 fatal 命中 5 次 → 累加 + 重新移到末尾。
    for (let i = 0; i < 5; i++) {
      __TEST_ONLY_dedup.consult('hot_fp', 'fatal')
    }
    expect(__TEST_ONLY_dedup.snapshot().length).toBe(cap)

    // 再插入 50 个新 fingerprint 触发 trim（每次 set 后 size > cap → 清头部）
    for (let i = 0; i < 50; i++) {
      __TEST_ONLY_dedup.consult(`extra_fp_${i}`, 'fatal')
    }

    const snap = new Map(__TEST_ONLY_dedup.snapshot())
    // hot_fp 应该还在（在末尾，trim 清头部时不受影响）
    expect(snap.has('hot_fp')).toBe(true)
    expect(snap.get('hot_fp')?.pendingDedupCount).toBe(5)
    // 头部最早的 fill_fp_0..fill_fp_49 应该被清掉
    expect(snap.has('fill_fp_0')).toBe(false)
    expect(snap.has('fill_fp_49')).toBe(false)
    // fill_fp_50 应该还在（共清了 50 个头部）
    expect(snap.has('fill_fp_50')).toBe(true)
    // 新插入的 extra_fp_49 应该在末尾
    expect(snap.has('extra_fp_49')).toBe(true)
  })

  it('case 7: Map 严格不超过 hard cap', () => {
    const cap = __TEST_ONLY_dedup.hardCap
    for (let i = 0; i < cap * 2; i++) {
      __TEST_ONLY_dedup.consult(`fp_${i}`, 'fatal')
    }
    expect(__TEST_ONLY_dedup.snapshot().length).toBeLessThanOrEqual(cap)
  })

  it('case 8 (Round 2 P1-3): FIFO 清理跳过 pendingDedupCount > 0 — 低频 fatal entry 在 noise burst 后仍存活', () => {
    const cap = __TEST_ONLY_dedup.hardCap

    // 先把一个低频 fatal entry 累加到 pendingDedupCount=10
    __TEST_ONLY_dedup.consult('low_freq_fatal', 'fatal')
    for (let i = 0; i < 10; i++) {
      __TEST_ONLY_dedup.consult('low_freq_fatal', 'fatal')
    }
    const beforePending = (
      new Map(__TEST_ONLY_dedup.snapshot()).get('low_freq_fatal')?.pendingDedupCount ?? 0
    )
    expect(beforePending).toBe(10)

    // 时间快进让 low_freq_fatal 出 dedup 窗口（让它的 lastSeen 过期），但 pendingDedupCount 仍 > 0
    vi.advanceTimersByTime(__TEST_ONLY_dedup.windowMs + 1_000)

    // 灌入 cap + 200 个新 noise fingerprint，pendingDedupCount=0（每个都 first emit 不命中窗口）
    for (let i = 0; i < cap + 200; i++) {
      __TEST_ONLY_dedup.consult(`noise_fp_${i}`, 'fatal')
    }

    // low_freq_fatal entry 必须仍存活 + pendingDedupCount=10 不丢
    const after = new Map(__TEST_ONLY_dedup.snapshot()).get('low_freq_fatal')
    expect(after).toBeDefined()
    expect(after?.pendingDedupCount).toBe(10)

    // Map 不超 cap
    expect(__TEST_ONLY_dedup.snapshot().length).toBeLessThanOrEqual(cap)
  })
})
