/**
 * Regression tests for Wave 4 P1 fixes:
 * - SS-01: SlideShow touch event support
 * - SS-02: Transition leave phase blocks pointer events
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SLIDESHOW_PATH = path.resolve(__dirname, '../components/SlideShow.tsx')
const SLIDESHOW_SRC = fs.readFileSync(SLIDESHOW_PATH, 'utf-8')
// getTransitionStyle 已抽到 slideshow/pageTransitions 模块
const PAGE_TRANSITIONS_SRC = fs.readFileSync(
  path.resolve(__dirname, '../components/slideshow/pageTransitions.ts'),
  'utf-8',
)

/* ── SS-02: getTransitionStyle leave phase blocks pointer events ── */

describe('getTransitionStyle — leave phase pointerEvents (SS-02)', () => {
  it('leave base style includes pointerEvents none', () => {
    const fnStart = PAGE_TRANSITIONS_SRC.indexOf('function getTransitionStyle(')
    expect(fnStart).toBeGreaterThan(-1)

    const fnBlock = PAGE_TRANSITIONS_SRC.slice(fnStart, fnStart + 600)

    expect(fnBlock).toContain('pointerEvents')
    expect(fnBlock).toContain("'none'")
    expect(fnBlock).toContain('isEnter')
  })
})

/* ── SS-01: touch event handlers existence verification ── */

describe('SlideShow touch event support (SS-01)', () => {
  it('event binding block registers touchstart and touchend listeners', () => {
    expect(SLIDESHOW_SRC).toContain("'touchstart'")
    expect(SLIDESHOW_SRC).toContain("'touchend'")
    expect(SLIDESHOW_SRC).toContain('handleTouchStart')
    expect(SLIDESHOW_SRC).toContain('handleTouchEnd')
  })

  it('cleanup removes all added touch listeners', () => {
    const touchstartAdds = (SLIDESHOW_SRC.match(/addEventListener\('touchstart'/g) || []).length
    const touchstartRemoves = (SLIDESHOW_SRC.match(/removeEventListener\('touchstart'/g) || []).length
    expect(touchstartAdds).toBe(touchstartRemoves)
    expect(touchstartAdds).toBeGreaterThan(0)

    const touchendAdds = (SLIDESHOW_SRC.match(/addEventListener\('touchend'/g) || []).length
    const touchendRemoves = (SLIDESHOW_SRC.match(/removeEventListener\('touchend'/g) || []).length
    expect(touchendAdds).toBe(touchendRemoves)
    expect(touchendAdds).toBeGreaterThan(0)
  })

  it('touch handler includes swipe and tap detection logic', () => {
    expect(SLIDESHOW_SRC).toContain('SWIPE_THRESHOLD')
    expect(SLIDESHOW_SRC).toContain('TAP_MAX_MOVE')
    expect(SLIDESHOW_SRC).toContain('changedTouches')
  })
})
