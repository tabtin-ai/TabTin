import { describe, expect, it } from 'vitest'
import { HostTurnStore } from '../../../../../../packages/agent-host/src/policy/index.js'
import { DeviceIdentityStore } from '../../../../../../packages/agent-host/src/state/device-identity/device-identity-store.js'

import { validateLocalExecutionTarget } from './validateLocalExecutionTarget.js'

const target = {
  kind: 'bound_device' as const,
  device_identity_key: 'device-1',
}

describe('validateLocalExecutionTarget', () => {
  function createTurnStore(deviceId = 'device-1'): HostTurnStore {
    const store = new HostTurnStore()
    store.replaceSnapshots([{
      organizationId: 'org-1',
      organizationDetail: { id: 'org-1', name: 'Organization' },
      agentDetail: {
        id: 'agent-1',
        organization_id: 'org-1',
        agent_config: {},
        organization_allow_member_yolo: false,
      },
      workspaceDetail: {
        id: 'workspace-1',
        organization_id: 'org-1',
        working_dir: '/tmp/workspace-1',
        working_dir_type: 'code',
        approval_grant: 'always_ask',
        device_id: deviceId,
      },
      runtimeConfig: {
        operationSwitches: {},
        memoryCapability: false,
        enabledApps: [],
      },
    }])
    return store
  }

  function createDeviceStore(deviceId = 'device-1'): DeviceIdentityStore {
    const store = new DeviceIdentityStore()
    store.setRegistration({ organizationId: 'org-1', deviceId })
    return store
  }

  it('执行目标、Workspace 绑定和当前 AgentHost Device.id 一致时允许执行', () => {
    expect(() => validateLocalExecutionTarget({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      target,
      turnStore: createTurnStore(),
      deviceIdentityStore: createDeviceStore(),
    })).not.toThrow()
  })

  it('目标不是当前 AgentHost 身份时拒绝执行', () => {
    expect(() => validateLocalExecutionTarget({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      target,
      turnStore: createTurnStore('device-2'),
      deviceIdentityStore: createDeviceStore(),
    })).toThrow('does not match this device')
  })

  it('当前 AgentHost 注册设备与 Workspace 目标不一致时拒绝执行', () => {
    expect(() => validateLocalExecutionTarget({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      target,
      turnStore: createTurnStore(),
      deviceIdentityStore: createDeviceStore('device-2'),
    })).toThrow('current AgentHost device does not match')
  })

  it('初始化未完成或绑定失效后拒绝执行', () => {
    const turnStore = createTurnStore()
    turnStore.invalidateExecutionBindings()

    expect(() => validateLocalExecutionTarget({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      target,
      turnStore,
      deviceIdentityStore: createDeviceStore(),
    })).toThrow('state is not ready')
  })
})
