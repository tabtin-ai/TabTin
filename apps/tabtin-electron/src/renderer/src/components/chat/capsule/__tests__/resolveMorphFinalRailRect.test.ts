import { describe, expect, it, beforeEach } from 'vitest'
import { LayoutConstraints } from '@/constants/layout'
import { resolveMorphFinalRailRect } from '../resolveMorphFinalRailRect'

describe('resolveMorphFinalRailRect', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('主位聊天：辅位最终宽按主位最低可读宽夹紧，再反推主位宽', () => {
    const row = document.createElement('div')
    Object.defineProperty(row, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 900, 600),
    })
    const secondary = document.createElement('div')
    secondary.setAttribute('data-shell-secondary-rail', '')
    // 未夹紧：600；900 - 685 - 4 = 211，应夹到 211
    secondary.dataset.morphFinalWidth = '600'
    row.appendChild(secondary)
    document.body.appendChild(row)

    const rail = document.createElement('div')
    Object.defineProperty(rail, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 100, 600),
    })
    document.body.appendChild(rail)

    const rect = resolveMorphFinalRailRect(rail)
    expect(rect).toBeTruthy()
    const primaryMin = LayoutConstraints.chatSidePanel.minWidth
    expect(rect!.width).toBe(Math.max(primaryMin, 900 - Math.min(600, 900 - primaryMin - 4)))
    expect(rect!.left).toBe(0)
  })

  it('辅位聊天：最终宽不超过行宽减去画布最低宽', () => {
    const row = document.createElement('div')
    Object.defineProperty(row, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 800, 600),
    })
    const secondary = document.createElement('div')
    secondary.setAttribute('data-shell-secondary-rail', '')
    secondary.dataset.morphFinalWidth = '700'
    row.appendChild(secondary)
    document.body.appendChild(row)

    const rail = document.createElement('div')
    secondary.appendChild(rail)
    Object.defineProperty(rail, 'getBoundingClientRect', {
      value: () => new DOMRect(800, 0, 0, 600),
    })

    const rect = resolveMorphFinalRailRect(rail)
    expect(rect).toBeTruthy()
    // 800 - 360 - 4 = 436
    expect(rect!.width).toBe(436)
    expect(rect!.left).toBe(800 - 436)
  })
})
