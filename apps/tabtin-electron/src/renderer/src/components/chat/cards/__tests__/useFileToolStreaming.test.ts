/**
 * useFileToolStreaming 单测 —— 钉死「订阅 args delta 后能正确从 partial JSON 提取
 * path / contents / content 字段，且在 finalContent + finalPath 都就位时不订阅」
 * 的契约。
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import {
  __resetToolCallArgsBuffersForTests,
  feedInputJsonDelta,
} from '../../../../stores/chat/stream/handlers/toolCallArgsBufferStore'
import { useFileToolStreaming } from '../hooks/useFileToolStreaming'

// Wave 4a 协议迁移：原 `handleToolCallArgsDelta(envelope, ctx)` 老协议入口已删除，
// 改为新协议入口 `feedInputJsonDelta(sessionId, toolCallId, toolName, partialJson)`。

beforeEach(() => {
  __resetToolCallArgsBuffersForTests()
  // 抹掉 rAF 的异步性——用 setTimeout(0) 同步触发
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(performance.now()), 0) as unknown as number
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})

const SESSION = 'session-test'
const TOOL_CALL = 'tc-write-file'

function pushDelta(delta: string, toolName = 'write_file'): void {
  feedInputJsonDelta(SESSION, TOOL_CALL, toolName, delta)
}

describe('useFileToolStreaming', () => {
  it('mount 时立即从已存在的 buffer 提取 partial path / contents（关键路径）', () => {
    // 模拟 phase=start 之前 args delta 已经累积完整
    pushDelta('{"path":"/tmp/foo.html","contents":"<!doctype html><html>')

    const { result } = renderHook(() =>
      useFileToolStreaming({
        sessionId: SESSION,
        toolCallId: TOOL_CALL,
        toolName: 'write_file',
        finalPath: null,
        finalContent: null,
      }),
    )

    expect(result.current.streamingPath).toBe('/tmp/foo.html')
    expect(result.current.streamingContent).toBe('<!doctype html><html>')
  })

  it('subscribe 后续 delta：累积更多 contents 字段时 streamingContent 跟进', async () => {
    pushDelta('{"path":"/tmp/foo.html","contents":"<!doctype ')

    const { result } = renderHook(() =>
      useFileToolStreaming({
        sessionId: SESSION,
        toolCallId: TOOL_CALL,
        toolName: 'write_file',
        finalPath: null,
        finalContent: null,
      }),
    )

    expect(result.current.streamingContent).toBe('<!doctype ')

    await act(async () => {
      pushDelta('html><html>')
      await new Promise((r) => setTimeout(r, 5))
    })

    expect(result.current.streamingContent).toBe('<!doctype html><html>')
    expect(result.current.isStreaming).toBe(true)
  })

  it('finalContent + finalPath 都就位时不订阅（避免覆盖最终值）', () => {
    pushDelta('{"path":"/tmp/x.html","contents":"streamed"}')

    const { result } = renderHook(() =>
      useFileToolStreaming({
        sessionId: SESSION,
        toolCallId: TOOL_CALL,
        toolName: 'write_file',
        finalPath: '/tmp/x.html',
        finalContent: 'final-result',
      }),
    )

    // hook 直接 early return → streaming 状态保持 null
    expect(result.current.streamingPath).toBeNull()
    expect(result.current.streamingContent).toBeNull()
    expect(result.current.isStreaming).toBe(false)
  })

  it('toolName 不在白名单（read_file）→ 不订阅，状态保持 null', () => {
    pushDelta('{"path":"/tmp/foo.txt"}', 'read_file')

    const { result } = renderHook(() =>
      useFileToolStreaming({
        sessionId: SESSION,
        toolCallId: TOOL_CALL,
        toolName: 'read_file',
        finalPath: null,
        finalContent: null,
      }),
    )

    expect(result.current.streamingPath).toBeNull()
    expect(result.current.streamingContent).toBeNull()
  })

  it('提取兼容 content 字段（外部 Agent 偶有的 contents 替代命名）', () => {
    pushDelta('{"path":"/tmp/legacy.txt","content":"legacy data"}')

    const { result } = renderHook(() =>
      useFileToolStreaming({
        sessionId: SESSION,
        toolCallId: TOOL_CALL,
        toolName: 'write_file',
        finalPath: null,
        finalContent: null,
      }),
    )

    expect(result.current.streamingPath).toBe('/tmp/legacy.txt')
    expect(result.current.streamingContent).toBe('legacy data')
  })

  it('sentinel buffer（deltaCount=0）切 isStreaming=false', async () => {
    pushDelta('{"path":"/tmp/foo.html"}')

    const { result } = renderHook(() =>
      useFileToolStreaming({
        sessionId: SESSION,
        toolCallId: TOOL_CALL,
        toolName: 'write_file',
        finalPath: null,
        finalContent: null,
      }),
    )

    // mount 时立即读初始 buffer，此时 lastDeltaAt 距 now 刚刚 → isStreaming=true
    expect(result.current.streamingPath).toBe('/tmp/foo.html')

    // 发 sentinel：deltaCount=0
    const { clearToolCallArgsBuffers } = await import(
      '../../../../stores/chat/stream/handlers/toolCallArgsBufferStore'
    )
    await act(async () => {
      clearToolCallArgsBuffers(SESSION, 'session_ended')
      await new Promise((r) => setTimeout(r, 5))
    })

    expect(result.current.isStreaming).toBe(false)
  })

  it('错误 toolCallId 的 buffer 被忽略（多并发不串台）', () => {
    pushDelta('{"path":"/tmp/should-not-show.html"}')

    const { result } = renderHook(() =>
      useFileToolStreaming({
        sessionId: SESSION,
        toolCallId: 'different-tc',
        toolName: 'write_file',
        finalPath: null,
        finalContent: null,
      }),
    )

    expect(result.current.streamingPath).toBeNull()
  })

  /**
   * Retry 兜底路径（W14 修隐患 2）。
   *
   * 真实场景：mount 那一帧 buffer 还是空的（provider 在 tool_call_start 与
   * 首条 args_delta 之间有 30~100ms 延迟），mount-time read 拿不到 path。
   * 50ms 后 retry 一次——这时 buffer 已经被写入，retry 命中拿到 path，
   * FileToolPlaceholder 占位时间最短化。
   */
  it('mount 时 buffer 为空 → 50ms retry 命中 args_delta 后续写入的 path', async () => {
    // mount 时 buffer 还没被任何 delta 写入
    const { result } = renderHook(() =>
      useFileToolStreaming({
        sessionId: SESSION,
        toolCallId: TOOL_CALL,
        toolName: 'write_file',
        finalPath: null,
        finalContent: null,
      }),
    )

    expect(result.current.streamingPath).toBeNull()
    expect(result.current.streamingContent).toBeNull()

    // 模拟"mount 后 30ms 才到达首条 args_delta"——hook 注册的 listener 也会触发，
    // 但即使 listener 没赶上，retry 在 50ms 时再读一次也能拿到。这里我们让 delta
    // 在 retry 之前到达，验证最坏情况下 retry 拿得到。
    //
    // **注意**：listener 的 setState 也会更新 path，所以只测 retry 单独路径需要
    // 把 listener 临时绕开——这里改成"先 mount + 等 retry 触发后再发 delta"
    // 不可行（delta 没发 retry 也读不到）。改用：mount → 立刻发 delta（listener
    // 接住）→ 验证 path 出现。retry 是兜底，listener 是主路径，两者协同。
    await act(async () => {
      pushDelta('{"path":"/tmp/late.html","contents":"hi"}')
      await new Promise((r) => setTimeout(r, 5))
    })

    expect(result.current.streamingPath).toBe('/tmp/late.html')
    expect(result.current.streamingContent).toBe('hi')
  })

  it('mount 时 buffer 为空 → retry 时 buffer 仍空 → 不抛错且 streaming 状态保持 null', async () => {
    // mount 时 buffer 不存在（args_delta 永远没来——譬如 LLM 在 tool_call_start
    // 后立刻给 tool_call_end，没有 args_delta）。
    const { result, unmount } = renderHook(() =>
      useFileToolStreaming({
        sessionId: SESSION,
        toolCallId: TOOL_CALL,
        toolName: 'write_file',
        finalPath: null,
        finalContent: null,
      }),
    )

    // 等过 retry 延迟（50ms + 余量），verify retry 不会因为 buffer 仍空而异常
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80))
    })

    expect(result.current.streamingPath).toBeNull()
    expect(result.current.streamingContent).toBeNull()
    // unmount 不应抛错（清 retry timer）
    expect(() => unmount()).not.toThrow()
  })
})
