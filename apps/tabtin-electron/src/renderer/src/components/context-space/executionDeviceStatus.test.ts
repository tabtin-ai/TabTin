import { describe, expect, it } from 'vitest'
import {
  computeExecutionDeviceStatus,
  resolveCurrentMemberProjectCompanionDeviceStatus,
} from './executionDeviceStatus'

const t = (key: string, options?: { defaultValue?: string; device?: string }) => {
  if (options?.defaultValue) {
    return options.device
      ? options.defaultValue.replace('{{device}}', options.device)
      : options.defaultValue
  }
  return key
}

describe('computeExecutionDeviceStatus', () => {
  const devices = [
    { id: 'device-local', name: 'Local Mac', status: 'online' },
    { id: 'device-remote', name: 'Remote Mac', status: 'offline' },
    { id: 'device-remote-online', name: 'Remote Online', status: 'online' },
  ]

  it('returns unbound when control device is missing', () => {
    expect(computeExecutionDeviceStatus(null, devices[0], devices, t)).toEqual({
      label: '未绑定',
      title: 'Agent 还没有绑定执行设备',
      tone: 'unbound',
    })
  })

  it('returns null when execution happens on the current device', () => {
    expect(computeExecutionDeviceStatus('device-local', devices[0], devices, t)).toBeNull()
  })

  it('reads a Project device status from its explicitly identified companion 工作空间', () => {
    const project = {
      id: 'project-1',
      type: 'team_space',
      my_workspace: { id: 'workspace-1' },
      // 协作容器残留的绑定不能覆盖成员自己的执行现场。
      control_device_id: 'device-local',
    }
    const companionWorkspace = {
      id: 'workspace-1',
      type: 'workspace',
      project_id: 'project-1',
      control_device_id: 'device-remote',
    }

    expect(
      resolveCurrentMemberProjectCompanionDeviceStatus(
        project,
        [project, companionWorkspace],
        devices[0],
        devices,
        t,
      ),
    ).toMatchObject({ label: '远程', secondaryLabel: '离线' })
  })

  it('keeps a regular 工作空间 device status unchanged', () => {
    const workspace = { id: 'workspace-1', type: 'workspace', control_device_id: 'device-remote' }

    expect(
      resolveCurrentMemberProjectCompanionDeviceStatus(workspace, [workspace], devices[0], devices, t),
    ).toMatchObject({ label: '远程', secondaryLabel: '离线' })
  })

  it('hides the Project device status when only a legacy execution_space_id is available', () => {
    const project = {
      id: 'project-1',
      type: 'team_space',
      execution_space_id: 'legacy-workspace',
      control_device_id: 'device-local',
    }
    const legacyWorkspace = {
      id: 'legacy-workspace',
      type: 'workspace',
      control_device_id: 'device-remote',
    }

    expect(resolveCurrentMemberProjectCompanionDeviceStatus(
      project,
      [project, legacyWorkspace],
      devices[0],
      devices,
      t,
    )).toBeNull()
  })

  it('returns remote when only machine_key matches', () => {
    const stale = {
      id: 'device-stale',
      fingerprint: 'fp-old',
      machine_key: 'mk-same',
      name: 'LAPTOP-FKICRALO (win32)',
      status: 'offline',
    }
    const current = {
      id: 'device-new',
      fingerprint: 'fp-new',
      machine_key: 'mk-same',
      name: 'LAPTOP-FKICRALO (win32)',
      status: 'online',
    }
    expect(
      computeExecutionDeviceStatus('device-stale', current, [stale, current], t),
    ).toMatchObject({ label: '远程', secondaryLabel: '离线' })
  })

  it('returns remote when only hostname matches (no silent same-machine)', () => {
    const stale = {
      id: 'device-stale',
      fingerprint: 'fp-old',
      name: 'LAPTOP-FKICRALO (win32)',
      status: 'offline',
    }
    const current = {
      id: 'device-new',
      fingerprint: 'fp-new',
      name: 'LAPTOP-FKICRALO (win32)',
      status: 'online',
    }
    expect(
      computeExecutionDeviceStatus('device-stale', current, [stale, current], t),
    ).toMatchObject({ label: '远程', secondaryLabel: '离线' })
  })

  it('returns remote + offline tags when execution device is on another machine and unreachable', () => {
    expect(computeExecutionDeviceStatus('device-remote', devices[0], devices, t)).toEqual({
      label: '远程',
      secondaryLabel: '离线',
      title: 'Agent 的执行设备「Remote Mac」当前不在线',
      tone: 'remote',
      secondaryTone: 'offline',
    })
  })

  it('returns remote when execution device is online on another machine', () => {
    expect(computeExecutionDeviceStatus('device-remote-online', devices[0], devices, t)).toEqual({
      label: '远程',
      title: 'Agent 在「Remote Online」上工作，需切换到该设备才能操作这个应用',
      tone: 'remote',
    })
  })

  it('returns remote + offline when control device is not in the current user list', () => {
    expect(computeExecutionDeviceStatus('device-someone-else', devices[0], devices, t)).toEqual({
      label: '远程',
      secondaryLabel: '离线',
      title: 'Agent 的执行设备「执行设备」当前不在线',
      tone: 'remote',
      secondaryTone: 'offline',
    })
  })
})
