import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureTaskViewModeMorph,
  consumeCapsuleMorph,
  getCapsuleMorphRevealDelayMs,
  getRailMorphRevealDelayMs,
  MORPH_DURATION_MS,
  MORPH_EASING,
  shouldHideCapsuleForMorph,
  shouldHideRailForMorph,
} from '../chatCapsuleMorph'

function stubAnimate() {
  const finish = { onfinish: null as null | (() => void), oncancel: null }
  Element.prototype.animate = vi.fn().mockReturnValue(finish) as never
  return finish
}

describe('chatCapsuleMorph', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never
  })

  it('导出 MORPH_DURATION_MS 与 MORPH_EASING 供列宽过渡复用', () => {
    expect(MORPH_DURATION_MS).toBe(420)
    expect(MORPH_EASING).toBe('cubic-bezier(0.77, 0, 0.175, 1)')
  })

  it('split→app-focus 捕获聊天列 rect，胶囊挂载时消费并播放 ghost', () => {
    const animate = stubAnimate()
    const rail = document.createElement('div')
    rail.setAttribute('data-task-chat-rail', '')
    document.body.appendChild(rail)

    captureTaskViewModeMorph('split', 'app-focus')
    // 捕获当下即进入隐藏窗口，防止实体胶囊抢跑
    expect(shouldHideCapsuleForMorph()).toBe(true)
    expect(getCapsuleMorphRevealDelayMs()).toBeGreaterThan(0)

    const capsule = document.createElement('button')
    document.body.appendChild(capsule)
    expect(consumeCapsuleMorph('to-capsule', capsule)).toBe(true)

    expect(Element.prototype.animate).toHaveBeenCalled()
    expect(document.querySelector('[aria-hidden="true"]')).not.toBeNull() // ghost 已入树
    // 消费后 pending 已空，但仍在 reveal 窗口内
    expect(shouldHideCapsuleForMorph()).toBe(true)
    void animate
  })

  it('方向不匹配时不消费且保留 pending，正确方向仍可消费', () => {
    stubAnimate()
    const rail = document.createElement('div')
    rail.setAttribute('data-task-chat-rail', '')
    document.body.appendChild(rail)

    captureTaskViewModeMorph('split', 'app-focus')
    // 错误方向：不播放、不清除 pending
    expect(consumeCapsuleMorph('to-rail', document.createElement('div'))).toBe(false)
    expect(Element.prototype.animate).not.toHaveBeenCalled()
    // 正确方向：仍可消费并播放
    expect(consumeCapsuleMorph('to-capsule', document.createElement('div'))).toBe(true)
    expect(Element.prototype.animate).toHaveBeenCalled()
  })

  it('reduced-motion 下不捕获，消费返回 false', () => {
    stubAnimate()
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never
    const rail = document.createElement('div')
    rail.setAttribute('data-task-chat-rail', '')
    document.body.appendChild(rail)

    captureTaskViewModeMorph('split', 'app-focus')
    expect(consumeCapsuleMorph('to-capsule', document.createElement('div'))).toBe(false)
    expect(Element.prototype.animate).not.toHaveBeenCalled()
  })

  it('app-focus→split 优先捕获 overlay rect，to-rail 消费返回 true', () => {
    stubAnimate()
    const overlay = document.createElement('div')
    overlay.setAttribute('data-agent-chat-overlay', '')
    document.body.appendChild(overlay)

    captureTaskViewModeMorph('app-focus', 'split')
    // 捕获当下即进入 rail 隐藏窗口，抗 Strict Mode 二次挂载
    expect(shouldHideRailForMorph()).toBe(true)
    expect(getRailMorphRevealDelayMs()).toBeGreaterThan(0)
    expect(consumeCapsuleMorph('to-rail', document.createElement('div'))).toBe(true)
    expect(Element.prototype.animate).toHaveBeenCalled()
    expect(shouldHideRailForMorph()).toBe(true)
  })

  it('consumeCapsuleMorph 可传入 finalRect，避免辅位宽度仍为 0 时 ghost 飞错', () => {
    stubAnimate()
    const overlay = document.createElement('div')
    overlay.setAttribute('data-agent-chat-overlay', '')
    document.body.appendChild(overlay)
    captureTaskViewModeMorph('app-focus', 'split')

    const target = document.createElement('div')
    document.body.appendChild(target)
    // 目标尚未布局到最终宽
    Object.defineProperty(target, 'getBoundingClientRect', {
      value: () => new DOMRect(900, 100, 0, 400),
    })
    const finalRect = new DOMRect(560, 100, 340, 400)
    expect(consumeCapsuleMorph('to-rail', target, { finalRect })).toBe(true)

    const keyframes = (Element.prototype.animate as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{
      width?: string
      transform?: string
    }>
    const endFrame = keyframes[keyframes.length - 1]
    expect(endFrame.width).toBe('340px')
    expect(endFrame.transform).toContain('translate(')
  })
})
