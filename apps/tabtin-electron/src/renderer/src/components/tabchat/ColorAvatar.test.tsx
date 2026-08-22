import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: mockWarn }),
}))

import { ColorAvatar } from './ColorAvatar'

describe('ColorAvatar', () => {
  it('同一 seed 始终映射到同一颜色', () => {
    const { container: first } = render(<ColorAvatar name="张三" seed="user-123" />)
    const { container: second } = render(<ColorAvatar name="李四" seed="user-123" />)

    expect(first.firstElementChild?.getAttribute('style')).toBe(second.firstElementChild?.getAttribute('style'))
  })

  it('没有真实头像时展示彩色姓名首字', () => {
    const { container } = render(<ColorAvatar name="张三" seed="user-2" className="h-10 w-10" />)

    expect(screen.getByText('张')).toBeTruthy()
    expect(container.firstElementChild?.getAttribute('style')).toContain('background-color')
  })

  it('Agent 保持专属语义色，不使用用户身份颜色', () => {
    const { container } = render(<ColorAvatar name="助手" seed="agent-1" isAgent />)

    expect(container.firstElementChild?.getAttribute('style')).toContain('var(--type-agent)')
  })

  it('有真实头像时优先展示图片', () => {
    render(<ColorAvatar name="张三" seed="user-2" imageUrl="https://example.com/avatar.png" />)
    expect(document.querySelector('img')?.getAttribute('src')).toBe('https://example.com/avatar.png')
  })

  it('头像加载失败时记录脱敏后的诊断上下文', () => {
    render(
      <ColorAvatar
        name="张三"
        seed="user-2"
        imageUrl="https://assets.example.com/user-avatars/user-2.png?token=secret"
      />,
    )

    fireEvent.error(document.querySelector('img')!)

    expect(mockWarn).toHaveBeenCalledWith('IM avatar image failed to load', {
      avatarHost: 'assets.example.com',
      avatarPath: '/user-avatars/user-2.png',
      avatarSubject: 'user-2',
    })
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('张')).toBeTruthy()
  })
})
