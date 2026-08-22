/**
 * AdminDash 客户端错误模块工具函数
 *
 * - formatLocalTime：把后端返回的 UTC ISO 时间字符串转成"本地时区 + 短格式"
 * - buildGroupDiagnosticMarkdown：把整组错误现场打包成可发送给 AI / 同事的 Markdown
 * - buildEventDiagnosticMarkdown：把单条事件完整现场打包成 Markdown
 * - copyToClipboard：navigator.clipboard.writeText 的 thin wrapper
 */

import type {
  Breadcrumb,
  ErrorEventItem,
  ErrorGroupDetail,
} from '../api/client-errors'

/**
 * 后端返回的时间是 UTC ISO（如 `2026-05-07T06:27:32.123Z`）。
 * 之前页面里到处用 `.slice(0, 16).replace('T', ' ')` 的写法，
 * 等同于"把 UTC 直接当本地时间显示"——结果就是看起来比真实早 8 小时。
 *
 * 用 toLocaleString 走浏览器内置时区数据库，自动按用户 OS 时区转换。
 *
 * @param iso 后端返回的 ISO 时间字符串，可能为 null
 * @param withSeconds 是否带秒。默认 false（YYYY-MM-DD HH:mm）
 * @returns 本地时间字符串；输入为空时返回 '-'
 */
export function formatLocalTime(
  iso: string | null | undefined,
  withSeconds = false,
): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso

  const pad = (n: number) => n.toString().padStart(2, '0')
  const Y = d.getFullYear()
  const M = pad(d.getMonth() + 1)
  const D = pad(d.getDate())
  const h = pad(d.getHours())
  const m = pad(d.getMinutes())
  const s = pad(d.getSeconds())

  return withSeconds
    ? `${Y}-${M}-${D} ${h}:${m}:${s}`
    : `${Y}-${M}-${D} ${h}:${m}`
}

/**
 * 复制文本到系统剪贴板。
 *
 * navigator.clipboard 在非 https / 非 secure context 下不可用，
 * 这里用 textarea + execCommand 兜底（虽然 execCommand 已 deprecated 但仍是最稳的 fallback）。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 失败走 fallback
    }
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

// ─── Markdown 报告生成 ──────────────────────────────────────────

const MAX_BREADCRUMBS_IN_REPORT = 30

function fenceCode(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body.trim()}\n\`\`\``
}

function formatBreadcrumb(b: Breadcrumb): string {
  const ts = b.timestamp ? formatLocalTime(b.timestamp, true).slice(11) : ''
  const data = b.data && Object.keys(b.data).length > 0
    ? ` ${JSON.stringify(b.data)}`
    : ''
  return `- \`[${ts}]\` **${b.type}** ${b.message}${data}`
}

/**
 * 生成事件级别的完整 Markdown 诊断报告。
 *
 * 给同事 / AI 看的时候，这一份能完整代表"崩溃现场"：
 * 错误本体 + 设备 + React 组件栈 + JS 堆栈 + 操作轨迹（面包屑） + 附加信息。
 *
 * 优先用 resolved_* 字段（sourcemap 反混淆后的可读源码定位）。
 */
export function buildEventDiagnosticMarkdown(event: ErrorEventItem): string {
  const lines: string[] = []

  lines.push(`# 客户端崩溃现场 · Event #${event.id}`)
  lines.push('')

  // ── 概览 ──
  lines.push('## 概览')
  lines.push(`- **错误类型**：\`${event.error_type}\``)
  lines.push(`- **级别**：${event.level.toUpperCase()}`)
  lines.push(`- **来源进程**：${event.source}`)
  lines.push(`- **发生时间**：${formatLocalTime(event.occurred_at, true)}`)
  if (event.group_id) lines.push(`- **所属分组**：#${event.group_id}`)
  lines.push('')
  lines.push('### 错误消息')
  lines.push(fenceCode('text', event.message))
  lines.push('')

  // ── 设备 ──
  lines.push('## 设备')
  const deviceFields: Array<[string, string | number | null]> = [
    ['操作系统', event.os_name && event.os_version ? `${event.os_name} ${event.os_version}` : event.os_name || '-'],
    ['架构', event.arch || '-'],
    ['Electron', event.electron_version || '-'],
    ['应用版本', event.app_version || '-'],
    ['语言', event.locale || '-'],
    ['用户 ID', event.user_id || '匿名'],
  ]
  for (const [k, v] of deviceFields) {
    lines.push(`- **${k}**：${v ?? '-'}`)
  }
  lines.push('')

  // ── React 组件栈（最关键的 React 错误定位线索） ──
  if (event.component_stack) {
    lines.push('## React 组件栈')
    if (event.resolved_component_stack) {
      lines.push('**还原后**（sourcemap 反混淆）：')
      lines.push(fenceCode('text', event.resolved_component_stack))
      lines.push('')
      lines.push('<details><summary>原始组件栈</summary>')
      lines.push('')
      lines.push(fenceCode('text', event.component_stack))
      lines.push('')
      lines.push('</details>')
    } else {
      lines.push(fenceCode('text', event.component_stack))
    }
    lines.push('')
  }

  // ── JS 堆栈 ──
  if (event.stack_trace) {
    lines.push('## JS 堆栈')
    if (event.resolved_stack_trace) {
      lines.push('**还原后**：')
      lines.push(fenceCode('text', event.resolved_stack_trace))
      lines.push('')
      lines.push('<details><summary>原始堆栈</summary>')
      lines.push('')
      lines.push(fenceCode('text', event.stack_trace))
      lines.push('')
      lines.push('</details>')
    } else {
      lines.push(fenceCode('text', event.stack_trace))
    }
    lines.push('')
  }

  // ── 操作轨迹 ──
  const breadcrumbs = event.breadcrumbs ?? []
  if (breadcrumbs.length > 0) {
    lines.push(`## 操作轨迹（最近 ${Math.min(breadcrumbs.length, MAX_BREADCRUMBS_IN_REPORT)} 条）`)
    const recent = breadcrumbs.slice(-MAX_BREADCRUMBS_IN_REPORT)
    for (const b of recent) {
      lines.push(formatBreadcrumb(b))
    }
    lines.push('')
  }

  // ── 附加信息 ──
  if (event.extra && Object.keys(event.extra).length > 0) {
    lines.push('## 附加信息')
    lines.push(fenceCode('json', JSON.stringify(event.extra, null, 2)))
    lines.push('')
  }

  // 文件位置（如果未走 sourcemap，会有这块原始定位）
  if (event.file) {
    lines.push('## 文件位置（原始）')
    lines.push(`- ${event.file}${event.line != null ? `:${event.line}` : ''}${event.column != null ? `:${event.column}` : ''}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 生成分组级别的 Markdown 诊断报告。
 *
 * 比 event 报告更"概览"：统计 + 示例堆栈 + 示例组件栈 + 最近 N 个事件的简要列表。
 * 适合发给同事说"这个 bug 影响 N 个用户、出现 M 次、首次见于 v..."。
 */
export function buildGroupDiagnosticMarkdown(
  group: ErrorGroupDetail,
  recentEvents: ErrorEventItem[] = [],
): string {
  const lines: string[] = []

  lines.push(`# 客户端崩溃分组 · #${group.id}`)
  lines.push('')

  // ── 概览 ──
  lines.push('## 概览')
  lines.push(`- **指纹**：\`${group.fingerprint}\``)
  lines.push(`- **状态**：${group.status}`)
  lines.push(`- **级别**：${group.level.toUpperCase()}`)
  lines.push(`- **出现次数**：${group.event_count}`)
  lines.push(`- **影响用户**：${group.user_count}`)
  lines.push(`- **首次出现**：${formatLocalTime(group.first_seen, true)}`)
  lines.push(`- **最近出现**：${formatLocalTime(group.last_seen, true)}`)
  lines.push(`- **示例版本**：${group.sample_app_version || '-'}`)
  lines.push('')

  lines.push('### 标题')
  lines.push(fenceCode('text', group.title))
  lines.push('')

  // ── 示例 React 组件栈 ──
  if (group.sample_component_stack) {
    lines.push('## React 组件栈（示例）')
    if (group.resolved_component_stack) {
      lines.push('**还原后**：')
      lines.push(fenceCode('text', group.resolved_component_stack))
      lines.push('')
      lines.push('<details><summary>原始组件栈</summary>')
      lines.push('')
      lines.push(fenceCode('text', group.sample_component_stack))
      lines.push('')
      lines.push('</details>')
    } else {
      lines.push(fenceCode('text', group.sample_component_stack))
    }
    lines.push('')
  }

  // ── 示例堆栈 ──
  if (group.sample_stack_trace) {
    lines.push('## JS 堆栈（示例）')
    if (group.resolved_stack_trace) {
      lines.push('**还原后**：')
      lines.push(fenceCode('text', group.resolved_stack_trace))
      lines.push('')
      lines.push('<details><summary>原始堆栈</summary>')
      lines.push('')
      lines.push(fenceCode('text', group.sample_stack_trace))
      lines.push('')
      lines.push('</details>')
    } else {
      lines.push(fenceCode('text', group.sample_stack_trace))
    }
    lines.push('')
  }

  // ── 最近事件简要列表（不含完整堆栈） ──
  if (recentEvents.length > 0) {
    lines.push(`## 最近事件（${recentEvents.length} 条）`)
    for (const e of recentEvents) {
      const when = formatLocalTime(e.occurred_at, true)
      const who = e.user_id ? `user=${e.user_id.slice(0, 8)}…` : '匿名'
      const ver = e.app_version ? ` v${e.app_version}` : ''
      const dev = e.os_name ? ` ${e.os_name}/${e.arch}` : ''
      lines.push(`- \`#${e.id}\` ${when} · ${who}${ver}${dev}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
