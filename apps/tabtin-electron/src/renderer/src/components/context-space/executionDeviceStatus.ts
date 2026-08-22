import type { TFunction } from 'i18next'
import type { ExecutionDeviceStatus } from './terminalOverviewModel'
import { isCurrentDeviceControl, isDeviceReachable } from '@/services/deviceControlMatch'
import type { DeviceControlView } from '@/services/deviceControlMatch'
import {
  resolveCurrentMemberProjectCompanionWorkspace,
  type ProjectExecutionTargetLike,
} from '@/utils/projectExecutionTarget'

export type DeviceLike = DeviceControlView

export type SpaceWithDeviceBinding = {
  control_device_id?: string | null
  bound_device_id?: string | null
  execution_agent_id?: string | null
  agent_id?: string | null
}

export type AgentWithDeviceBinding = {
  control_device_id?: string | null
  bound_device_id?: string | null
}

export function resolveSpaceControlDeviceId(
  space: SpaceWithDeviceBinding | null | undefined,
  agent: AgentWithDeviceBinding | null | undefined,
): string | null {
  return space?.control_device_id
    ?? space?.bound_device_id
    ?? agent?.control_device_id
    ?? agent?.bound_device_id
    ?? null
}

/**
 * 计算执行设备徽标（未绑定 / 离线 / 远程；本机执行返回 null = 无徽标）。
 *
 * 桌面侧栏、对话侧栏 Space 分组、跨 Agent 终端总览复用同一口径。
 */
export function computeExecutionDeviceStatus(
  controlDeviceId: string | null,
  currentDevice: DeviceControlView | null,
  devices: DeviceLike[],
  t: TFunction,
): ExecutionDeviceStatus | null {
  if (!controlDeviceId) {
    return {
      label: t('desktop.deviceStatus.unbound', { defaultValue: '未绑定' }),
      title: t('desktop.deviceStatus.unboundTitle', { defaultValue: 'Agent 还没有绑定执行设备' }),
      tone: 'unbound',
    }
  }
  const currentDeviceId = currentDevice?.id ?? null
  if (!currentDeviceId) return null
  if (isCurrentDeviceControl(controlDeviceId, currentDevice, devices)) return null
  const controlDevice = devices.find(d => d.id === controlDeviceId)
  const deviceName = controlDevice?.name || t('desktop.deviceStatus.remoteDevice', { defaultValue: '执行设备' })
  // 不在当前用户设备列表 = 对本人不可达（含登记在他人账号下），按离线而不是在线远程。
  // 列表里有设备但 status 暂缺时不误标离线，与 isWorkspaceExecutionSelectable 一致。
  if (!controlDevice || (controlDevice.status && !isDeviceReachable(controlDevice.status))) {
    return {
      label: t('desktop.deviceStatus.remote', { defaultValue: '远程' }),
      secondaryLabel: t('desktop.deviceStatus.offline', { defaultValue: '离线' }),
      title: t('desktop.deviceStatus.offlineTitle', {
        device: deviceName,
        defaultValue: 'Agent 的执行设备「{{device}}」当前不在线',
      }),
      tone: 'remote',
      secondaryTone: 'offline',
    }
  }
  return {
    label: t('desktop.deviceStatus.remote', { defaultValue: '远程' }),
    title: t('desktop.deviceStatus.remoteTitle', {
      device: deviceName,
      defaultValue: 'Agent 在「{{device}}」上工作，需切换到该设备才能操作这个应用',
    }),
    tone: 'remote',
  }
}

export function resolveSpaceExecutionDeviceStatus(
  space: SpaceWithDeviceBinding | null | undefined,
  agent: AgentWithDeviceBinding | null | undefined,
  currentDevice: DeviceControlView | null,
  devices: DeviceLike[],
  t: TFunction,
): ExecutionDeviceStatus | null {
  return computeExecutionDeviceStatus(
    resolveSpaceControlDeviceId(space, agent),
    currentDevice,
    devices,
    t,
  )
}

/**
 * Project 的设备状态只读取 Project API 明确标注为当前成员的伴生工作空间。
 * 缺少该工作空间时不展示徽标，绝不回退到容器历史 execution_space_id。
 */
export function resolveCurrentMemberProjectCompanionDeviceStatus<
  TSpace extends SpaceWithDeviceBinding & ProjectExecutionTargetLike,
>(
  project: (TSpace & { my_workspace?: { id?: string | null } | null }) | null | undefined,
  spaces: TSpace[],
  currentDevice: DeviceControlView | null,
  devices: DeviceLike[],
  t: TFunction,
): ExecutionDeviceStatus | null {
  if (project?.type !== 'team_space') {
    return resolveSpaceExecutionDeviceStatus(project, null, currentDevice, devices, t)
  }

  const workspace = resolveCurrentMemberProjectCompanionWorkspace(project, spaces)
  return workspace
    ? resolveSpaceExecutionDeviceStatus(workspace, null, currentDevice, devices, t)
    : null
}
