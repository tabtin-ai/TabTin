import { useDeviceStore } from '@stores/useDeviceStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { isCurrentDeviceControl } from '@/services/deviceControlMatch'

export interface RemoteExecutionAccess {
  isRemoteViewer: boolean
  isResolving: boolean
  controlDeviceId: string | null
  controlDeviceName: string | null
  currentDeviceId: string | null
  workingDir: string | null
}

export interface SessionExecutionTarget {
  kind: 'bound_device'
  device_identity_key: string
}

const NOT_REMOTE: RemoteExecutionAccess = {
  isRemoteViewer: false,
  isResolving: false,
  controlDeviceId: null,
  controlDeviceName: null,
  currentDeviceId: null,
  workingDir: null,
}

interface AgentLike {
  id?: string | null
  control_device_id?: string | null
  bound_device_id?: string | null
  working_dir?: string | null
}

interface SpaceLike {
  id?: string | null
  type?: string
  agent_id?: string | null
  execution_agent_id?: string | null
  execution_space_id?: string | null
  control_device_id?: string | null
  bound_device_id?: string | null
  owner_execution_device_id?: string | null
  owner_execution_device_name?: string | null
  working_dir?: string | null
}

function isWorkspaceLike(
  space: SpaceLike | null | undefined,
): boolean {
  return !!space && (space.type === 'workspace' || !!space.agent_id || !!space.execution_agent_id)
}

function findSpace(spaces: SpaceLike[], selectedSpace: SpaceLike | null | undefined, spaceId: string): SpaceLike | null {
  return spaces.find((item) => item.id === spaceId)
    ?? (selectedSpace?.id === spaceId ? selectedSpace : null)
}

function resolveAgent(space: SpaceLike | null | undefined, spaceState: {
  selectedAgent?: AgentLike | null
  agentCache?: Record<string, AgentLike | undefined>
}): AgentLike | null {
  const agentId = space?.execution_agent_id ?? space?.agent_id ?? null
  if (!agentId) return null
  return spaceState.agentCache?.[agentId]
    ?? (spaceState.selectedAgent?.id === agentId ? spaceState.selectedAgent : null)
}

function resolveWorkspaceBinding(
  space: SpaceLike | null | undefined,
  agent: AgentLike | null,
): { controlDeviceId: string | null; controlDeviceName: string | null; workingDir: string | null } {
  return {
    controlDeviceId: space?.control_device_id
      ?? space?.bound_device_id
      ?? agent?.control_device_id
      ?? agent?.bound_device_id
      ?? null,
    controlDeviceName: null,
    workingDir: space?.working_dir || agent?.working_dir || null,
  }
}

function resolveExecutionBinding(
  space: SpaceLike | null,
  spaceState: {
    spaces?: SpaceLike[]
    selectedSpace?: SpaceLike | null
    selectedAgent?: AgentLike | null
    agentCache?: Record<string, AgentLike | undefined>
  },
): { controlDeviceId: string | null; controlDeviceName: string | null; workingDir: string | null } | null {
  if (!space) return null

  // 分层模型：team_space（Project 协作房间）无单一控制设备；执行落到成员各自的
  // Workspace，成员不是"远程观察者"。因此这里不再对 team_space 解析 owner 设备，
  // 直接按非 workspace 处理（返回 null → NOT_REMOTE）。
  if (!isWorkspaceLike(space)) return null
  return resolveWorkspaceBinding(space, resolveAgent(space, spaceState))
}

export function getRemoteExecutionAccess(spaceId: string | null | undefined): RemoteExecutionAccess {
  if (!spaceId) return NOT_REMOTE

  const spaceState = useSpaceStore.getState()
  const deviceState = useDeviceStore.getState()
  const spaces = spaceState.spaces as SpaceLike[]
  const selectedSpace = spaceState.selectedSpace as SpaceLike | null | undefined
  const space = findSpace(spaces, selectedSpace, spaceId)
  const binding = resolveExecutionBinding(space, spaceState)
  if (!binding) return NOT_REMOTE

  const { controlDeviceId } = binding
  const currentDevice = deviceState.currentDevice ?? null
  const currentDeviceId = currentDevice?.id ?? null
  const devices = deviceState.devices ?? []
  const controlDevice = controlDeviceId
    ? devices.find((device) => device.id === controlDeviceId)
    : null
  const isResolving = !currentDeviceId
  const isControl =
    !isResolving &&
    isCurrentDeviceControl(controlDeviceId, currentDevice, devices)

  return {
    isRemoteViewer: !isResolving && !isControl && !!controlDeviceId && controlDeviceId !== currentDeviceId,
    isResolving,
    controlDeviceId,
    controlDeviceName: controlDevice?.name ?? binding.controlDeviceName,
    currentDeviceId,
    workingDir: binding.workingDir,
  }
}

export function isRemoteExecutionViewer(spaceId: string | null | undefined): boolean {
  return getRemoteExecutionAccess(spaceId).isRemoteViewer
}

/**
 * 新会话优先消费服务端签发的执行目标；旧会话缺字段时才读取 Workspace 投影。
 * `bound_device` 指向当前 AgentHost 注册身份时仍是本机执行，不能仅因目标字段存在
 * 就强制进入 gateway。
 */
export function resolveExecutionTargetLocation(input: {
  target?: SessionExecutionTarget | null
  legacyTargetDeviceId?: string | null
  spaceId?: string | null
}): 'local' | 'remote' | 'unresolved' {
  const legacyTargetDeviceId = input.legacyTargetDeviceId?.trim()
  if (legacyTargetDeviceId) {
    const deviceState = useDeviceStore.getState()
    const currentDevice = deviceState.currentDevice ?? null
    if (!currentDevice?.id) return 'unresolved'
    return isCurrentDeviceControl(
      legacyTargetDeviceId,
      currentDevice,
      deviceState.devices ?? [],
    ) ? 'local' : 'remote'
  }

  const target = input.target
  if (!target) {
    const access = getRemoteExecutionAccess(input.spaceId)
    if (access.isResolving) return 'unresolved'
    return access.isRemoteViewer ? 'remote' : 'local'
  }
  if (!target.device_identity_key) return 'unresolved'

  const deviceState = useDeviceStore.getState()
  const currentDevice = deviceState.currentDevice ?? null
  if (!currentDevice?.id) return 'unresolved'
  return target.device_identity_key === currentDevice.id ? 'local' : 'remote'
}
