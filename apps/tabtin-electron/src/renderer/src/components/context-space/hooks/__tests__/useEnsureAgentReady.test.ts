/**
 * useEnsureAgentReady —  根因 2 +  同机 stale 换绑。
 *
 * 核心：区分「从未绑定过」与「绑定丢失」。
 *   - 绑定丢失（无 control_device 但 working_dir 非空）→ 绝不静默绑本机，
 *     必须停在 'needs-reclaim'，由 UI 显式确认接管。
 *   - 显式 reclaim() 才允许把本机绑为 control_device。
 *   - 已完整配置且 control 已是本机 → 'ready'，不做任何写操作。
 *   - 已完整配置但 control 是同机 stale Device → 仍 bindSpaceDevice 换绑。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const h = vi.hoisted(() => ({
  spaceState: {} as Record<string, unknown>,
  deviceState: {} as Record<string, unknown>,
  orgState: {} as Record<string, unknown>,
  bindSpaceDevice: vi.fn(),
  loadAgent: vi.fn(),
  updateAgent: vi.fn(),
  updateSpace: vi.fn(),
  refreshSpace: vi.fn(),
  ensureDefaultAgentDir: vi.fn(),
}))

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: (sel: (s: unknown) => unknown) => sel(h.deviceState),
}))
vi.mock('@stores/useSpaceStore', () => {
  const useSpaceStore = (sel: (s: unknown) => unknown) => sel(h.spaceState)
  useSpaceStore.getState = () => h.spaceState
  return { useSpaceStore }
})
vi.mock('@stores/useOrganizationStore', () => {
  const useOrganizationStore = { getState: () => h.orgState }
  return { useOrganizationStore }
})
vi.mock('@/services/deviceApi', () => ({
  DeviceApiService: { bindSpaceDevice: (...a: unknown[]) => h.bindSpaceDevice(...a) },
}))
vi.mock('@components/workspace/notifyWorkspacePaths', () => ({
  notifyWorkspacePathsForSpace: vi.fn(),
}))
vi.mock('@tabtin/smartsheet-ui', () => ({ toast: vi.fn() }))
vi.mock('@/i18n', () => ({ default: { t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k } }))
vi.mock('@/utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))

import { useEnsureAgentReady, _resetAgentReadyGuardsForTests } from '../useEnsureAgentReady'

function setStores(opts: {
  controlDeviceId?: string | null
  workingDir?: string
  currentDeviceId?: string | null
  fingerprint?: string | null
  machineKey?: string | null
  devices?: Array<{
    id: string
    fingerprint?: string | null
    machine_key?: string | null
    status?: string | null
  }>
}): { id: string; control_device_id: string | null; working_dir: string } {
  const {
    controlDeviceId = null,
    workingDir = '',
    currentDeviceId = 'dev-A',
    fingerprint = 'fp-A',
    machineKey = null,
    devices,
  } = opts
  const agent = { id: 'ag-1', name: 'Agent', control_device_id: controlDeviceId, working_dir: workingDir }
  h.spaceState = {
    spaces: [{
      id: 'sp-1',
      name: 'Space',
      organization_id: 'org-1',
      control_device_id: controlDeviceId,
      working_dir: workingDir,
    }],
    loadAgent: h.loadAgent,
    updateAgent: h.updateAgent,
    updateSpace: h.updateSpace,
    refreshSpace: h.refreshSpace,
    error: null,
  }
  h.refreshSpace.mockImplementation(async () => {
    const spaces = h.spaceState.spaces as Array<Record<string, unknown>>
    const sp = spaces.find((item) => item.id === 'sp-1')
    if (sp && currentDeviceId) {
      sp.control_device_id = currentDeviceId
    }
  })
  const currentDevice = currentDeviceId
    ? { id: currentDeviceId, fingerprint, machine_key: machineKey }
    : null
  h.deviceState = {
    currentDevice,
    devices: devices ?? (currentDevice ? [currentDevice] : []),
  }
  h.orgState = { organizations: [], selectedOrganization: null }
  return agent
}

describe('useEnsureAgentReady 根因2', () => {
  beforeEach(() => {
    _resetAgentReadyGuardsForTests()
    h.bindSpaceDevice.mockReset().mockResolvedValue(undefined)
    h.loadAgent.mockReset().mockResolvedValue(null)
    h.updateAgent.mockReset().mockResolvedValue(true)
    h.updateSpace.mockReset().mockResolvedValue(true)
    h.refreshSpace.mockReset().mockResolvedValue(undefined)
    h.ensureDefaultAgentDir.mockReset()
    ;(window as unknown as { tabtin: unknown }).tabtin = {
      fileSystem: { ensureDefaultAgentDir: h.ensureDefaultAgentDir },
    }
  })

  it('绑定丢失（无 control_device 但 working_dir 非空）→ needs-reclaim，不静默绑设备', async () => {
    const agent = setStores({ controlDeviceId: null, workingDir: '/Users/a/proj' })
    const { result } = renderHook(() => useEnsureAgentReady('sp-1', agent))
    await waitFor(() => expect(result.current.status).toBe('needs-reclaim'))
    expect(h.bindSpaceDevice).not.toHaveBeenCalled()
    expect(h.updateAgent).not.toHaveBeenCalled()
    expect(h.updateSpace).not.toHaveBeenCalled()
  })

  it('已完整配置（本机 control + 有目录）→ ready，不写任何东西', async () => {
    const agent = setStores({ controlDeviceId: 'dev-A', workingDir: '/Users/a/proj' })
    const { result } = renderHook(() => useEnsureAgentReady('sp-1', agent))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(h.bindSpaceDevice).not.toHaveBeenCalled()
  })

  it('已有 control+目录，但 control 是同 fingerprint 重复记录 → 换绑到当前 Device', async () => {
    const agent = setStores({
      controlDeviceId: 'dev-stale',
      workingDir: '/Users/a/proj',
      currentDeviceId: 'dev-A',
      fingerprint: 'fp-same',
      devices: [
        { id: 'dev-stale', fingerprint: 'fp-same', status: 'offline' },
        { id: 'dev-A', fingerprint: 'fp-same', status: 'online' },
      ],
    })
    h.loadAgent.mockResolvedValue({
      id: 'ag-1',
      name: 'Agent',
      control_device_id: 'dev-A',
      working_dir: '/Users/a/proj',
    })
    const { result } = renderHook(() => useEnsureAgentReady('sp-1', agent))
    await waitFor(() => expect(h.bindSpaceDevice).toHaveBeenCalledWith('sp-1', 'dev-A'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(h.updateAgent).not.toHaveBeenCalled()
  })

  it('已有 control+目录，仅 machine_key 相同 → 不静默换绑', async () => {
    const agent = setStores({
      controlDeviceId: 'dev-stale',
      workingDir: '/Users/a/proj',
      currentDeviceId: 'dev-A',
      fingerprint: 'fp-A',
      machineKey: 'mk-shared',
      devices: [
        { id: 'dev-stale', fingerprint: 'fp-stale', machine_key: 'mk-shared', status: 'offline' },
        { id: 'dev-A', fingerprint: 'fp-A', machine_key: 'mk-shared', status: 'online' },
      ],
    })
    const { result } = renderHook(() => useEnsureAgentReady('sp-1', agent))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(h.bindSpaceDevice).not.toHaveBeenCalled()
  })

  it('已有 control+目录，绑到真正另一台设备 → ready 且不换绑（遥控器交给别处）', async () => {
    const agent = setStores({
      controlDeviceId: 'dev-other',
      workingDir: '/Users/a/proj',
      currentDeviceId: 'dev-A',
      fingerprint: 'fp-A',
      machineKey: 'mk-A',
      devices: [
        { id: 'dev-other', fingerprint: 'fp-other', machine_key: 'mk-other', status: 'offline' },
        { id: 'dev-A', fingerprint: 'fp-A', machine_key: 'mk-A', status: 'online' },
      ],
    })
    const { result } = renderHook(() => useEnsureAgentReady('sp-1', agent))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(h.bindSpaceDevice).not.toHaveBeenCalled()
  })

  it('reclaim() 显式接管：把本机绑为 control_device', async () => {
    const agent = setStores({ controlDeviceId: null, workingDir: '/Users/a/proj' })
    const { result } = renderHook(() => useEnsureAgentReady('sp-1', agent))
    await waitFor(() => expect(result.current.status).toBe('needs-reclaim'))
    await act(async () => {
      await result.current.reclaim()
    })
    expect(h.bindSpaceDevice).toHaveBeenCalledWith('sp-1', 'dev-A')
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('开箱自愈落目录走 updateSpace，不走 updateAgent', async () => {
    const agent = setStores({ controlDeviceId: null, workingDir: '' })
    h.ensureDefaultAgentDir.mockResolvedValue({
      success: true,
      path: '/Users/a/TabTin/Org/Space',
    })
    h.loadAgent.mockResolvedValue({
      id: 'ag-1',
      name: 'Agent',
      control_device_id: null,
      working_dir: '',
    })

    const { result } = renderHook(() => useEnsureAgentReady('sp-1', agent))

    await waitFor(() => expect(h.bindSpaceDevice).toHaveBeenCalledWith('sp-1', 'dev-A'))
    await waitFor(() => {
      expect(h.updateSpace).toHaveBeenCalledWith(
        'sp-1',
        expect.objectContaining({
          working_dir: '/Users/a/TabTin/Org/Space',
          working_dir_type: 'mixed',
          device_fingerprint: 'fp-A',
        }),
      )
    })
    expect(h.updateAgent).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })
})
