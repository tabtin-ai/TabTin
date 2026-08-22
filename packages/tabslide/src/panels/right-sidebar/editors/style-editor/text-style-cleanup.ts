function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripTextContentMarks(
  html: string,
  options: {
    quickPattern: RegExp
    styleProps: string[]
    attrs?: string[]
  },
): string {
  if (!html || !options.quickPattern.test(html)) {
    return html
  }

  const normalizedStyleProps = new Set(options.styleProps.map((prop) => prop.trim().toLowerCase()))
  const normalizeStyle = (styleText: string): string => (
    styleText
      .split(';')
      .map((rule) => rule.trim())
      .filter((rule) => {
        if (!rule) return false
        const [rawKey] = rule.split(':')
        const key = (rawKey || '').trim().toLowerCase()
        return !normalizedStyleProps.has(key)
      })
      .join('; ')
  )

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    let next = html
      .replace(/\sstyle\s*=\s*"([^"]*)"/gi, (_m, rawStyle: string) => {
        const normalized = normalizeStyle(rawStyle)
        return normalized ? ` style="${normalized}"` : ''
      })
      .replace(/\sstyle\s*=\s*'([^']*)'/gi, (_m, rawStyle: string) => {
        const normalized = normalizeStyle(rawStyle)
        return normalized ? ` style='${normalized}'` : ''
      })

    ;(options.attrs || []).forEach((attr) => {
      const attrPattern = new RegExp(`\\s${escapeRegExp(attr)}\\s*=\\s*(".*?"|'.*?'|[^\\s>]+)`, 'gi')
      next = next.replace(attrPattern, '')
    })
    return next
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div id="__wrap__">${html}</div>`, 'text/html')
  const root = doc.getElementById('__wrap__')
  if (!root) return html

  root.querySelectorAll<HTMLElement>('*').forEach((node) => {
    const styleAttr = node.getAttribute('style')
    if (styleAttr) {
      const normalized = normalizeStyle(styleAttr)
      if (normalized) node.setAttribute('style', normalized)
      else node.removeAttribute('style')
    }
    ;(options.attrs || []).forEach((attr) => {
      if (node.hasAttribute(attr)) node.removeAttribute(attr)
    })
  })

  return root.innerHTML
}

export function stripTextContentColorMarks(html: string): string {
  return stripTextContentMarks(html, {
    quickPattern: /(color\s*:|data-theme-color-key|<font\b[^>]*\bcolor\s*=)/i,
    styleProps: ['color'],
    attrs: ['data-theme-color-key', 'color'],
  })
}

export function stripTextContentFontSizeMarks(html: string): string {
  return stripTextContentMarks(html, {
    quickPattern: /(font-size\s*:|<font\b[^>]*\bsize\s*=)/i,
    styleProps: ['font-size'],
    attrs: ['size'],
  })
}

export function stripTextContentFontFamilyMarks(html: string): string {
  return stripTextContentMarks(html, {
    quickPattern: /(font-family\s*:|<font\b[^>]*\bface\s*=)/i,
    styleProps: ['font-family'],
    attrs: ['face'],
  })
}

export function stripTextContentLineHeightMarks(html: string): string {
  return stripTextContentMarks(html, {
    quickPattern: /(line-height\s*:)/i,
    styleProps: ['line-height'],
  })
}

export function stripTextContentLetterSpacingMarks(html: string): string {
  return stripTextContentMarks(html, {
    quickPattern: /(letter-spacing\s*:)/i,
    styleProps: ['letter-spacing'],
  })
}

export function stripTextContentParagraphSpacingMarks(html: string): string {
  return stripTextContentMarks(html, {
    quickPattern: /(margin-top\s*:|margin-bottom\s*:)/i,
    styleProps: ['margin-top', 'margin-bottom'],
  })
}
