import { describe, expect, it, vi } from 'vitest'

import {
  isToastOverlayHitTarget,
  shouldIgnoreToastOverlayMouse,
} from '../toast-overlay-hit-test'

describe('toast-overlay-hit-test', () => {
  it('识别 data-overlay-track 命中区及其子节点', () => {
    const track = document.createElement('div')
    track.setAttribute('data-overlay-track', 'true')
    const button = document.createElement('button')
    track.appendChild(button)
    document.body.appendChild(track)

    expect(isToastOverlayHitTarget(button)).toBe(true)
    expect(isToastOverlayHitTarget(track)).toBe(true)
    expect(isToastOverlayHitTarget(document.body)).toBe(false)
    expect(isToastOverlayHitTarget(null)).toBe(false)

    track.remove()
  })

  it('指针在命中区上时不应忽略鼠标事件', () => {
    const track = document.createElement('div')
    track.setAttribute('data-overlay-track', 'true')
    const elementFromPoint = vi.fn().mockReturnValue(track)

    expect(shouldIgnoreToastOverlayMouse(10, 20, elementFromPoint)).toBe(false)
    expect(elementFromPoint).toHaveBeenCalledWith(10, 20)
  })

  it('指针在空白处时应保持穿透', () => {
    const elementFromPoint = vi.fn().mockReturnValue(document.body)
    expect(shouldIgnoreToastOverlayMouse(0, 0, elementFromPoint)).toBe(true)
  })
})
