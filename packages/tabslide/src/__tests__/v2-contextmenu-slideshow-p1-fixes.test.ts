/**
 * V2 ContextMenu & SlideShow P1 回归测试
 *
 * C6-01: 菜单视口边界检测 — useLayoutEffect 修正越界坐标
 * C6-02: 子菜单动态展开方向 — 根据空间决定 left/right
 * C6-03: 子菜单 zIndex 使用 ZIndex.dropdown — 不再硬编码 1
 * V2-01: resolveElementAnimation effect null 守卫 — 损坏数据不再 TypeError
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const contextMenuSrc = fs.readFileSync(
  path.resolve(__dirname, '../components/ContextMenu.tsx'),
  'utf-8',
)
// resolveElementAnimation 已抽到 slideshow/animationResolver 模块
const slideShowSrc = fs.readFileSync(
  path.resolve(__dirname, '../components/slideshow/animationResolver.ts'),
  'utf-8',
)

/* ══════════════════════════════════════════════════════
 * C6-01: 主菜单视口边界检测
 * ══════════════════════════════════════════════════════ */

describe('C6-01: context menu viewport boundary detection', () => {
  it('imports useLayoutEffect from react', () => {
    expect(contextMenuSrc).toMatch(/import\s.*useLayoutEffect.*from\s+['"]react['"]/)
  })

  it('uses useLayoutEffect to adjust menu position with getBoundingClientRect', () => {
    expect(contextMenuSrc).toContain('useLayoutEffect')
    expect(contextMenuSrc).toContain('getBoundingClientRect')
  })

  it('clamps position to stay within viewport with padding', () => {
    const layoutBlock = contextMenuSrc.match(
      /useLayoutEffect\(\(\)\s*=>\s*\{([\s\S]*?)\},\s*\[state\.visible/,
    )
    expect(layoutBlock).toBeTruthy()
    const body = layoutBlock![1]
    expect(body).toContain('window.innerWidth')
    expect(body).toContain('window.innerHeight')
    expect(body).toContain('rect.width')
    expect(body).toContain('rect.height')
  })
})

/* ══════════════════════════════════════════════════════
 * C6-02: 子菜单动态展开方向
 * ══════════════════════════════════════════════════════ */

describe('C6-02: submenu dynamic open direction', () => {
  it('SubMenuRow tracks openDir state', () => {
    expect(contextMenuSrc).toMatch(/\[openDir,\s*setOpenDir\]/)
  })

  it('calculates direction based on viewport width on mouse enter', () => {
    expect(contextMenuSrc).toContain('window.innerWidth')
    expect(contextMenuSrc).toMatch(/setOpenDir\(.*'left'.*:.*'right'/)
  })

  it('applies left or right positioning based on openDir', () => {
    expect(contextMenuSrc).toMatch(
      /openDir\s*===\s*'right'\s*\?\s*\{\s*left:\s*'100%'\s*\}\s*:\s*\{\s*right:\s*'100%'\s*\}/,
    )
  })
})

/* ══════════════════════════════════════════════════════
 * C6-03: 子菜单 zIndex 使用设计系统语义值
 * ══════════════════════════════════════════════════════ */

describe('C6-03: submenu zIndex uses design system token', () => {
  it('does not hardcode zIndex: 1 in submenu panel', () => {
    const subMenuSection = contextMenuSrc.slice(
      contextMenuSrc.indexOf('const SubMenuRow'),
    )
    expect(subMenuSection).not.toMatch(/zIndex:\s*1[^0-9]/)
  })

  it('uses ZIndex.dropdown for submenu panel', () => {
    const subMenuSection = contextMenuSrc.slice(
      contextMenuSrc.indexOf('const SubMenuRow'),
    )
    expect(subMenuSection).toContain('ZIndex.dropdown')
  })

  it('ZIndex is imported from @tabtin/app-shell', () => {
    expect(contextMenuSrc).toMatch(/import\s*\{[^}]*ZIndex[^}]*\}\s*from\s*['"]@tabtin\/app-shell['"]/)
  })
})

/* ══════════════════════════════════════════════════════
 * V2-01: resolveElementAnimation effect null 守卫
 * ══════════════════════════════════════════════════════ */

describe('V2-01: resolveElementAnimation null guard for effect', () => {
  it('checks animation.effect before calling toLowerCase()', () => {
    const fnMatch = slideShowSrc.match(
      /function resolveElementAnimation\(\s*animation[\s\S]*?\{([\s\S]*?)const effect = animation\.effect\.toLowerCase\(\)/,
    )
    expect(fnMatch).toBeTruthy()
    const preamble = fnMatch![1]
    expect(preamble).toContain('!animation.effect')
  })

  it('returns fade fallback when effect is null/undefined', () => {
    const fnMatch = slideShowSrc.match(
      /function resolveElementAnimation\(\s*animation[\s\S]*?\{([\s\S]*?)const effect = animation\.effect\.toLowerCase\(\)/,
    )
    expect(fnMatch).toBeTruthy()
    const preamble = fnMatch![1]
    expect(preamble).toContain('tabslide-fadeMoveOut')
    expect(preamble).toContain('tabslide-fadeMoveIn')
  })

  it('guards with early return before any property access on effect', () => {
    const fnBody = slideShowSrc.slice(
      slideShowSrc.indexOf('function resolveElementAnimation'),
    )
    const guardIdx = fnBody.indexOf('!animation.effect')
    const accessIdx = fnBody.indexOf('animation.effect.toLowerCase()')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(accessIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(accessIdx)
  })
})
