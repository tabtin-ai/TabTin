import { afterEach, describe, expect, it } from 'vitest'
import {
  applySqueezeEffect,
  applySqueezeToElement,
  clearAllSqueezeEffects,
} from '../canvas-squeeze-effects'

function buildRoot(paneId: string) {
  const root = document.createElement('div')
  root.dataset.canvasContentRoot = 'true'
  const pane = document.createElement('div')
  pane.dataset.canvasPaneId = paneId
  const content = document.createElement('div')
  pane.appendChild(content)
  root.appendChild(pane)
  document.body.appendChild(root)
  return { root, content }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('canvas squeeze effects', () => {
  it('只挤压当前 Space 的内容根，不会污染后台 Activity 中的同名 pane', () => {
    const active = buildRoot('pane-1')
    const hidden = buildRoot('pane-1')

    applySqueezeEffect('pane-1', 'left', active.root)

    expect(active.content.style.width).toBe('calc(100% - 30px)')
    expect(active.content.style.marginLeft).toBe('30px')
    expect(hidden.content.style.width).toBe('')
    expect(hidden.content.style.marginLeft).toBe('')
  })

  it('切换落点时清除操作也限制在当前内容根', () => {
    const active = buildRoot('pane-active')
    const hidden = buildRoot('pane-hidden')
    applySqueezeToElement(active.content, 'right')
    applySqueezeToElement(hidden.content, 'right')

    clearAllSqueezeEffects(active.root)

    expect(active.content.style.width).toBe('')
    expect(active.content.style.marginRight).toBe('')
    expect(hidden.content.style.width).toBe('calc(100% - 30px)')
    expect(hidden.content.style.marginRight).toBe('30px')
  })

  it('上下方向只改变高度，并在目标侧腾出固定 30px 间隙', () => {
    const element = document.createElement('div')

    applySqueezeToElement(element, 'bottom')

    expect(element.style.height).toBe('calc(100% - 30px)')
    expect(element.style.marginBottom).toBe('30px')
    expect(element.style.width).toBe('')
  })
})
