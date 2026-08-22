import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserZoomControls } from '../BrowserZoomControls'
import {
  __resetBrowserZoomForTesting,
  adjustBrowserZoom,
} from '@/services/browserZoomController'

const setZoomLevelMock = vi.fn()
const getZoomLevelMock = vi.fn()
let zoomLevelChangedCallback: ((payload: { tabId: string; level: number }) => void) | null = null

beforeEach(() => {
  setZoomLevelMock.mockClear()
  getZoomLevelMock.mockReset()
  getZoomLevelMock.mockResolvedValue({ success: true, level: 0 })
  zoomLevelChangedCallback = null
  __resetBrowserZoomForTesting()
  ;(window as unknown as { tabtin: Partial<Window['tabtin']> }).tabtin = {
    crawlView: {
      setZoomLevel: setZoomLevelMock,
      getZoomLevel: getZoomLevelMock,
      onZoomLevelChanged: (callback: (payload: { tabId: string; level: number }) => void) => {
        zoomLevelChangedCallback = callback
        return () => {
          if (zoomLevelChangedCallback === callback) zoomLevelChangedCallback = null
        }
      },
    } as Partial<Window['tabtin']['crawlView']> as Window['tabtin']['crawlView'],
  }
})

afterEach(() => {
  __resetBrowserZoomForTesting()
})

describe('BrowserZoomControls', () => {
  it('显示当前缩放值，并提供缩小、重置、放大入口', () => {
    render(<BrowserZoomControls viewId="view-1" />)

    expect(screen.getByRole('group', { name: '网页缩放' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '缩小网页' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '放大网页' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重置网页缩放，当前 100%' })).toBeTruthy()
  })

  it('点击按钮时复用 browserZoomController 调整当前 view', () => {
    render(<BrowserZoomControls viewId="view-1" />)

    fireEvent.click(screen.getByRole('button', { name: '放大网页' }))
    expect(setZoomLevelMock).toHaveBeenLastCalledWith('view-1', 0.5)
    expect(screen.getByRole('button', { name: '重置网页缩放，当前 110%' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '缩小网页' }))
    expect(setZoomLevelMock).toHaveBeenLastCalledWith('view-1', 0)
    expect(screen.getByRole('button', { name: '重置网页缩放，当前 100%' })).toBeTruthy()
  })

  it('快捷键路径调整 zoom 后同步刷新显示值', async () => {
    render(<BrowserZoomControls viewId="view-1" />)

    await act(async () => {})
    act(() => {
      adjustBrowserZoom('view-1', 'in')
    })

    expect(screen.getByRole('button', { name: '重置网页缩放，当前 110%' })).toBeTruthy()
  })

  it('主进程 Ctrl+滚轮缩放事件会同步刷新显示值', async () => {
    render(<BrowserZoomControls viewId="view-1" />)

    await act(async () => {})
    await act(async () => {
      zoomLevelChangedCallback?.({ tabId: 'view-1', level: 1 })
    })

    expect(screen.getByRole('button', { name: '重置网页缩放，当前 120%' })).toBeTruthy()
  })

  it('重置按钮把当前 view 恢复到 100%', () => {
    render(<BrowserZoomControls viewId="view-1" />)

    fireEvent.click(screen.getByRole('button', { name: '放大网页' }))
    fireEvent.click(screen.getByRole('button', { name: '放大网页' }))
    expect(screen.getByRole('button', { name: '重置网页缩放，当前 120%' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '重置网页缩放，当前 120%' }))

    expect(setZoomLevelMock).toHaveBeenLastCalledWith('view-1', 0)
    expect(screen.getByRole('button', { name: '重置网页缩放，当前 100%' })).toBeTruthy()
  })
})
