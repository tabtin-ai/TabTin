import { describe, expect, it } from 'vitest'
import { clampMenuPosition } from './conversationMenuPosition'

describe('clampMenuPosition', () => {
  const viewport = { width: 800, height: 600 }
  const menu = { width: 176, height: 160 }

  it('保留窗口内右键锚点', () => {
    expect(clampMenuPosition({ x: 240, y: 180 }, menu, viewport)).toEqual({ x: 240, y: 180 })
  })

  it('右下角右键时把菜单收进可视区', () => {
    expect(clampMenuPosition({ x: 790, y: 590 }, menu, viewport)).toEqual({ x: 616, y: 432 })
  })

  it('左上角右键时保留安全边距', () => {
    expect(clampMenuPosition({ x: 0, y: 0 }, menu, viewport)).toEqual({ x: 8, y: 8 })
  })
})
