import { describe, it, expect } from 'vitest'
import {
  resolveBackgroundColor,
  getBackgroundCssValue,
  resolveThemeColorByKey,
} from '../utils/background'
import type { SlideBackground, SlideTheme } from '../types/slides'

const makeTheme = (overrides?: Partial<SlideTheme>): SlideTheme => ({
  backgroundColor: '#ffffff',
  fontColor: '#000000',
  themeColors: ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'],
  fontName: 'Arial',
  ...overrides,
})

describe('resolveThemeColorByKey', () => {
  const theme = makeTheme()

  it('resolves accent1 from themeColors', () => {
    expect(resolveThemeColorByKey('accent1', theme)).toBe('#4472c4')
  })

  it('resolves bg1 to backgroundColor', () => {
    expect(resolveThemeColorByKey('bg1', theme)).toBe('#ffffff')
  })

  it('resolves tx1 to fontColor', () => {
    expect(resolveThemeColorByKey('tx1', theme)).toBe('#000000')
  })

  it('normalizes alias keys (dk1 → tx1, lt1 → bg1)', () => {
    expect(resolveThemeColorByKey('dk1', theme)).toBe('#000000')
    expect(resolveThemeColorByKey('lt1', theme)).toBe('#ffffff')
  })

  it('returns undefined for unknown key', () => {
    expect(resolveThemeColorByKey('unknown', theme)).toBeUndefined()
  })

  it('returns undefined when no theme provided', () => {
    expect(resolveThemeColorByKey('accent1')).toBeUndefined()
  })
})

describe('resolveBackgroundColor — theme type (D7-1 regression)', () => {
  it('uses dynamic theme resolution over cached color when theme is present', () => {
    const oldTheme = makeTheme({ backgroundColor: '#ff0000' })
    const newTheme = makeTheme({ backgroundColor: '#00ff00' })

    const bg: SlideBackground = {
      type: 'theme',
      theme: {
        key: 'bg1',
        color: '#ff0000',
      },
    }

    expect(resolveBackgroundColor(bg, oldTheme)).toBe('#ff0000')
    expect(resolveBackgroundColor(bg, newTheme)).toBe('#00ff00')
  })

  it('falls back to cached color when no theme is provided', () => {
    const bg: SlideBackground = {
      type: 'theme',
      theme: {
        key: 'bg1',
        color: '#ff0000',
      },
    }

    expect(resolveBackgroundColor(bg, undefined)).toBe('#ff0000')
  })

  it('falls back to cached color when key resolves to undefined', () => {
    const theme = makeTheme()
    const bg: SlideBackground = {
      type: 'theme',
      theme: {
        key: 'nonexistent',
        color: '#abcdef',
      },
    }

    expect(resolveBackgroundColor(bg, theme)).toBe('#abcdef')
  })

  it('resolves accent colors dynamically with theme update', () => {
    const theme1 = makeTheme({ themeColors: ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'] })
    const theme2 = makeTheme({ themeColors: ['#aaaaaa', '#bbbbbb', '#cccccc', '#dddddd', '#eeeeee', '#ffffff'] })

    const bg: SlideBackground = {
      type: 'theme',
      theme: {
        key: 'accent1',
        color: '#111111',
      },
    }

    expect(resolveBackgroundColor(bg, theme1)).toBe('#111111')
    expect(resolveBackgroundColor(bg, theme2)).toBe('#aaaaaa')
  })

  it('falls back to theme.backgroundColor when no key or cached color', () => {
    const theme = makeTheme({ backgroundColor: '#deadbe' })
    const bg: SlideBackground = { type: 'theme' }

    expect(resolveBackgroundColor(bg, theme)).toBe('#deadbe')
  })

  it('falls back to #ffffff when nothing available', () => {
    const bg: SlideBackground = { type: 'theme' }

    expect(resolveBackgroundColor(bg, undefined)).toBe('#ffffff')
  })
})

describe('getBackgroundCssValue — theme type (D7-1 regression)', () => {
  it('returns dynamically resolved theme color, not cached', () => {
    const newTheme = makeTheme({ backgroundColor: '#00ff00' })

    const bg: SlideBackground = {
      type: 'theme',
      theme: {
        key: 'bg1',
        color: '#ff0000',
      },
    }

    expect(getBackgroundCssValue(bg, newTheme)).toBe('#00ff00')
  })
})

describe('resolveBackgroundColor — other types unaffected', () => {
  it('handles solid type normally', () => {
    const bg: SlideBackground = { type: 'solid', color: '#123456' }
    expect(resolveBackgroundColor(bg, makeTheme())).toBe('#123456')
  })

  it('falls back for undefined bg', () => {
    const theme = makeTheme({ backgroundColor: '#abcdef' })
    expect(resolveBackgroundColor(undefined, theme)).toBe('#abcdef')
  })
})
