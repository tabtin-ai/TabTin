/**
 * PPTElement → SceneObjects 适配器
 *
 * 将 TabSlide 的 PPTElement[] 转换为 media-core 的 SceneObjects 格式，
 * 使 tabslide 能直接使用 `@tabtin/media-core/fonts` 的 scanFonts 扫描能力。
 *
 * 映射策略：
 *   - PPTTextElement   → type:"text", fontFamily=defaultFontName, content 从 HTML 解析为树
 *   - PPTShapeElement  → 若有 text，同上处理
 *   - PPTTableElement  → 每个 cell 展开为独立 text shape
 *   - 其他元素类型不含字体信息，跳过
 */

import type { SceneObjects } from '@tabtin/media-core/fonts/types'
import { scanFonts } from '@tabtin/media-core/fonts'
import type { ScanResult } from '@tabtin/media-core/fonts'
import type {
  PPTElement,
  PPTTextElement,
  PPTShapeElement,
  PPTTableElement,
  TableCellStyle,
} from '../types/slides'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 将 PPTElement[] 转换为 media-core SceneObjects 格式，
 * 然后调用 scanFonts 扫描出所有使用的字体。
 */
export function scanSlideFonts(elements: PPTElement[]): ScanResult {
  const objects = adaptElementsToSceneObjects(elements)
  return scanFonts(objects)
}

/**
 * 仅做转换，不调用 scanFonts — 方便外部组合使用。
 */
export function adaptElementsToSceneObjects(elements: PPTElement[]): SceneObjects {
  const objects: SceneObjects = {}

  for (const el of elements) {
    switch (el.type) {
      case 'text':
        adaptTextElement(objects, el)
        break
      case 'shape':
        adaptShapeElement(objects, el)
        break
      case 'table':
        adaptTableElement(objects, el)
        break
      // 其他元素类型（image, line, chart, latex, video, audio, canvas）不含字体引用
    }
  }

  return objects
}

// ---------------------------------------------------------------------------
// Internal — element adapters
// ---------------------------------------------------------------------------

function adaptTextElement(objects: SceneObjects, el: PPTTextElement): void {
  objects[el.id] = {
    type: 'text',
    fontFamily: el.defaultFontName || undefined,
    fontWeight: undefined,
    fontStyle: undefined,
    content: htmlToContentTree(el.content, el.defaultFontName),
    name: el.name,
  }
}

function adaptShapeElement(objects: SceneObjects, el: PPTShapeElement): void {
  if (!el.text?.content) return

  objects[el.id] = {
    type: 'text',
    fontFamily: el.text.defaultFontName || undefined,
    fontWeight: undefined,
    fontStyle: undefined,
    content: htmlToContentTree(el.text.content, el.text.defaultFontName),
    name: el.name,
  }
}

function adaptTableElement(objects: SceneObjects, el: PPTTableElement): void {
  for (let r = 0; r < el.data.length; r++) {
    for (let c = 0; c < el.data[r].length; c++) {
      const cell = el.data[r][c]
      if (!cell) continue

      const textContent = cell.richText || cell.text
      if (!textContent) continue

      const fontFamily = resolveCellFontFamily(cell.style)
      const syntheticId = `${el.id}__r${r}c${c}`

      objects[syntheticId] = {
        type: 'text',
        fontFamily: fontFamily || undefined,
        fontWeight: cell.style?.bold ? 'bold' : undefined,
        fontStyle: cell.style?.italic ? 'italic' : undefined,
        content: htmlToContentTree(textContent, fontFamily),
        name: undefined,
      }
    }
  }
}

/**
 * 从 TableCellStyle 中获取字体族名称。
 * fontName 优先（新字段），fontFamily 为旧数据兼容。
 */
function resolveCellFontFamily(style?: TableCellStyle): string | undefined {
  if (!style) return undefined
  return style.fontName || style.fontFamily || undefined
}

// ---------------------------------------------------------------------------
// Internal — HTML → content tree 转换
//
// media-core 的 scanner 期望 content 为对象树结构：
//   root: { children: [ paragraph: { children: [ leaf: { text, fontFamily?, ... } ] } ] }
//
// PPTElement 的 content 是 TipTap 兼容的 HTML 字符串。
// 这里做轻量级解析，从 HTML 中提取 font-family/font-weight/font-style 信息。
// 不依赖 DOM parser（兼容 headless/worker 环境）。
// ---------------------------------------------------------------------------

interface ContentNode {
  text?: string
  fontFamily?: string
  fontWeight?: string
  fontStyle?: string
  children?: ContentNode[]
}

/**
 * 将 HTML 字符串转换为 scanner 能遍历的内容树。
 *
 * 策略：用正则提取所有文本片段及其内联 style 中的字体属性。
 * 这是轻量级方案，不需要完整 HTML parser。
 */
function htmlToContentTree(html: string, defaultFontFamily?: string): ContentNode {
  const leaves: ContentNode[] = []

  // 提取 <span style="...">text</span> 中的字体属性和文本
  // 以及裸文本内容
  const segments = extractTextSegments(html)

  for (const seg of segments) {
    if (!seg.text) continue
    const leaf: ContentNode = { text: seg.text }
    if (seg.fontFamily) leaf.fontFamily = seg.fontFamily
    else if (defaultFontFamily) leaf.fontFamily = defaultFontFamily
    if (seg.fontWeight) leaf.fontWeight = seg.fontWeight
    if (seg.fontStyle) leaf.fontStyle = seg.fontStyle
    leaves.push(leaf)
  }

  // 如果没有提取到任何片段，尝试把整个 HTML 当纯文本处理
  if (leaves.length === 0) {
    const plainText = stripHtmlTags(html)
    if (plainText) {
      const leaf: ContentNode = { text: plainText }
      if (defaultFontFamily) leaf.fontFamily = defaultFontFamily
      leaves.push(leaf)
    }
  }

  return { children: [{ children: leaves }] }
}

interface TextSegment {
  text: string
  fontFamily?: string
  fontWeight?: string
  fontStyle?: string
}

/**
 * 从 HTML 中提取文本片段及其关联的字体样式。
 *
 * 处理模式：
 * 1. <span style="font-family: X; font-weight: Y; font-style: Z">text</span>
 * 2. <strong>/<b> → fontWeight: 'bold'
 * 3. <em>/<i> → fontStyle: 'italic'
 * 4. 裸文本
 */
function extractTextSegments(html: string): TextSegment[] {
  const segments: TextSegment[] = []

  // 正则逐步匹配标签和文本
  // 使用状态机思路：遇到带 style 的 span 时提取字体属性
  let remaining = html
  let inheritedWeight: string | undefined
  let inheritedStyle: string | undefined

  while (remaining.length > 0) {
    // 匹配 HTML 开始标签
    const tagMatch = remaining.match(/^<(\w+)([^>]*)>/)
    if (tagMatch) {
      const tagName = tagMatch[1].toLowerCase()
      const attrs = tagMatch[2]
      remaining = remaining.slice(tagMatch[0].length)

      // 处理 bold 标签
      if (tagName === 'strong' || tagName === 'b') {
        inheritedWeight = 'bold'
        continue
      }
      // 处理 italic 标签
      if (tagName === 'em' || tagName === 'i') {
        inheritedStyle = 'italic'
        continue
      }

      // 处理 span with style
      if (tagName === 'span' && attrs) {
        const styleMatch = attrs.match(/style\s*=\s*"([^"]*)"/)
          || attrs.match(/style\s*=\s*'([^']*)'/)
        if (styleMatch) {
          const styleStr = styleMatch[1]
          const fontFamily = extractCssProperty(styleStr, 'font-family')
          const fontWeight = extractCssProperty(styleStr, 'font-weight')
          const fontStyle = extractCssProperty(styleStr, 'font-style')

          // 提取到关闭 </span> 之前的文本
          const closeIdx = remaining.indexOf('</span>')
          if (closeIdx !== -1) {
            const innerHtml = remaining.slice(0, closeIdx)
            remaining = remaining.slice(closeIdx + '</span>'.length)
            const innerText = stripHtmlTags(innerHtml)
            if (innerText) {
              segments.push({
                text: innerText,
                fontFamily: cleanFontFamily(fontFamily) || undefined,
                fontWeight: fontWeight || inheritedWeight || undefined,
                fontStyle: fontStyle || inheritedStyle || undefined,
              })
            }
            continue
          }
        }
      }
      continue
    }

    // 匹配关闭标签
    const closeMatch = remaining.match(/^<\/(\w+)>/)
    if (closeMatch) {
      const tagName = closeMatch[1].toLowerCase()
      remaining = remaining.slice(closeMatch[0].length)
      if (tagName === 'strong' || tagName === 'b') inheritedWeight = undefined
      if (tagName === 'em' || tagName === 'i') inheritedStyle = undefined
      continue
    }

    // 匹配自闭合标签 (<br/>, <br>, etc.)
    const selfCloseMatch = remaining.match(/^<[^>]*\/?>/)
    if (selfCloseMatch) {
      remaining = remaining.slice(selfCloseMatch[0].length)
      continue
    }

    // 匹配纯文本（到下一个 < 之前）
    const textEnd = remaining.indexOf('<')
    if (textEnd === -1) {
      // 剩余全是文本
      const text = decodeHtmlEntities(remaining.trim())
      if (text) {
        segments.push({
          text,
          fontWeight: inheritedWeight,
          fontStyle: inheritedStyle,
        })
      }
      break
    }
    if (textEnd > 0) {
      const text = decodeHtmlEntities(remaining.slice(0, textEnd).trim())
      if (text) {
        segments.push({
          text,
          fontWeight: inheritedWeight,
          fontStyle: inheritedStyle,
        })
      }
      remaining = remaining.slice(textEnd)
    }
  }

  return segments
}

/**
 * 从 CSS style 字符串中提取指定属性的值。
 */
function extractCssProperty(styleStr: string, property: string): string | undefined {
  const re = new RegExp(`${property}\\s*:\\s*([^;]+)`, 'i')
  const m = styleStr.match(re)
  return m ? m[1].trim() : undefined
}

/**
 * 清理 CSS font-family 值：去掉引号和 fallback 字体。
 * "Noto Sans SC", sans-serif → Noto Sans SC
 */
function cleanFontFamily(raw?: string): string | undefined {
  if (!raw) return undefined
  // 取第一个 font family（逗号分隔）
  const first = raw.split(',')[0].trim()
  // 去掉引号
  return first.replace(/^['"]|['"]$/g, '') || undefined
}

/**
 * 移除 HTML 标签，保留纯文本。
 */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim()
}

/**
 * 解码常见 HTML 实体。
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}
