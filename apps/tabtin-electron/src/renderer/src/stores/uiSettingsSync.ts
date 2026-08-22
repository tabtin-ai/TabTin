/** @store-category prefs */

/**
 * uiSettingsSync —— IA Phase 2 个人偏好跨设备同步的公共内核（renderer 侧）。
 *
 * 提供给 5 个 renderer store（theme/fontSize/colorScheme/voiceHotwords/
 * resourceOpenPrefs）复用的能力：
 *   1. per-namespace `updatedAt` 注册表（localStorage），用于 last-write-wins 合并；
 *   2. 防抖批量 PUT（authed 才写穿、合并多 namespace 为一次请求、失败静默重试）；
 *   3. `reconcileNamespace` 通用 LWW 合并（远端较新才应用、且只在值确有差异时切，
 *      本地较新则推回服务器）；
 *   4. `extractRemoteSettings` 把 GET 响应 / WS envelope 的多种嵌套形态稳健地
 *      归一成 `UISettingsMap`。
 *
 * 设计取舍：注册表用裸 localStorage 而非再开一个 zustand store——它要在登录
 * effect / WS 回调等非 React 上下文同步读写，且必须独立于各业务 store 的
 * hydration 时序。登出时该 key 不在保留名单 → 一并清除（跟人走）。
 */

import apiService from '@/services/api'
import { createLogger } from '@/utils/logger'
import { unwrapUISettingsMap } from '@shared/ui-settings-envelope'
import { PERSIST_KEYS } from './persist-key-registry'
import {
  UI_SETTINGS_NAMESPACES,
  type UISettingsNamespace,
  type UISettingEnvelope,
  type UISettingsMap,
} from '@/types/uiSettings'

const log = createLogger('UISettingsSync')

const REGISTRY_KEY = PERSIST_KEYS.uiSettingsSync

// ── per-namespace updatedAt 注册表 ──────────────────────────────

function readRegistry(): Record<string, number> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(REGISTRY_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, number>
    }
  } catch {
    /* localStorage 不可用 / JSON 损坏：当作空注册表 */
  }
  return {}
}

function writeRegistry(reg: Record<string, number>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg))
  } catch {
    /* 写失败静默——同步是尽力而为，丢失时间戳最坏只是下次被服务器值覆盖 */
  }
}

export function getLocalUpdatedAt(namespace: UISettingsNamespace): number {
  const value = readRegistry()[namespace]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function setLocalUpdatedAt(namespace: UISettingsNamespace, updatedAt: number): void {
  const reg = readRegistry()
  reg[namespace] = updatedAt
  writeRegistry(reg)
}

/** 标记某 namespace 刚被本地改动，返回写入的时间戳。 */
export function markLocalChange(namespace: UISettingsNamespace): number {
  const ts = Date.now()
  setLocalUpdatedAt(namespace, ts)
  return ts
}

// ── 防抖批量 PUT ────────────────────────────────────────────────

const SAVE_DEBOUNCE_MS = 600
const RETRY_BASE_DELAY_MS = 5_000
const MAX_RETRY = 5

interface PendingEntry {
  build: () => unknown
  updatedAt: number
}

const pending = new Map<UISettingsNamespace, PendingEntry>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let retryCount = 0

/**
 * 调度一次 namespace 写穿。authed 才入队；多次调用合并到一次 PUT。
 * `updatedAt` 缺省取注册表当前值（由 `markLocalChange` / reconcile 预先写好），
 * 仍为 0 时兜底 `Date.now()` 并回写注册表，保证 PUT 出去的时间戳与本地一致。
 */
export function scheduleNamespaceSave(
  namespace: UISettingsNamespace,
  build: () => unknown,
  updatedAt?: number,
): void {
  if (!apiService.isAuthenticated()) return
  let ts = typeof updatedAt === 'number' ? updatedAt : getLocalUpdatedAt(namespace)
  if (!ts) {
    ts = Date.now()
    setLocalUpdatedAt(namespace, ts)
  }
  pending.set(namespace, { build, updatedAt: ts })
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => void flushPending(), SAVE_DEBOUNCE_MS)
}

async function flushPending(): Promise<void> {
  flushTimer = null
  if (pending.size === 0) return
  if (!apiService.isAuthenticated()) {
    pending.clear()
    return
  }

  const snapshot = new Map(pending)
  pending.clear()

  const settings: UISettingsMap = {}
  for (const [namespace, entry] of snapshot) {
    ;(settings as Record<string, UISettingEnvelope>)[namespace] = {
      value: entry.build(),
      updatedAt: entry.updatedAt,
    }
  }

  try {
    await apiService.updateUISettings({ settings })
    retryCount = 0
  } catch (error) {
    // 失败静默重试：把这批（未被更新值覆盖的 namespace）重新入队，退避后再试。
    for (const [namespace, entry] of snapshot) {
      if (!pending.has(namespace)) pending.set(namespace, entry)
    }
    if (retryCount < MAX_RETRY) {
      retryCount += 1
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = setTimeout(() => void flushPending(), RETRY_BASE_DELAY_MS * retryCount)
    } else {
      log.warn('updateUISettings 连续重试失败，丢弃本批次（下次本地改动会重新触发）', error)
      pending.clear()
      retryCount = 0
    }
  }
}

// ── 通用 LWW 合并 ──────────────────────────────────────────────

/**
 * 单 namespace 的 last-write-wins 合并。
 *
 * - 远端存在且 `updatedAt >= 本地` → 远端胜：仅当值确有差异时才 `applyRemoteValue`
 *   （首屏不闪 / 避免无谓重渲染），并把本地 updatedAt 对齐到远端。
 * - 否则（远端缺失 或 本地较新）→ 本地胜：把本地值推回服务器（seed / 刷新），
 *   本地 updatedAt 兜底为当前值或 now。
 *
 * 注：voiceHotwords 因为是"列表型长期资产"需要并集合并，不走此通用函数，
 *     在其 store 内单独实现。
 */
export function reconcileNamespace<T>(opts: {
  namespace: UISettingsNamespace
  remote: UISettingEnvelope<T> | undefined
  getLocalValue: () => T
  applyRemoteValue: (value: T) => void
  equals?: (a: T, b: T) => boolean
  buildSaveValue?: () => unknown
}): void {
  const { namespace, remote, getLocalValue, applyRemoteValue } = opts
  const equals = opts.equals ?? Object.is
  const localUpdatedAt = getLocalUpdatedAt(namespace)

  if (remote && typeof remote.updatedAt === 'number' && remote.updatedAt >= localUpdatedAt) {
    if (!equals(getLocalValue(), remote.value)) {
      applyRemoteValue(remote.value)
    }
    setLocalUpdatedAt(namespace, remote.updatedAt)
    return
  }

  // 本地较新 / 远端缺失 → 推回服务器（保住刚 rehydrate 上来的 legacy 值，risk ④）。
  const ts = localUpdatedAt || Date.now()
  setLocalUpdatedAt(namespace, ts)
  scheduleNamespaceSave(namespace, opts.buildSaveValue ?? getLocalValue, ts)
}

// ── 远端形态归一 ──────────────────────────────────────────────

/**
 * 把 GET 响应 / WS envelope 的多种嵌套形态归一成 `UISettingsMap`。
 *
 * 解包逻辑由 main / renderer 共享的纯函数 `unwrapUISettingsMap` 统一实现
 * （`@shared/ui-settings-envelope`，单一事实源，严禁两端各造一套）；这里只负责
 * 把扁平 map 收窄到已知 namespace 的强类型 `UISettingsMap`。
 */
export function extractRemoteSettings(input: unknown): UISettingsMap {
  const flat = unwrapUISettingsMap(input)
  const out: UISettingsMap = {}
  for (const namespace of UI_SETTINGS_NAMESPACES) {
    const entry = flat[namespace]
    if (entry) {
      ;(out as Record<string, UISettingEnvelope>)[namespace] = {
        value: entry.value,
        updatedAt: entry.updatedAt,
      }
    }
  }
  return out
}
