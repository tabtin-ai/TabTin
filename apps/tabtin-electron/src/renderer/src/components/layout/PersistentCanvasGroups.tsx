import React, { Activity } from 'react'
import { cn } from '@utils/cn'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { CanvasGroupLayout } from './CanvasGroupLayout'

interface PersistentCanvasGroupsProps {
  groups: CanvasLayoutGroup[]
  activeGroupId: string | null
  crawlspaceId?: string | null
  className?: string
}

/**
 * 多 canvas group 持久挂载——切换 group 不卸载旧 group 的子树，但用 React
 * 19.2 `<Activity>` 暂停非 active group 的所有 effect / 订阅，避免后台
 * group 持续消耗 CPU。React state 仍保留，切回来秒恢复。
 *
 * `isGroupActive` props 仍传给 `CanvasGroupLayout`——子组件可据此控制
 * 「DOM 自带副作用」（如 video.pause()）和 portal slot 的 active 状态。
 */
export const PersistentCanvasGroups: React.FC<PersistentCanvasGroupsProps> = ({
  groups,
  activeGroupId,
  crawlspaceId,
  className,
}) => {
  if (groups.length === 0) return null

  const hasActiveGroup = Boolean(activeGroupId)

  return (
    <div
      className={cn('absolute inset-0', className)}
      style={{ pointerEvents: hasActiveGroup ? 'auto' : 'none' }}
    >
      {groups.map(group => {
        const isActive = group.id === activeGroupId
        return (
          <Activity key={group.id} mode={isActive ? 'visible' : 'hidden'}>
            <div
              className="absolute inset-0"
              aria-hidden={!isActive}
              data-canvas-group-id={group.id}
            >
              <CanvasGroupLayout
                group={group}
                className="h-full w-full"
                crawlspaceId={crawlspaceId}
                isGroupActive={isActive}
              />
            </div>
          </Activity>
        )
      })}
    </div>
  )
}

PersistentCanvasGroups.displayName = 'PersistentCanvasGroups'
