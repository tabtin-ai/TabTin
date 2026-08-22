/** @store-category prefs */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS, LEGACY_KEY_MAP } from './persist-key-registry'
import { registerResetAction } from './sessionResetRegistry'

/**
 * TabData「风格」面板的字体外观偏好（字体 / 字重 / 字号）。
 *
 * 历史背景：这三项曾作为「用户级全局偏好」存在 useUIStore，
 * 没有按表区分，导致 A 表选的风格串到 B 表。行高一直是对的（存在
 * view.config 按视图隔离）。本 store 把字体三件套改为 **per-table 独立**：
 * 结构 `Record<tableId, TableAppearance>`，切表时由表格面板加载并重应用
 * `--table-font-*` 根级 CSS 变量（只有 active tab 写 root）。
 */

export type TableFontStyle = 'system' | 'serif' | 'mono' | 'rounded'
export type TableFontWeight = 'thin' | 'regular' | 'medium' | 'semibold'
export type TableFontSize = 12 | 13 | 14 | 16

export interface TableAppearance {
  style: TableFontStyle
  weight: TableFontWeight
  size: TableFontSize
}

export const DEFAULT_TABLE_FONT_STYLE: TableFontStyle = 'system'
export const DEFAULT_TABLE_FONT_WEIGHT: TableFontWeight = 'regular'
export const DEFAULT_TABLE_FONT_SIZE: TableFontSize = 12

export const DEFAULT_TABLE_APPEARANCE: TableAppearance = {
  style: DEFAULT_TABLE_FONT_STYLE,
  weight: DEFAULT_TABLE_FONT_WEIGHT,
  size: DEFAULT_TABLE_FONT_SIZE,
}

const TABLE_FONT_STYLE_VALUES: TableFontStyle[] = ['system', 'serif', 'mono', 'rounded']
const TABLE_FONT_WEIGHT_VALUES: TableFontWeight[] = ['thin', 'regular', 'medium', 'semibold']
const TABLE_FONT_SIZE_VALUES: TableFontSize[] = [12, 13, 14, 16]

export const TABLE_FONT_WEIGHT_MAP: Record<TableFontWeight, number> = {
  thin: 300,
  regular: 400,
  medium: 500,
  semibold: 600,
}

export const SYSTEM_FONT_FAMILY =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif'
export const SERIF_FONT_FAMILY = '"Songti SC", "STSong", Georgia, "Times New Roman", serif'
export const MONO_FONT_FAMILY =
  '"JetBrains Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
export const ROUNDED_FONT_FAMILY =
  '"SF Pro Rounded", "Avenir Next Rounded", "Nunito", "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif'

const TABLE_FONT_FAMILY_MAP: Record<TableFontStyle, string> = {
  system: SYSTEM_FONT_FAMILY,
  serif: SERIF_FONT_FAMILY,
  mono: MONO_FONT_FAMILY,
  rounded: ROUNDED_FONT_FAMILY,
}

export const normalizeTableFontStyle = (value: unknown): TableFontStyle => {
  if (typeof value === 'string' && TABLE_FONT_STYLE_VALUES.includes(value as TableFontStyle)) {
    return value as TableFontStyle
  }
  return DEFAULT_TABLE_FONT_STYLE
}

export const normalizeTableFontWeight = (value: unknown): TableFontWeight => {
  // 兼容旧版本存量值
  if (value === 'bold') {
    return 'semibold'
  }
  if (typeof value === 'string' && TABLE_FONT_WEIGHT_VALUES.includes(value as TableFontWeight)) {
    return value as TableFontWeight
  }
  return DEFAULT_TABLE_FONT_WEIGHT
}

export const normalizeTableFontSize = (value: unknown): TableFontSize => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (TABLE_FONT_SIZE_VALUES.includes(parsed as TableFontSize)) {
    return parsed as TableFontSize
  }
  return DEFAULT_TABLE_FONT_SIZE
}

const normalizeAppearance = (value: unknown): TableAppearance => {
  const source = (value ?? {}) as Partial<TableAppearance>
  return {
    style: normalizeTableFontStyle(source.style),
    weight: normalizeTableFontWeight(source.weight),
    size: normalizeTableFontSize(source.size),
  }
}

/**
 * 把一套外观写入根级 CSS 变量（CanvasGridAdapter 通过 MutationObserver 消费）。
 * 仅 active tab 调用——保证 root 上始终只反映当前激活表的那套。
 */
export const applyTableFontSettings = (appearance: TableAppearance): void => {
  if (typeof document === 'undefined') return

  const { style, weight, size } = normalizeAppearance(appearance)
  const fontFamily = TABLE_FONT_FAMILY_MAP[style]
  const numericWeight = TABLE_FONT_WEIGHT_MAP[weight]
  const headerWeight = Math.min(numericWeight + 200, 700)

  const root = document.documentElement
  root.style.setProperty('--table-font-family', fontFamily)
  root.style.setProperty('--table-font-weight', String(numericWeight))
  root.style.setProperty('--table-header-font-weight', String(headerWeight))
  root.style.setProperty('--table-font-size', `${size}px`)
}

/**
 * 升级一次性种子：把旧版「全局字体偏好」（曾存在 useUIStore 的
 * tabtin-prefs-ui）读出来当作新 store 的 `defaultAppearance`，让升级用户
 * 在尚未给具体表设过风格时仍看到原来的字体（不丢风格、不 crash）。
 *
 * 时序保证：本函数在模块加载（同步）时执行，先于 useUIStore 那条 200ms
 * 防抖落盘——所以即便 useUIStore 之后会 strip 掉这三个字段，这里也已经
 * 抢先读到旧值。
 */
const readLegacyGlobalAppearance = (): TableAppearance => {
  if (typeof localStorage === 'undefined') {
    return { ...DEFAULT_TABLE_APPEARANCE }
  }

  const legacyUiKeys = [
    PERSIST_KEYS.ui,
    ...Object.entries(LEGACY_KEY_MAP)
      .filter(([, mapped]) => mapped === PERSIST_KEYS.ui)
      .map(([legacyKey]) => legacyKey),
  ]

  for (const key of legacyUiKeys) {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw)
      const state = (parsed?.state ?? parsed) as Record<string, unknown> | null
      if (!state) continue
      if (
        state.tableFontStyle !== undefined ||
        state.tableFontWeight !== undefined ||
        state.tableFontSize !== undefined
      ) {
        return {
          style: normalizeTableFontStyle(state.tableFontStyle),
          weight: normalizeTableFontWeight(state.tableFontWeight),
          size: normalizeTableFontSize(state.tableFontSize),
        }
      }
    } catch {
      // 解析失败就跳过，回落默认
    }
  }

  return { ...DEFAULT_TABLE_APPEARANCE }
}

interface TableAppearanceState {
  /** per-table 外观；未设过的表回落到 defaultAppearance */
  byTable: Record<string, TableAppearance>
  /** 全表默认外观——新用户为系统默认；升级用户种子自旧的全局偏好 */
  defaultAppearance: TableAppearance

  getTableAppearance: (tableId?: string | null) => TableAppearance
  setTableFontStyle: (tableId: string, style: TableFontStyle) => void
  setTableFontWeight: (tableId: string, weight: TableFontWeight) => void
  setTableFontSize: (tableId: string, size: TableFontSize) => void
  cleanupStaleTables: (validTableIds: string[]) => void
  reset: () => void
}

const isBrowser = typeof window !== 'undefined' && typeof localStorage !== 'undefined'

export const useTableAppearanceStore = create<TableAppearanceState>()(
  persist(
    (set, get) => {
      const updateTable = (tableId: string, patch: Partial<TableAppearance>) => {
        if (!tableId) return
        set(state => {
          const current = state.byTable[tableId] ?? state.defaultAppearance
          const next = normalizeAppearance({ ...current, ...patch })
          return {
            byTable: {
              ...state.byTable,
              [tableId]: next,
            },
          }
        })
      }

      return {
        byTable: {},
        defaultAppearance: readLegacyGlobalAppearance(),

        getTableAppearance: (tableId) => {
          if (!tableId) return get().defaultAppearance
          return get().byTable[tableId] ?? get().defaultAppearance
        },

        setTableFontStyle: (tableId, style) => updateTable(tableId, { style }),
        setTableFontWeight: (tableId, weight) => updateTable(tableId, { weight }),
        setTableFontSize: (tableId, size) => updateTable(tableId, { size }),

        cleanupStaleTables: (validTableIds) => {
          if (validTableIds.length === 0) return
          const validSet = new Set(validTableIds)
          set(state => {
            const next: Record<string, TableAppearance> = {}
            for (const [tableId, appearance] of Object.entries(state.byTable)) {
              if (validSet.has(tableId)) next[tableId] = appearance
            }
            return { byTable: next }
          })
        },

        reset: () => {
          set({ byTable: {}, defaultAppearance: { ...DEFAULT_TABLE_APPEARANCE } })
        },
      }
    },
    withPersistSafety({
      name: PERSIST_KEYS.tableAppearance,
      storage: isBrowser ? createJSONStorage(() => localStorage) : undefined,
      version: 1,
      partialize: (state) => ({
        byTable: state.byTable,
        defaultAppearance: state.defaultAppearance,
      }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<TableAppearanceState>
        const byTableSource = persisted.byTable ?? {}
        const byTable: Record<string, TableAppearance> = {}
        for (const [tableId, appearance] of Object.entries(byTableSource)) {
          byTable[tableId] = normalizeAppearance(appearance)
        }
        return {
          ...currentState,
          byTable,
          // 已持久化（老用户首次升级后即落盘）→ 用持久值；否则保留模块初始化时
          // 种子出来的 defaultAppearance（旧全局偏好），避免升级丢风格。
          defaultAppearance: persisted.defaultAppearance
            ? normalizeAppearance(persisted.defaultAppearance)
            : currentState.defaultAppearance,
        }
      },
    })
  )
)

// 登出 / 换账号时清空——与 useTableViewUiStore（同为 per-table 本地偏好）一致，
// 避免把上一个账号的表外观留给下一个账号。localStorage 由 sessionReset 统一清，
// 这里把内存态拉回默认。
registerResetAction('table-appearance', 'reset', () => useTableAppearanceStore.getState().reset())
