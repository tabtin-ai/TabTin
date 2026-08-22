/**
 * useTableAppearanceStore 单元测试 — 「多维表格风格选择串库」根因修复
 *
 * 覆盖：
 *   1. per-table 独立：A 表 set serif、B 表 set mono，互不影响
 *   2. getTableAppearance：未设过的表回落 defaultAppearance
 *   3. 持久化往返（byTable 落 localStorage，命中 PERSIST_KEYS.tableAppearance）
 *   4. applyTableFontSettings：把一套外观写到根级 --table-font-* CSS 变量
 *   5. cleanupStaleTables / reset
 *
 * setup.ts 的 afterEach 会清 localStorage；但 zustand store 是 module singleton——
 * 每个测试用 setState 重置内存态。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  useTableAppearanceStore,
  applyTableFontSettings,
  DEFAULT_TABLE_APPEARANCE,
  TABLE_FONT_WEIGHT_MAP,
  SERIF_FONT_FAMILY,
  MONO_FONT_FAMILY,
} from './useTableAppearanceStore'
import { PERSIST_KEYS } from './persist-key-registry'

beforeEach(() => {
  useTableAppearanceStore.setState({
    byTable: {},
    defaultAppearance: { ...DEFAULT_TABLE_APPEARANCE },
  })
})

describe('useTableAppearanceStore — per-table 独立', () => {
  it('A 表 set serif、B 表 set mono，互不影响', () => {
    const store = useTableAppearanceStore.getState()
    store.setTableFontStyle('table-A', 'serif')
    store.setTableFontStyle('table-B', 'mono')

    const after = useTableAppearanceStore.getState()
    expect(after.getTableAppearance('table-A').style).toBe('serif')
    expect(after.getTableAppearance('table-B').style).toBe('mono')
    // 关键回归断言：A 的风格不会串到 B
    expect(after.getTableAppearance('table-A').style).not.toBe(
      after.getTableAppearance('table-B').style,
    )
  })

  it('字重 / 字号也按表独立', () => {
    const store = useTableAppearanceStore.getState()
    store.setTableFontWeight('table-A', 'semibold')
    store.setTableFontSize('table-A', 16)
    store.setTableFontWeight('table-B', 'thin')
    store.setTableFontSize('table-B', 13)

    const after = useTableAppearanceStore.getState()
    expect(after.getTableAppearance('table-A')).toMatchObject({ weight: 'semibold', size: 16 })
    expect(after.getTableAppearance('table-B')).toMatchObject({ weight: 'thin', size: 13 })
  })

  it('改 A 表的某一项不会带出 B 表的其它项', () => {
    const store = useTableAppearanceStore.getState()
    store.setTableFontStyle('table-A', 'serif')
    store.setTableFontWeight('table-A', 'medium')
    // B 表只动字号，其余应仍是默认
    store.setTableFontSize('table-B', 14)

    const after = useTableAppearanceStore.getState()
    expect(after.getTableAppearance('table-B')).toEqual({
      style: DEFAULT_TABLE_APPEARANCE.style,
      weight: DEFAULT_TABLE_APPEARANCE.weight,
      size: 14,
    })
  })
})

describe('useTableAppearanceStore — 回落与清理', () => {
  it('getTableAppearance 对未设过的表回落 defaultAppearance', () => {
    const store = useTableAppearanceStore.getState()
    expect(store.getTableAppearance('never-touched')).toEqual(DEFAULT_TABLE_APPEARANCE)
    expect(store.getTableAppearance(null)).toEqual(DEFAULT_TABLE_APPEARANCE)
    expect(store.getTableAppearance(undefined)).toEqual(DEFAULT_TABLE_APPEARANCE)
  })

  it('defaultAppearance 作为兜底基线被无表项的表读到', () => {
    useTableAppearanceStore.setState({
      byTable: {},
      defaultAppearance: { style: 'serif', weight: 'medium', size: 14 },
    })
    const store = useTableAppearanceStore.getState()
    expect(store.getTableAppearance('x')).toEqual({ style: 'serif', weight: 'medium', size: 14 })
  })

  it('cleanupStaleTables 只保留有效表', () => {
    const store = useTableAppearanceStore.getState()
    store.setTableFontStyle('keep', 'serif')
    store.setTableFontStyle('drop', 'mono')
    store.cleanupStaleTables(['keep'])

    const after = useTableAppearanceStore.getState()
    expect(after.byTable.keep).toBeDefined()
    expect(after.byTable.drop).toBeUndefined()
  })

  it('reset 清空 byTable 并把 defaultAppearance 拉回系统默认', () => {
    useTableAppearanceStore.setState({
      byTable: { a: { style: 'serif', weight: 'thin', size: 16 } },
      defaultAppearance: { style: 'mono', weight: 'semibold', size: 14 },
    })
    useTableAppearanceStore.getState().reset()
    const after = useTableAppearanceStore.getState()
    expect(after.byTable).toEqual({})
    expect(after.defaultAppearance).toEqual(DEFAULT_TABLE_APPEARANCE)
  })
})

describe('useTableAppearanceStore — 持久化往返', () => {
  it('byTable 落 localStorage（命中 PERSIST_KEYS.tableAppearance）', () => {
    const store = useTableAppearanceStore.getState()
    store.setTableFontStyle('table-A', 'serif')
    store.setTableFontSize('table-A', 16)

    const raw = localStorage.getItem(PERSIST_KEYS.tableAppearance)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.state.byTable['table-A']).toMatchObject({ style: 'serif', size: 16 })
    expect(parsed.version).toBe(1)
  })
})

describe('applyTableFontSettings — 根级 CSS 变量', () => {
  it('serif 把 family / weight / size 写到 document root', () => {
    applyTableFontSettings({ style: 'serif', weight: 'semibold', size: 16 })
    const root = document.documentElement
    expect(root.style.getPropertyValue('--table-font-family')).toBe(SERIF_FONT_FAMILY)
    expect(root.style.getPropertyValue('--table-font-weight')).toBe(
      String(TABLE_FONT_WEIGHT_MAP.semibold),
    )
    expect(root.style.getPropertyValue('--table-font-size')).toBe('16px')
  })

  it('mono 覆盖前一次写入（模拟切到另一张表）', () => {
    applyTableFontSettings({ style: 'serif', weight: 'regular', size: 13 })
    applyTableFontSettings({ style: 'mono', weight: 'regular', size: 12 })
    const root = document.documentElement
    expect(root.style.getPropertyValue('--table-font-family')).toBe(MONO_FONT_FAMILY)
    expect(root.style.getPropertyValue('--table-font-size')).toBe('12px')
  })
})
