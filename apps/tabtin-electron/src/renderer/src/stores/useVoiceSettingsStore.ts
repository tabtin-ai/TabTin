/** @store-category prefs */

/**
 * VoiceSettings Store — 语音识别用户设置
 *
 * 复刻 iOS VoiceSettings.swift 的四层增强能力：
 * 1. 平台热词（自动启用，不可关闭）
 * 2. 应用上下文（对话历史 → ASR context）
 * 3. 自定义热词（用户手动添加，提升识别概率）
 * 4. 替换规则（ASR 识别后做确定性文本替换）
 * 5. 自定义快捷键（用户可修改语音输入快捷键）
 *
 * 另：`enabled` 是模块总开关。关闭后 ChatInput 的麦克风按钮隐藏、
 * 快捷键不响应（其他热词/规则等配置仍保留，不会清空）。
 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared'
import { getBucket, registerStorageBucket } from '@tabtin/storage-manager'
import { PERSIST_KEYS } from './persist-key-registry'
import {
  getLocalUpdatedAt,
  markLocalChange,
  scheduleNamespaceSave,
  setLocalUpdatedAt,
} from './uiSettingsSync'
import { registerResetAction } from './sessionResetRegistry'
import type { UISettingsMap, VoiceHotwordsPayload } from '@/types/uiSettings'

export interface ReplacementRule {
  id: string
  from: string
  to: string
  isEnabled: boolean
}

/**
 * 快捷键序列化格式: "mod+shift+m"
 * - mod = Cmd(macOS) / Ctrl(Windows/Linux)
 * - 修饰键: mod, shift, alt
 * - 主键: 小写字母/数字/符号
 */
export const DEFAULT_VOICE_SHORTCUT = 'mod+shift+m'

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '')

// ---- Key normalization ----

const IGNORED_KEYS = new Set([
  'control', 'meta', 'shift', 'alt', 'capslock', 'tab', 'escape',
  'dead', 'unidentified', 'process',
])

const KEY_NAME_MAP: Record<string, string> = {
  ' ': 'space',
  '+': 'plus',
  'arrowup': 'up',
  'arrowdown': 'down',
  'arrowleft': 'left',
  'arrowright': 'right',
  'backspace': 'backspace',
  'delete': 'delete',
  'enter': 'enter',
}

const KEY_DISPLAY_MAP: Record<string, string> = {
  space: '␣',
  plus: '+',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  backspace: '⌫',
  delete: '⌦',
  enter: '↵',
}

function normalizeKeyName(rawKey: string): string | null {
  const lower = rawKey.toLowerCase()
  if (IGNORED_KEYS.has(lower)) return null
  return KEY_NAME_MAP[lower] ?? lower
}

// ---- Shortcut utilities ----

export function parseShortcut(shortcut: string): { mod: boolean; shift: boolean; alt: boolean; key: string } {
  const parts = shortcut.toLowerCase().split('+').map(s => s.trim()).filter(Boolean)
  const modifiers = new Set(['mod', 'shift', 'alt'])
  const key = parts.find(p => !modifiers.has(p)) ?? ''
  return {
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key,
  }
}

export function matchesShortcut(e: globalThis.KeyboardEvent, shortcut: string): boolean {
  const { mod, shift, alt, key } = parseShortcut(shortcut)
  if (!key) return false
  const modPressed = IS_MAC ? e.metaKey : e.ctrlKey
  if (mod && !modPressed) return false
  if (!mod && modPressed) return false
  if (shift !== e.shiftKey) return false
  if (alt !== e.altKey) return false
  const eventKey = normalizeKeyName(e.key) ?? e.key.toLowerCase()
  return eventKey === key
}

export function formatShortcut(shortcut: string): string {
  const { mod, shift, alt, key } = parseShortcut(shortcut)
  const parts: string[] = []
  if (mod) parts.push(IS_MAC ? '⌘' : 'Ctrl')
  if (alt) parts.push(IS_MAC ? '⌥' : 'Alt')
  if (shift) parts.push(IS_MAC ? '⇧' : 'Shift')
  if (key) {
    const display = KEY_DISPLAY_MAP[key]
    if (display) parts.push(display)
    else parts.push(key.length === 1 ? key.toUpperCase() : key)
  }
  return parts.join(IS_MAC ? '' : '+')
}

export function eventToShortcut(e: globalThis.KeyboardEvent): string | null {
  const key = normalizeKeyName(e.key)
  if (!key) return null
  const parts: string[] = []
  const modPressed = IS_MAC ? e.metaKey : e.ctrlKey
  if (modPressed) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (parts.length === 0) return null
  parts.push(key)
  return parts.join('+')
}

/** 自定义热词新增结果，供 UI 展示失败原因（重复 / 已满）。 */
export type AddHotwordResult = 'added' | 'duplicate' | 'full' | 'empty'
export type AddReplacementRuleResult = 'added' | 'duplicate' | 'full' | 'empty' | 'same'

interface VoiceSettingsState {
  enabled: boolean
  enableAppContext: boolean
  enableDialogContext: boolean
  customHotwords: string[]
  replacementRules: ReplacementRule[]
  voiceShortcut: string

  setEnabled: (value: boolean) => void
  setEnableAppContext: (value: boolean) => void
  setEnableDialogContext: (value: boolean) => void

  addHotword: (word: string) => AddHotwordResult
  removeHotword: (index: number) => void

  addReplacementRule: (from: string, to: string) => AddReplacementRuleResult
  removeReplacementRule: (id: string) => void
  toggleReplacementRule: (id: string) => void

  setVoiceShortcut: (shortcut: string) => void
  resetVoiceShortcut: () => void

  mergedHotwords: (appHotwords?: string[]) => string[]
  applyReplacements: (text: string) => string

  // IA Phase 2 个人偏好同步（namespace = voiceHotwords）。
  // saveToServer：标记本地改动 + 防抖写穿（authed 才发、失败静默重试）。
  // syncFromServer：列表型长期资产做并集合并（绝不整体覆盖），标量按 updatedAt LWW。
  saveToServer: () => void
  syncFromServer: (remote: UISettingsMap) => void
}

// ── voiceHotwords 跨设备合并：列表型长期资产做并集 ────────────────────────
//
// 取舍（与 reviewer 确认的刻意限制）：热词 / 替换规则是用户长期沉淀的资产，
// 合并时做并集、绝不整体覆盖，宁可"多"也不"丢"。代价是 **删除不可靠跨设备
// 传播**——在 A 设备删一条热词/规则，B 设备若仍有该条，下次同步并集会把它
// "复活"回 A。这是无 tombstone 的 LWW 并集的固有局限；若未来要支持可靠删除，
// 需引入按条目的删除墓碑（per-item tombstone）或服务端权威删除。标量字段
// （快捷键 / 开关）不受影响，按 namespace updatedAt 做 last-write-wins。

/** 自定义热词并集（保留顺序、去重、裁到上限）。 */
function unionHotwords(local: string[], remote: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const word of [...local, ...remote]) {
    const trimmed = (word ?? '').trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= MAX_CUSTOM_HOTWORDS) break
  }
  return out
}

/**
 * 替换规则并集（按 id 合并；同 id 时较新一侧覆盖；再按 from 去重维持 store 不变量）。
 * `remoteNewer` 决定同 id 冲突时谁覆盖谁——较旧一侧先放、较新一侧后放覆盖。
 */
function unionRules(
  local: ReplacementRule[],
  remote: ReplacementRule[],
  remoteNewer: boolean,
): ReplacementRule[] {
  const byId = new Map<string, ReplacementRule>()
  const order: string[] = []
  const older = remoteNewer ? local : remote
  const newer = remoteNewer ? remote : local
  for (const rule of [...older, ...newer]) {
    if (!rule || !rule.id || !rule.from) continue
    if (!byId.has(rule.id)) order.push(rule.id)
    byId.set(rule.id, rule)
  }
  const seenFrom = new Set<string>()
  const out: ReplacementRule[] = []
  for (const id of order) {
    const rule = byId.get(id)
    if (!rule || seenFrom.has(rule.from)) continue
    seenFrom.add(rule.from)
    out.push(rule)
    if (out.length >= MAX_REPLACEMENT_RULES) break
  }
  return out
}

const PLATFORM_HOTWORDS = [
  'TabTin', 'TabData', 'TabDoc', 'TabSlide',
  'Agentspace', 'Agent', 'Space',
  'RAG', 'Prompt', 'Skill', 'Memo', 'Composer', 'Crawler',
]

const MAX_CUSTOM_HOTWORDS = 100
const MAX_REPLACEMENT_RULES = 50

function generateRuleId(): string {
  return crypto.randomUUID()
}

export const useVoiceSettingsStore = create<VoiceSettingsState>()(
  persist(
    (set, get) => ({
      enabled: true,
      enableAppContext: true,
      enableDialogContext: true,
      customHotwords: [],
      replacementRules: [],
      voiceShortcut: DEFAULT_VOICE_SHORTCUT,

      setEnabled: (value) => {
        if (get().enabled === value) return
        set({ enabled: value })
        get().saveToServer()
      },
      setEnableAppContext: (value) => {
        if (get().enableAppContext === value) return
        set({ enableAppContext: value })
        get().saveToServer()
      },
      setEnableDialogContext: (value) => {
        if (get().enableDialogContext === value) return
        set({ enableDialogContext: value })
        get().saveToServer()
      },

      addHotword: (word) => {
        const trimmed = word.trim()
        if (!trimmed) return 'empty'
        let result: AddHotwordResult = 'added'
        set(state => {
          if (state.customHotwords.includes(trimmed)) {
            result = 'duplicate'
            return state
          }
          if (state.customHotwords.length >= MAX_CUSTOM_HOTWORDS) {
            result = 'full'
            return state
          }
          return { customHotwords: [...state.customHotwords, trimmed] }
        })
        if (result === 'added') get().saveToServer()
        return result
      },

      removeHotword: (index) => {
        const before = get().customHotwords
        set(state => {
          if (index < 0 || index >= state.customHotwords.length) return state
          const next = [...state.customHotwords]
          next.splice(index, 1)
          return { customHotwords: next }
        })
        if (get().customHotwords !== before) get().saveToServer()
      },

      addReplacementRule: (from, to) => {
        const trimmedFrom = from.trim()
        const trimmedTo = to.trim()
        if (!trimmedFrom) return 'empty'
        // 两侧相同无替换效果；空 to 仍允许（表示删除该词）
        if (trimmedFrom === trimmedTo) return 'same'
        let result: AddReplacementRuleResult = 'added'
        set(state => {
          if (state.replacementRules.some(r => r.from === trimmedFrom)) {
            result = 'duplicate'
            return state
          }
          if (state.replacementRules.length >= MAX_REPLACEMENT_RULES) {
            result = 'full'
            return state
          }
          return {
            replacementRules: [
              ...state.replacementRules,
              { id: generateRuleId(), from: trimmedFrom, to: trimmedTo, isEnabled: true },
            ],
          }
        })
        if (result === 'added') get().saveToServer()
        return result
      },

      removeReplacementRule: (id) => {
        const before = get().replacementRules
        set(state => ({
          replacementRules: state.replacementRules.filter(r => r.id !== id),
        }))
        if (get().replacementRules.length !== before.length) get().saveToServer()
      },

      toggleReplacementRule: (id) => {
        const existed = get().replacementRules.some(r => r.id === id)
        set(state => ({
          replacementRules: state.replacementRules.map(r =>
            r.id === id ? { ...r, isEnabled: !r.isEnabled } : r
          ),
        }))
        if (existed) get().saveToServer()
      },

      setVoiceShortcut: (shortcut) => {
        const parsed = parseShortcut(shortcut)
        if (parsed.key && parsed.mod) {
          if (get().voiceShortcut === shortcut) return
          set({ voiceShortcut: shortcut })
          get().saveToServer()
        }
      },

      resetVoiceShortcut: () => {
        if (get().voiceShortcut === DEFAULT_VOICE_SHORTCUT) return
        set({ voiceShortcut: DEFAULT_VOICE_SHORTCUT })
        get().saveToServer()
      },

      mergedHotwords: (appHotwords) => {
        const state = get()
        const all = [...PLATFORM_HOTWORDS]
        if (state.enableAppContext && appHotwords) {
          all.push(...appHotwords)
        }
        all.push(...state.customHotwords)
        return [...new Set(all.filter(Boolean))]
      },

      applyReplacements: (text) => {
        const { replacementRules } = get()
        if (replacementRules.length === 0) return text
        let result = text
        for (const rule of replacementRules) {
          if (rule.isEnabled && rule.from) {
            result = result.replaceAll(rule.from, rule.to)
          }
        }
        return result
      },

      // ── IA Phase 2 个人偏好同步（namespace = voiceHotwords） ──────
      saveToServer: () => {
        markLocalChange('voiceHotwords')
        scheduleNamespaceSave('voiceHotwords', () => {
          const s = get()
          const payload: VoiceHotwordsPayload = {
            customHotwords: s.customHotwords,
            replacementRules: s.replacementRules,
            voiceShortcut: s.voiceShortcut,
            enableAppContext: s.enableAppContext,
            enableDialogContext: s.enableDialogContext,
            enabled: s.enabled,
          }
          return payload
        })
      },

      syncFromServer: (remote) => {
        const env = remote.voiceHotwords
        const localUpdatedAt = getLocalUpdatedAt('voiceHotwords')

        // 服务器尚无该 namespace → 把本地长期资产推上去 seed（scheduleNamespaceSave
        // 内部 authed 才真正发；非 authed 则只更新本地时间戳，无副作用）。
        if (!env || typeof env.updatedAt !== 'number') {
          get().saveToServer()
          return
        }

        const remoteVal = (env.value ?? {}) as Partial<VoiceHotwordsPayload>
        const remoteNewer = env.updatedAt >= localUpdatedAt
        const local = get()

        // 列表型长期资产：始终并集合并，绝不整体覆盖（risk ②）。
        const remoteHotwords = Array.isArray(remoteVal.customHotwords) ? remoteVal.customHotwords : []
        const remoteRules = Array.isArray(remoteVal.replacementRules) ? remoteVal.replacementRules : []
        const mergedHotwords = unionHotwords(local.customHotwords, remoteHotwords)
        const mergedRules = unionRules(local.replacementRules, remoteRules, remoteNewer)

        const next: Partial<VoiceSettingsState> = {
          customHotwords: mergedHotwords,
          replacementRules: mergedRules,
        }
        // 标量按 updatedAt LWW：仅当远端较新才采用远端标量。
        if (remoteNewer) {
          if (typeof remoteVal.voiceShortcut === 'string') {
            const parsed = parseShortcut(remoteVal.voiceShortcut)
            if (parsed.key && parsed.mod) next.voiceShortcut = remoteVal.voiceShortcut
          }
          if (typeof remoteVal.enableAppContext === 'boolean') next.enableAppContext = remoteVal.enableAppContext
          if (typeof remoteVal.enableDialogContext === 'boolean') next.enableDialogContext = remoteVal.enableDialogContext
          if (typeof remoteVal.enabled === 'boolean') next.enabled = remoteVal.enabled
        }
        set(next)
        setLocalUpdatedAt('voiceHotwords', Math.max(env.updatedAt, localUpdatedAt))

        // 并集后本地若比远端"多"（有远端没有的资产），或本地标量较新 → 把并集推回，
        // 让服务器最终收敛到并集（自己 PUT 引发的 WS 回灌不会再次增长，不成环）。
        const grew =
          mergedHotwords.length > remoteHotwords.length ||
          mergedRules.length > remoteRules.length
        if (grew || !remoteNewer) {
          get().saveToServer()
        }
      },
    }),
    withPersistSafety({
      name: PERSIST_KEYS.voice,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['tabtin-voice-settings'])),
      partialize: (state) => ({
        enabled: state.enabled,
        enableAppContext: state.enableAppContext,
        enableDialogContext: state.enableDialogContext,
        customHotwords: state.customHotwords,
        replacementRules: state.replacementRules,
        voiceShortcut: state.voiceShortcut,
      }),
      // v1 → v2：补齐 enabled 字段（默认 true，保持老用户行为不变）。
      // 这里走 migrate 而不是依赖默认值合并，是因为部分老用户的 persisted
      // payload 里可能显式写入 enabled: undefined，shallow merge 会覆盖默认值。
      version: 2,
      migrate: (persisted: unknown, version: number) => {
        if (!persisted || typeof persisted !== 'object') return persisted
        const p = persisted as Record<string, unknown>
        if (version < 2 && typeof p.enabled !== 'boolean') {
          p.enabled = true
        }
        return p
      },
    })
  )
)

// ─── storage-manager 接入（W3.3 D-5 5 核心导出之 Voice）─────────
//
// Voice 热词与替换规则是用户长期沉淀的资产（D-9 决策：登出也保留），
// 因此暴露成一个独立 bucket，在「我的资产」面板里给"导出 JSON 备份"
// 按钮一个落点。导出格式按 D-5 §1：
//   { customHotwords, replacementRules, voiceShortcut,
//     enableAppContext, enableDialogContext, exportedAt }
//
// 设计决策：
//   - hideFromList: true —— Voice 在"语音设置"页面已经有 UI 入口，
//     不在存储管理面板渲染卡片，仅作为"导出/清理"能力的 SSoT；
//     UI 端从存储管理页面的"Voice 配置"入口或语音设置页直接调
//     exportBucket('system:voice-settings') 触发下载；
//   - data 类 + warnings 强约束（清理会丢自定义热词与替换规则）；
//   - sizeFn 直接读 localStorage 字节数（小数据量，无性能顾虑）。
const VOICE_BUCKET_ID = 'system:voice-settings'
const VOICE_LEGACY_KEY = 'tabtin-voice-settings'

interface VoiceExportPayload {
  schemaVersion: 1
  exportedAt: string
  source: 'tabtin-electron'
  bucketId: string
  enabled: boolean
  voiceShortcut: string
  enableAppContext: boolean
  enableDialogContext: boolean
  customHotwords: string[]
  replacementRules: ReplacementRule[]
}

if (typeof window !== 'undefined' && !getBucket(VOICE_BUCKET_ID)) {
  registerStorageBucket({
    id: VOICE_BUCKET_ID,
    category: 'data',
    group: 'system',
    displayName: 'Voice 热词与替换规则',
    description: '语音输入的自定义热词、替换规则、快捷键与上下文开关（无云端备份）',
    warnings: [
      '清理会永久丢失自定义热词与替换规则，不可恢复',
      '无云端备份——清理前请使用"导出"按钮保留 JSON 备份',
      '快捷键会重置为默认 mod+shift+m',
    ],
    requiresConfirmation: 'hard',
    hideFromList: true,
    sizeFn: async () => {
      try {
        const raw = localStorage.getItem(PERSIST_KEYS.voice) ?? localStorage.getItem(VOICE_LEGACY_KEY)
        if (raw) {
          const bytes = typeof TextEncoder !== 'undefined'
            ? new TextEncoder().encode(raw).length
            : raw.length
          const state = useVoiceSettingsStore.getState()
          const itemCount = state.customHotwords.length + state.replacementRules.length
          return { bytes, itemCount }
        }
      } catch { /* localStorage 不可用 */ }
      const state = useVoiceSettingsStore.getState()
      return {
        bytes: 0,
        itemCount: state.customHotwords.length + state.replacementRules.length,
      }
    },
    clearFn: async (options) => {
      const state = useVoiceSettingsStore.getState()
      const itemCount = state.customHotwords.length + state.replacementRules.length
      let bytes = 0
      try {
        const raw = localStorage.getItem(PERSIST_KEYS.voice) ?? localStorage.getItem(VOICE_LEGACY_KEY)
        if (raw) {
          bytes = typeof TextEncoder !== 'undefined'
            ? new TextEncoder().encode(raw).length
            : raw.length
        }
      } catch { /* ignore */ }
      if (options?.dryRun) {
        return { clearedItemCount: itemCount, freedBytes: bytes }
      }
      useVoiceSettingsStore.setState({
        customHotwords: [],
        replacementRules: [],
        voiceShortcut: DEFAULT_VOICE_SHORTCUT,
        enabled: true,
        enableAppContext: true,
        enableDialogContext: true,
      })
      return { clearedItemCount: itemCount, freedBytes: bytes }
    },
    exportFn: async () => {
      const state = useVoiceSettingsStore.getState()
      // 单次 new Date()——保证 filename 时间戳与 payload.exportedAt 完全一致，
      // 跟其他 4 个 export 的写法对齐。
      const exportedAt = new Date().toISOString()
      const payload: VoiceExportPayload = {
        schemaVersion: 1,
        exportedAt,
        source: 'tabtin-electron',
        bucketId: VOICE_BUCKET_ID,
        enabled: state.enabled,
        voiceShortcut: state.voiceShortcut,
        enableAppContext: state.enableAppContext,
        enableDialogContext: state.enableDialogContext,
        customHotwords: [...state.customHotwords],
        replacementRules: state.replacementRules.map(r => ({ ...r })),
      }
      const ts = exportedAt.replace(/[:.]/g, '-')
      return {
        filename: `tabtin-voice-${ts}.json`,
        data: JSON.stringify(payload, null, 2),
        mimeType: 'application/json',
      }
    },
  })
}

// ── IA Phase 2：登出/换账号时内存重置为默认 ──────────────────────────────
// 与 useUIStore / useResourceOpenPreferences 同款（详见 useUIStore 末尾注释）：
// voiceHotwords 已接后端同步，登出只清 localStorage 会留下上个人的热词/规则在内存，
// 换人登录被"远端缺失→推本地"灌进新账号云端。这里把内存拉回默认，与清 localStorage 对齐。
registerResetAction('voice-prefs-sync', 'reset', () => {
  useVoiceSettingsStore.setState({
    enabled: true,
    enableAppContext: true,
    enableDialogContext: true,
    customHotwords: [],
    replacementRules: [],
    voiceShortcut: DEFAULT_VOICE_SHORTCUT,
  })
})
