import React from 'react'
import { cn } from '@utils/cn'
import { TABTIN_MARK_ON_DARK_URL, TABTIN_MARK_ON_LIGHT_URL } from '@/constants/brandLogo'

export interface SidebarBrandHeaderProps {
  className?: string
  /** 双端开发时由主进程注入到 renderer URL；正式用户不会看到该标识。 */
  devInstanceId?: string
}

function getDevInstanceIdFromUrl(): string | undefined {
  const instanceId = new URLSearchParams(window.location.search).get('tabtin-dev-instance')?.trim()
  return instanceId || undefined
}

/**
 * 侧栏左上角品牌区：主题自适应 logo + 产品名。
 * 浅色模式用黑色 logo，深色模式用白色 logo。
 */
export const SidebarBrandHeader: React.FC<SidebarBrandHeaderProps> = ({ className, devInstanceId }) => {
  const instanceId = devInstanceId ?? getDevInstanceIdFromUrl()
  const productName = instanceId ? `TabTin · IM 测试端 ${instanceId}` : 'TabTin · 主端'

  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <span className="relative h-8 w-8 shrink-0" aria-hidden>
        <img
          src={TABTIN_MARK_ON_LIGHT_URL}
          alt=""
          className="h-8 w-8 object-contain dark:hidden"
          draggable={false}
        />
        <img
          src={TABTIN_MARK_ON_DARK_URL}
          alt=""
          className="hidden h-8 w-8 object-contain dark:block"
          draggable={false}
        />
      </span>
      <span className="truncate text-body font-semibold leading-none tracking-wide text-foreground">
        {productName}
      </span>
    </div>
  )
}

SidebarBrandHeader.displayName = 'SidebarBrandHeader'
