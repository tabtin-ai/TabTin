import { describe, expect, it } from 'vitest'

import {
  ChromeVersionTracker,
  WeightedDesktopUAPool,
  generateDesktopChromeVersionPool,
  generateDesktopUAPool,
} from '@tabtin/anti-detect'

describe('anti-detect version alignment', () => {
  it('桌面 UA 池会跟随传入的 Chromium 版本生成', () => {
    const pool = generateDesktopUAPool({
      chromeVersion: '141.0.7390.65',
    })

    expect(pool.some(ua => ua.includes('Chrome/141.0.7390.65'))).toBe(true)
    expect(pool.some(ua => ua.includes('Chrome/140.0.7390.65'))).toBe(true)
  })

  it('加权池会基于 Chromium 版本生成 Chrome/Edge 条目', () => {
    const pool = new WeightedDesktopUAPool({
      chromeVersion: '141.0.7390.65',
    })

    const allUA = pool.getAllUA()
    expect(allUA.some(ua => ua.includes('Chrome/141.0.7390.65'))).toBe(true)
    expect(allUA.some(ua => ua.includes('Edg/141.0.7390.65'))).toBe(true)
  })

  it('Chrome 版本池生成器会递减主版本号', () => {
    expect(generateDesktopChromeVersionPool('141.0.7390.65', 3)).toEqual([
      '141.0.7390.65',
      '140.0.7390.65',
      '139.0.7390.65',
    ])
  })

  it('ChromeVersionTracker 的回退版本池不再停留在旧 major', () => {
    const tracker = new ChromeVersionTracker()

    expect(tracker.generateVersionPool('141.0.7390.65', 3)).toEqual([
      '141.0.7390.65',
      '140.0.7390.65',
      '139.0.7390.65',
    ])
  })
})
