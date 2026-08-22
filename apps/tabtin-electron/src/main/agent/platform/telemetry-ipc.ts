/**
 * Telemetry IPC handlers（Electron 宿主）。
 *
 * 让 renderer / 客服 UI / DevTools 能通过 IPC 发送 MTTR 标记事件：
 *   - `telemetry:mttr:start`      —— 开始事故计时
 *   - `telemetry:mttr:resolved`   —— 标记事故根因定位完成
 *   - `telemetry:event`           —— 通用出口，让运维可从 DevTools 手工上报特殊事件
 *
 * 设计原则：
 *   - 所有 IPC 入参必须经最小校验（避免 renderer 发送任意内容）
 *   - description / resolution 强制限长，避免日志爆炸
 *   - 失败不抛异常（telemetry 是旁路）
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  emitMttrStart,
  emitMttrResolved,
  generateIncidentId,
  emitTelemetryEvent,
  TelemetryEvents,
} from '@tabtin/agent-runtime'

interface MttrStartRequest {
  incident_id?: string
  description?: string
  reporter?: string
  session_id?: string
  severity?: string
}

interface MttrResolvedRequest {
  incident_id: string
  resolution?: string
  duration_ms?: number
  resolver?: string
  session_id?: string
  error_class?: string
}

interface GenericEventRequest {
  event_name?: string
  payload?: Record<string, unknown>
  session_id?: string
  agent_id?: string
  trace_id?: string
}

const MAX_DESC_LEN = 200
const MAX_RESOLUTION_LEN = 400
const MAX_EVENT_NAME_LEN = 128

/**
 * Renderer 侧可发的事件 allowlist（Review #8 收窄）。
 * 默认只允许 MTTR / 运维诊断类事件；业务埋点应在 Main 进程发起。
 * 若你想新增入口，必须：
 *   1. 在此处加常量（明文）
 *   2. 在 TELEMETRY.md 登记调用方场景
 *   3. 评估是否需要更严格的 payload 校验
 */
const RENDERER_ALLOWED_EVENT_NAMES = new Set<string>([
  TelemetryEvents.MTTR_START,
  TelemetryEvents.MTTR_RESOLVED,
  // 运维/QA 诊断通道：必须以 `manual.` 前缀打头
])
const RENDERER_ALLOWED_EVENT_PREFIXES = ['manual.']

const MAX_PAYLOAD_KEYS = 20
const MAX_PAYLOAD_DEPTH = 2

/**
 * 速率限制：renderer 每 60 秒最多上报 120 条（超额静默丢弃，防 bug 渲染进程把 disk 打爆）。
 *
 * 三个 IPC 入口**共用**同一个限流桶：
 *   - `telemetry:event` —— 通用出口，原本就有限流
 *   - `telemetry:mttr:start` / `telemetry:mttr:resolved`（Verifier-C 补齐，真实场景下
 *     人工标记每分钟 < 5 次，共享桶不会被业务流挤占；但防御恶意脚本刷日志必要）
 *
 * 共享桶的副作用：若 renderer 脚本大量发 `manual.*` 诊断，会连累 MTTR 标记被限流。
 * 产品取舍：单进程速率限制本就是总量控制，这是正确的。如果 MTTR 需要独立桶可后续分拆。
 */
const EMIT_RATE_WINDOW_MS = 60_000
const EMIT_RATE_LIMIT = 120
let emitRateBucket: { windowStart: number; count: number } = {
  windowStart: 0,
  count: 0,
}

function withinRateLimit(now: number): boolean {
  if (now - emitRateBucket.windowStart > EMIT_RATE_WINDOW_MS) {
    emitRateBucket = { windowStart: now, count: 0 }
  }
  if (emitRateBucket.count >= EMIT_RATE_LIMIT) return false
  emitRateBucket.count += 1
  return true
}

let registered = false

export function registerTelemetryIpcHandlers(): void {
  if (registered) return
  registered = true

  ipcMain.handle(
    'telemetry:mttr:start',
    (_event: IpcMainInvokeEvent, req: MttrStartRequest = {}) => {
      if (!withinRateLimit(Date.now())) {
        return { success: false, reason: 'rate_limited' }
      }
      const incidentId = sanitizeId(req.incident_id) ?? generateIncidentId()
      emitMttrStart({
        incident_id: incidentId,
        description: truncate(req.description ?? 'unspecified', MAX_DESC_LEN),
        ...(req.reporter ? { reporter: truncate(req.reporter, 80) } : {}),
        ...(req.session_id ? { session_id: req.session_id } : {}),
        ...(req.severity ? { severity: truncate(req.severity, 16) } : {}),
      })
      return { success: true, incident_id: incidentId }
    },
  )

  ipcMain.handle(
    'telemetry:mttr:resolved',
    (_event: IpcMainInvokeEvent, req: MttrResolvedRequest) => {
      if (!req?.incident_id) {
        return { success: false, reason: 'missing_incident_id' }
      }
      if (!withinRateLimit(Date.now())) {
        return { success: false, reason: 'rate_limited' }
      }
      const duration = Number.isFinite(req.duration_ms) ? Math.max(0, Number(req.duration_ms)) : 0
      emitMttrResolved({
        incident_id: sanitizeId(req.incident_id) ?? req.incident_id,
        resolution: truncate(req.resolution ?? 'resolved', MAX_RESOLUTION_LEN),
        duration_ms: duration,
        ...(req.resolver ? { resolver: truncate(req.resolver, 80) } : {}),
        ...(req.session_id ? { session_id: req.session_id } : {}),
        ...(req.error_class ? { error_class: truncate(req.error_class, 80) } : {}),
      })
      return { success: true }
    },
  )

  // 运维通用出口：DevTools 里调 window.api.telemetry.emit(...) 发送受限事件
  // **安全约束**（Review #8）：
  //   - 事件名必须在 allowlist 或带 `manual.` 前缀，防 renderer 伪造业务事件污染指标
  //   - payload 深度 ≤ 2、键数量 ≤ 20，防构造大对象打爆磁盘
  //   - 速率限制：每分钟最多 120 次
  ipcMain.handle('telemetry:event', (_event: IpcMainInvokeEvent, req: GenericEventRequest) => {
    if (!req?.event_name || typeof req.event_name !== 'string') {
      return { success: false, reason: 'missing_event_name' }
    }
    const eventName = truncate(req.event_name, MAX_EVENT_NAME_LEN)
    if (!isEventNameAllowed(eventName)) {
      return { success: false, reason: 'event_name_not_allowed' }
    }
    if (!withinRateLimit(Date.now())) {
      return { success: false, reason: 'rate_limited' }
    }
    const payload = sanitizePayload(req.payload ?? {})
    emitTelemetryEvent(eventName, payload, {
      ...(req.session_id ? { session_id: req.session_id } : {}),
      ...(req.agent_id ? { agent_id: req.agent_id } : {}),
      ...(req.trace_id ? { trace_id: req.trace_id } : {}),
    })
    return { success: true }
  })
}

function isEventNameAllowed(name: string): boolean {
  if (RENDERER_ALLOWED_EVENT_NAMES.has(name)) return true
  return RENDERER_ALLOWED_EVENT_PREFIXES.some((p) => name.startsWith(p))
}

function truncate(input: string, max: number): string {
  return typeof input === 'string' && input.length > max ? input.slice(0, max) : (input ?? '')
}

function sanitizeId(input: string | undefined | null): string | undefined {
  if (typeof input !== 'string') return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined
  if (trimmed.length > 128) return trimmed.slice(0, 128)
  return trimmed
}

/**
 * 防御式过滤 payload：
 *   - 丢弃函数 / undefined / symbol / bigint
 *   - 长字符串截断 + 标记原长度（> 1000 字符）
 *   - 键数量上限 `MAX_PAYLOAD_KEYS`（默认 20），超出部分丢弃并添加 `_truncated` 标记
 *   - 嵌套深度上限 `MAX_PAYLOAD_DEPTH`（默认 2），超出层改为 `[object depth limit]`
 *
 * 设计意图：renderer 被注入/被攻击时无法刷爆 telemetry 磁盘。
 */
function sanitizePayload(
  raw: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let keyCount = 0
  let truncated = false

  for (const [key, value] of Object.entries(raw)) {
    if (keyCount >= MAX_PAYLOAD_KEYS) {
      truncated = true
      break
    }
    const sanitized = sanitizeValue(value, depth)
    if (sanitized === SKIP) continue
    if (typeof value === 'string' && value.length > 1000) {
      out[key] = sanitized
      out[`${key}_len`] = value.length
    } else {
      out[key] = sanitized
    }
    keyCount += 1
  }
  if (truncated) {
    out._truncated = true
  }
  return out
}

const SKIP = Symbol('skip')

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'function' || t === 'undefined' || t === 'symbol' || t === 'bigint') {
    return SKIP
  }
  if (t === 'string') {
    return (value as string).length > 1000 ? `${(value as string).slice(0, 1000)}…` : value
  }
  if (t === 'number' || t === 'boolean') return value
  if (Array.isArray(value)) {
    if (depth >= MAX_PAYLOAD_DEPTH) return '[array depth limit]'
    return value.slice(0, 50).map((v) => sanitizeValue(v, depth + 1))
  }
  if (t === 'object') {
    if (depth >= MAX_PAYLOAD_DEPTH) return '[object depth limit]'
    return sanitizePayload(value as Record<string, unknown>, depth + 1)
  }
  return SKIP
}
