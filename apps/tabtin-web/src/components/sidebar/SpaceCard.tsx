/**
 * SpaceCard — Web 端 Space 列表项组件
 *
 * UI 与 Electron SpaceCard 保持一致，精简掉：
 * - device status indicator（Web 无设备管理）
 * - AgentContextMenuRadix / SpaceContextMenu（Web 暂无右键菜单）
 * - IM / 群协作衍生分支（Web 暂只支持 workspace）
 *
 * @see apps/tabtin-electron/src/renderer/src/components/sidebar/SpaceCard.tsx
 */

import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  useSpaceListStore,
  type SpaceListItem,
  getSpaceNavigationIcon,
  getSpaceNavigationLabel,
} from '@tabtin/app-shell'
import { spaceHomePath } from '@/features/space/spaceRoutes'
import { cn } from '@/utils/cn'

interface SpaceCardProps {
  space: SpaceListItem
  isSelected: boolean
}

export const SpaceCard: React.FC<SpaceCardProps> = ({ space, isSelected }) => {
  const { t } = useTranslation('sidebar')
  const navigate = useNavigate()
  const location = useLocation()
  const selectSpace = useSpaceListStore(state => state.selectSpace)

  const kind = space.navigationKind
  const displayIcon = space.icon || getSpaceNavigationIcon(kind, space.type)

  const handleClick = () => {
    selectSpace(space)
    if (space.navigationKind === 'workspace') {
      const targetPath = spaceHomePath(space.organization_id, space.source_id)
      if (location.pathname !== targetPath) {
        navigate(targetPath)
      }
    }
  }

  const title = buildTitle(space, t)

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'group relative w-full h-9 rounded-lg border flex items-center gap-2 px-2 text-left transition-all',
        isSelected
          ? 'bg-accent/15 border-accent/45'
          : 'bg-transparent border-transparent hover:bg-muted/45 hover:border-border/35'
      )}
      title={title}
      aria-label={space.name}
    >
      <span className="shrink-0 text-body leading-none select-none">
        {displayIcon}
      </span>
      <span className="flex-1 truncate text-body text-foreground/90">
        {space.name}
      </span>

      {space.unread_count > 0 && (
        <span className="shrink-0 min-w-[16px] h-4 rounded-full bg-destructive text-destructive-foreground text-caption font-medium flex items-center justify-center px-1 animate-in zoom-in-50 duration-200">
          {space.unread_count > 99 ? '99+' : space.unread_count}
        </span>
      )}
    </button>
  )
}

function buildTitle(
  space: SpaceListItem,
  _t: (key: string) => string,
): string {
  const navigationLabel = getSpaceNavigationLabel(space.navigationKind)
  return `${navigationLabel} · ${space.name}`
}
