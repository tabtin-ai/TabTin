import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageHost } from '../message-host'
import { defaultMessageController } from '../message-controller'
import { ToastAction } from '../toast'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('MessageHost — CTA 点击后应关闭 toast', () => {
  afterEach(() => {
    defaultMessageController.destroy()
  })

  it('ActionModel CTA 点击后 destroy 当前项', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onClick = vi.fn()

    try {
      act(() => {
        root.render(<MessageHost />)
        defaultMessageController.open({
          key: 'cta-model',
          type: 'error',
          content: '额度已用完',
          duration: 0,
          action: { label: '去升级', onClick },
        })
      })

      const button = Array.from(container.querySelectorAll('button')).find(
        (el) => el.textContent === '去升级',
      )
      expect(button).toBeTruthy()

      act(() => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(onClick).toHaveBeenCalledTimes(1)
      expect(defaultMessageController.getVisibleItems()).toHaveLength(0)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('有 CTA 时动作区在文案下方右对齐（右下角）', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(<MessageHost />)
        defaultMessageController.open({
          key: 'cta-layout',
          type: 'error',
          content: '已达配额上限，需升级套餐',
          description: '组织可创建表格数量已达上限：已用 20 / 上限 10',
          duration: 0,
          action: { label: '去升级', onClick: () => undefined },
        })
      })

      const card = container.querySelector('[role="status"]')
      expect(card).toBeTruthy()
      expect(card?.className).toContain('flex-col')
      const actionRow = card?.querySelector('.justify-end')
      expect(actionRow).toBeTruthy()
      expect(actionRow?.textContent).toContain('去升级')
      // 文案块应在 CTA 行之前，互不挤占同一行
      const children = Array.from(card?.children ?? [])
      const textBlockIdx = children.findIndex((el) => el.className.includes('grid'))
      const actionIdx = children.findIndex((el) => el.className.includes('justify-end'))
      expect(textBlockIdx).toBeGreaterThanOrEqual(0)
      expect(actionIdx).toBeGreaterThan(textBlockIdx)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('legacy ToastAction CTA 点击后 destroy 当前项', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onClick = vi.fn()

    try {
      act(() => {
        root.render(<MessageHost />)
        defaultMessageController.open({
          key: 'cta-legacy',
          type: 'error',
          content: '额度已用完',
          duration: 0,
          action: (
            <ToastAction altText="去升级" onClick={onClick}>
              去升级
            </ToastAction>
          ),
        })
      })

      const button = Array.from(container.querySelectorAll('button')).find(
        (el) => el.textContent === '去升级',
      )
      expect(button).toBeTruthy()

      act(() => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(onClick).toHaveBeenCalledTimes(1)
      expect(defaultMessageController.getVisibleItems()).toHaveLength(0)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
