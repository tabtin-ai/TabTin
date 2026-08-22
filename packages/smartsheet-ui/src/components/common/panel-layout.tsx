/**
 * PanelLayout — 通用面板布局组件
 *
 * 从 LayerPanel / DocList / DocRevisionPanel / PropertyPanel 中提炼的共性布局模式。
 * 提供标准的「头部 + 可滚动内容 + 可选底部」三段式面板结构。
 *
 * @example
 * // 基础用法
 * <PanelLayout title="图层">
 *   <LayerList />
 * </PanelLayout>
 *
 * // 带头部操作按钮
 * <PanelLayout
 *   title="版本历史"
 *   headerAction={<Button size="icon" onClick={refresh}><RefreshIcon /></Button>}
 *   footer={<span>共 12 个版本</span>}
 * >
 *   <RevisionList />
 * </PanelLayout>
 *
 * // 空状态
 * <PanelLayout title="评论" empty emptyText="暂无评论">
 *   <CommentList />
 * </PanelLayout>
 */

import * as React from 'react'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'
import { EmptyState, type EmptyStateProps } from './empty-state'
import { PanelLoadingState, type PanelLoadingStateVariant } from './panel-loading-state'
import { ScrollArea } from '../scroll-area'

export interface PanelLayoutProps {
  /** 面板标题（显示在头部） */
  title?: string
  /** 头部右侧操作区域 */
  headerAction?: React.ReactNode
  /** 自定义头部（替代默认头部） */
  customHeader?: React.ReactNode
  /** 底部内容（如统计信息、分页等） */
  footer?: React.ReactNode
  /** 是否正在加载 */
  loading?: boolean
  /** 加载态模式：面板骨架或 spinner */
  loadingMode?: 'skeleton' | 'spinner'
  /** 骨架布局 */
  loadingSkeletonVariant?: PanelLoadingStateVariant
  /** 骨架行数 */
  loadingRows?: number
  /** 自定义加载态 */
  loadingFallback?: React.ReactNode
  /** 是否为空状态 */
  empty?: boolean
  /** 空状态图标 */
  emptyIcon?: EmptyStateProps['icon']
  /** 空状态文字 */
  emptyText?: string
  /** 空状态描述 */
  emptyDescription?: string
  /** 空状态操作 */
  emptyAction?: React.ReactNode
  /** 空状态布局 */
  emptyLayout?: EmptyStateProps['layout']
  /** 空状态对齐 */
  emptyAlign?: EmptyStateProps['align']
  /** 空状态色调 */
  emptyTone?: EmptyStateProps['tone']
  /** 主内容区域 */
  children: React.ReactNode
  /** 根容器 className */
  className?: string
  /** 内容区域是否使用 ScrollArea（默认 true） */
  scrollable?: boolean
  /** 头部是否显示底部边框（默认 true） */
  headerBordered?: boolean
}

export const PanelLayout: React.FC<PanelLayoutProps> = ({
  title,
  headerAction,
  customHeader,
  footer,
  loading = false,
  loadingMode = 'skeleton',
  loadingSkeletonVariant = 'list',
  loadingRows = 5,
  loadingFallback,
  empty = false,
  emptyIcon,
  emptyText,
  emptyDescription,
  emptyAction,
  emptyLayout = 'plain',
  emptyAlign = 'center',
  emptyTone = 'muted',
  children,
  className,
  scrollable = true,
  headerBordered = true,
}) => {
  return (
    <div className={cn('flex h-full flex-col', className)}>
      {/* Header */}
      {customHeader ?? (
        title && (
          <div
            className={cn(
              'flex items-center justify-between px-3 py-2 flex-shrink-0',
              headerBordered && 'border-b',
            )}
          >
            <span className="text-body font-medium text-foreground">{title}</span>
            {headerAction && (
              <div className="flex items-center gap-1">{headerAction}</div>
            )}
          </div>
        )
      )}

      {/* Content */}
      {(() => {
        const contentNode = loading ? (
          loadingFallback ?? (
            loadingMode === 'spinner' ? (
              <div className="flex items-center justify-center py-12">
                <svg
                  className="h-5 w-5 animate-spin text-muted-foreground"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </div>
            ) : (
              <PanelLoadingState variant={loadingSkeletonVariant} rows={loadingRows} />
            )
          )
        ) : empty ? (
          <EmptyState
            icon={emptyIcon}
            title={emptyText || t('common.noData')}
            description={emptyDescription}
            action={emptyAction}
            size="sm"
            layout={emptyLayout}
            align={emptyAlign}
            tone={emptyTone}
          />
        ) : (
          children
        )
        return scrollable ? (
          <ScrollArea className="flex-1">{contentNode}</ScrollArea>
        ) : (
          <div className="flex-1 min-h-0">{contentNode}</div>
        )
      })()}

      {/* Footer */}
      {footer && (
        <div className="flex-shrink-0 border-t px-3 py-2 text-body text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  )
}

PanelLayout.displayName = 'PanelLayout'
