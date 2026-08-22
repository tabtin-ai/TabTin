/**
 * 执行设备「是否本机」判定 —— 远程/离线徽标、遥控器 gate、开箱自愈共用。
 *
 * 除 device id 精确相等外，还需覆盖 fingerprint / machine_key 漂移场景：清缓存 /
 * 重装等会让后端同一物理机产生多条 Device 记录；存量 Space 仍钉在旧 id 上。
 *
 * 自动换绑（useEnsureAgentReady）只信任本函数；hostname 同名绝不能当真同机。
 */

export type DeviceControlView = {
  id: string
  fingerprint?: string | null
  machine_key?: string | null
  name?: string | null
  status?: string | null
}

const AVAILABLE_STATUSES = new Set(['online', 'busy'])

export function isDeviceReachable(status: string | null | undefined): boolean {
  return !!status && AVAILABLE_STATUSES.has(status)
}

/**
 * Workspace 选择器是否可选 —— 与 useRemoteExecutionGate 对齐：
 * 本机即执行设备始终可选；遥控器仅在绑定设备明确 offline 时不可选；
 * 设备列表短暂缺失（无 status）不误伤。
 */
export function isWorkspaceExecutionSelectable(input: {
  controlDeviceId: string | null | undefined
  controlDeviceStatus: string | null | undefined
  currentDevice: DeviceControlView | null | undefined
  devices: readonly DeviceControlView[]
}): boolean {
  const { controlDeviceId, controlDeviceStatus, currentDevice, devices } = input
  if (!controlDeviceId) return true
  if (isCurrentDeviceControl(controlDeviceId, currentDevice, devices)) return true
  if (!controlDeviceStatus) return true
  return isDeviceReachable(controlDeviceStatus)
}

/**
 * 两条 Device 记录是否指向同一台物理机。
 *
 * 仅信任：id / fingerprint。machine_key 只供服务端在重装注册时恢复唯一离线设备，
 * 不能在客户端直接放行，否则同机多安装的歧义会静默接管执行权。
 */
export function isSamePhysicalDevice(
  bound: DeviceControlView | null | undefined,
  current: DeviceControlView | null | undefined,
): boolean {
  if (!bound?.id || !current?.id) return false
  if (bound.id === current.id) return true
  const boundFp = bound.fingerprint?.trim()
  const currentFp = current.fingerprint?.trim()
  if (boundFp && currentFp && boundFp === currentFp) return true

  return false
}

/**
 * 当前 Electron 会话是否应视为 Space/Agent 的执行设备（本机 control）。
 */
export function isCurrentDeviceControl(
  controlDeviceId: string | null | undefined,
  currentDevice: DeviceControlView | null | undefined,
  devices: readonly DeviceControlView[],
): boolean {
  if (!controlDeviceId || !currentDevice?.id) return false
  if (controlDeviceId === currentDevice.id) return true
  const boundDevice = devices.find(d => d.id === controlDeviceId) ?? null
  return isSamePhysicalDevice(boundDevice, currentDevice)
}
