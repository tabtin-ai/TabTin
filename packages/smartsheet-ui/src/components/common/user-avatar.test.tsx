import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { UserAvatar } from './user-avatar'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('UserAvatar', () => {
  it('resolves user-avatars object keys before loading', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(<UserAvatar name="Alice" avatarUrl="user-avatars/042a.png" size={24} />)
      })

      const image = container.querySelector('img')
      expect(image?.getAttribute('src')).toBe('https://assets.example.com/user-avatars/042a.png')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('skips img for unknown relative avatar paths', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(<UserAvatar name="Alice" avatarUrl="junk-relative.png" size={24} />)
      })

      expect(container.querySelector('img')).toBeNull()
      expect(container.textContent).toBe('A')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('falls back to initials when the avatar image fails to load', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(<UserAvatar name="张三" avatarUrl="https://example.com/broken.png" size={24} />)
      })

      const image = container.querySelector('img')
      expect(image).not.toBeNull()
      expect(image?.className).toContain('object-cover')
      expect(image?.parentElement?.className).toContain('overflow-hidden')
      expect(image?.parentElement?.className).toContain('rounded-full')

      act(() => {
        image?.dispatchEvent(new Event('error', { bubbles: true }))
      })

      expect(container.querySelector('img')).toBeNull()
      expect(container.textContent).toBe('张')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('keeps emoji initials intact at small sizes', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(<UserAvatar name="😂 tester" size={24} />)
      })

      expect(container.textContent).toBe('😂')
      expect(container.textContent).not.toContain('�')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('keeps the fallback color when the user changes their display name', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(<UserAvatar name="晨曦" seed="user-42" size={32} />)
      })
      const originalColor = (container.firstElementChild as HTMLElement).style.backgroundColor

      act(() => {
        root.render(<UserAvatar name="清晨" seed="user-42" size={32} />)
      })

      expect((container.firstElementChild as HTMLElement).style.backgroundColor).toBe(originalColor)
      expect(container.textContent).toBe('清')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('uses a readable typography token for large profile avatars', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(<UserAvatar name="Alice" size={72} />)
      })

      expect(container.firstElementChild?.className).toContain('text-title')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('uses the first leading character instead of skipping to later CJK text', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(<UserAvatar name="87878邀请验收成员96998" size={72} />)
      })

      expect(container.textContent).toBe('8')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
