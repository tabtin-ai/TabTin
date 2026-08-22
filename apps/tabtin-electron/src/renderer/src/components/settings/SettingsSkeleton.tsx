import React from 'react'
import { Skeleton } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'

const SECTION_CARD_COUNT = 3

interface SettingsSkeletonProps {
  className?: string
  /** 是否渲染顶部 tab 条占位（组合面板首次加载时减少布局跳变） */
  showTabBar?: boolean
}

export const SettingsSkeleton: React.FC<SettingsSkeletonProps> = ({
  className,
  showTabBar = true,
}) => {
  return (
    <div
      className={cn('flex h-full min-h-0 w-full flex-col', className)}
      aria-hidden="true"
      aria-busy="true"
      data-testid="settings-panel-skeleton"
    >
      <div className="mb-6 flex shrink-0 min-w-0 items-end gap-4">
        <Skeleton width={56} height={56} rounded="lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton width="38%" height={20} rounded="md" />
          <Skeleton width="52%" height={14} rounded="md" className="opacity-75" />
        </div>
      </div>

      {showTabBar ? (
        <div className="mb-4 shrink-0">
          <Skeleton width={280} height={36} rounded="lg" />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-4">
        {Array.from({ length: SECTION_CARD_COUNT }, (_, index) => (
          <div
            key={index}
            className="space-y-3 rounded-[12px] bg-muted/10 px-4 py-3"
          >
            <Skeleton width="32%" height={16} rounded="md" />
            <Skeleton width="100%" height={14} rounded="md" className="opacity-70" />
            <Skeleton width="86%" height={14} rounded="md" className="opacity-60" />
          </div>
        ))}
      </div>
    </div>
  )
}
