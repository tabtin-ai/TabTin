import type { ThreadOverviewMessage, Trace } from '@/types/agent-debug'

const PREVIEW_MAX = 28

export function truncateRunPreview(text: string, max = PREVIEW_MAX): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max)}…`
}

/** 运行环境文案：把 local-runtime 等技术值收成运营可读说法。 */
export function formatRuntimeLabel(graphType: string | null | undefined): string {
  const value = (graphType || '').trim()
  if (!value) return '未知环境'
  const lower = value.toLowerCase()
  if (lower === 'local-runtime' || lower === 'local_runtime') return '本机运行'
  if (lower === 'tin') return 'Tin 编排'
  return value
}

export function formatTraceDuration(trace: Trace): string | null {
  let ms = typeof trace.duration_ms === 'number' ? trace.duration_ms : null
  if (ms === null && trace.ended_at && trace.started_at) {
    ms = new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime()
  }
  if (ms === null || Number.isNaN(ms) || ms < 0) {
    return trace.status === 'running' ? '进行中' : null
  }
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} 分钟`
  return `${(ms / 3_600_000).toFixed(1)} 小时`
}

/**
 * 为每条 trace 找触发它的用户话预览。
 * 优先：同 trace_id 的用户消息；否则：同 trace 的助手消息往前找最近用户话。
 */
export function buildTraceUserPreviewMap(
  messages: ThreadOverviewMessage[]
): Map<string, string> {
  const map = new Map<string, string>()

  for (const message of messages) {
    if (message.role !== 'user' || !message.trace_id) continue
    if (map.has(message.trace_id)) continue
    const preview = truncateRunPreview(message.content || '')
    if (preview) map.set(message.trace_id, preview)
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message?.trace_id || map.has(message.trace_id)) continue
    if (message.role !== 'assistant') continue

    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previous = messages[cursor]
      if (previous?.role !== 'user') continue
      const preview = truncateRunPreview(previous.content || '')
      if (preview) map.set(message.trace_id, preview)
      break
    }
  }

  return map
}

export function getExecutionRunTitle(
  trace: Trace,
  userPreviewByTraceId: Map<string, string>
): string {
  const preview = userPreviewByTraceId.get(trace.trace_id)
  if (preview) return `回复「${preview}」`
  return '系统拉起 / 续跑'
}

export function getExecutionRunSubtitle(trace: Trace): string {
  const time = new Date(trace.started_at).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts = [time, formatTraceDuration(trace), formatRuntimeLabel(trace.graph_type)].filter(
    Boolean
  )
  return parts.join(' · ')
}
