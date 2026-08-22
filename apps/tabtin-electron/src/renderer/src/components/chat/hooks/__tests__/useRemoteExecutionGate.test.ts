/**
 * useRemoteExecutionGate 测试 —— 遥控端聊天发送闸门的核心判定。
 *
 * 关键不变量：
 *   - 遥控器可以发消息；消息应交给绑定执行设备运行；
 *   - 本机即执行设备 / 自愈窗口 / 解析中一律不拦（避免误伤本机、不闪提示）；
 *   - 仅在真·遥控器且执行设备明确 offline 时禁发；online/busy/unknown 均不假禁发。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const h = vi.hoisted(() => ({
  remote: {} as Record<string, unknown>,
  deviceState: {} as Record<string, unknown>,
}))

vi.mock('@components/context-space/hooks/useIsRemoteViewer', () => ({
  useIsRemoteViewer: () => h.remote,
}))
vi.mock('@/stores/useDeviceStore', () => ({
  useDeviceStore: (sel: (s: unknown) => unknown) => sel(h.deviceState),
}))

import { useRemoteExecutionGate } from '../useRemoteExecutionGate'

interface DeviceLike { id: string; name?: string; status?: string }

function setStores(opts: {
  isRemoteViewer?: boolean
  isResolving?: boolean
  controlDeviceName?: string | null
  controlDeviceId?: string | null
  devices?: DeviceLike[]
}): void {
  const {
    isRemoteViewer = false,
    isResolving = false,
    controlDeviceName = null,
    controlDeviceId = null,
    devices = [],
  } = opts
  h.remote = { isRemoteViewer, isResolving, controlDeviceName, controlDeviceId, workingDir: null }
  h.deviceState = { devices }
}

describe('useRemoteExecutionGate', () => {
  beforeEach(() => {
    h.remote = {}
    h.deviceState = {}
  })

  it('非遥控器：不拦', () => {
    setStores({ isRemoteViewer: false })
    const { result } = renderHook(() => useRemoteExecutionGate('sp-1'))
    expect(result.current.isRemoteViewer).toBe(false)
    expect(result.current.isBlocked).toBe(false)
    expect(result.current.controlDeviceOffline).toBe(false)
  })

  it('解析中：不拦，但透出 isResolving', () => {
    setStores({ isRemoteViewer: false, isResolving: true })
    const { result } = renderHook(() => useRemoteExecutionGate('sp-1'))
    expect(result.current.isRemoteViewer).toBe(false)
    expect(result.current.isBlocked).toBe(false)
    expect(result.current.isResolving).toBe(true)
  })

  it('遥控器 + 执行设备在线：允许发送，文案非离线', () => {
    setStores({
      isRemoteViewer: true,
      controlDeviceName: '家里 Mac',
      controlDeviceId: 'dev-B',
      devices: [{ id: 'dev-B', name: '家里 Mac', status: 'online' }],
    })
    const { result } = renderHook(() => useRemoteExecutionGate('sp-1'))
    expect(result.current.isRemoteViewer).toBe(true)
    expect(result.current.isBlocked).toBe(false)
    expect(result.current.controlDeviceName).toBe('家里 Mac')
    expect(result.current.controlDeviceOffline).toBe(false)
  })

  it('遥控器 + 执行设备 busy：busy 视为可达，允许发送', () => {
    setStores({
      isRemoteViewer: true,
      controlDeviceName: '家里 Mac',
      controlDeviceId: 'dev-B',
      devices: [{ id: 'dev-B', status: 'busy' }],
    })
    const { result } = renderHook(() => useRemoteExecutionGate('sp-1'))
    expect(result.current.isRemoteViewer).toBe(true)
    expect(result.current.isBlocked).toBe(false)
    expect(result.current.controlDeviceOffline).toBe(false)
  })

  it('遥控器 + 执行设备离线：拦，文案走离线', () => {
    setStores({
      isRemoteViewer: true,
      controlDeviceName: '家里 Mac',
      controlDeviceId: 'dev-B',
      devices: [{ id: 'dev-B', status: 'offline' }],
    })
    const { result } = renderHook(() => useRemoteExecutionGate('sp-1'))
    expect(result.current.isRemoteViewer).toBe(true)
    expect(result.current.isBlocked).toBe(true)
    expect(result.current.controlDeviceOffline).toBe(true)
  })

  it('遥控器 + 执行设备不在本地列表：不假禁发，交给后端路由权威判断', () => {
    setStores({
      isRemoteViewer: true,
      controlDeviceName: '家里 Mac',
      controlDeviceId: 'dev-B',
      devices: [],
    })
    const { result } = renderHook(() => useRemoteExecutionGate('sp-1'))
    expect(result.current.isRemoteViewer).toBe(true)
    expect(result.current.isBlocked).toBe(false)
    expect(result.current.controlDeviceOffline).toBe(false)
  })
})
