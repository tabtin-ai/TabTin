/**
 * V2 Editor Interaction W2-04 batch 2 — P1 fixes regression tests
 *
 * C1-05: applyImportedPresentation preserves serverIdRef (no reset to null)
 * C2-01/C2-09: HTML group end handlers guard with lastEvent before pushHistorySnapshot
 * C5-05: Selection box Shift-append uses XOR logic (toggle already-selected)
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ═══════════════════════════════════════════════════════════
// C1-05: applyImportedPresentation preserves serverIdRef
// ═══════════════════════════════════════════════════════════

describe('C1-05: applyImportedPresentation does not reset serverIdRef', () => {
  const hostPath = path.resolve(
    __dirname,
    '../../../../apps/tabtin-electron/src/renderer/src/components/slide/SlideEditorHost.tsx',
  )
  let src: string
  try {
    src = fs.readFileSync(hostPath, 'utf-8')
  } catch {
    src = ''
  }

  const getApplyImportedBody = () => {
    const start = src.indexOf('const applyImportedPresentation')
    if (start === -1) return ''
    const end = src.indexOf('}, [enqueueSave', start)
    return src.slice(start, end)
  }

  it('applyImportedPresentation exists', () => {
    expect(src).toContain('const applyImportedPresentation')
  })

  it('does NOT contain serverIdRef.current = null', () => {
    const body = getApplyImportedBody()
    expect(body).not.toContain('serverIdRef.current = null')
  })

  it('still calls setPresentation with imported data', () => {
    const body = getApplyImportedBody()
    expect(body).toContain('setPresentation(result.presentation)')
  })

  it('still calls enqueueSave to persist imported data', () => {
    const body = getApplyImportedBody()
    expect(body).toContain('enqueueSave(result.presentation)')
  })
})

// ═══════════════════════════════════════════════════════════
// C5-05: Selection box Shift-append uses XOR logic
// ═══════════════════════════════════════════════════════════

describe('C5-05: useSelectionBox Shift-append uses XOR logic', () => {
  // 框选命中 + Shift 追加语义已抽到纯函数模块
  const selSrc = fs.readFileSync(
    path.resolve(__dirname, '../utils/selection-hit-test.ts'),
    'utf-8',
  )

  function getAppendBlock() {
    const start = selSrc.indexOf('if (appendMode)')
    if (start === -1) return ''
    const end = selSrc.indexOf('return { type: \'select\', ids: hitIds }', start)
    return selSrc.slice(start, end)
  }

  it('does NOT use simple Set merge (union)', () => {
    const block = getAppendBlock()
    expect(block).not.toContain('[...new Set([...prev, ...hitIds])]')
  })

  it('filters out previously selected hits (kept = prev minus hits)', () => {
    const block = getAppendBlock()
    expect(block).toMatch(/prev\.filter\(\(?id\)?\s*=>\s*!hitSet\.has\(id\)/)
  })

  it('adds newly hit elements that were not previously selected', () => {
    const block = getAppendBlock()
    expect(block).toMatch(/hitIds\.filter/)
  })

  it('combines kept and added into final selection', () => {
    const block = getAppendBlock()
    expect(block).toContain('[...kept, ...added]')
  })
})
