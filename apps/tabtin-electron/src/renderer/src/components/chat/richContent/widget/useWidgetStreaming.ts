/**
 * 重构来源：apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx（行 719-732、764-885）
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：widget 流式状态 hook —— 订阅 tool_call_args_delta buffer、用 forgiving JSON
 *       提取 partial code/format/loading_message、rAF 节流避免高频 setState 重渲染。
 *       与 RichWidget 容器分离后，后续 widget 的"其他流式字段"扩展可以在不触碰容器
 *       组件的情况下演进。
 *
 *       **与原实现的等价性**：
 *         - useState 声明顺序（streamingCode → streamingLoadingMessage → streamingFormat
 *           → isStreaming）原样保留，React hook ordering rule 不变
 *         - useRef 声明顺序（pendingArgsRef → rafIdRef → lastFlushAtRef）原样保留
 *         - useCallback（extractPartialField → extractPartialCode）原样保留，依赖
 *           数组字面不变
 *         - useEffect 依赖数组 `[sessionId, finalCode, extractPartialCode, extractPartialField, blockToolCallId]`
 *           完全一致，避免订阅生命周期漂移
 *         - cleanup 函数字面拷贝（unsubscribe + cancelAnimationFrame + rafIdRef 置 null）
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  subscribeToolCallArgsDelta,
  type ToolCallArgsBuffer,
} from '@stores/chat/stream/handlers/toolCallArgsBufferStore'

/** 流式 partial SVG 累积长度上限——防止恶意 / 误用导致内存爆炸（与 8KB code 上限对齐）。 */
const STREAMING_CODE_HARD_CAP_BYTES = 16 * 1024

/** rAF 节流间隔下限（ms）——避免在 1000 token/s 流式期间每个 token 都触发 reload。 */
const STREAMING_REFRESH_MIN_MS = 16

export interface WidgetStreamingState {
  streamingCode: string | null
  streamingLoadingMessage: string | null
  streamingFormat: 'svg' | 'html' | 'mermaid' | null
  isStreaming: boolean
}

export interface UseWidgetStreamingInput {
  sessionId?: string | null
  /** 持久化 code 已就位时不订阅流式（一旦 finalCode 就位停止覆盖最终值）。 */
  finalCode: string
  /** 过滤条件：只消费自己 tool_call_id 的 partial。空串时退化向后兼容。 */
  blockToolCallId: string
}

/**
 * Widget Wave 2.5 流式 hook —— 原 RichWidget 内的 extractPartialField / rAF 节流
 * useEffect / 订阅 args delta buffer 全部搬入本 hook。
 *
 * 输出只读状态：{ streamingCode, streamingLoadingMessage, streamingFormat, isStreaming }
 * 当 finalCode 或 sessionId 缺失时直接 early return，不订阅 —— 跟原实现 `if (finalCode || !sessionId) return`
 * 在 useEffect 内部的 early-exit 完全等价（React 会在依赖变化时重跑 effect）。
 */
export function useWidgetStreaming(input: UseWidgetStreamingInput): WidgetStreamingState {
  const { sessionId, finalCode, blockToolCallId } = input

  // 持久化模式（block.code 已就绪）走 final code；流式模式走 streamingCode（订阅 args delta）。
  const [streamingCode, setStreamingCode] = useState<string | null>(null)
  // Widget Wave 2.5（用户 Review #7 修复）：partial 期间从 buffer 提取 LLM 写
  // 的 loading_message——Agent 自定义文案能在最该用的流式期就生效，而不是
  // 等 final RICH_CONTENT 来时被 finalCode 屏蔽掉。
  const [streamingLoadingMessage, setStreamingLoadingMessage] = useState<string | null>(null)
  const [streamingFormat, setStreamingFormat] = useState<'svg' | 'html' | 'mermaid' | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)

  // rAF / setTimeout 节流：高频 partial 不要每个 token 都 setState（React 重渲染 +
  // iframe srcdoc reload 都是 expensive operation）。
  const pendingArgsRef = useRef<string | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const lastFlushAtRef = useRef<number>(0)

  // 通用 partial 字符串字段提取——给定 fieldName，从 forgiving JSON 累积串
  // 里挖出 `"<fieldName>":"..."` 的值（即便 JSON 没闭合也能拿到 partial）。
  const extractPartialField = useCallback((args: string, fieldName: string): string | null => {
    if (!args) return null
    // 找 `"<field>":"` 起始（容忍空白）。fieldName 是受控字符串（'code' / 'loading_message'）
    // 不含 regex 特殊字符，直接拼接安全。
    const re = new RegExp(`"${fieldName}"\\s*:\\s*"`)
    const m = args.match(re)
    if (!m || m.index == null) return null
    const start = m.index + m[0].length
    // 从 start 开始扫描，识别未 escape 的 `"` 作为终止；途中 `\\` / `\"` 跳过。
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
    // 解析 JSON-style escapes（`\n` / `\"` / `\\` / `\/` 等）。失败则原样返回——
    // 流式期间宁可显示半截 raw 也不要 crash。
    try {
      return JSON.parse('"' + raw + '"')
    } catch {
      return raw
    }
  }, [])

  // 提取 partial code from accumulated args JSON——`{"summary":"...","format":"svg","code":"<svg ..."}`
  // 即便 JSON 整体还没闭合也能拿到 partial code 用于流式渲染。
  const extractPartialCode = useCallback(
    (args: string): string | null => extractPartialField(args, 'code'),
    [extractPartialField],
  )

  // 订阅 tool_call_args_delta（Wave 1 ready 的 API）。仅在持久化 code 还没到时
  // 才订阅——一旦 finalCode 就位，停止流式更新避免覆盖最终值。
  useEffect(() => {
    if (finalCode || !sessionId) return // 持久化模式 / 无 session 不订阅
    const flush = (): void => {
      rafIdRef.current = null
      const args = pendingArgsRef.current
      if (args == null) return
      pendingArgsRef.current = null
      lastFlushAtRef.current = performance.now()
      // 截断到 hard cap 防爆栈；超过后期望 LLM 自己止损 / Wave 4 OSS 落地
      const safeArgs =
        args.length > STREAMING_CODE_HARD_CAP_BYTES
          ? args.slice(0, STREAMING_CODE_HARD_CAP_BYTES)
          : args
      const partial = extractPartialCode(safeArgs)
      if (partial != null) {
        setStreamingCode(partial)
      }
      const partialFormat = extractPartialField(safeArgs, 'format')
      if (partialFormat === 'svg' || partialFormat === 'html' || partialFormat === 'mermaid') {
        setStreamingFormat(partialFormat)
      }
      // Widget Wave 2.5（用户 Review #7 修复）：partial 期间也提取 loading_message
      // ——这样 LLM 流式吐 args 顺序通常是 summary → format → loading_message → code
      // 时，code 还没到的 200ms-2s 窗口里用户看到的就是 Agent 自定义文案而不是
      // i18n 兜底"Agent 正在生成可视化…"。
      const partialLoading = extractPartialField(safeArgs, 'loading_message')
      if (partialLoading != null && partialLoading) {
        setStreamingLoadingMessage(partialLoading)
      }
    }

    const unsubscribe = subscribeToolCallArgsDelta(sessionId, (buffer: ToolCallArgsBuffer) => {
      // 只对 show_widget 工具的 partial 感兴趣。其他工具的 args delta 不影响 widget。
      if (buffer.toolName !== 'show_widget') return
      // Widget Wave 2.5：多 widget 不串台——只对自己 tool_call_id 的 buffer 才更新 srcdoc。
      // placeholder block 由 streamMessageHandler 预创建时带 tool_call_id，工具 emit final
      // 也带 tool_call_id（show-widget.ts 启发式注入）。
      // 如果 block 没 tool_call_id（罕见的退化场景：旧 widget block 没经过 placeholder
      // 路径），允许接受任何 show_widget buffer——保持向后兼容不 crash。
      if (blockToolCallId && buffer.toolCallId !== blockToolCallId) return
      // **流式终止 sentinel**（widget Wave 2 产品 Review 必修-2）：
      // `clearToolCallArgsBuffers` 在 lifecycle phase=end / cancel 时调，
      // 给每个 in-flight buffer 发一个 deltaCount=0 的 sentinel 通知。
      // 收到这个 sentinel 后清掉"流式中…" badge——避免 LLM 中断时 badge
      // 永远转，给用户一种"还在生成"的错觉。
      if (buffer.deltaCount === 0) {
        setIsStreaming(false)
        return
      }
      // Widget Wave 2.5（用户 Review #3 修复）：收到任何非 sentinel 的 buffer
      // 就切 isStreaming=true——而不是等到 partial code 提取出来才切。这样
      // LLM 还在吐 summary / loading_message（code 还没开始）期间就有"流式中…"
      // badge 让用户知道"在做事"。
      setIsStreaming(true)
      pendingArgsRef.current = buffer.accumulatedArgs
      // rAF 节流：合并多个 delta 到下一帧；如果距离上一次 flush > 16ms 立即调度
      if (rafIdRef.current != null) return
      const now = performance.now()
      if (now - lastFlushAtRef.current >= STREAMING_REFRESH_MIN_MS) {
        rafIdRef.current = requestAnimationFrame(flush)
      } else {
        // 距离上次 flush 太近，延后到下下帧——
        // Widget Wave 2.5（用户 Review #8 修复）：把 inner rAF id 写回 rafIdRef，
        // 让 cleanup 路径能 cancel 到下下帧。旧实现 outer 已 fire 但 inner 在
        // queue 里时 unmount 会触发 setState on unmounted React 警告。
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = requestAnimationFrame(flush)
        })
      }
    })

    return () => {
      unsubscribe()
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [sessionId, finalCode, extractPartialCode, extractPartialField, blockToolCallId])

  return { streamingCode, streamingLoadingMessage, streamingFormat, isStreaming }
}
