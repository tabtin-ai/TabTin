/**
 * CrawlspaceViewTab - 单个标签页组件
 *
 * Chrome 风格的标签，用于在 Crawlspace 内切换不同的页面 View
 * 从 WorkspaceViewTab 迁移
 */

import React from 'react'
import { Globe, X } from 'lucide-react'
import { t } from '../../i18n'
import { cn } from '../../utils/cn'

export interface CrawlspaceViewTabProps {
  viewId: string
  title: string
  url: string
  favicon?: string
  isActive: boolean
  onSelect: () => void
  onClose: () => void
  showClose?: boolean
  /** 标签生命周期状态（deferred=休眠, loading=加载中, error=错误） */
  status?: 'active' | 'deferred' | 'loading' | 'error'
  /** Session 颜色标识，有值时在标签底部显示 2px 颜色条 */
  accentColor?: string
  dragData?: {
    text: string
    mimeData: Record<string, string>
    effectAllowed?: DataTransfer['effectAllowed']
  } | null
}

export const CrawlspaceViewTab: React.FC<CrawlspaceViewTabProps> = ({
  viewId,
  title,
  favicon,
  isActive,
  onSelect,
  onClose,
  showClose = true,
  status,
  accentColor,
  dragData
}) => {
  const isDeferred = status === 'deferred'
  const hasError = status === 'error'
  const isLoading = status === 'loading'

  return (
    <div
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      draggable={Boolean(dragData)}
      data-tab-item
      data-tab-key={viewId}
      className={cn(
        'group relative flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer transition-all',
        // 与 ContextTabs 一致：tab 自然宽度 + shrink-0，超容器靠 overflow popover 兜底
        'min-w-[80px] max-w-[200px] shrink-0 border shadow-sm',
        'backdrop-blur-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isActive
          ? 'bg-background border-border text-foreground'
          : 'bg-muted/40 border-transparent text-muted-foreground hover:bg-muted/60'
      )}
      style={accentColor ? { borderBottomColor: accentColor, borderBottomWidth: 2, borderBottomStyle: 'solid' } : undefined}
      onClick={onSelect}
      onDragStart={(e) => {
        if (!dragData) return
        e.dataTransfer.setData('text/plain', dragData.text)
        Object.entries(dragData.mimeData).forEach(([type, value]) => {
          e.dataTransfer.setData(type, value)
        })
        e.dataTransfer.effectAllowed = dragData.effectAllowed ?? 'move'
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      {/* Favicon */}
      <div className={cn(
        'relative flex-shrink-0 w-4 h-4 flex items-center justify-center',
        isDeferred && 'opacity-40'
      )}>
        {/* 加载中动画 */}
        {isLoading ? (
          <div className="w-3.5 h-3.5 border-[1.5px] border-muted-foreground/30 border-t-primary rounded-full animate-spin" />
        ) : (
          <>
            {favicon ? (
              <img
                src={favicon}
                alt=""
                draggable={false}
                className="w-4 h-4 object-contain"
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                  const sibling = e.currentTarget.nextElementSibling
                  if (sibling) {
                    sibling.classList.remove('hidden')
                  }
                }}
              />
            ) : null}
            <span className={cn(favicon ? 'hidden' : '')}>
              <Globe className="w-3.5 h-3.5 text-muted-foreground" />
            </span>
          </>
        )}
        {/* 错误红点 */}
        {hasError && (
          <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-destructive rounded-full" />
        )}
      </div>

      {/* 标题 */}
      <div
        className={cn(
          'flex-1 min-w-0 truncate text-body',
          isActive ? 'text-foreground font-medium' : 'text-muted-foreground',
          isDeferred && 'opacity-60 italic'
        )}
        title={title}
      >
        {title}
      </div>

      {/* 关闭按钮 —— absolute 悬浮在标题之上，hover 才显示 */}
      {showClose && (
        <button
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded transition-opacity',
            'opacity-0 group-hover:opacity-100',
            'bg-background/90 backdrop-blur-sm hover:bg-accent/50'
          )}
          aria-label={t('common.close')}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}
