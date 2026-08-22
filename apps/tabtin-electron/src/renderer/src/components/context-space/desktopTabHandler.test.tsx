import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  buildDesktopTabItem,
  DESKTOP_TAB_KEY,
  DESKTOP_TAB_TYPE,
  desktopTabHandler,
  registerDesktopTabHandler,
} from './desktopTabHandler'
import type { ContextRegistry } from './registry'

const mockOpenAppHome = vi.fn()
const mockSelectItem = vi.fn()

vi.mock('@components/context-space/DesktopHomePane', async () => {
  const ReactModule = await import('react')
  return {
    DesktopHomePane: () => ReactModule.createElement(
      'div',
      {
        'data-testid': 'desktop-home-pane',
      },
    ),
  }
})

describe('desktopTabHandler', () => {
  it('构造固定首位使用的虚拟桌面标签 item', () => {
    expect(buildDesktopTabItem()).toEqual({
      type: DESKTOP_TAB_TYPE,
      id: 'current',
      tabKey: DESKTOP_TAB_KEY,
      title: '桌面',
    })
  })

  it('桌面标签不可关闭且不产生拖拽 payload', () => {
    const item = buildDesktopTabItem()

    expect(desktopTabHandler.closable).toBe(false)
    expect(desktopTabHandler.getTabLabel?.(item)).toBe('桌面')
    expect(desktopTabHandler.getDragPayload?.(item)).toBeNull()
  })

  it('注册逻辑幂等', () => {
    const register = vi.fn()
    const registry = {
      getHandler: vi.fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(desktopTabHandler),
      register,
    } as unknown as ContextRegistry

    registerDesktopTabHandler(registry)
    registerDesktopTabHandler(registry)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(desktopTabHandler)
  })

  it('桌面标签主画布渲染桌面主页', async () => {
    const pane = desktopTabHandler.renderPane?.(buildDesktopTabItem(), {
      spaceId: 'space-1',
    } as never)

    render(<>{pane}</>)

    await waitFor(() => {
      expect(screen.getByTestId('desktop-home-pane')).toBeTruthy()
    })
    expect(mockOpenAppHome).not.toHaveBeenCalled()
    expect(mockSelectItem).not.toHaveBeenCalled()
  })
})
