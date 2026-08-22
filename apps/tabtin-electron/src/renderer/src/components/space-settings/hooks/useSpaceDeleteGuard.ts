/**
 * useSpaceDeleteGuard —— Space 删除入口的统一守卫（workspace-requirements §5.4）
 *
 * 把「能不能删」收敛成一个 hook，供 SpaceSettingsPane 的
 * GeneralSection 共用，避免两个删除入口各写一套规则：
 *
 * 1. `last-space`：按当前 Team + 执行设备计数（与后端 LAST_SPACE_REQUIRED 同口径），
 *    最后一个 Space 删除禁用；无 control_device 的遗留 Space 退化为整个 Team 计数。
 * 2. `remote`：远程控制端不能删除 Space（与后端 REMOTE_DELETE_FORBIDDEN 同口径），
 *    禁用并提示回到执行设备本机操作，而不是静默隐藏入口。
 * 3. `resolving`：设备信息还在加载，先禁用避免误放行（不展示提示，防闪现）。
 *
 * 前端判定只是交互护栏，后端 service 层有同口径校验兜底。
 */
import { useMemo } from 'react'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useIsRemoteViewer } from '@components/context-space/hooks/useIsRemoteViewer'
import type { Space } from '@tabtin/app-shell'

export type SpaceDeleteBlockReason = 'last-space' | 'remote' | 'resolving' | null

export interface SpaceDeleteGuardResult {
  /** 删除入口是否可用 */
  canDelete: boolean
  /** 禁用原因（可用时为 null） */
  blockReason: SpaceDeleteBlockReason
  /** 远程态时执行设备名，用于提示文案 */
  controlDeviceName: string | null
  /** 是否远程查看（也用于回收站/归档等本机生命周期动作的禁用） */
  isRemoteViewer: boolean
  /** 设备信息仍在解析中 */
  isResolving: boolean
}

export function useSpaceDeleteGuard(space: Space | null): SpaceDeleteGuardResult {
  const { isRemoteViewer, isResolving, controlDeviceName } = useIsRemoteViewer(space?.id)
  const spaces = useSpaceStore((s) => s.spaces)

  const isLastSpace = useMemo(() => {
    if (!space || space.type !== 'workspace') return false
    // 与后端 _assert_not_last_space_for_device 同口径：
    // 有执行设备 → Team + 该设备下的活跃 workspace；无设备 → 整个 Team 兜底。
    const peers = spaces.filter(
      (s) =>
        s.organization_id === space.organization_id &&
        s.type === 'workspace' &&
        !s.is_archived &&
        (!space.control_device_id || s.control_device_id === space.control_device_id),
    )
    // peers 为空通常是列表尚在加载，不能当成「最后一个 Space」误锁删除入口。
    if (peers.length === 0) return false
    return peers.length <= 1
  }, [spaces, space])

  return useMemo<SpaceDeleteGuardResult>(() => {
    let blockReason: SpaceDeleteBlockReason = null
    if (isResolving) blockReason = 'resolving'
    else if (isRemoteViewer) blockReason = 'remote'
    else if (isLastSpace) blockReason = 'last-space'
    return {
      canDelete: blockReason === null,
      blockReason,
      controlDeviceName,
      isRemoteViewer,
      isResolving,
    }
  }, [isResolving, isRemoteViewer, isLastSpace, controlDeviceName])
}
