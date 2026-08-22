import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { ToastAction } from './toast'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('ToastAction', () => {
  it('uses altText as its accessible name without forwarding it to the DOM', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(<ToastAction altText="重试发送">重试</ToastAction>)
      })

      const button = container.querySelector('button')
      expect(button).not.toBeNull()
      expect(button?.getAttribute('aria-label')).toBe('重试发送')
      expect(button?.hasAttribute('altText')).toBe(false)
      expect(button?.hasAttribute('alttext')).toBe(false)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
