import type { PPTElementLink } from '../types/slides'

const SAFE_WEB_LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])

const SCHEME_RE = /^([a-zA-Z][a-zA-Z\d+.-]*):/

export function normalizeWebHyperlinkInput(raw: string): string | undefined {
  const value = String(raw || '').trim()
  if (!value) return undefined

  if (value.startsWith('//')) {
    return `https:${value}`
  }

  const schemeMatch = value.match(SCHEME_RE)
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    if (!SAFE_WEB_LINK_SCHEMES.has(scheme)) {
      return undefined
    }
    return value
  }

  if (/\s/.test(value)) {
    return undefined
  }

  return `https://${value}`
}

export type RichTextHyperlinkType = 'web' | 'slide'

export interface NormalizedRichTextHyperlink {
  type: RichTextHyperlinkType
  target: string
  href: string
}

export function normalizeSlideLinkTarget(raw: string): string | undefined {
  const value = String(raw || '').trim()
  if (!value) return undefined

  const pageMatch = value.match(/^page-(\d+)$/i)
  if (pageMatch) {
    const idx = Number.parseInt(pageMatch[1], 10)
    if (Number.isFinite(idx) && idx > 0) {
      return `page-${idx}`
    }
    return undefined
  }

  const slideXmlMatch = value.match(/^slide(\d+)\.xml$/i)
  if (slideXmlMatch) {
    const idx = Number.parseInt(slideXmlMatch[1], 10)
    if (Number.isFinite(idx) && idx > 0) {
      return `page-${idx}`
    }
    return undefined
  }

  if (/^\d+$/.test(value)) {
    const idx = Number.parseInt(value, 10)
    if (Number.isFinite(idx) && idx > 0) {
      return `page-${idx}`
    }
  }

  return undefined
}

export function parseRichTextHyperlinkHref(rawHref: string): Omit<NormalizedRichTextHyperlink, 'href'> | undefined {
  const raw = String(rawHref || '').trim()
  if (!raw) return undefined

  const slideRaw = raw.startsWith('#') ? raw.slice(1).trim() : raw
  const slideTarget = normalizeSlideLinkTarget(slideRaw)
  if (slideTarget) {
    return { type: 'slide', target: slideTarget }
  }

  const webTarget = normalizeWebHyperlinkInput(raw)
  if (webTarget) {
    return { type: 'web', target: webTarget }
  }

  return undefined
}

export function normalizeRichTextHyperlinkInput(rawInput: string): NormalizedRichTextHyperlink | undefined {
  const parsed = parseRichTextHyperlinkHref(rawInput)
  if (!parsed) return undefined
  if (parsed.type === 'slide') {
    return {
      type: 'slide',
      target: parsed.target,
      href: `#${parsed.target}`,
    }
  }
  return {
    type: 'web',
    target: parsed.target,
    href: parsed.target,
  }
}

export function inferElementLinkType(
  rawTarget: string,
  fallback: PPTElementLink['type'] = 'web',
): PPTElementLink['type'] {
  return normalizeSlideLinkTarget(rawTarget) ? 'slide' : fallback
}
