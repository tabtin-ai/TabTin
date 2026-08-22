/**
 * CapsLockHint 组件测试
 *
 * 覆盖点：
 *  1. show=false 时绝对定位、不占流高度，且不可见
 *  2. show=true 时渲染传入的提示文案
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CapsLockHint } from '../CapsLockHint'

describe('CapsLockHint', () => {
  it('show=false 时应绝对定位叠缝且不可见', () => {
    const { container } = render(<CapsLockHint show={false} label="Caps Lock is on" />)
    const el = container.firstElementChild as HTMLElement | null
    expect(el).not.toBeNull()
    expect(el?.getAttribute('aria-hidden')).toBe('true')
    expect(el?.className).toMatch(/invisible/)
    expect(el?.className).toMatch(/absolute/)
    expect(screen.queryByText('Caps Lock is on')).toBeNull()
  })

  it('show=true 时渲染传入的提示文案', () => {
    render(<CapsLockHint show={true} label="Caps Lock is on" />)
    expect(screen.getByText('Caps Lock is on')).not.toBeNull()
  })
})
