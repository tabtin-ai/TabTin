/**
 * useRemoteExecutionGate — 判断「这个 Space 的执行设备是否可接收对话指令」
 *
 * 遥控器语义：当前 Electron 不是执行设备时，仍然可以在聊天里发消息；消息应路由给
 * Space 绑定的执行设备去跑。这里不能把「不能本地打开文件/终端/浏览器」扩大成「不能
 * 对话」。只有绑定执行设备不可达时才禁发，避免用户提交后落到 runtime offline。
 *
 * 判定刻意用 `isRemoteViewer`（当前设备 ≠ 执行设备）而非 `device.status`：
 *   - 本机就是执行设备时，即使心跳短暂 offline 也能跑，绝不能因 status 拦本机；
 *   - 遥控器只有在绑定执行设备明确 offline / draining 等不可达时才拦；
 *     设备列表短暂缺失时交给后端路由权威判断，避免假禁发。
 *
 * 三态沿用 `useIsRemoteViewer`：解析中 / 无 control_device 自愈窗口 / 本机即 control
 * 一律不拦（`isBlocked=false`），避免误伤本机与首帧闪现。
 */
import { useMemo } from 'react'
import { useDeviceStore } from '@/stores/useDeviceStore'
import { useIsRemoteViewer } from '@components/context-space/hooks/useIsRemoteViewer'

export interface RemoteExecutionGate {
  /** 当前设备不是执行设备，但可以作为遥控器发聊天消息。 */
  isRemoteViewer: boolean
  /** 绑定执行设备不可达 → 禁止发送，避免提交到离线 runtime。 */
  isBlocked: boolean
  /** device store / agent 仍在解析；调用方应短暂等待，不据此拦截或闪提示。 */
  isResolving: boolean
  /** 执行设备名，用于文案「这个 Space 在「X」上运行」。 */
  controlDeviceName: string | null
  /** 执行设备当前明确不可达（offline / draining 等）→ 文案走「离线」。 */
  controlDeviceOffline: boolean
}

const NOT_BLOCKED: RemoteExecutionGate = {
  isRemoteViewer: false,
  isBlocked: false,
  isResolving: false,
  controlDeviceName: null,
  controlDeviceOffline: false,
}

// 与后端 DEVICE_AVAILABLE_STATUSES 对齐：online / busy 视为可达，其余按离线处理。
const AVAILABLE_STATUSES = new Set(['online', 'busy'])

export function useRemoteExecutionGate(
  spaceId: string | null | undefined,
): RemoteExecutionGate {
  const { isRemoteViewer, isResolving, controlDeviceName, controlDeviceId } =
    useIsRemoteViewer(spaceId)
  const devices = useDeviceStore((s) => s.devices)

  return useMemo<RemoteExecutionGate>(() => {
    if (!isRemoteViewer) {
      return isResolving ? { ...NOT_BLOCKED, isResolving: true } : NOT_BLOCKED
    }

    const controlDevice = controlDeviceId
      ? (devices ?? []).find((d) => d.id === controlDeviceId) ?? null
      : null
    const status = controlDevice?.status ?? null

    const controlDeviceOffline = !!status && !AVAILABLE_STATUSES.has(status)

    return {
      isRemoteViewer: true,
      isBlocked: controlDeviceOffline,
      isResolving: false,
      controlDeviceName,
      controlDeviceOffline,
    }
  }, [isRemoteViewer, isResolving, controlDeviceName, controlDeviceId, devices])
}
