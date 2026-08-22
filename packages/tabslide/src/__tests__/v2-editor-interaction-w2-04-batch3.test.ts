/**
 * V2 Editor Interaction W2-04 batch 3 — P1 fixes regression tests
 *
 * C2-02: targets RAF cleanup (cancelled flag + cancelAnimationFrame)
 * C2-03: flipPrefixById Map replaces per-frame findElement DOM traversal
 * C5-03: currentPageLockedKey replaces presentation as targets Effect dependency
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildFlipTransform } from '../utils/geometry'

const moveableSrc = fs.readFileSync(
  path.resolve(__dirname, '../components/interactive/MoveableWrapper.tsx'),
  'utf-8',
)

// ═══════════════════════════════════════════════════════════
// C2-02: targets RAF has cleanup (cancelAnimationFrame + cancelled)
// ═══════════════════════════════════════════════════════════

describe('C2-02: targets useEffect RAF has proper cleanup', () => {
  function getTargetsEffect() {
    const marker = '选中变化 → 更新 targets'
    const start = moveableSrc.indexOf(marker)
    if (start === -1) return ''
    const effectStart = moveableSrc.indexOf('useEffect(', start)
    const nextBlock = moveableSrc.indexOf('\n  // ', effectStart + 10)
    return moveableSrc.slice(effectStart, nextBlock > -1 ? nextBlock : undefined)
  }

  it('declares a cancelled flag', () => {
    const body = getTargetsEffect()
    expect(body).toContain('let cancelled = false')
  })

  it('checks cancelled inside RAF callback', () => {
    const body = getTargetsEffect()
    expect(body).toContain('if (cancelled) return')
  })

  it('calls cancelAnimationFrame in cleanup', () => {
    const body = getTargetsEffect()
    expect(body).toContain('cancelAnimationFrame(rafId)')
  })

  it('sets cancelled = true in cleanup', () => {
    const body = getTargetsEffect()
    const cleanupStart = body.lastIndexOf('return () =>')
    expect(cleanupStart).toBeGreaterThan(-1)
    const cleanup = body.slice(cleanupStart)
    expect(cleanup).toContain('cancelled = true')
    expect(cleanup).toContain('cancelAnimationFrame')
  })

  it('captures RAF id for cleanup', () => {
    const body = getTargetsEffect()
    expect(body).toMatch(/const rafId\s*=\s*requestAnimationFrame/)
  })
})

// ═══════════════════════════════════════════════════════════
// C2-03: flipPrefixById pre-built Map replaces per-frame DOM queries
// ═══════════════════════════════════════════════════════════

describe('C2-03: flipPrefixById Map replaces per-frame findElement in rotation', () => {
  it('defines flipPrefixById as useMemo', () => {
    expect(moveableSrc).toContain('const flipPrefixById = useMemo')
  })

  it('flipPrefixById builds Map from currentPageElements', () => {
    const start = moveableSrc.indexOf('const flipPrefixById = useMemo')
    const end = moveableSrc.indexOf('}, [currentPageElements])', start)
    expect(end).toBeGreaterThan(start)
    const body = moveableSrc.slice(start, end)
    expect(body).toContain('new Map<string, string>()')
    expect(body).toContain('buildFlipTransform')
    expect(body).toContain('map.set(el.id')
  })

  it('onRotate uses getAttribute instead of findElement for flip', () => {
    const rotateStart = moveableSrc.indexOf('onRotate={(e: OnRotate)')
    const rotateEnd = moveableSrc.indexOf('onRotateEnd', rotateStart)
    const body = moveableSrc.slice(rotateStart, rotateEnd)
    expect(body).toContain('getAttribute(\'data-element-id\')')
    expect(body).toContain('flipPrefixById.get(id)')
    expect(body).not.toContain('findElement(e.target)')
  })

  it('onRotateGroup uses getAttribute instead of findElement for flip', () => {
    const marker = 'onRotateGroup={(e: OnRotateGroup)'
    const start = moveableSrc.indexOf(marker)
    const end = moveableSrc.indexOf('onRotateGroupEnd', start)
    const body = moveableSrc.slice(start, end)
    expect(body).toContain('getAttribute(\'data-element-id\')')
    expect(body).toContain('flipPrefixById.get(id)')
    expect(body).not.toContain('findElement(ev.target)')
  })

  it('no longer has buildFlipPrefix useCallback', () => {
    expect(moveableSrc).not.toContain('const buildFlipPrefix = useCallback')
  })
})

// ═══════════════════════════════════════════════════════════
// C5-03: currentPageLockedKey replaces presentation dependency
// ═══════════════════════════════════════════════════════════

describe('C5-03: targets Effect uses lockedKey instead of presentation', () => {
  it('defines currentPageLockedKey as useMemo', () => {
    expect(moveableSrc).toContain('const currentPageLockedKey = useMemo')
  })

  it('currentPageLockedKey filters locked elements and joins IDs', () => {
    const start = moveableSrc.indexOf('const currentPageLockedKey = useMemo')
    const end = moveableSrc.indexOf('}, [currentPageElements])', start)
    expect(end).toBeGreaterThan(start)
    const body = moveableSrc.slice(start, end)
    expect(body).toContain('.filter((e) => e.locked)')
    expect(body).toContain('.map((e) => e.id)')
    expect(body).toContain('.join(\',\')')
  })

  function getTargetsEffectBlock() {
    const marker = '选中变化 → 更新 targets'
    const start = moveableSrc.indexOf(marker)
    if (start === -1) return ''
    const effectStart = moveableSrc.indexOf('useEffect(', start)
    const nextBlock = moveableSrc.indexOf('\n  // ', effectStart + 10)
    return moveableSrc.slice(effectStart, nextBlock > -1 ? nextBlock : undefined)
  }

  it('targets Effect deps include currentPageLockedKey', () => {
    const body = getTargetsEffectBlock()
    expect(body).toContain('currentPageLockedKey')
  })

  it('targets Effect deps do NOT include presentation', () => {
    const body = getTargetsEffectBlock()
    const depsLine = body.slice(body.lastIndexOf('], ['))
    expect(depsLine).not.toContain('presentation')
  })

  it('targets Effect uses lockedSet from currentPageLockedKey', () => {
    const body = getTargetsEffectBlock()
    expect(body).toContain('currentPageLockedKey')
    expect(body).toContain('new Set(')
  })
})

// ═══════════════════════════════════════════════════════════
// buildFlipTransform utility correctness
// ═══════════════════════════════════════════════════════════

describe('buildFlipTransform (used by flipPrefixById)', () => {
  it('returns empty string for no flips', () => {
    expect(buildFlipTransform({})).toBe('')
    expect(buildFlipTransform({ flipH: false, flipV: false })).toBe('')
  })

  it('returns scaleX(-1) for flipH', () => {
    expect(buildFlipTransform({ flipH: true })).toBe('scaleX(-1)')
  })

  it('returns scaleY(-1) for flipV', () => {
    expect(buildFlipTransform({ flipV: true })).toBe('scaleY(-1)')
  })

  it('returns both for flipH+flipV', () => {
    expect(buildFlipTransform({ flipH: true, flipV: true })).toBe('scaleX(-1) scaleY(-1)')
  })
})
