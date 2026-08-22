/**
 * 共享字体列表逻辑
 *
 * 提供系统字体枚举、降级检测、运行时字体合并，
 * 供 TextBubbleMenu / StyleEditor 等字体选择器复用。
 *
 * 本地字体检测能力已提取到 @tabtin/media-core/fonts（local-fonts），
 * 此文件复用 media-core 的 queryLocalFonts / isFontAvailable 实现。
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  getRuntimeFontFamilies,
  subscribeRuntimeFontFamilies,
} from './runtime-fonts'
import {
  getSharedFontCatalog,
  loadSharedFont,
  type SharedFontEntry,
} from './font-bridge'
import {
  queryLocalFonts as queryLocalFontsCore,
  isFontAvailable,
  type LocalFontInfo,
} from '@tabtin/media-core/fonts'

export interface FontDef {
  label: string
  value: string
  group: string
}

export interface FontItem {
  label: string
  value: string
  group?: string
}

const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF]/

function isCJKFont(family: string): boolean {
  return CJK_RE.test(family)
}

const SERIF_KEYWORDS = [
  'serif', 'times', 'georgia', 'garamond', 'palatino', 'cambria',
  'baskerville', 'bodoni', 'didot', 'caslon', 'cochin', 'charter',
  'book antiqua', 'song', 'ming', 'batang', 'simsun', 'stsong',
]
const MONO_KEYWORDS = [
  'mono', 'code', 'courier', 'consola', 'menlo', 'monaco', 'hack',
  'fira code', 'source code', 'jetbrains', 'iosevka', 'inconsolata',
]

function classifyFont(family: string): string {
  if (isCJKFont(family)) return 'font.chinese'
  const lc = family.toLowerCase()
  if (/^(pingfang|stkaiti|stheiti|stsong|stfangsong|hiragino|noto sans (sc|tc|jp|kr)|wenquanyi|microsoft yahei|simhei|simsun|kaiti|fangsong|dengxian|fzlantinghei|fzsongti|source han)/i.test(family)) {
    return 'font.chinese'
  }
  for (const kw of MONO_KEYWORDS) if (lc.includes(kw)) return 'font.monospace'
  for (const kw of SERIF_KEYWORDS) if (lc.includes(kw)) return 'font.serif'
  return 'font.sansSerif'
}

/**
 * 通过 media-core 检测系统字体，并转换为 FontDef[] 格式。
 */
async function querySystemFonts(): Promise<FontDef[]> {
  try {
    const localFonts: LocalFontInfo[] = await queryLocalFontsCore()
    if (localFonts.length === 0) return []
    return localFonts
      .map((f) => ({ label: f.family, value: f.family, group: classifyFont(f.family) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans'))
  } catch (e) {
    console.warn('[tabslide] queryLocalFonts failed:', e)
    return []
  }
}

export const FALLBACK_CANDIDATES: FontDef[] = [
  { label: '苹方', value: 'PingFang SC', group: 'font.chinese' },
  { label: '华文宋体', value: 'STSong', group: 'font.chinese' },
  { label: '华文黑体', value: 'STHeiti', group: 'font.chinese' },
  { label: '华文楷体', value: 'STKaiti', group: 'font.chinese' },
  { label: '微软雅黑', value: 'Microsoft YaHei', group: 'font.chinese' },
  { label: '宋体', value: 'SimSun', group: 'font.chinese' },
  { label: '黑体', value: 'SimHei', group: 'font.chinese' },
  { label: 'Noto Sans SC', value: 'Noto Sans SC', group: 'font.chinese' },
  { label: 'Arial', value: 'Arial', group: 'font.sansSerif' },
  { label: 'Helvetica Neue', value: 'Helvetica Neue', group: 'font.sansSerif' },
  { label: 'Verdana', value: 'Verdana', group: 'font.sansSerif' },
  { label: 'Times New Roman', value: 'Times New Roman', group: 'font.serif' },
  { label: 'Georgia', value: 'Georgia', group: 'font.serif' },
  { label: 'Courier New', value: 'Courier New', group: 'font.monospace' },
  { label: 'Menlo', value: 'Menlo', group: 'font.monospace' },
  { label: 'Monaco', value: 'Monaco', group: 'font.monospace' },
]

function getFallbackFonts(): FontDef[] {
  return FALLBACK_CANDIDATES.filter(f => isFontAvailable(f.value))
}

export function buildFontItems(
  systemFonts: FontDef[] | null,
  runtimeFamilies: string[],
  t: (key: string) => string,
): FontItem[] {
  const base = systemFonts && systemFonts.length > 0
    ? [...systemFonts].map(f => ({ ...f, label: f.label, group: t(f.group) }))
    : getFallbackFonts().map(f => ({ ...f, group: t(f.group) }))

  const seen = new Set(base.map((item) => item.value.toLowerCase()))
  const runtimeDefs: FontDef[] = []
  for (const family of runtimeFamilies) {
    const name = family.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    runtimeDefs.push({
      label: `${name} (${t('font.document')})`,
      value: name,
      group: t('font.document'),
    })
  }

  const ORDER: Record<string, number> = {
    [t('font.document')]: 0,
    [t('font.chinese')]: 1,
    [t('font.sansSerif')]: 2,
    [t('font.serif')]: 3,
    [t('font.monospace')]: 4,
  }
  const all = [...base, ...runtimeDefs].sort(
    (a, b) => (ORDER[a.group] ?? 9) - (ORDER[b.group] ?? 9)
      || a.label.localeCompare(b.label, 'zh-Hans'),
  )
  return [{ label: t('font.default'), value: '' }, ...all]
}

/**
 * React Hook：异步加载系统字体列表（含运行时字体）。
 * queryLocalFonts 不可用时降级为 Canvas 检测。
 */
export function useSystemFonts(t: (key: string) => string): FontItem[] {
  const [systemFonts, setSystemFonts] = useState<FontDef[] | null>(null)
  const [runtimeFonts, setRuntimeFonts] = useState<string[]>(() => getRuntimeFontFamilies())

  useEffect(() => {
    let cancelled = false
    querySystemFonts().then((fonts) => {
      if (cancelled) return
      if (fonts.length > 0) setSystemFonts(fonts)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    return subscribeRuntimeFontFamilies((families) => {
      setRuntimeFonts(families)
    })
  }, [])

  return useMemo(
    () => buildFontItems(systemFonts, runtimeFonts, t),
    [systemFonts, runtimeFonts, t],
  )
}

function sharedEntryToFontDef(entry: SharedFontEntry, t: (key: string) => string): FontItem {
  const groupKey = entry.cjk
    ? 'font.chinese'
    : entry.category === 'serif' ? 'font.serif'
    : entry.category === 'monospace' ? 'font.monospace'
    : 'font.sansSerif'
  return {
    label: entry.family,
    value: entry.family,
    group: t(groupKey),
  }
}

/**
 * React Hook：统一字体列表 — 合并系统字体 + media-core 共享字体 + 运行时字体。
 * 共享字体来自 media-core 的 CDN 注册表，可按需通过 @font-face 加载。
 */
export function useUnifiedFonts(t: (key: string) => string): {
  fonts: FontItem[]
  ensureLoaded: (family: string) => Promise<boolean>
} {
  const [systemFonts, setSystemFonts] = useState<FontDef[] | null>(null)
  const [sharedFonts, setSharedFonts] = useState<SharedFontEntry[]>([])
  const [runtimeFonts, setRuntimeFonts] = useState<string[]>(() => getRuntimeFontFamilies())

  useEffect(() => {
    let cancelled = false
    querySystemFonts().then((fonts) => {
      if (cancelled) return
      if (fonts.length > 0) setSystemFonts(fonts)
    })
    getSharedFontCatalog().then((catalog) => {
      if (cancelled) return
      setSharedFonts(catalog)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    return subscribeRuntimeFontFamilies((families) => {
      setRuntimeFonts(families)
    })
  }, [])

  const fonts = useMemo(() => {
    const base = buildFontItems(systemFonts, runtimeFonts, t)
    if (sharedFonts.length === 0) return base

    const seen = new Set(base.map(f => f.value.toLowerCase()))
    const extras: FontItem[] = []
    for (const entry of sharedFonts) {
      const key = entry.family.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      extras.push(sharedEntryToFontDef(entry, t))
    }

    if (extras.length === 0) return base
    const GROUP_ORDER: Record<string, number> = {
      [t('font.document')]: 0,
      [t('font.chinese')]: 1,
      [t('font.sansSerif')]: 2,
      [t('font.serif')]: 3,
      [t('font.monospace')]: 4,
    }
    return [...base, ...extras].sort((a, b) => {
      if (a.value === '') return -1
      if (b.value === '') return 1
      const ga = GROUP_ORDER[a.group ?? ''] ?? 9
      const gb = GROUP_ORDER[b.group ?? ''] ?? 9
      if (ga !== gb) return ga - gb
      return a.label.localeCompare(b.label, 'zh-Hans')
    })
  }, [systemFonts, sharedFonts, runtimeFonts, t])

  const ensureLoaded = useCallback(async (family: string): Promise<boolean> => {
    return loadSharedFont(family)
  }, [])

  return { fonts, ensureLoaded }
}
