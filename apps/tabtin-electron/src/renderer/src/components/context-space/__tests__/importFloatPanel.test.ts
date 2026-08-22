import { describe, expect, it, vi } from 'vitest'
import {
  getOutsideDismissEventTarget,
  isImportFloatPanelEventTarget,
  preventDialogDismissOnImportFloatPanel,
} from '../importFloatPanel'

describe('isImportFloatPanelEventTarget', () => {
  it('命中浮层及其子节点', () => {
    const root = document.createElement('div')
    root.setAttribute('data-import-float-panel', '')
    const button = document.createElement('button')
    root.appendChild(button)
    document.body.appendChild(root)
    expect(isImportFloatPanelEventTarget(button)).toBe(true)
    root.remove()
  })

  it('未命中时返回 false', () => {
    const el = document.createElement('div')
    expect(isImportFloatPanelEventTarget(el)).toBe(false)
    expect(isImportFloatPanelEventTarget(null)).toBe(false)
  })
})

describe('getOutsideDismissEventTarget', () => {
  it('优先取 Radix detail.originalEvent.target', () => {
    const original = document.createElement('button')
    const fallback = document.createElement('div')
    const event = {
      target: fallback,
      detail: { originalEvent: { target: original } as unknown as Event },
    }
    expect(getOutsideDismissEventTarget(event)).toBe(original)
  })
})

describe('preventDialogDismissOnImportFloatPanel', () => {
  it('点击浮层时 preventDefault，避免 Dialog 关窗', () => {
    const root = document.createElement('div')
    root.setAttribute('data-import-float-panel', '')
    const button = document.createElement('button')
    root.appendChild(button)
    document.body.appendChild(root)

    const preventDefault = vi.fn()
    preventDialogDismissOnImportFloatPanel({
      target: document.body,
      detail: { originalEvent: { target: button } as unknown as Event },
      preventDefault,
    })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    root.remove()
  })

  it('点击 mask 空白不拦截', () => {
    const preventDefault = vi.fn()
    const mask = document.createElement('div')
    preventDialogDismissOnImportFloatPanel({
      target: mask,
      preventDefault,
    })
    expect(preventDefault).not.toHaveBeenCalled()
  })
})
