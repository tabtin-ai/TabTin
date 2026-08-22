import { describe, expect, it } from 'vitest'
import { isGridOverlayTarget } from './isGridOverlayTarget'

describe('isGridOverlayTarget', () => {
  it('returns false for null / non-Element targets', () => {
    expect(isGridOverlayTarget(null)).toBe(false)
    expect(isGridOverlayTarget(document.createTextNode('x'))).toBe(false)
  })

  it('recognizes data-grid-overlay ancestors', () => {
    const root = document.createElement('div')
    root.setAttribute('data-grid-overlay', 'cell-editor')
    const child = document.createElement('button')
    root.appendChild(child)
    document.body.appendChild(root)

    expect(isGridOverlayTarget(child)).toBe(true)
    root.remove()
  })

  it('recognizes portaled date-editor overlay on body ', () => {
    const root = document.createElement('div')
    root.setAttribute('data-grid-overlay', 'date-editor')
    const day = document.createElement('button')
    day.textContent = '15'
    root.appendChild(day)
    document.body.appendChild(root)

    expect(isGridOverlayTarget(day)).toBe(true)
    root.remove()
  })

  it('recognizes Radix Select content portaled to body', () => {
    const content = document.createElement('div')
    content.setAttribute('data-radix-select-content', '')
    const option = document.createElement('div')
    option.textContent = '7月'
    content.appendChild(option)
    document.body.appendChild(content)

    expect(isGridOverlayTarget(option)).toBe(true)
    content.remove()
  })

  it('recognizes radix popper wrapper around select', () => {
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-radix-popper-content-wrapper', '')
    const option = document.createElement('div')
    wrapper.appendChild(option)
    document.body.appendChild(wrapper)

    expect(isGridOverlayTarget(option)).toBe(true)
    wrapper.remove()
  })

  it('returns false for ordinary grid stage clicks', () => {
    const stage = document.createElement('div')
    stage.className = 'size-full'
    document.body.appendChild(stage)

    expect(isGridOverlayTarget(stage)).toBe(false)
    stage.remove()
  })
})
