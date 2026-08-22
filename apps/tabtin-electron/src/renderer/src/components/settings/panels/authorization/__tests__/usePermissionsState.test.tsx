/**
 * usePermissionsState — 「重新检查」反馈单测
 *
 * 回归：ready 后再点 refresh 必须进入 isRefreshing，并 toast 成功；
 * 旧实现把 loadState 卡在 ready，按钮永远无转圈。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

const toastSuccess = vi.fn()
const toastError = vi.fn()

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

vi.mock('react-i18next', () => {
  // 保持 t 引用稳定，否则 usePermissionsState 的 refresh callback 会在每次 render
  // 变化，触发挂载 effect 反复刷新。
  const t = (key: string) => key
  return {
    useTranslation: () => ({ t }),
  }
})

import {
  PERMISSIONS_PAGE_POLL_INTERVAL_MS,
  usePermissionsState,
} from '../usePermissionsState'

const listMock = vi.fn()
const checkMock = vi.fn()
const requestMock = vi.fn()
const openSettingsMock = vi.fn()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function dispatchVisibilityChange(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('usePermissionsState refresh feedback', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    listMock.mockReset()
    checkMock.mockReset()
    requestMock.mockReset()
    openSettingsMock.mockReset()
    sessionStorage.clear()
    listMock.mockResolvedValue([
      {
        kind: 'microphone',
        status: 'granted',
        platform: 'win32',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
      },
    ])
    checkMock.mockResolvedValue({
      kind: 'microphone',
      status: 'granted',
      platform: 'win32',
      canRequest: false,
      canOpenSettings: true,
      detection: 'supported',
    })
    requestMock.mockResolvedValue('granted')
    openSettingsMock.mockResolvedValue(true)
    ;(window as unknown as { tabtin: unknown }).tabtin = {
      osPermissions: {
        list: listMock,
        check: checkMock,
        request: requestMock,
        openSettings: openSettingsMock,
      },
    }
  })

  afterEach(() => {
    delete (window as unknown as { tabtin?: unknown }).tabtin
    sessionStorage.clear()
  })

  it('手动重新检查会置 isRefreshing 并 toast 成功', async () => {
    const { result } = renderHook(() => usePermissionsState())

    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    expect(result.current.isRefreshing).toBe(false)
    expect(toastSuccess).not.toHaveBeenCalled()

    let refreshPromise: Promise<void>
    act(() => {
      refreshPromise = result.current.refresh()
    })

    await waitFor(() => expect(result.current.isRefreshing).toBe(true))
    await act(async () => {
      await refreshPromise!
    })

    expect(result.current.isRefreshing).toBe(false)
    expect(toastSuccess).toHaveBeenCalledWith(
      'authorizationSystem.overview.refreshDone',
    )
    expect(listMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('silent 刷新（focus）不弹 toast、不亮 isRefreshing', async () => {
    const { result } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    toastSuccess.mockClear()

    await act(async () => {
      await result.current.refresh({ silent: true })
    })

    expect(result.current.isRefreshing).toBe(false)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('document 从 hidden 回到 visible 时静默刷新（ 从系统设置返回）', async () => {
    let visibility: DocumentVisibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })

    const { result } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    const callsBefore = listMock.mock.calls.length
    toastSuccess.mockClear()

    await act(async () => {
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      visibility = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() => {
      expect(listMock.mock.calls.length).toBeGreaterThan(callsBefore)
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('系统权限页挂载期间会静默轮询；卸载后不再打 list（ 并排改系统开关）', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })

    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => usePermissionsState())
    try {
      // 初次 silent refresh（promise microtask）+ 页级 interval 都挂在 fake clock 上
      await act(async () => {
        await Promise.resolve()
      })
      expect(result.current.loadState).toBe('ready')
      const callsAfterMount = listMock.mock.calls.length
      toastSuccess.mockClear()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PERMISSIONS_PAGE_POLL_INTERVAL_MS)
      })
      expect(listMock.mock.calls.length).toBeGreaterThan(callsAfterMount)
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(result.current.isRefreshing).toBe(false)

      const callsBeforeUnmount = listMock.mock.calls.length
      unmount()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PERMISSIONS_PAGE_POLL_INTERVAL_MS * 3)
      })
      expect(listMock.mock.calls.length).toBe(callsBeforeUnmount)
    } finally {
      unmount()
      vi.useRealTimers()
    }
  })

  it('窗口 hidden 时页级轮询跳过，避免后台空转', async () => {
    let visibility: DocumentVisibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })

    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => usePermissionsState())
    try {
      await act(async () => {
        await Promise.resolve()
      })
      expect(result.current.loadState).toBe('ready')

      visibility = 'hidden'
      const callsBefore = listMock.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PERMISSIONS_PAGE_POLL_INTERVAL_MS)
      })
      expect(listMock.mock.calls.length).toBe(callsBefore)
    } finally {
      unmount()
      vi.useRealTimers()
    }
  })

  it('打开系统设置后会短时间轮询单项权限，授权后更新行状态', async () => {
    const { result, unmount } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))

    vi.useFakeTimers()
    try {
      checkMock
        .mockResolvedValueOnce({
          kind: 'microphone',
          status: 'not-determined',
          platform: 'win32',
          canRequest: false,
          canOpenSettings: true,
          detection: 'supported',
        })
        .mockResolvedValueOnce({
          kind: 'microphone',
          status: 'granted',
          platform: 'win32',
          canRequest: false,
          canOpenSettings: true,
          detection: 'supported',
        })

      await act(async () => {
        await result.current.openSettings('microphone')
      })

      expect(openSettingsMock).toHaveBeenCalledWith('microphone')
      expect(checkMock).toHaveBeenCalledTimes(1)

      await act(async () => {
        vi.advanceTimersByTime(1000)
        await Promise.resolve()
      })

      expect(checkMock).toHaveBeenCalledTimes(2)
      expect(result.current.items.find((item) => item.kind === 'microphone')?.status).toBe('granted')
    } finally {
      unmount()
      vi.useRealTimers()
    }
  })

  it('打开无法自动检测的权限时不轮询，避免把系统设置里的真实开关刷成未开启错觉', async () => {
    listMock.mockResolvedValue([
      {
        kind: 'location',
        status: 'not-determined',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'unsupported',
      },
    ])
    const { result, unmount } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))

    vi.useFakeTimers()
    try {
      await act(async () => {
        await result.current.openSettings('location')
      })

      expect(openSettingsMock).toHaveBeenCalledWith('location')
      expect(checkMock).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(3000)
        await Promise.resolve()
      })

      // 页级 list 轮询可能触发，但 unsupported 单项 check 轮询不得启动
      expect(checkMock).not.toHaveBeenCalled()
    } finally {
      unmount()
      vi.useRealTimers()
    }
  })

  it('离页后 openSettings 的 await 尾迹不再挂单项轮询', async () => {
    const { result, unmount } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))

    const openDeferred = deferred<boolean>()
    openSettingsMock.mockReturnValueOnce(openDeferred.promise)

    let openPromise!: Promise<void>
    act(() => {
      openPromise = result.current.openSettings('microphone')
    })

    unmount()

    vi.useFakeTimers()
    try {
      await act(async () => {
        openDeferred.resolve(true)
        await openPromise
      })
      const checksAfterUnmount = checkMock.mock.calls.length

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      // 不得因尾迹 startPermissionPolling 而继续 check
      expect(checkMock.mock.calls.length).toBe(checksAfterUnmount)
    } finally {
      vi.useRealTimers()
    }
  })

  it('重复打开系统设置时，同一权限不会并发发起 check', async () => {
    const { result, unmount } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))

    vi.useFakeTimers()
    try {
      const firstCheck = deferred<any>()
      checkMock.mockReturnValueOnce(firstCheck.promise)

      await act(async () => {
        await result.current.openSettings('microphone')
      })
      expect(checkMock).toHaveBeenCalledTimes(1)

      await act(async () => {
        await result.current.openSettings('microphone')
      })
      expect(checkMock).toHaveBeenCalledTimes(1)

      await act(async () => {
        firstCheck.resolve({
          kind: 'microphone',
          status: 'not-determined',
          platform: 'win32',
          canRequest: false,
          canOpenSettings: true,
          detection: 'supported',
        })
        await Promise.resolve()
      })

      await act(async () => {
        vi.advanceTimersByTime(1000)
        await Promise.resolve()
      })
      expect(checkMock).toHaveBeenCalledTimes(2)
    } finally {
      unmount()
      vi.useRealTimers()
    }
  })

  it('用户未操作：重启敏感权限保持尚未确认，不标记待重启确认', async () => {
    listMock.mockResolvedValue([
      {
        kind: 'accessibility',
        status: 'not-determined',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
        requiresAppRestartAfterGrant: true,
      },
    ])

    const { result } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))

    const item = result.current.items.find((it) => it.kind === 'accessibility')
    expect(item?.status).toBe('not-determined')
    expect(item?.pendingRestartConfirmation).toBe(false)
  })

  it('打开需重启确认的系统设置后，not-determined 标记为待重启确认', async () => {
    listMock.mockResolvedValue([
      {
        kind: 'accessibility',
        status: 'not-determined',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
        requiresAppRestartAfterGrant: true,
      },
    ])
    checkMock.mockResolvedValue({
      kind: 'accessibility',
      status: 'not-determined',
      platform: 'darwin',
      canRequest: false,
      canOpenSettings: true,
      detection: 'supported',
      requiresAppRestartAfterGrant: true,
    })

    const { result } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))

    await act(async () => {
      await result.current.openSettings('accessibility')
    })

    expect(result.current.items.find((item) => item.kind === 'accessibility')?.pendingRestartConfirmation).toBe(true)
  })

  it('未点击授权入口：App 从后台回到前台仍保持尚未确认', async () => {
    listMock.mockResolvedValue([
      {
        kind: 'screenCapture',
        status: 'not-determined',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
        requiresAppRestartAfterGrant: true,
      },
    ])

    const { result } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    expect(result.current.items.find((item) => item.kind === 'screenCapture')?.pendingRestartConfirmation).toBe(false)

    await act(async () => {
      dispatchVisibilityChange('hidden')
      dispatchVisibilityChange('visible')
    })

    await waitFor(() => {
      const item = result.current.items.find((it) => it.kind === 'screenCapture')
      expect(item?.status).toBe('not-determined')
      expect(item?.pendingRestartConfirmation).toBe(false)
    })
  })

  it('点击辅助功能设置入口后：App 从后台回到前台保持待重启确认', async () => {
    listMock.mockResolvedValue([
      {
        kind: 'accessibility',
        status: 'not-determined',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
        requiresAppRestartAfterGrant: true,
      },
    ])
    checkMock.mockResolvedValue({
      kind: 'accessibility',
      status: 'not-determined',
      platform: 'darwin',
      canRequest: false,
      canOpenSettings: true,
      detection: 'supported',
      requiresAppRestartAfterGrant: true,
    })

    const { result } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))

    await act(async () => {
      await result.current.openSettings('accessibility')
      dispatchVisibilityChange('hidden')
      dispatchVisibilityChange('visible')
    })

    await waitFor(() => {
      const item = result.current.items.find((it) => it.kind === 'accessibility')
      expect(item?.status).toBe('not-determined')
      expect(item?.pendingRestartConfirmation).toBe(true)
    })
  })

  it('待重启确认权限检测为 granted 后清理 pending 状态', async () => {
    listMock.mockResolvedValue([
      {
        kind: 'screenCapture',
        status: 'not-determined',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
        requiresAppRestartAfterGrant: true,
      },
    ])
    checkMock
      .mockResolvedValueOnce({
        kind: 'screenCapture',
        status: 'not-determined',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
        requiresAppRestartAfterGrant: true,
      })
      .mockResolvedValueOnce({
        kind: 'screenCapture',
        status: 'granted',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
        requiresAppRestartAfterGrant: true,
      })

    const { result } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))

    await act(async () => {
      await result.current.openSettings('screenCapture')
    })
    expect(result.current.items.find((item) => item.kind === 'screenCapture')?.pendingRestartConfirmation).toBe(true)

    await act(async () => {
      await result.current.checkOne('screenCapture')
    })
    const item = result.current.items.find((it) => it.kind === 'screenCapture')
    expect(item?.status).toBe('granted')
    expect(item?.pendingRestartConfirmation).toBe(false)
  })

  it('待重启确认权限检测为 denied 后清理 pending 并保留拒绝状态', async () => {
    listMock.mockResolvedValue([
      {
        kind: 'accessibility',
        status: 'not-determined',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
        requiresAppRestartAfterGrant: true,
      },
    ])
    checkMock
      .mockResolvedValueOnce({
        kind: 'accessibility',
        status: 'not-determined',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
        requiresAppRestartAfterGrant: true,
      })
      .mockResolvedValueOnce({
        kind: 'accessibility',
        status: 'denied',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
        requiresAppRestartAfterGrant: true,
      })

    const { result } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))

    await act(async () => {
      await result.current.openSettings('accessibility')
    })
    expect(result.current.items.find((item) => item.kind === 'accessibility')?.pendingRestartConfirmation).toBe(true)

    await act(async () => {
      await result.current.checkOne('accessibility')
    })
    const item = result.current.items.find((it) => it.kind === 'accessibility')
    expect(item?.status).toBe('denied')
    expect(item?.pendingRestartConfirmation).toBe(false)
  })

  it('sessionStorage 恢复 pending 但状态为 restricted 时清除 pending', async () => {
    sessionStorage.setItem('tabtin:os-permissions:pending-restart', JSON.stringify(['screenCapture']))
    listMock.mockResolvedValue([
      {
        kind: 'screenCapture',
        status: 'restricted',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
        requiresAppRestartAfterGrant: true,
      },
    ])

    const { result } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))

    const item = result.current.items.find((it) => it.kind === 'screenCapture')
    expect(item?.status).toBe('restricted')
    expect(item?.pendingRestartConfirmation).toBe(false)
    expect(sessionStorage.getItem('tabtin:os-permissions:pending-restart')).toBe('[]')
  })

  it('sessionStorage 恢复 pending 且状态仍为 not-determined 时保留 pending', async () => {
    sessionStorage.setItem('tabtin:os-permissions:pending-restart', JSON.stringify(['accessibility']))
    listMock.mockResolvedValue([
      {
        kind: 'accessibility',
        status: 'not-determined',
        platform: 'darwin',
        canRequest: false,
        canOpenSettings: true,
        detection: 'supported',
        requiresAppRestartAfterGrant: true,
      },
    ])

    const { result } = renderHook(() => usePermissionsState())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))

    const item = result.current.items.find((it) => it.kind === 'accessibility')
    expect(item?.status).toBe('not-determined')
    expect(item?.pendingRestartConfirmation).toBe(true)
  })
})
