import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { UserInitialsAvatar, UserSelector } from './UserSelector'

vi.mock('../popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('UserSelector keyboard navigation', () => {
  it('selects the next member with ArrowDown and Enter', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onChange = vi.fn()

    try {
      act(() => {
        root.render(
          <UserSelector
            value={null}
            onChange={onChange}
            users={[
              { id: 'user-1', name: '张三' },
              { id: 'user-2', name: '林小满' },
            ]}
            defaultOpen
          />
        )
      })

      const searchInput = container.querySelector('input')
      expect(searchInput).not.toBeNull()

      act(() => {
        searchInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      })
      act(() => {
        searchInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })

      expect(onChange).toHaveBeenCalledWith('user-2')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('wraps from the first member to the last member with ArrowUp', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onChange = vi.fn()

    try {
      act(() => {
        root.render(
          <UserSelector
            value={null}
            onChange={onChange}
            users={[
              { id: 'user-1', name: '张三' },
              { id: 'user-2', name: '林小满' },
            ]}
            defaultOpen
          />
        )
      })

      const searchInput = container.querySelector('input')
      act(() => {
        searchInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      })
      act(() => {
        searchInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })

      expect(onChange).toHaveBeenCalledWith('user-2')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('selects from the filtered member list instead of a hidden result', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onChange = vi.fn()

    try {
      act(() => {
        root.render(
          <UserSelector
            value={null}
            onChange={onChange}
            users={[
              { id: 'user-1', name: '张三' },
              { id: 'user-2', name: '林小满' },
            ]}
            defaultOpen
          />
        )
      })

      const searchInput = container.querySelector('input')
      expect(searchInput).not.toBeNull()
      if (!searchInput) throw new Error('member search input should be rendered')

      act(() => {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set
        valueSetter?.call(searchInput, '林')
        searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => {
        searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })

      expect(onChange).toHaveBeenCalledWith('user-2')
      expect(onChange).not.toHaveBeenCalledWith('user-1')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})

describe('UserInitialsAvatar', () => {
  it('resolves a platform avatar object key through the shared avatar renderer', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(
          <UserInitialsAvatar
            user={{ id: 'user-42', name: '王小明', avatarUrl: 'user-avatars/member.png' }}
          />
        )
      })

      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'https://assets.example.com/user-avatars/member.png',
      )
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
