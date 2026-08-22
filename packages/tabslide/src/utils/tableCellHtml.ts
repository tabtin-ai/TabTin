import type { TableCell } from '../types/slides'
import { sanitizeHtml } from './sanitize'

export const EDITOR_EMPTY_HTML = '<p><br></p>'

// 将 execCommand/computed style 读到的颜色统一为大写 #RRGGBB
export function normalizeCommandColor(raw: string): string | undefined {
  if (!raw) return undefined
  const val = raw.trim()
  if (!val) return undefined

  if (val.startsWith('#')) {
    if (/^#[0-9a-fA-F]{3}$/.test(val)) {
      const r = val[1]
      const g = val[2]
      const b = val[3]
      return `#${r}${r}${g}${g}${b}${b}`.toUpperCase()
    }
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      return val.toUpperCase()
    }
  }

  const rgb = val.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (!rgb) return undefined
  const r = Number(rgb[1]).toString(16).padStart(2, '0')
  const g = Number(rgb[2]).toString(16).padStart(2, '0')
  const b = Number(rgb[3]).toString(16).padStart(2, '0')
  return `#${r}${g}${b}`.toUpperCase()
}

export function plainTextToParagraphHtml(text: string): string {
  if (typeof document === 'undefined') return text ? `<p>${text}</p>` : EDITOR_EMPTY_HTML
  const normalized = (text || '').replace(/\r\n/g, '\n')
  if (!normalized) return EDITOR_EMPTY_HTML
  return normalized.split('\n').map((line) => {
    const p = document.createElement('p')
    if (line) {
      p.textContent = line
    } else {
      p.innerHTML = '<br>'
    }
    return p.outerHTML
  }).join('')
}

export function getInitialCellEditHtml(cell: TableCell): string {
  if (cell.richText && cell.richText.trim()) return sanitizeHtml(cell.richText)
  if (cell.text && cell.text.trim()) return plainTextToParagraphHtml(cell.text)
  return EDITOR_EMPTY_HTML
}

export function normalizeEditorHtml(rawHtml: string): string | undefined {
  const sanitized = sanitizeHtml(rawHtml || '').trim()
  if (!sanitized || typeof document === 'undefined') return undefined

  const source = document.createElement('div')
  source.innerHTML = sanitized
  const normalized = document.createElement('div')

  const appendParagraph = (inner: string, style?: string | null) => {
    const p = document.createElement('p')
    p.innerHTML = inner || '<br>'
    if (style) p.setAttribute('style', style)
    normalized.appendChild(p)
  }

  for (const node of Array.from(source.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || '').replace(/\u00a0/g, ' ')
      if (text.trim()) {
        const p = document.createElement('p')
        p.textContent = text
        normalized.appendChild(p)
      }
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue

    const el = node as HTMLElement
    const tag = el.tagName.toUpperCase()
    if (tag === 'P' || tag === 'UL' || tag === 'OL') {
      normalized.appendChild(el.cloneNode(true))
      continue
    }
    if (tag === 'DIV') {
      appendParagraph(el.innerHTML, el.getAttribute('style'))
      continue
    }
    if (tag === 'BR') {
      appendParagraph('<br>')
      continue
    }

    const p = document.createElement('p')
    p.appendChild(el.cloneNode(true))
    normalized.appendChild(p)
  }

  if (!normalized.childNodes.length) return undefined
  const result = sanitizeHtml(normalized.innerHTML).trim()
  if (!result) return undefined

  const compact = result.toLowerCase().replace(/\s+/g, '')
  if (compact === '<p><br></p>' || compact === '<p></p>') return undefined
  return result
}

export function htmlToPlainText(html: string): string {
  if (!html || typeof document === 'undefined') return ''
  const div = document.createElement('div')
  div.innerHTML = html
  return (div.innerText || div.textContent || '').replace(/\u00a0/g, ' ').trimEnd()
}
