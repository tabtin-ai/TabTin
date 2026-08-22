/**
 * useSpaceSettingsEditGuard — Space 设置编辑守卫（远程查看）
 *
 * 与 deleteGuard 同口径：当前客户端 ≠ Space 执行设备时，设置页只能查看不能改。
 * 后端 update_agent / bind_device 等仍有兜底；这里是前端交互护栏。
 *
 * ⚠️ `blockSettingsEdit` 只跟真·遥控器（`isRemoteViewer`），**不要**把 `isResolving`
 *（本机设备未注册完）并进来——那会让 YOLO 开关等控件在设备就绪前静默长期灰死，
 * 且不展示 RemoteSettingsReadonlyNotice（notice 只看 isRemoteViewer）。与
 * `useIsRemoteViewer` 三态正典一致：resolving → 短暂骨架；无 control_device 自愈
 * 窗口 → 不拦；仅真遥控器 → 只读。
 */
import { useMemo } from 'react'
import { useIsRemoteViewer } from '@components/context-space/hooks/useIsRemoteViewer'

export interface SpaceSettingsEditGuard {
  isRemoteViewer: boolean
  isResolving: boolean
  controlDeviceName: string | null
  /** true → 所有 Agent/Space 配置表单应只读（仅真·遥控器） */
  blockSettingsEdit: boolean
}

/** 纯函数：导出供单测钉死「resolving ≠ 只读锁」契约。 */
export function deriveBlockSettingsEdit(remote: {
  isRemoteViewer: boolean
}): boolean {
  return remote.isRemoteViewer
}

export function useSpaceSettingsEditGuard(
  spaceId: string | null | undefined,
): SpaceSettingsEditGuard {
  const remote = useIsRemoteViewer(spaceId)

  return useMemo(
    () => ({
      isRemoteViewer: remote.isRemoteViewer,
      isResolving: remote.isResolving,
      controlDeviceName: remote.controlDeviceName,
      blockSettingsEdit: deriveBlockSettingsEdit(remote),
    }),
    [
      remote.isRemoteViewer,
      remote.isResolving,
      remote.controlDeviceName,
    ],
  )
}

export function effectiveCanEditAgentSettings(
  roleCanEdit: boolean,
  guard: Pick<SpaceSettingsEditGuard, 'blockSettingsEdit'>,
): boolean {
  return roleCanEdit && !guard.blockSettingsEdit
}

/** B 类 Space 设置（admin+）同样受远程查看守卫 */
export function effectiveCanManageSpaceSettings(
  roleCanManage: boolean,
  guard: Pick<SpaceSettingsEditGuard, 'blockSettingsEdit'>,
): boolean {
  return roleCanManage && !guard.blockSettingsEdit
}
