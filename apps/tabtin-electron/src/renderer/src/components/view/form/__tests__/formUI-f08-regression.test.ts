/**
 * Regression tests for CMT-012 and EMF-011.
 *
 * CMT-012: FormPreviewer should show gradient background when no cover image.
 * EMF-011: FormEditorMain logo buttons should use design system Button, not raw <button>.
 *
 * These tests verify the rendered markup patterns since the components have
 * heavy runtime dependencies that make full rendering impractical in unit tests.
 */

import { describe, it, expect } from 'vitest'

describe('CMT-012: default gradient background when no cover image', () => {
  it('gradient classes are present in FormPreviewer cover fallback', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        'src/renderer/src/components/view/form/FormPreviewer.tsx',
        'utf-8',
      ),
    )
    expect(source).toContain('bg-gradient-to-tr')
    expect(source).toContain('from-green-400')

    const coverCondition = source.includes('effectiveFormConfig.cover_url ?')
    expect(coverCondition).toBe(true)
  })
})

describe('EMF-011: logo buttons use design system Button component', () => {
  it('logo overlay does not use raw <button> elements', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        'src/renderer/src/components/view/form/FormEditorMain.tsx',
        'utf-8',
      ),
    )

    const logoOverlayMatch = source.match(
      /absolute inset-0 flex items-center justify-center gap-1 rounded-lg[\s\S]*?<\/div>/,
    )
    expect(logoOverlayMatch).toBeTruthy()

    const overlay = logoOverlayMatch![0]
    expect(overlay).not.toMatch(/<button[\s\n]/)
    expect(overlay).toContain('<Button')
    expect(overlay).toContain('variant="secondary"')
  })
})
