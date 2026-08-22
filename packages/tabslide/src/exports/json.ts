/**
 * JSON 序列化 — 保存/加载项目数据
 *
 * 支持：
 * - 序列化 SlidePresentation → JSON 字符串
 * - 反序列化 JSON → SlidePresentation（含版本校验）
 * - 下载为 .tabslide.json 文件
 * - 从文件读取
 * - 自动补全缺失字段（向后兼容）
 */

import type { SlidePresentation } from '../types/slides'
import { DEFAULT_ACCENT_COLORS } from './backend-adapter'

/** 文件格式版本号 */
const FORMAT_VERSION = 1

/** 持久化包装结构 */
export interface TabSlideFile {
  /** 文件格式标识 */
  format: 'tabslide'
  /** 格式版本 */
  version: number
  /** 保存时间（ISO 8601） */
  savedAt: string
  /** 演示文稿数据 */
  presentation: SlidePresentation
}

// ═══════════════════════════════════════════════
// 序列化
// ═══════════════════════════════════════════════

/** 将 SlidePresentation 序列化为带元信息的 JSON 字符串 */
export function serializePresentation(
  presentation: SlidePresentation,
  pretty = false,
): string {
  const file: TabSlideFile = {
    format: 'tabslide',
    version: FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    presentation,
  }
  return JSON.stringify(file, null, pretty ? 2 : undefined)
}

/** 将 SlidePresentation 序列化为纯数据 JSON（不含包装） */
export function serializePresentationRaw(
  presentation: SlidePresentation,
  pretty = false,
): string {
  return JSON.stringify(presentation, null, pretty ? 2 : undefined)
}

// ═══════════════════════════════════════════════
// 反序列化
// ═══════════════════════════════════════════════

export interface DeserializeResult {
  success: boolean
  presentation?: SlidePresentation
  error?: string
  warnings?: string[]
}

/** 从 JSON 字符串反序列化 */
export function deserializePresentation(json: string): DeserializeResult {
  try {
    const parsed = JSON.parse(json)
    const warnings: string[] = []

    // 情况 1: TabSlide 包装格式
    if (parsed.format === 'tabslide') {
      const file = parsed as TabSlideFile
      if (file.version > FORMAT_VERSION) {
        warnings.push(`文件版本 (${file.version}) 高于当前支持版本 (${FORMAT_VERSION})，部分数据可能丢失`)
      }
      const pres = migratePresentation(file.presentation, warnings)
      return { success: true, presentation: pres, warnings: warnings.length > 0 ? warnings : undefined }
    }

    // 情况 2: 纯 SlidePresentation JSON
    if (parsed.pages && parsed.canvasWidth) {
      const pres = migratePresentation(parsed as SlidePresentation, warnings)
      return { success: true, presentation: pres, warnings: warnings.length > 0 ? warnings : undefined }
    }

    return { success: false, error: '无法识别的文件格式，请确认是有效的 .tabslide.json 文件' }
  } catch (err) {
    return { success: false, error: `JSON 解析失败: ${(err as Error).message}` }
  }
}

/** 数据迁移/补全（向后兼容），不修改原始对象 */
function migratePresentation(input: SlidePresentation, warnings: string[]): SlidePresentation {
  const p: SlidePresentation = structuredClone(input)
  if (!p.id) { p.id = crypto.randomUUID?.() ?? `pres-${Date.now()}`; warnings.push('已自动生成 id') }
  if (!p.name) p.name = '未命名演示文稿'
  if (!p.canvasWidth) p.canvasWidth = 1280
  if (!p.canvasHeight) p.canvasHeight = 720
  if (!p.pages) p.pages = []

  // preset 推断
  if (!p.preset) {
    const ratio = (p.canvasWidth || 1280) / (p.canvasHeight || 720)
    if (ratio > 1.5) p.preset = '16:9'
    else if (ratio > 1.2) p.preset = '4:3'
    else if (ratio < 0.8) p.preset = 'poster'
    else if ((p.canvasHeight || 0) > (p.canvasWidth || 0)) p.preset = 'xiaohongshu'
    else p.preset = '16:9'
  }

  // theme 合并：部分存在时补全缺失的必填字段，而非全量覆盖
  const defaultTheme = {
    backgroundColor: '#ffffff',
    themeColors: [...DEFAULT_ACCENT_COLORS],
    fontColor: '#333333',
    fontName: 'Microsoft YaHei',
  }
  if (!p.theme) {
    p.theme = { ...defaultTheme }
  } else {
    if (!p.theme.backgroundColor) p.theme.backgroundColor = defaultTheme.backgroundColor
    if (!Array.isArray(p.theme.themeColors) || p.theme.themeColors.length === 0) {
      p.theme.themeColors = defaultTheme.themeColors
      warnings.push('主题调色板缺失，已使用默认调色板')
    }
    if (!p.theme.fontColor) p.theme.fontColor = defaultTheme.fontColor
    if (!p.theme.fontName) p.theme.fontName = defaultTheme.fontName
  }

  // 补全每页字段
  for (const page of p.pages) {
    if (!page.id) page.id = crypto.randomUUID?.() ?? `page-${Date.now()}-${Math.random()}`
    if (!page.elements) page.elements = []
    for (const el of page.elements) {
      if (!el.id) el.id = crypto.randomUUID?.() ?? `el-${Date.now()}-${Math.random()}`
      if (el.opacity === undefined) el.opacity = 1
      if (el.locked === undefined) el.locked = false
    }
  }

  return p
}

// ═══════════════════════════════════════════════
// 文件操作
// ═══════════════════════════════════════════════

/** 下载为 .tabslide.json 文件 */
export function downloadAsJSON(
  presentation: SlidePresentation,
  filename?: string,
): void {
  const json = serializePresentation(presentation, true)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const name = filename || `${presentation.name || '演示文稿'}.tabslide.json`

  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 从用户选择的文件读取并反序列化 */
export function loadFromFile(): Promise<DeserializeResult> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: DeserializeResult) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onWindowFocus)
      resolve(result)
    }

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.tabslide.json'

    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        settle({ success: false, error: '未选择文件' })
        return
      }

      try {
        const text = await file.text()
        settle(deserializePresentation(text))
      } catch (err) {
        settle({ success: false, error: `文件读取失败: ${(err as Error).message}` })
      }
    }

    input.oncancel = () => settle({ success: false, error: '已取消' })

    // 兼容不支持 oncancel 的旧 Chromium / Electron：窗口重新获得焦点后
    // 若仍无文件选择则判定为取消
    const onWindowFocus = () => {
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) {
          settle({ success: false, error: '已取消' })
        }
      }, 500)
    }
    window.addEventListener('focus', onWindowFocus)

    input.click()
  })
}

/** 计算演示文稿数据大小（字节） */
export function estimateSize(presentation: SlidePresentation): number {
  return new TextEncoder().encode(JSON.stringify(presentation)).length
}

/** 格式化字节数 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}
