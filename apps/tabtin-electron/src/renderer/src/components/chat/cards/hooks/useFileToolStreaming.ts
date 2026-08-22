/**
 * useFileToolStreaming — 文件工具卡片的流式订阅 hook。
 *
 * 设计精神参考 `useWidgetStreaming`：
 *   - 订阅 `subscribeToolCallArgsDelta` 拿到 LLM 流式吐 args 的 partial JSON
 *   - 用 forgiving JSON 提取 `path` / `contents`（容忍未闭合的 JSON）
 *   - rAF 节流避免高频 setState 重渲染
 *   - 流式终止 sentinel（`deltaCount === 0`）切 `isStreaming=false`
 *   - mount 时立即读 buffer 当前态——这点对 file 工具很关键，因为 phase=start
 *     瞬间 ToolStepCard 才挂载，此时 args delta buffer 通常已经累积完成且
 *     不再有新 delta，订阅函数 fn 不会被触发；不读初始态会丢掉所有累积。
 *
 * 与 widget 的差异：
 *   - widget 字段是 `code` / `format` / `loading_message`；file 工具字段是 `path` / `contents`
 *   - widget 不依赖最终 input（流式 + 工具结果分两路）；file 工具有 phase=start 后的 final input，
 *     hook 在 finalContent 就位时停止覆盖（避免流式残值闪烁）
 *
 * **fallback 行为**：当 phase=start 时 input 已完整、且 hook 还没拿到 buffer
 * （比如 React 挂载晚于 args delta 流结束），调用方应直接用完整 input.contents——
 * hook 仅是"流式期间的视觉补强"，不是"必须有的数据源"。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getToolCallArgsBuffer,
  subscribeToolCallArgsDelta,
  type ToolCallArgsBuffer,
} from '@stores/chat/stream/handlers/toolCallArgsBufferStore'

/** partial 累积上限（对齐 widget 路径，避免内存爆栈）。 */
const STREAMING_HARD_CAP_BYTES = 64 * 1024
/** rAF 节流间隔下限（ms）。 */
const STREAMING_REFRESH_MIN_MS = 16
/**
 * Mount-time 读 buffer 失败后的 retry 延迟（ms）。
 *
 * 50ms 的取值：覆盖 provider 在 `tool_call_start` 与首条 `tool_call_args_delta`
 * 之间的网络延迟（OpenAI / Anthropic 实测 < 30ms 居多），又远小于一般可感知
 * 的视觉延迟阈值（≥ 100ms）；retry 命中后立即把 streamingPath 投出去，让
 * FileToolPlaceholder 占位时间最短化。
 *
 * 见 useEffect 内 retry 注释里的更详细分析。
 */
const BUFFER_RETRY_DELAY_MS = 50

export interface FileToolStreamingState {
  /** 流式提取出来的 path 字段（partial JSON 容错）；finalPath 就位后停止更新。 */
  streamingPath: string | null
  /** 流式提取出来的 contents/content 字段；finalContent 就位后停止更新。 */
  streamingContent: string | null
  /** 是否正在流式（收到任意非 sentinel buffer 后切 true，sentinel 后切 false）。 */
  isStreaming: boolean
}

export interface UseFileToolStreamingInput {
  sessionId?: string | null
  /** 当前 tool_call_id（按 toolCallId 过滤 buffer，多并发不串台）。 */
  toolCallId?: string | null
  /** 期望匹配的 toolName（白名单：write_file / edit_file / delete_file）。 */
  toolName: string
  /** phase=end 来时的最终 contents——就位后 hook 停止订阅（避免覆盖最终值）。 */
  finalContent?: string | null
  /** phase=end 来时的最终 path——就位后 hook 停止覆盖。 */
  finalPath?: string | null
}

const FILE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'delete_file'])

/**
 * 从 forgiving JSON 累积串里挖某个字段的 partial 值。
 *
 * 与 useWidgetStreaming 的 extractPartialField 等价；保留独立副本避免 hook 依赖
 * widget 实现细节（widget 模块在 chat/richContent/widget/ 子目录里）。
 */
function extractPartialField(args: string, fieldName: string): string | null {
  if (!args) return null
  // fieldName 是受控字符串（'path' / 'contents' / 'content'）不含 regex 特殊字符
  const re = new RegExp(`"${fieldName}"\\s*:\\s*"`)
  const m = args.match(re)
  if (!m || m.index == null) return null
  const start = m.index + m[0].length
  let end = -1
  for (let i = start; i < args.length; i++) {
    const ch = args[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '"') {
      end = i
      break
    }
  }
  const raw = end >= 0 ? args.slice(start, end) : args.slice(start)
  if (!raw) return null
  try {
    return JSON.parse('"' + raw + '"') as string
  } catch {
    return raw
  }
}

/** 从 args 串里同时提取 path/contents/content 三个字段（write_file 用 contents，
 *  外部 Agent 可能用 content）。 */
function extractFileFields(args: string): { path: string | null; content: string | null } {
  const safeArgs = args.length > STREAMING_HARD_CAP_BYTES ? args.slice(0, STREAMING_HARD_CAP_BYTES) : args
  return {
    path: extractPartialField(safeArgs, 'path'),
    content: extractPartialField(safeArgs, 'contents') ?? extractPartialField(safeArgs, 'content'),
  }
}

export function useFileToolStreaming(input: UseFileToolStreamingInput): FileToolStreamingState {
  const { sessionId, toolCallId, toolName, finalContent, finalPath } = input

  const [streamingPath, setStreamingPath] = useState<string | null>(null)
  const [streamingContent, setStreamingContent] = useState<string | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)

  const pendingArgsRef = useRef<string | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const lastFlushAtRef = useRef<number>(0)

  const flush = useCallback(() => {
    rafIdRef.current = null
    const args = pendingArgsRef.current
    if (args == null) return
    pendingArgsRef.current = null
    lastFlushAtRef.current = performance.now()
    const { path, content } = extractFileFields(args)
    if (path != null) setStreamingPath(path)
    if (content != null) setStreamingContent(content)
  }, [])

  useEffect(() => {
    // 不订阅的若干 early return：
    //   - 没 sessionId / toolCallId：拿不到 buffer
    //   - 不在白名单：避免误订阅其他工具的 buffer
    //   - finalContent + finalPath 都已就位：流式期已结束，避免覆盖最终值
    if (!sessionId || !toolCallId) return
    if (!FILE_TOOL_NAMES.has(toolName)) return
    if (finalContent != null && finalPath != null) return

    /**
     * 把 buffer 当前态映射到 React state 的内联函数。
     *
     * 在 mount-time 立即读 + 50ms retry + listener fanout 三处共享：
     *   - mount-time read: phase=start 那一刻 args delta 可能已经累积，立即拿
     *   - 50ms retry: provider 在 tool_call_start → args_delta 之间有几十~几百
     *     毫秒延迟（W14 修隐患 2 真实场景），50ms 后再读一次能接住"延迟流"
     *   - listener: 后续 delta 实时通知
     *
     * @returns true 表示成功拿到 path 或 content（不需要再 retry）
     */
    const tryReadBuffer = (): boolean => {
      const buf = getToolCallArgsBuffer(sessionId, toolCallId)
      if (!buf || buf.toolName !== toolName) return false
      const { path, content } = extractFileFields(buf.accumulatedArgs)
      let hit = false
      if (path != null) {
        setStreamingPath(path)
        hit = true
      }
      if (content != null) {
        setStreamingContent(content)
        hit = true
      }
      // 仅当 buffer 还在累积（lastDeltaAt 距 now < 1s）才标 isStreaming。
      // 已 finalize 的 buffer 直接给"已加载"状态，避免冒一个空的"流式中"badge。
      if (Date.now() - buf.lastDeltaAt < 1000) {
        setIsStreaming(true)
      }
      return hit
    }

    // mount-time 立即读：phase=start 那一刻 args delta 通常已经累积完成。
    const hitOnMount = tryReadBuffer()

    /**
     * Retry 兜底（W14 修隐患 2）：mount-time 没读到 path/content 时，50ms 后
     * 再试一次。
     *
     * 为什么需要 retry：WebSocket message 是串行 callback，但 `tool_call_start`
     * 和首条 `tool_call_args_delta` 之间通常有几十到几百毫秒的网络/provider 延迟。
     * Mount 那一帧可能 buffer 还没被任何 delta 写入（toolEvent 已 push 但 args
     * 字段空），listener 又要等下一条 delta 才会被调用——用户视角上"path 还没
     * 出现"的窗口期变长，FileToolPlaceholder 多停留一会。
     *
     * 50ms 的取值：覆盖绝大多数 provider 的 args 首条延迟（OpenAI / Anthropic
     * 实测 < 30ms 居多），又远小于一帧（16ms）的视觉感知阈值放大区间，retry
     * 命中后立即切到带文件名的头部，用户感觉"path 一闪就出来了"。
     */
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    if (!hitOnMount) {
      retryTimer = setTimeout(() => {
        retryTimer = null
        tryReadBuffer()
      }, BUFFER_RETRY_DELAY_MS)
    }

    const unsubscribe = subscribeToolCallArgsDelta(sessionId, (buffer: ToolCallArgsBuffer) => {
      if (buffer.toolCallId !== toolCallId) return
      if (buffer.toolName !== toolName) return
      // sentinel：deltaCount=0 表示流式终止
      if (buffer.deltaCount === 0) {
        setIsStreaming(false)
        return
      }
      setIsStreaming(true)
      pendingArgsRef.current = buffer.accumulatedArgs
      if (rafIdRef.current != null) return
      const now = performance.now()
      if (now - lastFlushAtRef.current >= STREAMING_REFRESH_MIN_MS) {
        rafIdRef.current = requestAnimationFrame(flush)
      } else {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = requestAnimationFrame(flush)
        })
      }
    })

    return () => {
      if (retryTimer != null) clearTimeout(retryTimer)
      unsubscribe()
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [sessionId, toolCallId, toolName, finalContent, finalPath, flush])

  return { streamingPath, streamingContent, isStreaming }
}
