import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const viewerFiles = ['CsvViewer.tsx', 'XlsxViewer.tsx'] as const

describe('spreadsheet preview sticky headers', () => {
  it.each(viewerFiles)('%s keeps every sticky top header fully opaque', async (viewerFile) => {
    const source = await readFile(resolve(__dirname, '..', viewerFile), 'utf8')
    const stickyTopHeaderClasses = [...source.matchAll(/className="([^"]*\bsticky\b[^"]*\btop-0\b[^"]*)"/g)]
      .map((match) => match[1].split(/\s+/))

    expect(stickyTopHeaderClasses.length).toBeGreaterThan(0)
    for (const classTokens of stickyTopHeaderClasses) {
      expect(classTokens).toContain('bg-muted')
      expect(classTokens.some((token) => /^bg-muted\/\d+$/.test(token))).toBe(false)
    }
  })
})
