/**
 * RevisionPanel — 通用版本历史面板
 *
 * 从 Table RecordHistoryPanel / Docs DocRevisionPanel 提炼。
 * 提供可扩展的版本历史展示组件，各模块通过 render props 自定义内容渲染。
 *
 * 支持两种模式：
 * - list：列表模式（简洁，适合文档版本）
 * - timeline：时间线模式（丰富，适合表格记录变更）
 *
 * @example
 * // 文档版本历史
 * <RevisionPanel
 *   mode="list"
 *   revisions={revisions}
 *   currentVersion={currentVersion}
 *   loading={loading}
 *   onRestore={handleRestore}
 *   renderPreview={(rev) => <MarkdownPreview content={rev.content} />}
 * />
 *
 * // 表格记录历史（使用内置的 HistoryTimeline）
 * <RevisionPanel
 *   mode="timeline"
 *   revisions={operations}
 *   loading={loading}
 *   renderItem={(rev) => <ChangeCard changes={rev.changes} />}
 * />
 */

import * as React from 'react'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'
import { UserAvatar } from './user-avatar'
import { EmptyState } from './empty-state'
import { formatSmartTime } from '../../utils/time'
import { LoadingSpinner } from '../loading-spinner'
import { ScrollArea } from '../scroll-area'

// ── 核心类型 ──

export interface RevisionItem {
  /** 唯一 ID */
  id: string
  /** 版本号 */
  version: number
  /** 创建时间（ISO string） */
  createdAt: string
  /** 操作者 */
  user?: {
    /** 用户稳定 ID；缺失时兼容按名称生成默认头像。 */
    id?: string | number | null
    name: string
    avatarUrl?: string | null
  } | null
  /** 变更摘要文本 */
  summary?: string
  /** 是否为当前版本 */
  isCurrent?: boolean
  /** 任意扩展数据（供 renderItem / renderPreview 使用） */
  data?: unknown
}

export interface RevisionPanelProps {
  /** 展示模式：list=列表（文档风格）timeline=时间线（表格风格） */
  mode?: 'list' | 'timeline'
  /** 版本列表 */
  revisions: RevisionItem[]
  /** 总数 */
  total?: number
  /** 当前版本号（高亮标记） */
  currentVersion?: number | null
  /** 是否正在加载 */
  loading?: boolean
  /** 正在恢复的版本号 */
  restoringVersion?: number | null
  /** 加载更多回调 */
  onLoadMore?: () => void
  /** 恢复版本回调 */
  onRestore?: (version: number) => void
  /** 预览回调 */
  onPreview?: (revision: RevisionItem) => void
  /** 刷新回调 */
  onRefresh?: () => void
  /** 自定义版本条目渲染 */
  renderItem?: (revision: RevisionItem, isActive: boolean) => React.ReactNode
  /** 自定义预览区域渲染 */
  renderPreview?: (revision: RevisionItem) => React.ReactNode
  /** 额外 className */
  className?: string
}

// ── 子组件 ──

function RevisionListItem({
  revision,
  isCurrent,
  isActive,
  isRestoring,
  canRestore,
  onRestore,
  onPreview,
  renderItem,
}: {
  revision: RevisionItem
  isCurrent: boolean
  isActive: boolean
  isRestoring: boolean
  canRestore: boolean
  onRestore?: (version: number) => void
  onPreview?: (revision: RevisionItem) => void
  renderItem?: (revision: RevisionItem, isActive: boolean) => React.ReactNode
}) {
  return (
    <div
      className={cn(
        'border-b px-3 py-2 transition-colors',
        isCurrent && 'bg-primary/5',
        isActive && 'ring-1 ring-primary/30',
      )}
    >
      {/* 自定义渲染 */}
      {renderItem ? (
        renderItem(revision, isActive)
      ) : (
        <>
          {/* 头部：版本号 + 时间 */}
          <div className="flex items-center justify-between text-body">
            <span className="flex items-center gap-1.5">
              {revision.user && (
                <UserAvatar
                  name={revision.user.name}
                  seed={revision.user.id?.toString()}
                  avatarUrl={revision.user.avatarUrl}
                  size={18}
                />
              )}
              <span className="font-medium">
                v{revision.version}
                {isCurrent && (
                  <span className="ml-1 text-primary">
                    ({t('revisionPanel.current')})
                  </span>
                )}
              </span>
            </span>
            <span className="text-muted-foreground">
              {formatSmartTime(revision.createdAt)}
            </span>
          </div>

          {/* 摘要 */}
          {revision.summary && (
            <div className="mt-1 line-clamp-2 text-caption text-muted-foreground">
              {revision.summary}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="mt-1.5 flex items-center gap-1">
            {onPreview && (
              <button
                type="button"
                onClick={() => onPreview(revision)}
                className="flex items-center gap-1 rounded px-2 py-0.5 text-caption text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                {isActive
                  ? t('revisionPanel.closePreview')
                  : t('revisionPanel.preview')}
              </button>
            )}
            {onRestore && !isCurrent && canRestore && (
              <button
                type="button"
                onClick={() => onRestore(revision.version)}
                disabled={isRestoring}
                className="flex items-center gap-1 rounded px-2 py-0.5 text-caption text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                {isRestoring ? (
                  <LoadingSpinner size="xs" inline />
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                )}
                {t('revisionPanel.restore')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── 主组件 ──

export const RevisionPanel: React.FC<RevisionPanelProps> = ({
  mode = 'list',
  revisions,
  total,
  currentVersion,
  loading = false,
  restoringVersion,
  onLoadMore,
  onRestore,
  onPreview,
  onRefresh,
  renderItem,
  renderPreview,
  className,
}) => {
  const [previewRevision, setPreviewRevision] = React.useState<RevisionItem | null>(null)
  const sentinelRef = React.useRef<HTMLDivElement>(null)

  const resolvedTotal = total ?? revisions.length
  const hasMore = revisions.length < resolvedTotal

  // IntersectionObserver for infinite scroll
  React.useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !onLoadMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry?.isIntersecting && !loading && hasMore) {
          onLoadMore()
        }
      },
      { rootMargin: '100px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [onLoadMore, loading, hasMore])

  const handlePreview = onPreview
    ? (revision: RevisionItem) => {
        const toggling = previewRevision?.id === revision.id
        setPreviewRevision(toggling ? null : revision)
        onPreview(toggling ? previewRevision! : revision)
      }
    : renderPreview
    ? (revision: RevisionItem) => {
        setPreviewRevision(
          previewRevision?.id === revision.id ? null : revision,
        )
      }
    : undefined

  return (
    <div className={cn('flex h-full flex-col', className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2 flex-shrink-0">
        <span className="text-body font-medium text-foreground">
          {t('revisionPanel.title')}
        </span>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {loading ? (
              <LoadingSpinner size="xs" inline />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            )}
          </button>
        )}
      </div>

      {/* Revisions list */}
      <ScrollArea
        className={cn(
          'flex-1 min-h-0',
          previewRevision && renderPreview && 'max-h-[50%]',
        )}
      >
        {loading && revisions.length === 0 ? (
          <LoadingSpinner size="sm" className="py-12" />
        ) : revisions.length === 0 ? (
          <EmptyState
            icon="clock"
            title={t('revisionPanel.empty')}
            description={t('revisionPanel.emptyDescription')}
            size="sm"
          />
        ) : (
          <div>
            {revisions.map((rev) => {
              const isCurrent = currentVersion === rev.version || rev.isCurrent === true
              const isActive = previewRevision?.id === rev.id
              const isRestoring = restoringVersion === rev.version

              return (
                <RevisionListItem
                  key={rev.id}
                  revision={rev}
                  isCurrent={isCurrent}
                  isActive={isActive}
                  isRestoring={isRestoring}
                  canRestore={restoringVersion === null || restoringVersion === undefined}
                  onRestore={onRestore}
                  onPreview={handlePreview}
                  renderItem={renderItem}
                />
              )
            })}

            {/* Infinite scroll sentinel */}
            {hasMore && (
              <div ref={sentinelRef} className="flex justify-center py-3">
                {loading && (
                  <span className="text-body text-muted-foreground">
                    {t('common.loading')}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* Preview pane */}
      {previewRevision && renderPreview && (
        <div className="flex flex-col border-t flex-1 min-h-0">
          <div className="flex items-center justify-between px-3 py-1.5 flex-shrink-0">
            <span className="text-caption font-medium text-muted-foreground">
              {t('revisionPanel.previewVersion')} v{previewRevision.version}
            </span>
            <button
              type="button"
              onClick={() => setPreviewRevision(null)}
              className="text-caption text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
          <ScrollArea className="flex-1">
            {renderPreview(previewRevision)}
          </ScrollArea>
        </div>
      )}

      {/* Footer */}
      {resolvedTotal > 0 && (
        <div className="flex items-center justify-between px-3 py-2 border-t text-body text-muted-foreground flex-shrink-0">
          <span>
            {t('revisionPanel.total', { count: String(resolvedTotal) })}
          </span>
        </div>
      )}
    </div>
  )
}

RevisionPanel.displayName = 'RevisionPanel'
