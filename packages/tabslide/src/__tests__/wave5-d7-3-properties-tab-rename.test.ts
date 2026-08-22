/**
 * Regression tests for Wave 5 — D7-3: DesignTab → PropertiesTab rename
 *
 * Validates:
 * 1. PropertiesTab.tsx exists and exports PropertiesTab (not DesignTab)
 * 2. RightSidebar imports PropertiesTab (not DesignTab)
 * 3. RightSidebar panel title uses 'tab.properties' (not 'tab.design')
 * 4. index.ts re-exports PropertiesTab (not DesignTab)
 * 5. Old DesignTab.tsx no longer exists
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

const fileExists = (relativePath: string) =>
  fs.existsSync(path.resolve(__dirname, '..', relativePath))

describe('D7-3: DesignTab renamed to PropertiesTab', () => {
  it('DesignTab.tsx no longer exists', () => {
    expect(fileExists('panels/right-sidebar/DesignTab.tsx')).toBe(false)
  })

  it('PropertiesTab.tsx exists', () => {
    expect(fileExists('panels/right-sidebar/PropertiesTab.tsx')).toBe(true)
  })

  describe('PropertiesTab component', () => {
    const src = readSrc('panels/right-sidebar/PropertiesTab.tsx')

    it('exports PropertiesTab', () => {
      expect(src).toMatch(/export const PropertiesTab/)
    })

    it('does not contain DesignTab identifier', () => {
      expect(src).not.toMatch(/export const DesignTab/)
    })
  })

  describe('RightSidebar references', () => {
    const src = readSrc('panels/right-sidebar/RightSidebar.tsx')

    it('imports PropertiesTab from ./PropertiesTab', () => {
      expect(src).toMatch(/import.*PropertiesTab.*from.*['"]\.\/PropertiesTab['"]/)
    })

    it('does not import DesignTab', () => {
      expect(src).not.toMatch(/import.*DesignTab/)
    })

    it('renders <PropertiesTab> (not <DesignTab>)', () => {
      expect(src).toContain('<PropertiesTab')
      expect(src).not.toContain('<DesignTab')
    })

    it('panel title uses tab.properties for element selection', () => {
      expect(src).toContain("translate('tab.properties')")
      expect(src).not.toMatch(/translate\('tab\.design'\)/)
    })
  })

  describe('index.ts re-exports', () => {
    const src = readSrc('panels/right-sidebar/index.ts')

    it('exports PropertiesTab', () => {
      expect(src).toContain("export { PropertiesTab } from './PropertiesTab'")
    })

    it('does not export DesignTab', () => {
      expect(src).not.toMatch(/export.*DesignTab/)
    })
  })
})
