import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('ContextPageToolbarImportButton', () => {
  it('defaults to an upload icon and allows overriding the icon', () => {
    const source = readFileSync(
      resolve(__dirname, './ContextPageToolbarImportButton.tsx'),
      'utf8',
    )

    expect(source).toContain('Upload')
    expect(source).toContain('icon: Icon = Upload')
    expect(source).toContain('<Icon className="h-3.5 w-3.5" />')
    expect(source).not.toContain('<Download className="h-3.5 w-3.5" />')
  })
})
