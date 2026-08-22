/**
 * Sentry 事件脱敏（Electron 主/渲染进程 + Daemon 共享 beforeSend 钩子）
 *
 * 契约：docs/agent/error-context-schema.md——
 * 外部平台只收结构性现场，token / 手机号 / 邮箱 / 家目录用户名不出境。
 * 复用诊断包同款脱敏规则（diagnostics-redact.ts），保证「本地诊断包」与
 * 「Sentry 上报」两条通道的脱敏口径一致。
 *
 * 用结构化宽类型而非 @sentry/* 的 Event 类型：shared 层不绑定具体 SDK 包，
 * @sentry/electron（主/渲染）与 @sentry/node（Daemon）的事件都能过这一个函数。
 */

import { redact } from './diagnostics-redact.js'

interface SentryEventLike {
  message?: unknown
  logentry?: { message?: unknown }
  exception?: {
    values?: Array<{
      value?: unknown
      stacktrace?: { frames?: Array<{ abs_path?: unknown; filename?: unknown }> }
    }>
  }
  breadcrumbs?: Array<{ message?: unknown; data?: Record<string, unknown> }>
  request?: {
    url?: unknown
    query_string?: unknown
    data?: unknown
    headers?: unknown
    cookies?: unknown
  }
  user?: { id?: unknown; [key: string]: unknown }
  server_name?: unknown
}

function redactNestedStrings(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redact(value)
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = redactNestedStrings(value[index], seen)
    }
    return value
  }
  for (const [key, nested] of Object.entries(value)) {
    (value as Record<string, unknown>)[key] = redactNestedStrings(nested, seen)
  }
  return value
}

/** beforeSend：对事件的文本部位全量脱敏，请求体直接丢弃。原地修改并原样返回。 */
export function scrubSentryEvent<E>(event: E): E {
  const e = event as SentryEventLike
  // server_name 是 SDK 默认采集的主机名——Electron/Daemon 跑在用户设备上，
  // 主机名常含真名（如 "xxx的Mac-mini.local"），属 PII，整体丢弃。
  // （Django 端不走本函数，服务器主机名保留用于多实例定位。）
  delete e.server_name
  if (e.user) {
    e.user = typeof e.user.id === 'string' && e.user.id ? { id: e.user.id } : undefined
  }
  if (typeof e.message === 'string') {
    e.message = redact(e.message)
  }
  if (e.logentry && typeof e.logentry.message === 'string') {
    e.logentry.message = redact(e.logentry.message)
  }
  for (const value of e.exception?.values ?? []) {
    if (typeof value.value === 'string') {
      value.value = redact(value.value)
    }
    for (const frame of value.stacktrace?.frames ?? []) {
      if (typeof frame.abs_path === 'string') frame.abs_path = redact(frame.abs_path)
      if (typeof frame.filename === 'string') frame.filename = redact(frame.filename)
    }
  }
  for (const crumb of e.breadcrumbs ?? []) {
    if (typeof crumb.message === 'string') {
      crumb.message = redact(crumb.message)
    }
    // fetch/xhr 面包屑的 url（query 可能带 token/邮箱）在 data 里，不在 message
    if (crumb.data) {
      redactNestedStrings(crumb.data)
    }
  }
  if (e.request) {
    // 结构性现场原则：请求体（可能含用户内容）不出境
    delete e.request.data
    delete e.request.headers
    delete e.request.cookies
    if (typeof e.request.query_string === 'string') {
      e.request.query_string = redact(e.request.query_string)
    }
    if (typeof e.request.url === 'string') {
      e.request.url = redact(e.request.url)
    }
  }
  return event
}
