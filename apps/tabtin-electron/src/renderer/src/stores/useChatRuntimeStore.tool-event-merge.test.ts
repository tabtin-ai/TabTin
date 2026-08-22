/**
 * useChatRuntimeStore — toolEvent merge & race 契约测试（W14）。
 *
 * **守的不变量**：
 *
 *   `upsertToolEventForSession` 必须做"undefined-保留"字段级 merge——任何字段
 *   在新事件里是 undefined 时沿用旧值。结合 `getEffectiveToolEventForSession`
 *   双源（_pendingTools + toolEventsBySessionId）查找，让 toolEvent.input 等
 *   字段在 rAF 批量 flush 的 race 窗口内仍然稳定。
 *
 * **真实 dogfood bug（会话 0b1b4ce4-c5bb-4c0e-9a31-73f8217aadad）**：
 *
 *   小文件 write_file 的 phase=start 与 phase=end 在同一帧 WebSocket message
 *   到达，rAF flush 还没跑：
 *     - phase=start：_pendingTools.set([{input: full}])，rAF 排队 flush
 *     - phase=end 同一 tick：toolHandler 读 toolEventsBySessionId（empty）
 *       → existingTool=undefined → resolvedInput=undefined → 上传 store
 *       → 旧实现 store 直接覆盖，input 被 undefined 擦掉
 *     - rAF 真正跑时：store 收到 input=undefined 的 phase=end
 *     - FileWriteCard 渲染 → "文件内容为空"
 *   刷新（走 hydrate 路径，从 content_blocks_json 重建，原 blocks collector 用同步 cache）→ 正常。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useChatRuntimeStore } from './useChatRuntimeStore'
import type { ToolEvent } from './chat/shared/types'

const SESSION = 'session-store-merge'
const TOOL_CALL = 'tc-merge-1'

function makeToolEvent(partial: Partial<ToolEvent>): ToolEvent {
  return {
    id: TOOL_CALL,
    toolName: 'write_file',
    phase: 'start',
    timestamp: Date.now(),
    ...partial,
  }
}

describe('useChatRuntimeStore — toolEvent undefined-保留 merge（race 修复）', () => {
  beforeEach(() => {
    // 清空 store 状态避免测试间污染
    useChatRuntimeStore.setState({
      toolEventsBySessionId: {},
    })
  })

  it('phase=end 不带 input → 沿用 phase=start 写入的 input（核心 race 场景）', async () => {
    const store = useChatRuntimeStore.getState()
    const fileContents = '<!doctype html>\n<html>...</html>'

    // 模拟 phase=start：写入 _pendingTools 但 rAF 还未 flush
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'start',
      input: { path: '/tmp/race.html', contents: fileContents },
      startedAt: 1_000,
    }))

    // 模拟同一帧的 phase=end：toolHandler 拿不到 phase=start 的 entry（rAF 没刷），
    // 它给 store 的 event input=undefined（payload 里没 input 字段）
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'end',
      input: undefined, // ← runtime stream protocol phase=end 故意不带 input
      output: { data: { path: '/tmp/race.html' } },
      timestamp: 1_500,
    }))

    // 等 rAF flush
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))

    const events = useChatRuntimeStore.getState().toolEventsBySessionId[SESSION]
    expect(events).toHaveLength(1)

    // 关键断言：合并后的 toolEvent.input 仍持有 phase=start 时的 contents
    expect(events[0].phase).toBe('end')
    expect(events[0].input).toEqual({
      path: '/tmp/race.html',
      contents: fileContents,
    })
    // output 走 phase=end 的新值
    expect(events[0].output).toEqual({ data: { path: '/tmp/race.html' } })
  })

  it('phase=end 显式带 input → 用新值覆盖（runtime 未来若补 protocol 不破坏）', async () => {
    const store = useChatRuntimeStore.getState()

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'start',
      input: { path: '/x.html', contents: 'OLD' },
    }))

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'end',
      input: { path: '/x.html', contents: 'NEW COMPLETE' }, // 假设 runtime 未来透传
      output: { data: { path: '/x.html' } },
    }))

    await new Promise((r) => requestAnimationFrame(() => r(undefined)))

    const events = useChatRuntimeStore.getState().toolEventsBySessionId[SESSION]
    expect(events[0].input).toEqual({ path: '/x.html', contents: 'NEW COMPLETE' })
  })

  it('startedAt 在 phase=end 不带 startedAt 时沿用 phase=start 的值（durationMs 计算依赖）', async () => {
    const store = useChatRuntimeStore.getState()

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'start',
      input: { path: '/x.txt' },
      startedAt: 5_000,
    }))

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'end',
      output: 'ok',
      // 注意：不传 startedAt，模拟 toolHandler race 时拿到 undefined
      startedAt: undefined,
      durationMs: 800,
    }))

    await new Promise((r) => requestAnimationFrame(() => r(undefined)))

    const events = useChatRuntimeStore.getState().toolEventsBySessionId[SESSION]
    expect(events[0].startedAt).toBe(5_000)
    expect(events[0].durationMs).toBe(800)
  })

  it('inputSummary 在 phase=end 不带 inputSummary 时沿用旧值', async () => {
    const store = useChatRuntimeStore.getState()

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'start',
      inputSummary: 'write /tmp/foo.html',
    }))
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'end',
      output: 'ok',
      inputSummary: undefined,
    }))

    await new Promise((r) => requestAnimationFrame(() => r(undefined)))

    const events = useChatRuntimeStore.getState().toolEventsBySessionId[SESSION]
    expect(events[0].inputSummary).toBe('write /tmp/foo.html')
  })

  it('presentation 在 phase=end 显式 undefined 时沿用 phase=start 的值', async () => {
    const store = useChatRuntimeStore.getState()
    const presentation = { kind: 'file_write', data: { path: '/tmp/foo.html' } }

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'start',
      presentation,
    }))
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'end',
      output: 'ok',
      presentation: undefined,
    }))

    await new Promise((r) => requestAnimationFrame(() => r(undefined)))

    const events = useChatRuntimeStore.getState().toolEventsBySessionId[SESSION]
    expect(events[0].presentation).toEqual(presentation)
  })

  it('不同 toolCallId 互不污染', async () => {
    const store = useChatRuntimeStore.getState()

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      id: 'tc-A',
      input: { path: '/a.txt', contents: 'A' },
    }))
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      id: 'tc-B',
      input: { path: '/b.txt', contents: 'B' },
    }))
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      id: 'tc-A',
      phase: 'end',
      input: undefined,
      output: 'a-done',
    }))
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      id: 'tc-B',
      phase: 'end',
      input: undefined,
      output: 'b-done',
    }))

    await new Promise((r) => requestAnimationFrame(() => r(undefined)))

    const events = useChatRuntimeStore.getState().toolEventsBySessionId[SESSION]
    const a = events.find((e) => e.id === 'tc-A')!
    const b = events.find((e) => e.id === 'tc-B')!
    expect(a.input).toEqual({ path: '/a.txt', contents: 'A' })
    expect(b.input).toEqual({ path: '/b.txt', contents: 'B' })
  })
})

describe('useChatRuntimeStore — getEffectiveToolEventForSession 双源查找', () => {
  beforeEach(() => {
    useChatRuntimeStore.setState({ toolEventsBySessionId: {} })
  })

  it('upsert 后立即调（rAF 还没 flush）能从 _pendingTools 拿到', () => {
    const store = useChatRuntimeStore.getState()

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      input: { path: '/x.html', contents: 'pending' },
    }))

    // 注意：**不**等 rAF flush。toolEventsBySessionId 此时仍是空的。
    expect(useChatRuntimeStore.getState().toolEventsBySessionId[SESSION]).toBeUndefined()

    // 但 effective lookup 必须能找到——这是 race 修复的核心
    const effective = store.getEffectiveToolEventForSession(SESSION, TOOL_CALL)
    expect(effective).toBeDefined()
    expect(effective?.input).toEqual({ path: '/x.html', contents: 'pending' })
  })

  it('rAF flush 后从 toolEventsBySessionId 拿到（_pendingTools 已 clear）', async () => {
    const store = useChatRuntimeStore.getState()

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      input: { path: '/x.html' },
    }))

    await new Promise((r) => requestAnimationFrame(() => r(undefined)))

    const effective = store.getEffectiveToolEventForSession(SESSION, TOOL_CALL)
    expect(effective).toBeDefined()
    expect(effective?.input).toEqual({ path: '/x.html' })
  })

  it('未知 eventId 返回 undefined', () => {
    const store = useChatRuntimeStore.getState()
    expect(store.getEffectiveToolEventForSession(SESSION, 'no-such-id')).toBeUndefined()
  })
})

// ── 2026-05-17 dogfood Review P0-2 + P0-3：progress 字段清理 ──────────
//
// streaming tool_progress 引入 ToolEvent.progress 字段。设计契约：
//   - 命令运行中（phase=start）：progress 累积 partial stdout 快照
//   - 命令结束（phase=end / error）：progress 必须被显式清空，不能残留过期帧
//   - 命令重试（retryTool）：新一轮起手 progress 必须从 undefined 开始
// 缺这两个清理点会让 ToolUseBlockView 在 race 窗口期显示过期 progress。
describe('useChatRuntimeStore — progress 字段清理契约（dogfood Review P0-2/P0-3）', () => {
  beforeEach(() => {
    useChatRuntimeStore.setState({ toolEventsBySessionId: {} })
  })

  it('phase=start 带 progress → 写入；后续 spread 显式 progress: undefined → 被擦掉', () => {
    const store = useChatRuntimeStore.getState()

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'start',
      progress: { stdout: 'hello\n', outputBytes: 6, truncated: false, capturedAt: 1_000 },
    }))

    let ev = store.getEffectiveToolEventForSession(SESSION, TOOL_CALL)
    expect(ev?.progress?.stdout).toBe('hello\n')

    // 显式 progress: undefined → spread 时确实写入 progress=undefined，merge 擦掉
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'end',
      output: 'final',
      progress: undefined,
    }))

    ev = store.getEffectiveToolEventForSession(SESSION, TOOL_CALL)
    expect(ev?.progress).toBeUndefined()
    expect(ev?.output).toBe('final')
  })

  it('未传 progress 字段（不在 event 对象里） → merge 沿用旧值（这正是 P0-3 想堵的漏）', () => {
    const store = useChatRuntimeStore.getState()

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'start',
      progress: { stdout: 'partial', outputBytes: 7, truncated: false, capturedAt: 1_000 },
    }))

    // 第二条 upsert **不带** progress 字段（譬如未修复的 handleToolLifecycleNotice
    // 行为）→ merge 后旧 progress 还在
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'end',
      output: 'final',
    }))

    const ev = store.getEffectiveToolEventForSession(SESSION, TOOL_CALL)
    // 这条断言记录"如果不在 lifecycle 里显式清，旧 progress 会泄漏"——
    // 用来锁定 store 当前的 undefined-保留语义；P0-3 修复点在 lifecycle handler，
    // 不在 store 层。
    expect(ev?.progress?.stdout).toBe('partial')
  })

  it('P0-2 retryTool：起新一轮时 progress 被显式清掉', async () => {
    const store = useChatRuntimeStore.getState()

    // 先植入一轮"已完成 + 残留 progress"的 toolEvent（模拟上一轮泄漏的状态）
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'end',
      output: 'old result',
      progress: { stdout: 'old partial', outputBytes: 11, truncated: false, capturedAt: 500 },
    }))

    // mock window.tabtin —— retryTool 走 IPC 路径需要这个
    const originalTabtin = (globalThis as unknown as { window?: unknown }).window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        tabtin: {
          agentEngine: {
            retryTool: async () => ({ ok: true, result: 'retry result' }),
          },
        },
      },
    })

    try {
      const ok = await store.retryTool(SESSION, makeToolEvent({
        phase: 'end',
        output: 'old result',
        progress: { stdout: 'old partial', outputBytes: 11, truncated: false, capturedAt: 500 },
      }))
      expect(ok).toBe(true)

      // retry 完成后查 toolEvent —— phase=end + new output，progress 应该不再有旧帧
      const ev = store.getEffectiveToolEventForSession(SESSION, TOOL_CALL)
      expect(ev?.phase).toBe('end')
      // retryTool 的 phase=start 起手时已显式 progress: undefined，phase=end 写入
      // 时也没带 progress（merge 沿用 undefined）—— 最终 progress 是 undefined
      expect(ev?.progress).toBeUndefined()
    } finally {
      // 恢复 window
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalTabtin })
    }
  })
})

// ── ：abort / cancel 收尾 in-flight ToolEvent ────────────────
//
// 现象：用户在工具/终端执行中点停止后，UI 仍显示 "tool in flight" /
// terminal_command partial。根因：StreamManager._doAbortSession 先退订 WS，
// daemon 随后 emit 的 tool_failed / lifecycle.end 在退订后到达会丢包，导致
// ToolEvent 永远停在 phase='start'。cleanupSessionOnTerminal 在 cancel/error
// 终态调用 finalizeInFlightToolEventsForSession 兜底收尾——这里锁定该方法契约。
describe('useChatRuntimeStore — finalizeInFlightToolEventsForSession（ abort 收尾）', () => {
  beforeEach(() => {
    useChatRuntimeStore.setState({ toolEventsBySessionId: {} })
  })

  it('phase=start 的 ToolEvent 被收尾成 phase=error + errorCode=aborted_by_user + progress 清空', () => {
    const store = useChatRuntimeStore.getState()

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'start',
      input: { command: 'npm install' },
      startedAt: 10_000,
      progress: { stdout: 'added 12 packages\n', outputBytes: 17, truncated: false, capturedAt: 11_000 },
    }))

    // finalizeInFlightToolEventsForSession 同步写 store（不经 rAF），立即对外可见
    store.finalizeInFlightToolEventsForSession(SESSION)

    const ev = store.getEffectiveToolEventForSession(SESSION, TOOL_CALL)
    expect(ev?.phase).toBe('error')
    expect(ev?.errorKind).toBe('aborted_by_user')
    expect(ev?.progress).toBeUndefined()
    // durationMs 由 startedAt 派生
    expect(ev?.durationMs).toBeGreaterThan(0)
    // input / startedAt 沿用（不被收尾擦掉）
    expect(ev?.input).toEqual({ command: 'npm install' })
    expect(ev?.startedAt).toBe(10_000)
  })

  it('phase=end / phase=error 的 ToolEvent 不被改动（已完成工具不重复收尾）', () => {
    const store = useChatRuntimeStore.getState()

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      id: 'tc-done',
      phase: 'end',
      output: '{"success":true,"exitCode":0}',
      durationMs: 42,
    }))
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      id: 'tc-errored',
      phase: 'error',
      errorKind: 'request_timeout',
      error: 'timed out',
      durationMs: 120_000,
    }))

    store.finalizeInFlightToolEventsForSession(SESSION)

    const done = store.getEffectiveToolEventForSession(SESSION, 'tc-done')
    const errored = store.getEffectiveToolEventForSession(SESSION, 'tc-errored')
    expect(done?.phase).toBe('end')
    expect(done?.durationMs).toBe(42)
    expect(errored?.phase).toBe('error')
    expect(errored?.errorKind).toBe('request_timeout')
    expect(errored?.error).toBe('timed out')
  })

  it('已有 errorCode / error 的 phase=start ToolEvent 不被兜底文案覆盖（保留真实诊断）', () => {
    const store = useChatRuntimeStore.getState()

    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'start',
      errorKind: 'custom_code',
      error: 'real diagnostic',
      startedAt: 100,
    }))

    store.finalizeInFlightToolEventsForSession(SESSION)

    const ev = store.getEffectiveToolEventForSession(SESSION, TOOL_CALL)
    expect(ev?.phase).toBe('error')
    // 已有值不被 aborted_by_user 兜底覆盖
    expect(ev?.errorKind).toBe('custom_code')
    expect(ev?.error).toBe('real diagnostic')
  })

  it('无 ToolEvent / 全是终态时是 no-op（不抛错、不写 set）', () => {
    const store = useChatRuntimeStore.getState()
    // 空 session
    expect(() => store.finalizeInFlightToolEventsForSession('empty-session')).not.toThrow()
    expect(store.getEffectiveToolEventForSession('empty-session', 'any')).toBeUndefined()
  })

  it('迟到的真实 lifecycle notice 经 upsert 顶掉兜底收尾（新值覆盖语义）', async () => {
    const store = useChatRuntimeStore.getState()

    // 模拟 in-flight + abort 兜底收尾
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'start',
      input: { command: 'ls' },
      startedAt: 1_000,
    }))
    store.finalizeInFlightToolEventsForSession(SESSION)
    expect(store.getEffectiveToolEventForSession(SESSION, TOOL_CALL)?.phase).toBe('error')

    // 迟到的 tool_completed notice（譬如 WS 未完全退订前最后一条 envelope 到达）
    store.upsertToolEventForSession(SESSION, makeToolEvent({
      phase: 'end',
      output: '{"success":true,"exitCode":0,"stdout":"total 8\\n"}',
      durationMs: 68,
      // 真实 notice 不带 input —— merge 必须沿用 phase=start 的 input
      input: undefined,
    }))

    await new Promise((r) => requestAnimationFrame(() => r(undefined)))

    const ev = store.getEffectiveToolEventForSession(SESSION, TOOL_CALL)
    // 真实 notice 胜出
    expect(ev?.phase).toBe('end')
    expect(ev?.output).toContain('total 8')
    // input 仍保留（undefined-保留 merge）
    expect(ev?.input).toEqual({ command: 'ls' })
  })
})
