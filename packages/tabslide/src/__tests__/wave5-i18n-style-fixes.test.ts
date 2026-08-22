/**
 * Regression tests for Wave 5 DECISION fixes:
 * - I18N-01: AnimationGroup groupKey field + i18n key migration
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/* ── I18N-01: AnimationGroup groupKey ── */

describe('AnimationGroup groupKey (I18N-01)', () => {
  it('every AnimationGroup has a non-empty groupKey string', async () => {
    const {
      ENTER_ANIMATIONS,
      EXIT_ANIMATIONS,
      ATTENTION_ANIMATIONS,
    } = await import('../configs/animations')

    const all = [...ENTER_ANIMATIONS, ...EXIT_ANIMATIONS, ...ATTENTION_ANIMATIONS]
    for (const group of all) {
      expect(group.groupKey).toBeTruthy()
      expect(typeof group.groupKey).toBe('string')
      expect(group.groupKey.length).toBeGreaterThan(0)
    }
  })

  it('groupKey values are unique within each animation type', async () => {
    const {
      ENTER_ANIMATIONS,
      EXIT_ANIMATIONS,
      ATTENTION_ANIMATIONS,
    } = await import('../configs/animations')

    for (const groups of [ENTER_ANIMATIONS, EXIT_ANIMATIONS, ATTENTION_ANIMATIONS]) {
      const keys = groups.map((g) => g.groupKey)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('groupKey is a lowercase alphanumeric identifier', async () => {
    const {
      ENTER_ANIMATIONS,
      EXIT_ANIMATIONS,
      ATTENTION_ANIMATIONS,
    } = await import('../configs/animations')

    const all = [...ENTER_ANIMATIONS, ...EXIT_ANIMATIONS, ...ATTENTION_ANIMATIONS]
    for (const group of all) {
      expect(group.groupKey).toMatch(/^[a-z][a-z0-9]*$/)
    }
  })

  it('AnimationTab uses group.groupKey for i18n lookup (not position index)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../panels/right-sidebar/AnimationTab.tsx'),
      'utf-8',
    )
    expect(src).toContain('animation.group.${group.groupKey}')
    expect(src).not.toMatch(/animation\.group\.\$\{addType\}\.\$\{groupIdx\}/)
  })

  it('AnimationTimeline uses group.groupKey for i18n lookup (not position index)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../panels/AnimationTimeline.tsx'),
      'utf-8',
    )
    expect(src).toContain('animation.group.${group.groupKey}')
    expect(src).not.toMatch(/animation\.group\.\$\{addType\}\.\$\{groupIdx\}/)
  })

  it('en-US translation file has flat group keys (not nested by type)', () => {
    const enUS = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../../apps/tabtin-electron/src/renderer/src/i18n/locales/en-US/tabslide.json',
        ),
        'utf-8',
      ),
    )
    const group = enUS.animation?.group
    expect(group).toBeDefined()
    expect(group.fade).toBeDefined()
    expect(group.zoom).toBeDefined()
    expect(group.bounce).toBeDefined()
    expect(group.slide).toBeDefined()
    expect(group.rotate).toBeDefined()
    expect(group.flip).toBeDefined()
    expect(group.shake).toBeDefined()
    expect(group.other).toBeDefined()
    expect(group.in).toBeUndefined()
    expect(group.out).toBeUndefined()
    expect(group.attention).toBeUndefined()
  })

  it('zh-CN translation file has flat group keys (not nested by type)', () => {
    const zhCN = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../../apps/tabtin-electron/src/renderer/src/i18n/locales/zh-CN/tabslide.json',
        ),
        'utf-8',
      ),
    )
    const group = zhCN.animation?.group
    expect(group).toBeDefined()
    expect(group.fade).toBeDefined()
    expect(group.zoom).toBeDefined()
    expect(group.bounce).toBeDefined()
    expect(group.slide).toBeDefined()
    expect(group.rotate).toBeDefined()
    expect(group.flip).toBeDefined()
    expect(group.shake).toBeDefined()
    expect(group.other).toBeDefined()
    expect(group.in).toBeUndefined()
  })

  it('all groupKeys used in configs have corresponding en-US translations', async () => {
    const {
      ENTER_ANIMATIONS,
      EXIT_ANIMATIONS,
      ATTENTION_ANIMATIONS,
    } = await import('../configs/animations')

    const enUS = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../../apps/tabtin-electron/src/renderer/src/i18n/locales/en-US/tabslide.json',
        ),
        'utf-8',
      ),
    )
    const group = enUS.animation?.group ?? {}
    const all = [...ENTER_ANIMATIONS, ...EXIT_ANIMATIONS, ...ATTENTION_ANIMATIONS]
    const uniqueKeys = [...new Set(all.map((g) => g.groupKey))]

    for (const key of uniqueKeys) {
      expect(group[key], `missing en-US translation for groupKey "${key}"`).toBeDefined()
    }
  })
})

