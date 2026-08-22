/**
 * VaultPanelLayout —— 通用容器（master-detail 双栏）。
 *
 * 把 toolbar / list / detail 三块按固定比例排版，供「凭据」面板共用。
 */

import React from 'react'
import { cn } from '@utils/cn'

interface VaultPanelLayoutProps {
  toolbar: React.ReactNode
  list: React.ReactNode
  detail: React.ReactNode
  className?: string
}

export const VaultPanelLayout: React.FC<VaultPanelLayoutProps> = ({ toolbar, list, detail, className }) => (
  <div
    className={cn(
      'rounded-xl border border-border/60 flex flex-col overflow-hidden bg-background',
      className,
    )}
    style={{ height: 'calc(100vh - 260px)', minHeight: '480px' }}
  >
    <div className="shrink-0 border-b border-border/40 p-3">{toolbar}</div>

    <div className="flex-1 flex min-h-0">
      <div className="w-[40%] min-w-[240px] max-w-[360px] border-r border-border/40 flex flex-col">
        {list}
      </div>
      <div className="flex-1 min-w-0 bg-muted/[0.04]">{detail}</div>
    </div>
  </div>
)
