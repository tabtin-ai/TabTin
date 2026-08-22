/**
 * Agent 运行时模型本地 sticky（本机偏好）。
 *
 * 与 `Agent.preferred_model_id`（云端平台首选）分工：
 * - 平台模型：切模时仍 PATCH preferred_model_id；本地 sticky 同步记一份
 * - 本机 Codex：不写 preferred_model_id；只记 sticky，供新对话默认
 *
 * 新对话默认顺序：草稿意图 → sticky → Agent 平台首选 → 平台默认
 */

import { isOpenAICodexModel } from '../../../../../shared/openai-codex-models'
import { isSendableChatModelId } from '@/utils/chatModelGuards'

const STORAGE_PREFIX = 'tabtin:agent-runtime-model:'
const PARAMS_STORAGE_PREFIX = 'tabtin:agent-runtime-model-params:'

export type RuntimeModelParamPreferenceValue = string | number | boolean | null

const paramsStorageKey = (agentId: string, modelId: string): string =>
  `${PARAMS_STORAGE_PREFIX}${agentId}:${modelId}`

const isStoredParamValue = (value: unknown): value is Exclude<RuntimeModelParamPreferenceValue, null> =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

export function readRuntimeModelPreference(
  agentId: string | null | undefined,
): string | null {
  if (!agentId || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${agentId}`)
    const trimmed = (raw || '').trim()
    return trimmed && isSendableChatModelId(trimmed) ? trimmed : null
  } catch {
    return null
  }
}

export function writeRuntimeModelPreference(
  agentId: string | null | undefined,
  modelId: string,
): void {
  if (!agentId || typeof window === 'undefined') return
  const trimmed = modelId.trim()
  if (!isSendableChatModelId(trimmed)) return
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${agentId}`, trimmed)
  } catch {
    // 存储失败不阻塞切模
  }
}

/**
 * 读取某个 Agent + 模型上次显式选择的运行参数。
 *
 * 仅保存标量控制值（如 Codex reasoning_effort / service_tier），不复用会话级上下文。
 */
export function readRuntimeModelParamPreference(
  agentId: string | null | undefined,
  modelId: string | null | undefined,
): Record<string, Exclude<RuntimeModelParamPreferenceValue, null>> | null {
  const normalizedAgentId = agentId?.trim()
  const normalizedModelId = modelId?.trim()
  if (!normalizedAgentId || !normalizedModelId || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(paramsStorageKey(normalizedAgentId, normalizedModelId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, Exclude<RuntimeModelParamPreferenceValue, null>] =>
        Boolean(entry[0].trim()) && isStoredParamValue(entry[1]),
    )
    return entries.length > 0 ? Object.fromEntries(entries) : null
  } catch {
    return null
  }
}

/** 记录模型控制项；恢复默认值（null）时删除该项。 */
export function writeRuntimeModelParamPreference(
  agentId: string | null | undefined,
  modelId: string | null | undefined,
  key: string,
  value: RuntimeModelParamPreferenceValue,
): void {
  const normalizedAgentId = agentId?.trim()
  const normalizedModelId = modelId?.trim()
  const normalizedKey = key.trim()
  if (
    !normalizedAgentId
    || !normalizedModelId
    || !normalizedKey
    || typeof window === 'undefined'
  ) return
  if (value !== null && !isStoredParamValue(value)) return

  try {
    const storageKey = paramsStorageKey(normalizedAgentId, normalizedModelId)
    const next = {
      ...(readRuntimeModelParamPreference(normalizedAgentId, normalizedModelId) ?? {}),
    }
    if (value === null) {
      delete next[normalizedKey]
    } else {
      next[normalizedKey] = value
    }
    if (Object.keys(next).length === 0) {
      window.localStorage.removeItem(storageKey)
    } else {
      window.localStorage.setItem(storageKey, JSON.stringify(next))
    }
  } catch {
    // 存储失败不阻塞当前会话切换参数
  }
}

/**
 * 目录可用性检查：平台模型须在 catalog；Codex sticky 不依赖 merge 时机
 * （冷启动 catalog 尚未带上 Codex 时仍应解析并对齐，switchModel 会再验登录）。
 */
export function createRuntimeModelAvailabilityChecker(
  catalogHas: (modelId: string) => boolean,
): (modelId: string) => boolean {
  return (modelId: string) => catalogHas(modelId) || isOpenAICodexModel(modelId)
}

/**
 * 解析新对话 / 草稿应使用的运行时模型 id。
 * 调用方用 `isAvailable` 过滤当前目录里可发送的模型。
 */
export function resolveRuntimeDefaultModelId(options: {
  pendingModelId?: string | null
  stickyModelId?: string | null
  preferredModelId?: string | null
  isAvailable: (modelId: string) => boolean
}): string | undefined {
  for (const candidate of [
    options.pendingModelId,
    options.stickyModelId,
    options.preferredModelId,
  ]) {
    const trimmed = (candidate || '').trim()
    if (!trimmed) continue
    if (!isSendableChatModelId(trimmed)) continue
    if (!options.isAvailable(trimmed)) continue
    return trimmed
  }
  return undefined
}

/**
 * 草稿意图 / sticky 对齐目标（不含平台 preferred）。
 * 用于 create/prefetch 之后、以及草稿首发复用预建会话时——只纠正「UI 已按 sticky 展示但 session 仍是平台模型」的漂移。
 */
export function resolveLocalRuntimeAlignTarget(options: {
  pendingModelId?: string | null
  stickyModelId?: string | null
  catalogHas: (modelId: string) => boolean
}): string | undefined {
  return resolveRuntimeDefaultModelId({
    pendingModelId: options.pendingModelId,
    stickyModelId: options.stickyModelId,
    preferredModelId: null,
    isAvailable: createRuntimeModelAvailabilityChecker(options.catalogHas),
  })
}

/**
 * Django create / quickStart 只能收平台 UUID。
 * Codex sticky 时回退到可用的平台首选；都没有则 undefined（服务端默认）。
 */
export function toProvisionModelId(
  runtimeModelId: string | undefined,
  options?: {
    preferredModelId?: string | null
    isAvailable?: (modelId: string) => boolean
  },
): string | undefined {
  if (runtimeModelId && !isOpenAICodexModel(runtimeModelId)) {
    return runtimeModelId
  }
  const preferred = (options?.preferredModelId || '').trim()
  if (
    preferred
    && !isOpenAICodexModel(preferred)
    && isSendableChatModelId(preferred)
    && (!options?.isAvailable || options.isAvailable(preferred))
  ) {
    return preferred
  }
  return undefined
}
