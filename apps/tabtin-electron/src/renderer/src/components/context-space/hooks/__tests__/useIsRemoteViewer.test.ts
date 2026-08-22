/**
 * useIsRemoteViewer 三态测试 —— (APP-29) 遥控器占位的核心判定。
 *
 * 重点验证「isRemoteViewer 不等于 !isControl」：isResolving / 无 control_device 自愈窗口 /
 * 本机 control 三种情况都**不能**拦截,只有「control_device 已绑定且 ≠ 当前设备」才是真遥控器。
 * 这是 plan 标记的 P1 正确性风险（误拦会让本机被占位墙误伤）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIsRemoteViewer } from '../useIsRemoteViewer'

const h = vi.hoisted(() => ({
  spaceState: {} as Record<string, unknown>,
  deviceState: {} as Record<string, unknown>,
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (sel: (s: unknown) => unknown) => sel(h.spaceState),
}))
vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: (sel: (s: unknown) => unknown) => sel(h.deviceState),
}))

interface DeviceLike { id: string; name?: string; status?: string }

function setStores(opts: {
  spaceType?: string
  controlDeviceId?: string | null
  currentDeviceId?: string | null
  devices?: DeviceLike[]
  workingDir?: string | null
}): void {
  const {
    spaceType = 'workspace',
    controlDeviceId = null,
    currentDeviceId = null,
    devices = [],
    workingDir = null,
  } = opts
  const agent = { id: 'ag-1', control_device_id: controlDeviceId, working_dir: workingDir }
  h.spaceState = {
    spaces: [{ id: 'sp-1', type: spaceType, agent_id: 'ag-1' }],
    selectedAgent: agent,
    agentCache: { 'ag-1': agent },
  }
  h.deviceState = {
    devices,
    currentDevice: currentDeviceId ? { id: currentDeviceId } : null,
  }
}

describe('useIsRemoteViewer 三态', () => {
  beforeEach(() => {
    h.spaceState = {}
    h.deviceState = {}
  })

  it('非 workspace：从不拦截', () => {
    setStores({
      spaceType: 'channel',
      controlDeviceId: 'dev-B',
      currentDeviceId: 'dev-A',
      devices: [{ id: 'dev-A' }, { id: 'dev-B' }],
    })
    const { result } = renderHook(() => useIsRemoteViewer('sp-1'))
    expect(result.current.isRemoteViewer).toBe(false)
  })

  it('① isResolving（current device 未就绪）：不闪 banner', () => {
    setStores({ controlDeviceId: 'dev-B', currentDeviceId: null, devices: [] })
    const { result } = renderHook(() => useIsRemoteViewer('sp-1'))
    expect(result.current.isResolving).toBe(true)
    expect(result.current.isRemoteViewer).toBe(false)
  })

  it('current device 已注册但设备列表未加载完整：仍按 device id 判断遥控器', () => {
    setStores({ controlDeviceId: 'dev-B', currentDeviceId: 'dev-A', devices: [] })
    const { result } = renderHook(() => useIsRemoteViewer('sp-1'))
    expect(result.current.isResolving).toBe(false)
    expect(result.current.isRemoteViewer).toBe(true)
    expect(result.current.controlDeviceName).toBeNull()
  })

  it('② 无 control_device（ 自愈窗口）：不拦', () => {
    setStores({ controlDeviceId: null, currentDeviceId: 'dev-A', devices: [{ id: 'dev-A' }] })
    const { result } = renderHook(() => useIsRemoteViewer('sp-1'))
    expect(result.current.isRemoteViewer).toBe(false)
  })

  it('本机即 control_device：不拦', () => {
    setStores({ controlDeviceId: 'dev-A', currentDeviceId: 'dev-A', devices: [{ id: 'dev-A' }] })
    const { result } = renderHook(() => useIsRemoteViewer('sp-1'))
    expect(result.current.isRemoteViewer).toBe(false)
  })

  it('③ 真·遥控器（control_device ≠ 当前设备）：拦截 + 带设备名/目录', () => {
    setStores({
      controlDeviceId: 'dev-B',
      currentDeviceId: 'dev-A',
      devices: [
        { id: 'dev-A', name: '公司 Mac', status: 'online' },
        { id: 'dev-B', name: '家里 Mac', status: 'online' },
      ],
      workingDir: '/Users/x/proj',
    })
    const { result } = renderHook(() => useIsRemoteViewer('sp-1'))
    expect(result.current.isRemoteViewer).toBe(true)
    expect(result.current.isResolving).toBe(false)
    expect(result.current.controlDeviceName).toBe('家里 Mac')
    expect(result.current.controlDeviceId).toBe('dev-B')
    expect(result.current.workingDir).toBe('/Users/x/proj')
  })

  it('Space 级执行绑定优先于 Agent：agent_id 为空时仍能识别遥控器', () => {
    h.spaceState = {
      spaces: [{
        id: 'sp-1',
        type: 'workspace',
        agent_id: null,
        execution_agent_id: null,
        control_device_id: 'dev-B',
        bound_device_id: 'dev-B',
        working_dir: '/Users/owner/ooo',
      }],
      selectedAgent: { id: 'selected-agent', control_device_id: 'dev-A', working_dir: '/Users/local/wrong' },
      agentCache: {},
    }
    h.deviceState = {
      devices: [
        { id: 'dev-A', name: '当前 Mac', status: 'online' },
        { id: 'dev-B', name: '执行 Mac', status: 'online' },
      ],
      currentDevice: { id: 'dev-A' },
    }

    const { result } = renderHook(() => useIsRemoteViewer('sp-1'))

    expect(result.current.isRemoteViewer).toBe(true)
    expect(result.current.controlDeviceId).toBe('dev-B')
    expect(result.current.controlDeviceName).toBe('执行 Mac')
    expect(result.current.workingDir).toBe('/Users/owner/ooo')
  })
})
