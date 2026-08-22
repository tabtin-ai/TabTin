import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRemoteExecutionAccess,
  resolveExecutionTargetLocation,
} from '../remoteExecutionGuard'

const h = vi.hoisted(() => ({
  spaceState: {} as Record<string, unknown>,
  deviceState: {} as Record<string, unknown>,
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => h.spaceState,
  },
}))

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: {
    getState: () => h.deviceState,
  },
}))

function setStores(opts: {
  controlDeviceId?: string | null
  currentDeviceId?: string | null
  currentDeviceFingerprint?: string | null
  currentDeviceName?: string | null
  currentDeviceStatus?: string | null
  devices?: Array<{
    id: string
    name?: string
    fingerprint?: string
    machine_key?: string
    status?: string
  }>
  workingDir?: string | null
}): void {
  const {
    controlDeviceId = null,
    currentDeviceId = null,
    currentDeviceFingerprint = null,
    currentDeviceName = null,
    currentDeviceStatus = 'online',
    devices = [],
    workingDir = null,
  } = opts
  const agent = {
    id: 'agent-1',
    control_device_id: controlDeviceId,
    working_dir: workingDir,
  }
  h.spaceState = {
    selectedSpace: { id: 'space-1', type: 'workspace', execution_agent_id: 'agent-1' },
    spaces: [{ id: 'space-1', type: 'workspace', execution_agent_id: 'agent-1' }],
    selectedAgent: null,
    agentCache: { 'agent-1': agent },
  }
  h.deviceState = {
    currentDevice: currentDeviceId
      ? {
          id: currentDeviceId,
          fingerprint: currentDeviceFingerprint ?? undefined,
          name: currentDeviceName ?? undefined,
          status: currentDeviceStatus ?? undefined,
        }
      : null,
    devices,
  }
}

describe('remoteExecutionGuard', () => {
  beforeEach(() => {
    h.spaceState = { spaces: [], selectedSpace: null, selectedAgent: null, agentCache: {} }
    h.deviceState = { currentDevice: null, devices: [] }
  })

  it('does not block when the current Electron is the control device', () => {
    setStores({
      controlDeviceId: 'dev-A',
      currentDeviceId: 'dev-A',
      devices: [{ id: 'dev-A', name: 'This Mac' }],
      workingDir: '/Users/me/space',
    })

    const access = getRemoteExecutionAccess('space-1')
    expect(access.isRemoteViewer).toBe(false)
    expect(access.isResolving).toBe(false)
  })

  it('blocks local file access when the Space is bound to another device', () => {
    setStores({
      controlDeviceId: 'dev-B',
      currentDeviceId: 'dev-A',
      devices: [
        { id: 'dev-A', name: 'This Mac' },
        { id: 'dev-B', name: 'Office Mac' },
      ],
      workingDir: '/Users/remote/project',
    })

    const access = getRemoteExecutionAccess('space-1')
    expect(access.isRemoteViewer).toBe(true)
    expect(access.controlDeviceName).toBe('Office Mac')
    expect(access.workingDir).toBe('/Users/remote/project')
  })

  it('does not report remote while the current device is still resolving', () => {
    setStores({
      controlDeviceId: 'dev-B',
      currentDeviceId: null,
      devices: [],
    })

    const access = getRemoteExecutionAccess('space-1')
    expect(access.isResolving).toBe(true)
    expect(access.isRemoteViewer).toBe(false)
  })

  it('reports remote when current device is known even if the device list is still incomplete', () => {
    setStores({
      controlDeviceId: 'dev-B',
      currentDeviceId: 'dev-A',
      devices: [],
    })

    const access = getRemoteExecutionAccess('space-1')
    expect(access.isResolving).toBe(false)
    expect(access.isRemoteViewer).toBe(true)
    expect(access.controlDeviceName).toBeNull()
  })

  it('resolves a legacy target on the current device as local', () => {
    setStores({ currentDeviceId: 'dev-A' })

    expect(resolveExecutionTargetLocation({
      legacyTargetDeviceId: 'dev-A',
    })).toBe('local')
  })

  it('resolves a legacy target on another device as remote', () => {
    setStores({ currentDeviceId: 'dev-A' })

    expect(resolveExecutionTargetLocation({
      legacyTargetDeviceId: 'dev-B',
    })).toBe('remote')
  })

  it('preserves the frozen legacy target when the structured target disagrees', () => {
    setStores({ currentDeviceId: 'dev-A' })

    expect(resolveExecutionTargetLocation({
      target: {
        kind: 'bound_device',
        device_identity_key: 'dev-A',
      },
      legacyTargetDeviceId: 'dev-B',
    })).toBe('remote')
  })

  it('requires an exact Device.id match for a structured execution target', () => {
    h.deviceState = {
      currentDevice: { id: 'dev-new', fingerprint: 'same-fingerprint' },
      devices: [
        { id: 'dev-old', fingerprint: 'same-fingerprint' },
        { id: 'dev-new', fingerprint: 'same-fingerprint' },
      ],
    }

    expect(resolveExecutionTargetLocation({
      target: {
        kind: 'bound_device',
        device_identity_key: 'dev-old',
      },
    })).toBe('remote')
  })

  it('keeps a legacy target unresolved until current device identity is ready', () => {
    setStores({ currentDeviceId: null })

    expect(resolveExecutionTargetLocation({
      legacyTargetDeviceId: 'dev-B',
    })).toBe('unresolved')
  })

  it('uses Space-level execution binding when the Space has no Agent id', () => {
    h.spaceState = {
      selectedSpace: {
        id: 'space-1',
        type: 'workspace',
        agent_id: null,
        execution_agent_id: null,
        control_device_id: 'dev-B',
        bound_device_id: 'dev-B',
        working_dir: '/Users/owner/ooo',
      },
      spaces: [{
        id: 'space-1',
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
      currentDevice: { id: 'dev-A' },
      devices: [
        { id: 'dev-A', name: 'This Mac' },
        { id: 'dev-B', name: 'Owner Mac' },
      ],
    }

    const access = getRemoteExecutionAccess('space-1')

    expect(access.isRemoteViewer).toBe(true)
    expect(access.controlDeviceId).toBe('dev-B')
    expect(access.controlDeviceName).toBe('Owner Mac')
    expect(access.workingDir).toBe('/Users/owner/ooo')
  })

  it('does not treat same hostname as local control (no silent same-machine)', () => {
    setStores({
      controlDeviceId: 'dev-old',
      currentDeviceId: 'dev-new',
      currentDeviceName: 'LAPTOP-FKICRALO (win32)',
      devices: [
        {
          id: 'dev-old',
          fingerprint: 'fp-old',
          name: 'LAPTOP-FKICRALO (win32)',
          status: 'offline',
        },
        {
          id: 'dev-new',
          fingerprint: 'fp-new',
          name: 'LAPTOP-FKICRALO (win32)',
          status: 'online',
        },
      ],
      workingDir: 'C:\\Users\\me\\TabTin\\win',
    })

    const access = getRemoteExecutionAccess('space-1')
    expect(access.isRemoteViewer).toBe(true)
  })

  it('keeps remote guard when only machine_key matches, avoiding silent same-machine takeover', () => {
    h.spaceState = {
      selectedSpace: { id: 'space-1', type: 'workspace', execution_agent_id: 'agent-1' },
      spaces: [{ id: 'space-1', type: 'workspace', execution_agent_id: 'agent-1' }],
      selectedAgent: null,
      agentCache: {
        'agent-1': { id: 'agent-1', control_device_id: 'dev-old', working_dir: '/tmp' },
      },
    }
    h.deviceState = {
      currentDevice: {
        id: 'dev-new',
        fingerprint: 'fp-new',
        machine_key: 'mk-same',
        name: 'Host',
        status: 'online',
      },
      devices: [
        {
          id: 'dev-old',
          fingerprint: 'fp-old',
          machine_key: 'mk-same',
          name: 'Host',
          status: 'offline',
        },
        {
          id: 'dev-new',
          fingerprint: 'fp-new',
          machine_key: 'mk-same',
          name: 'Host',
          status: 'online',
        },
      ],
    }

    const access = getRemoteExecutionAccess('space-1')
    expect(access.isRemoteViewer).toBe(true)
  })

  it('treats a Project as non-remote (members run in their own 工作空间)', () => {
    // 分层模型：team_space 无单一控制设备，成员在自己的 Workspace 执行，
    // 不再被判定为 owner 设备的"远程观察者"。
    h.spaceState = {
      selectedSpace: {
        id: 'team-space-1',
        type: 'team_space',
        execution_space_id: 'owner-space-1',
        owner_execution_device_id: 'dev-B',
        owner_execution_device_name: 'Owner Host',
      },
      spaces: [
        {
          id: 'team-space-1',
          type: 'team_space',
          execution_space_id: 'owner-space-1',
          owner_execution_device_id: 'dev-B',
          owner_execution_device_name: 'Owner Host',
        },
        {
          id: 'owner-space-1',
          type: 'workspace',
          control_device_id: 'dev-B',
          bound_device_id: 'dev-B',
          working_dir: '/Users/owner/project',
        },
      ],
      selectedAgent: null,
      agentCache: {},
    }
    h.deviceState = {
      currentDevice: { id: 'dev-A' },
      devices: [
        { id: 'dev-A', name: 'Member Client' },
        { id: 'dev-B', name: 'Owner Host' },
      ],
    }

    const access = getRemoteExecutionAccess('team-space-1')

    expect(access.isRemoteViewer).toBe(false)
    expect(access.controlDeviceId).toBeNull()
    expect(access.workingDir).toBeNull()
  })

  it('服务端目标指向当前 AgentHost 身份时走本机执行', () => {
    setStores({ currentDeviceId: 'dev-current', devices: [{ id: 'dev-current' }] })

    expect(resolveExecutionTargetLocation({
      target: {
        kind: 'bound_device',
        device_identity_key: 'dev-current',
      },
      spaceId: 'space-1',
    })).toBe('local')
  })

  it('服务端目标指向另一 AgentHost 身份时走 gateway', () => {
    setStores({
      currentDeviceId: 'dev-current',
      devices: [{ id: 'dev-current' }, { id: 'dev-remote' }],
    })

    expect(resolveExecutionTargetLocation({
      target: {
        kind: 'bound_device',
        device_identity_key: 'dev-remote',
      },
      spaceId: 'space-1',
    })).toBe('remote')
  })
})
