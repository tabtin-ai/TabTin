/**
 * Tracker WS 事件类型与 payload 解析（波次 4 Stage 2.5 一刀切版）。
 *
 * - 主 topic ``tracker.events.{organizationId}``、event type ``tracker.*``、payload
 *   字段 ``tracker_id``（原 ``goal_id`` 命名遗留全部下线）。
 * - 单 Skill 执行模型下不再有「步骤」概念，已删除以下类型与解析函数：
 *     - TrackerStepEvent / parseTrackerStepPayload
 *     - TrackerCheckpointEvent / parseTrackerCheckpointPayload
 *     - TrackerStepSubProgressEvent / parseTrackerStepSubProgressPayload
 *   后端 TrackerEvent 中对应的 STEP_STARTED / STEP_FINISHED / STEP_SUB_PROGRESS /
 *   CHECKPOINT 常量已同步删除。
 */

import { createLogger } from '@/utils/logger'

const log = createLogger('TrackerWS')

export interface TrackerProgressEvent {
  tracker_id: string
  run_id: string
  space_id?: string | null
  progress: number
  status: string
  progress_pct?: number
  progress_message?: string | null
  tokens_used?: number
  current_cycle?: number
  max_cycles?: number
}

/** Wave 6 charter §4.4: Skill 失败时的可恢复动作；前端通知中心按钮渲染源 */
export interface TrackerRecoveryAction {
  kind: string
  label: string
  model?: string
}

export interface TrackerRunCompletedEvent {
  tracker_id: string
  run_id: string
  space_id?: string | null
  status: string
  duration: number | null
  // Wave 6 charter §4.4「看产物 1 步可达」：后端按 skill→app 映射推断产物 app 跳转
  skill_key?: string | null
  artifact_ref?: Record<string, unknown> | null
}

export interface TrackerRunFailedEvent {
  tracker_id: string
  run_id: string
  space_id?: string | null
  status: string
  error_summary: string
  duration: number | null
  // Wave 6 charter §4.4 续作：失败也能跳产物 app（半成品/草稿场景）
  skill_key?: string | null
  // Wave 6 charter §4.4 续作 P0-4：可点击恢复动作列表（rerun / retry_with_model / 等）
  recovery_actions?: TrackerRecoveryAction[]
}

/** 用户主动取消产生的事件（与 RUN_FAILED 区分语义，避免 UI 显示「失败」红色误导） */
export interface TrackerRunCancelledEvent {
  tracker_id: string
  run_id: string
  space_id?: string | null
  status: string
  duration: number | null
}

export interface TrackerHealthAlertEvent {
  tracker_id: string
  space_id?: string | null
  alert_type: string
  [key: string]: unknown
}

export interface TrackerTriggerFilteredEvent {
  tracker_id: string
  event_type: string
  event_label: string
  reason: string
  space_id?: string | null
}

const _warnedTypes = new Set<string>()

/**
 * parse 返回 null 时调用：按 type 去重输出 warn，便于排查后端字段变更。
 * 生产环境不会影响性能（Set lookup + 已 warn 的跳过）。
 */
export function warnTrackerPayloadDropped(
  msgType: string,
  raw: Record<string, unknown>,
  source: string,
): void {
  const key = `${source}:${msgType}`
  if (_warnedTypes.has(key)) return
  _warnedTypes.add(key)
  log.warn(
    `[${source}] Tracker event dropped: parse returned null`,
    { type: msgType, keys: Object.keys(raw) },
  )
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k]
  return typeof v === 'string' ? v : undefined
}

function num(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k]
  return typeof v === 'number' && !Number.isNaN(v) ? v : undefined
}

function optSpaceId(o: Record<string, unknown>): string | null | undefined {
  const v = o.space_id
  if (v === null) return null
  return typeof v === 'string' ? v : undefined
}

/**
 * 从 WS envelope 中提取 Tracker 事件的 payload。
 * 标准 envelope 结构 ``{ type, payload: {...} }``；payload 缺失时返回 null。
 *
 * ``allowFlatEnvelope=true``：兼容历史 agenda 路径上扁平合并到 envelope 的情况；
 * 主路径（tracker.events.*）始终走 nested payload，无需此 fallback。
 */
export function extractTrackerPayload(
  envelope: Record<string, unknown>,
  allowFlatEnvelope = false,
): Record<string, unknown> | null {
  const nested = asRecord(envelope.payload)
  if (nested) return nested
  return allowFlatEnvelope ? envelope : null
}

export function parseTrackerProgressPayload(raw: Record<string, unknown>): TrackerProgressEvent | null {
  const tracker_id = str(raw, 'tracker_id')
  const run_id = str(raw, 'run_id')
  if (!tracker_id || !run_id) return null
  const progress = num(raw, 'progress') ?? 0
  const status = str(raw, 'status') ?? ''
  const out: TrackerProgressEvent = {
    tracker_id,
    run_id,
    space_id: optSpaceId(raw) ?? null,
    progress,
    status,
  }
  const progress_pct = num(raw, 'progress_pct')
  if (progress_pct !== undefined) out.progress_pct = progress_pct
  const pm = raw.progress_message
  if (typeof pm === 'string' || pm === null) out.progress_message = pm
  const tokens_used = num(raw, 'tokens_used')
  if (tokens_used !== undefined) out.tokens_used = tokens_used
  const current_cycle = num(raw, 'current_cycle')
  if (current_cycle !== undefined) out.current_cycle = current_cycle
  const max_cycles = num(raw, 'max_cycles')
  if (max_cycles !== undefined) out.max_cycles = max_cycles
  return out
}

function optSkillKey(raw: Record<string, unknown>): string | null | undefined {
  const v = raw.skill_key
  if (v === null) return null
  return typeof v === 'string' ? v : undefined
}

function optArtifactRef(raw: Record<string, unknown>): Record<string, unknown> | null | undefined {
  const v = raw.artifact_ref
  if (v === null) return null
  return asRecord(v) ?? undefined
}

function optRecoveryActions(raw: Record<string, unknown>): TrackerRecoveryAction[] | undefined {
  const v = raw.recovery_actions
  if (!Array.isArray(v)) return undefined
  const out: TrackerRecoveryAction[] = []
  for (const item of v) {
    const rec = asRecord(item)
    if (!rec) continue
    const kind = str(rec, 'kind')
    const label = str(rec, 'label')
    if (!kind || !label) continue
    const action: TrackerRecoveryAction = { kind, label }
    const model = str(rec, 'model')
    if (model) action.model = model
    out.push(action)
  }
  return out.length > 0 ? out : undefined
}

export function parseTrackerRunCompletedPayload(raw: Record<string, unknown>): TrackerRunCompletedEvent | null {
  const tracker_id = str(raw, 'tracker_id')
  const run_id = str(raw, 'run_id')
  if (!tracker_id || !run_id) return null
  const status = str(raw, 'status') ?? ''
  const duration = raw.duration === null ? null : (num(raw, 'duration') ?? null)
  const out: TrackerRunCompletedEvent = {
    tracker_id,
    run_id,
    space_id: optSpaceId(raw) ?? null,
    status,
    duration,
  }
  const skill_key = optSkillKey(raw)
  if (skill_key !== undefined) out.skill_key = skill_key
  const artifact_ref = optArtifactRef(raw)
  if (artifact_ref !== undefined) out.artifact_ref = artifact_ref
  return out
}

export function parseTrackerRunFailedPayload(raw: Record<string, unknown>): TrackerRunFailedEvent | null {
  const tracker_id = str(raw, 'tracker_id')
  const run_id = str(raw, 'run_id')
  if (!tracker_id || !run_id) return null
  const status = str(raw, 'status') ?? ''
  const error_summary = str(raw, 'error_summary') ?? ''
  const duration = raw.duration === null ? null : (num(raw, 'duration') ?? null)
  const out: TrackerRunFailedEvent = {
    tracker_id,
    run_id,
    space_id: optSpaceId(raw) ?? null,
    status,
    error_summary,
    duration,
  }
  const skill_key = optSkillKey(raw)
  if (skill_key !== undefined) out.skill_key = skill_key
  const recovery_actions = optRecoveryActions(raw)
  if (recovery_actions !== undefined) out.recovery_actions = recovery_actions
  return out
}

export function parseTrackerRunCancelledPayload(raw: Record<string, unknown>): TrackerRunCancelledEvent | null {
  const tracker_id = str(raw, 'tracker_id')
  const run_id = str(raw, 'run_id')
  if (!tracker_id || !run_id) return null
  const status = str(raw, 'status') ?? 'cancelled'
  const duration = raw.duration === null ? null : (num(raw, 'duration') ?? null)
  return {
    tracker_id,
    run_id,
    space_id: optSpaceId(raw) ?? null,
    status,
    duration,
  }
}

export function parseTrackerHealthAlertPayload(raw: Record<string, unknown>): TrackerHealthAlertEvent | null {
  const tracker_id = str(raw, 'tracker_id')
  const alert_type = str(raw, 'alert_type')
  if (!tracker_id || !alert_type) return null
  const base: TrackerHealthAlertEvent = {
    tracker_id,
    space_id: optSpaceId(raw) ?? null,
    alert_type,
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k !== 'tracker_id' && k !== 'space_id' && k !== 'alert_type') {
      (base as Record<string, unknown>)[k] = v
    }
  }
  return base
}

export function parseTrackerTriggerFilteredPayload(
  raw: Record<string, unknown>,
): TrackerTriggerFilteredEvent | null {
  const tracker_id = str(raw, 'tracker_id')
  const event_type = str(raw, 'event_type')
  const event_label = str(raw, 'event_label')
  const reason = str(raw, 'reason')
  if (!tracker_id || !event_type || !event_label || !reason) return null
  return {
    tracker_id,
    event_type,
    event_label,
    reason,
    space_id: optSpaceId(raw) ?? null,
  }
}
