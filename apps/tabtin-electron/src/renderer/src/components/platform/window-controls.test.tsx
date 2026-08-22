import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WindowControls } from './window-controls'

vi.mock('@/utils/cn', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}))

const installWindowControlsApi = () => {
  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    value: {
      windowControls: {
        minimize: vi.fn(),
        toggleMaximize: vi.fn(),
        close: vi.fn(),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizeChange: vi.fn(() => vi.fn()),
      },
    },
  })
}

describe('WindowControls', () => {
  it('min/max match topbar chrome; close is wider with Windows red hover', () => {
    installWindowControlsApi()

    render(<WindowControls className="absolute right-0 top-0" />)

    const controls = screen.getByLabelText('最小化').parentElement
    const minimize = screen.getByLabelText('最小化')
    const maximize = screen.getByLabelText('最大化')
    const close = screen.getByLabelText('关闭')

    expect(controls?.className).toContain('h-8')
    expect(controls?.className).toContain('gap-1')
    expect(controls?.className).toContain('app-region-no-drag')

    for (const button of [minimize, maximize]) {
      expect(button.className).toContain('h-8')
      expect(button.className).toContain('w-8')
      expect(button.className).toContain('hover:bg-foreground/[0.06]')
      expect(button.className).not.toContain('hover:bg-[#e81123]')
    }

    expect(close.className).toContain('h-8')
    expect(close.className).toContain('w-12')
    expect(close.className).toContain('hover:bg-[#e81123]')
    expect(close.className).toContain('hover:text-white')
    expect(close.className).toContain('app-region-no-drag')
  })
})
