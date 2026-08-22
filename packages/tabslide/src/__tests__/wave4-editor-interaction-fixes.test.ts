/**
 * Regression tests for Wave 4 Editor Interaction P1 fixes:
 * - EI-002: SlideEditor exposes and forwards onExportImages prop
 * - EI-004: Canvas wheel effect no longer depends on `page`
 * - EI-012: TableElement registers flush-text-edit listener
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/* ── EI-002: SlideEditor forwards onExportImages to RightSidebar ── */

describe('EI-002: onExportImages prop forwarding', () => {
  const editorSrc = fs.readFileSync(
    path.resolve(__dirname, '../components/SlideEditor.tsx'),
    'utf-8',
  )

  it('SlideEditorProps declares onExportImages', () => {
    expect(editorSrc).toContain('onExportImages?:')
  })

  it('component destructures onExportImages', () => {
    expect(editorSrc).toMatch(/onExportImages/)
  })

  it('passes onExportImages to RightSidebar JSX', () => {
    expect(editorSrc).toMatch(/onExportImages=\{onExportImages\}/)
  })
})

/* ── EI-004: Canvas wheel effect dependency ── */

describe('EI-004: Canvas wheel effect does not depend on page', () => {
  const canvasSrc = fs.readFileSync(
    path.resolve(__dirname, '../components/Canvas.tsx'),
    'utf-8',
  )

  it('wheel useEffect depends only on setZoom (no page)', () => {
    const wheelEffectRegex =
      /el\.addEventListener\('wheel'[\s\S]*?^\s*\},\s*\[([^\]]*)\]\)/m
    const match = canvasSrc.match(wheelEffectRegex)
    expect(match).toBeTruthy()
    const deps = match![1]
    expect(deps).not.toContain('page')
    expect(deps).toContain('setZoom')
  })
})

/* ── EI-012: TableElement registers flush-text-edit listener ── */

describe('EI-012: TableElement flush-text-edit listener', () => {
  // 表格单元格编辑逻辑（含 flush-text-edit 监听）已抽到 useTableCellEditor hook
  const tableSrc = fs.readFileSync(
    path.resolve(__dirname, '../hooks/useTableCellEditor.ts'),
    'utf-8',
  )

  it('registers tabslide:flush-text-edit event listener', () => {
    expect(tableSrc).toContain("'tabslide:flush-text-edit'")
  })

  it('adds listener via addEventListener', () => {
    expect(tableSrc).toMatch(
      /window\.addEventListener\(\s*'tabslide:flush-text-edit'/,
    )
  })

  it('removes listener in cleanup', () => {
    expect(tableSrc).toMatch(
      /window\.removeEventListener\(\s*'tabslide:flush-text-edit'/,
    )
  })

  it('calls commitCurrentEditingCell in flush handler', () => {
    const flushBlock = tableSrc.match(
      /const handler[\s\S]*?flush-text-edit[\s\S]*?removeEventListener/,
    )
    expect(flushBlock).toBeTruthy()
    expect(flushBlock![0]).toContain('commitCurrentEditingCell')
  })

  it('also flushes on unmount (cleanup return)', () => {
    const cleanupPattern =
      /removeEventListener[\s\S]*?commitCurrentEditingCell\(\)/
    expect(tableSrc).toMatch(cleanupPattern)
  })
})
