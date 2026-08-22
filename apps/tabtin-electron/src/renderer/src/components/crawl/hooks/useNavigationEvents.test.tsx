import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNavigationEvents } from './useNavigationEvents'

vi.mock('../utils/ipc-error-handler', () => ({
  createIPCErrorHandler: () => () => () => {},
}))

describe('useNavigationEvents', () => {
  it('在拉取和接收完整 navigation state 时会把 title/url 写回 updateLocation', async () => {
    let eventListener: ((event: any) => void) | null = null
    const updateLocation = vi.fn()
    const hostView = {
      onEvent: (listener: (event: any) => void) => {
        eventListener = listener
        return () => {
          eventListener = null
        }
      },
      getNavigationState: vi.fn().mockResolvedValue({
        success: true,
        state: {
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
          url: 'https://loaded.example',
          title: 'Loaded title',
        },
      }),
    }

    renderHook(() =>
      useNavigationEvents({
        tabId: 'view-1',
        hostView,
        managedExternally: false,
        isActive: true,
        updateLocation,
        touchView: vi.fn(),
        t: ((key: string) => key) as any,
      }),
    )

    await waitFor(() => {
      expect(updateLocation).toHaveBeenCalledWith({
        url: 'https://loaded.example',
        title: 'Loaded title',
      })
    })

    act(() => {
      eventListener?.({
        type: 'navigation:state',
        data: {
          canGoBack: true,
          canGoForward: false,
          isLoading: false,
          url: 'https://navigated.example',
          title: 'Navigated title',
        },
      })
    })

    expect(updateLocation).toHaveBeenCalledWith({
      url: 'https://navigated.example',
      title: 'Navigated title',
    })
  })

  it('加载中会显式清空 themeColor，并接受后续 null 主题色事件', async () => {
    let eventListener: ((event: any) => void) | null = null
    const updateLocation = vi.fn()
    const hostView = {
      onEvent: (listener: (event: any) => void) => {
        eventListener = listener
        return () => {
          eventListener = null
        }
      },
      getNavigationState: vi.fn().mockResolvedValue({
        success: true,
        state: {
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
          url: 'https://loaded.example',
          title: 'Loaded title',
        },
      }),
    }

    const { result } = renderHook(() =>
      useNavigationEvents({
        tabId: 'view-2',
        hostView,
        managedExternally: false,
        isActive: true,
        updateLocation,
        touchView: vi.fn(),
        t: ((key: string) => key) as any,
      }),
    )

    await waitFor(() => {
      expect(updateLocation).toHaveBeenCalledWith({
        url: 'https://loaded.example',
        title: 'Loaded title',
      })
    })

    act(() => {
      eventListener?.({
        type: 'page:loading',
        data: {
          viewId: 'view-2',
          url: 'https://next.example',
        },
      })
    })

    expect(result.current.navigationState.themeColor).toBeNull()
    expect(updateLocation).toHaveBeenCalledWith({ themeColor: null })

    act(() => {
      eventListener?.({
        type: 'theme-color:changed',
        data: {
          viewId: 'view-2',
          themeColor: null,
        },
      })
    })

    expect(result.current.navigationState.themeColor).toBeNull()
  })

  it('page:error 后同轮 navigation:state 不得把 addressBarStatus 清回 idle', async () => {
    let eventListener: ((event: any) => void) | null = null
    const hostView = {
      onEvent: (listener: (event: any) => void) => {
        eventListener = listener
        return () => {
          eventListener = null
        }
      },
      getNavigationState: vi.fn().mockResolvedValue({ success: true, state: null }),
    }

    const { result } = renderHook(() =>
      useNavigationEvents({
        tabId: 'view-fail',
        hostView,
        managedExternally: false,
        isActive: true,
        updateLocation: vi.fn(),
        touchView: vi.fn(),
        t: ((key: string) => key) as any,
      }),
    )

    act(() => {
      eventListener?.({
        type: 'page:error',
        data: {
          viewId: 'view-fail',
          errorDescription: 'ERR_CONNECTION_CLOSED',
        },
      })
      eventListener?.({
        type: 'navigation:state',
        data: {
          canGoBack: true,
          canGoForward: false,
          isLoading: false,
          url: 'https://bbbbb.com/',
          title: 'bbbbb.com',
        },
      })
    })

    expect(result.current.addressBarStatus).toBe('error')
    expect(result.current.addressBarMessage).toBe('ERR_CONNECTION_CLOSED')
    expect(result.current.toolbarMessage).toBe('ERR_CONNECTION_CLOSED')
  })

  it('空导航态（guest 未附着，url 为空串）不得回写 updateLocation（ B5）', async () => {
    let eventListener: ((event: any) => void) | null = null
    const updateLocation = vi.fn()
    const hostView = {
      onEvent: (listener: (event: any) => void) => {
        eventListener = listener
        return () => {
          eventListener = null
        }
      },
      // webview 模式下新 tab 的 guest 尚未创建时，主进程返回空态
      getNavigationState: vi.fn().mockResolvedValue({
        success: true,
        state: {
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
          url: '',
          title: '',
        },
      }),
    }

    renderHook(() =>
      useNavigationEvents({
        tabId: 'view-empty',
        hostView,
        managedExternally: false,
        isActive: true,
        updateLocation,
        touchView: vi.fn(),
        t: ((key: string) => key) as any,
      }),
    )

    await waitFor(() => {
      expect(hostView.getNavigationState).toHaveBeenCalled()
    })
    expect(updateLocation).not.toHaveBeenCalledWith({ url: '', title: '' })

    act(() => {
      eventListener?.({
        type: 'navigation:state',
        data: {
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
          url: '',
          title: '',
        },
      })
    })
    expect(updateLocation).not.toHaveBeenCalledWith({ url: '', title: '' })

    // 有真实 URL 时照常回写
    act(() => {
      eventListener?.({
        type: 'navigation:state',
        data: {
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
          url: 'https://real.example',
          title: 'Real',
        },
      })
    })
    expect(updateLocation).toHaveBeenCalledWith({ url: 'https://real.example', title: 'Real' })
  })
})
