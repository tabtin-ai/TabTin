/**
 * VersionPanel — 统一版本管理面板
 *
 * 所有模块（TabDoc / TabData / TabSlide / TabVideo）
 * 共用同一个版本面板组件，通过 VersionAdapter 接入差异化逻辑。
 *
 * 功能：
 * - 版本时间线列表（区分人/AI/系统编辑）
 * - 恢复到指定版本
 * - 命名/重命名/置顶版本（条目 ⋯ 菜单）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { VersionAdapter, VersionHistoryItem, VersionPanelLabels, ViewConversationOptions } from "./types"
import { useVersionHistory } from "./useVersionHistory"
import { ConversationSegmentPopover } from "./ConversationSegmentPopover"

export interface VersionPanelProps {
  adapter: VersionAdapter
  apiBase: string
  token: string
  className?: string
  /** 当前语言 locale（如 'zh-CN'、'en-US'），影响日期格式化 */
  locale?: string
  /** 自定义文案，用于 i18n。未提供时使用中文默认值。 */
  labels?: VersionPanelLabels
  /** 面板底部提示信息（如 TTL 说明、存储策略等） */
  footerNotice?: React.ReactNode
  onRestore?: (versionId: string) => void
  onRestoreError?: (error: string) => void
  /** 关闭面板回调 */
  onClose?: () => void
  /**
   * CLB-008: 外部传入的当前版本 ID（如 restore 后后端返回的新快照 ID）。
   * 若不传，则使用内部 restoreVersion 响应中的 version_id 自动更新。
   */
  currentVersionId?: string | null
  /**
   * 面板模式：
   * - 'standalone'（默认）: 独立面板，包含 DiffPreview、关闭按钮、内部还原确认
   * - 'embedded': 嵌入 Dialog Modal 右侧时间线，DiffPreview 和还原确认由外层负责
   */
  mode?: 'standalone' | 'embedded'
  /** 点击 Agent 条目的"查看对话"链接。新增可选 options 参数，向后兼容。 */
  onViewConversation?: (agentRunId: string, options?: ViewConversationOptions) => void
  /** Chat API base URL（如 https://api.example.com/api/chat）。用于对话片段浮层内的 API 调用。 */
  chatApiBase?: string
  /** embedded 模式：用户选中版本时通知外层（用于左侧预览） */
  onSelectPreview?: (versionId: string | null, version?: VersionHistoryItem) => void
  /** embedded 模式：用户点击还原按钮时通知外层（由外层展示确认弹窗） */
  onSelectRestore?: (versionId: string, version?: VersionHistoryItem) => void
  /** 是否允许命名、置顶、取消命名和还原；只读用户传 false 时隐藏全部写操作。 */
  canManageVersions?: boolean
}

export function VersionPanel({ adapter, apiBase, token, className = "", locale, labels, footerNotice, onRestore, onRestoreError, onClose, currentVersionId: externalCurrentVersionId, mode = 'standalone', onViewConversation, onSelectPreview, onSelectRestore, chatApiBase, canManageVersions = true }: VersionPanelProps) {
  const {
    versions,
    total,
    loading,
    error,
    hasMore,
    fetchVersions,
    restoreVersion,
    renameVersion,
    unnameVersion,
    togglePin,
    currentVersionId: internalCurrentVersionId,
  } = useVersionHistory({
    resourceType: adapter.resourceType,
    resourceId: adapter.resourceId,
    apiBase,
    token,
  })

  // CLB-008: 优先使用外部传入的 currentVersionId，否则使用内部 restore 响应的 ID
  const currentVersionId = externalCurrentVersionId ?? internalCurrentVersionId

  const [showNamedOnly, setShowNamedOnly] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isRestoring, setIsRestoring] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  /**
   * QC-12：Session 归档状态会话级缓存。
   *
   * 后端 `conversation-anchors` / version API 未返回 session_exists 字段；
   * 为避免每个版本条目点击后才触发 404（浮层展开 → 看到"原始对话已归档"），
   * 一旦某个 session 被 Popover 检测为已归档，就将其 session_id 加入缓存，
   * 后续该 session 的所有版本条目直接置灰"查看对话片段"按钮。
   *
   * 简单但有效 — 不需后端配合；会话级状态，重开面板刷新即可。
   */
  const [archivedSessionIds, setArchivedSessionIds] = useState<Set<string>>(new Set())
  const markSessionArchived = useCallback((sessionId: string) => {
    if (!sessionId) return
    setArchivedSessionIds((prev) => {
      if (prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
  }, [])

  useEffect(() => {
    if (canManageVersions) return
    setConfirmRestore(null)
    setEditingId(null)
    setEditName("")
  }, [canManageVersions])

  const handleRestore = useCallback(
    async (id: string) => {
      setIsRestoring(true)
      setActionError(null)
      const result = await restoreVersion(id)
      if (result.success) {
        onRestore?.(id)
      } else {
        const errMsg = result.error || labels?.restoreFailed || "版本还原失败"
        onRestoreError?.(errMsg)
        setActionError(errMsg)
      }
      setConfirmRestore(null)
      setIsRestoring(false)
    },
    [restoreVersion, onRestore, onRestoreError, labels],
  )

  const handleRename = useCallback(
    async (id: string) => {
      setActionError(null)
      const result = await renameVersion(id, editName.trim())
      if (result.success) {
        setEditingId(null)
        setEditName("")
      } else {
        setActionError(result.error || labels?.renameFailed || "重命名失败")
      }
    },
    [editName, renameVersion, labels],
  )

  const handleTogglePin = useCallback(
    async (id: string, pinned: boolean) => {
      setActionError(null)
      const result = await togglePin(id, pinned, { namedOnly: showNamedOnly })
      if (!result.success) {
        setActionError(result.error || labels?.pinFailed || "置顶操作失败")
      }
    },
    [togglePin, labels, showNamedOnly],
  )

  const handleUnname = useCallback(
    async (id: string) => {
      setActionError(null)
      const result = await unnameVersion(id)
      if (!result.success) {
        setActionError(result.error || labels?.unnameFailed || "取消命名失败")
      }
    },
    [unnameVersion, labels],
  )

  const handleLoadMore = useCallback(async () => {
    setIsLoadingMore(true)
    try {
      await fetchVersions({ namedOnly: showNamedOnly, offset: versions.length })
    } finally {
      setIsLoadingMore(false)
    }
  }, [fetchVersions, showNamedOnly, versions.length])

  const handleFilter = useCallback(
    (namedOnly: boolean) => {
      setShowNamedOnly(namedOnly)
      fetchVersions({ namedOnly })
    },
    [fetchVersions],
  )

  const displayVersions = useMemo(() => sortPinnedVersionsFirst(versions), [versions])

  const selectVersionForPreview = useCallback((version: VersionHistoryItem) => {
    setPreviewId(version.id)
    onSelectPreview?.(version.id, version)
  }, [onSelectPreview])

  const timeSections = groupVersionsForDisplay(displayVersions, locale, labels)

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-body font-medium text-foreground">{labels?.title ?? "版本历史"}</h3>
        <div className="flex items-center gap-2">
          <span className="text-body text-muted-foreground">
            {labels?.versionCount ? labels.versionCount.replace("{count}", String(total)) : `${total} 个版本`}
          </span>
          {onClose && (
            <button
              onClick={onClose}
              className="flex items-center justify-center w-6 h-6 rounded hover:bg-muted text-muted-foreground transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Filter */}
      <div className="flex gap-2 px-4 py-2">
        <button
          onClick={() => handleFilter(false)}
          className={`text-body px-2 py-0.5 rounded ${!showNamedOnly ? "bg-muted" : "text-muted-foreground"}`}
        >
          {labels?.allVersions ?? "全部"}
        </button>
        <button
          onClick={() => handleFilter(true)}
          className={`text-body px-2 py-0.5 rounded ${showNamedOnly ? "bg-muted" : "text-muted-foreground"}`}
        >
          {labels?.namedVersions ?? "命名版本"}
        </button>
      </div>

      {/* Diff preview (standalone only; embedded mode delegates to parent) */}
      {mode !== 'embedded' && adapter.DiffPreview && previewId && (
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-body font-medium text-foreground">{labels?.preview ?? "版本预览"}</span>
            <button
              onClick={() => setPreviewId(null)}
              className="text-caption px-1.5 py-0.5 rounded hover:bg-muted text-muted-foreground"
            >
              ✕
            </button>
          </div>
          <adapter.DiffPreview versionId={previewId} version={displayVersions.find((v) => v.id === previewId)} />
        </div>
      )}

      {/* Version list */}
      <div className="flex-1 overflow-y-auto px-4">
        {loading && versions.length === 0 && (
          <div className="py-8 text-center text-body text-muted-foreground">{labels?.loading ?? "加载中..."}</div>
        )}
        {error && (
          <div className="py-4 text-center text-body text-destructive">{error}</div>
        )}
        {actionError && (
          <div className="py-2 px-2 mb-2 text-body text-destructive bg-destructive/10 rounded flex items-center justify-between">
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)} className="text-caption px-1 ml-2 hover:bg-destructive/20 rounded">✕</button>
          </div>
        )}
        {!loading && versions.length === 0 && !error && (
          <div className="py-12 flex flex-col items-center gap-2 text-muted-foreground">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12,6 12,12 16,14" />
            </svg>
            <span className="text-body">{labels?.noVersions ?? "暂无版本记录"}</span>
          </div>
        )}

        {timeSections.map((section) => (
          <div key={section.label}>
            <div className="sticky top-0 z-sticky bg-card py-1.5 mt-2 first:mt-0">
              <span className="text-caption font-medium text-muted-foreground/60">{section.label}</span>
            </div>
            {section.items.map((v) => (
              <VersionItem
                key={v.id}
                item={v}
                adapter={adapter}
                locale={locale}
                labels={labels}
                isSelected={previewId === v.id}
                isCurrent={currentVersionId === v.id}
                isConfirmingRestore={confirmRestore === v.id}
                isRestoring={isRestoring && confirmRestore === v.id}
                isEditing={canManageVersions && editingId === v.id}
                editName={editingId === v.id ? editName : ""}
                forceClickable={mode === 'embedded'}
                onSelect={() => {
                  const newId = previewId === v.id ? null : v.id
                  setPreviewId(newId)
                  onSelectPreview?.(newId, newId ? v : undefined)
                }}
                onRequestRestore={() => {
                  if (mode === 'embedded' && onSelectRestore) {
                    onSelectRestore(v.id, v)
                  } else {
                    setConfirmRestore(v.id)
                  }
                }}
                onConfirmRestore={() => handleRestore(v.id)}
                onCancelRestore={() => setConfirmRestore(null)}
                onStartEdit={() => {
                  setEditingId(v.id)
                  setEditName(v.name)
                }}
                onEditNameChange={setEditName}
                onSaveEdit={() => handleRename(v.id)}
                onCancelEdit={() => setEditingId(null)}
                onTogglePin={() => handleTogglePin(v.id, !v.pinned)}
                onUnname={v.is_named ? () => handleUnname(v.id) : undefined}
                onViewConversation={onViewConversation ? (agentRunId, options) => {
                  selectVersionForPreview(v)
                  onViewConversation(agentRunId, options)
                } : undefined}
                chatApiBase={chatApiBase}
                apiToken={token}
                archivedSessionIds={archivedSessionIds}
                onSessionArchived={markSessionArchived}
                canManageVersions={canManageVersions}
              />
            ))}
          </div>
        ))}

        {/* CC-017: Load more */}
        {hasMore && (
          <div className="py-3 text-center">
            <button
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              className="text-body px-4 py-1.5 rounded bg-muted hover:bg-muted/80 text-foreground disabled:opacity-50"
            >
              {isLoadingMore ? (labels?.loading ?? "加载中...") : `${labels?.loadMore ?? "加载更多"}（${versions.length}/${total}）`}
            </button>
          </div>
        )}
      </div>

      {/* Footer notice — TTL 清理规则 + 可选自定义说明 */}
      {(footerNotice || labels?.versionRetentionHint !== '') && (
        <div className="flex-shrink-0 px-4 py-2 border-t border-border text-caption text-muted-foreground/60 space-y-1">
          {footerNotice}
          {labels?.versionRetentionHint !== '' && (
            <p>
              {labels?.versionRetentionHint
                ?? '未命名版本按套餐保留 7–90 天，到期后每小时自动清理；命名或置顶版本长期保留。'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Version Item ──────────────────────────────────────

interface VersionItemProps {
  item: VersionHistoryItem
  adapter: VersionAdapter
  locale?: string
  labels?: VersionPanelLabels
  isSelected: boolean
  /** CLB-008: 是否为当前正在使用的版本（restore 后高亮） */
  isCurrent?: boolean
  isConfirmingRestore: boolean
  isRestoring: boolean
  isEditing: boolean
  editName: string
  onSelect: () => void
  onRequestRestore: () => void
  onConfirmRestore: () => void
  onCancelRestore: () => void
  onStartEdit: () => void
  onEditNameChange: (name: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onTogglePin: () => void
  /** 取消命名（仅命名版本显示） */
  onUnname?: () => void
  /** embedded 模式下即使无 DiffPreview 也可点击选中 */
  forceClickable?: boolean
  /** 查看 Agent 对话 */
  onViewConversation?: (agentRunId: string, options?: ViewConversationOptions) => void
  /** Chat API base URL for conversation segment fetching */
  chatApiBase?: string
  /** JWT token for API calls */
  apiToken?: string
  /**
   * QC-12：已知归档的 session_id 集合。若当前条目的 session_id 在集合中，
   * "查看对话片段"按钮直接置灰，不再触发 API 请求。
   */
  archivedSessionIds?: Set<string>
  /** 本条目 Popover 检测到 sessionArchived 时的回调，用于父级缓存同 session 的后续条目。 */
  onSessionArchived?: (sessionId: string) => void
  /** false 时仍可查看/预览版本，但不渲染任何写操作入口。 */
  canManageVersions?: boolean
}

function VersionItem({
  item,
  adapter,
  locale,
  labels,
  isSelected,
  isCurrent = false,
  isConfirmingRestore,
  isRestoring,
  isEditing,
  editName,
  onSelect,
  onRequestRestore,
  onConfirmRestore,
  onCancelRestore,
  onStartEdit,
  onEditNameChange,
  onSaveEdit,
  onCancelEdit,
  onTogglePin,
  onUnname,
  forceClickable = false,
  onViewConversation,
  chatApiBase,
  apiToken,
  archivedSessionIds,
  onSessionArchived,
  canManageVersions = true,
}: VersionItemProps) {
  const [showMenu, setShowMenu] = useState(false)
  const [showSegment, setShowSegment] = useState(false)
  const [segmentArchived, setSegmentArchived] = useState(false)
  const segmentTriggerRef = useRef<HTMLButtonElement>(null)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const closeMenu = useCallback(() => setShowMenu(false), [])

  const openMenu = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const menuWidth = 140
    setMenuStyle({
      position: "fixed",
      top: rect.bottom + 2,
      left: Math.max(4, rect.right - menuWidth),
      minWidth: menuWidth,
    })
    setShowMenu(true)
  }, [])

  useEffect(() => {
    if (!showMenu) return
    const onOutsideClick = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setShowMenu(false)
      }
    }
    document.addEventListener("mousedown", onOutsideClick)
    document.addEventListener("scroll", closeMenu, true)
    window.addEventListener("resize", closeMenu)
    return () => {
      document.removeEventListener("mousedown", onOutsideClick)
      document.removeEventListener("scroll", closeMenu, true)
      window.removeEventListener("resize", closeMenu)
    }
  }, [showMenu, closeMenu])

  const onMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation()
      setShowMenu(false)
      triggerRef.current?.focus()
    }
  }, [])

  const isAgent = item.editor_type === "agent"
  const isUserEdit = item.editor_type === "user" || item.editor_type === "human"
  // QC-18 / PRD §3.5：user edit 时 chip 已单独显示"由你手动编辑"，
  // description 里就不必再 prefix "用户"，只保留 time；避免"用户 · 14:30"与 chip 文案重复。
  const editorLabel = isAgent
    ? (labels?.editorAI ?? "AI")
    : item.editor_type === "system"
      ? (labels?.editorSystem ?? "系统")
      : null
  const time = formatTime(item.created_at, locale, labels)
  const description = adapter.renderDescription?.(item) ?? (editorLabel ? `${editorLabel} · ${time}` : time)

  const ctx = item.checkpoint_context
  const userPromptPreview = ctx?.user_prompt || null
  const hasConversationContext = !!(ctx?.session_id && (ctx.assistant_message_id || ctx.user_message_id))
  const hasSubTasks = !!ctx?.has_sub_conversations
  const subConversations = (ctx?.sub_conversations && ctx.sub_conversations.length > 0)
    ? ctx.sub_conversations
    : null
  /**
   * Review 必修：徽章展示子任务 label（PRD §3.4 US-1 mock "└ 含子任务: 数据迁移脚本"）。
   * - 单个子任务且有 label：显示 "含子任务: 数据迁移脚本"
   * - 多个子任务：显示 "含 N 个子任务"
   * - 只有 has_sub_conversations（无 sub_conversations 详情）：显示 "含子任务" 兜底
   */
  const subTaskBadgeText = (() => {
    const baseLabel = labels?.hasSubTasks ?? '含子任务'
    if (!subConversations) return baseLabel
    if (subConversations.length === 1) {
      const single = subConversations[0].label?.trim()
      return single ? `${baseLabel}: ${single}` : baseLabel
    }
    return (labels?.hasSubTasksWithCount?.replace('{count}', String(subConversations.length)))
      ?? `含 ${subConversations.length} 个子任务`
  })()
  /**
   * QC-12：归档信号三路合并——任一命中即按已归档渲染（置灰、不触发 popover）：
   *   1. 本条目 popover 曾返回 session_archived（访问时 404）
   *   2. 父级缓存命中同 session_id（同列表另一条先发现已归档）
   *   3. Wave 14 QC-12：后端批量预检下发 `session_exists === false`（挂载态即知）
   * 路径 3 消除"点击才知道"的反馈延迟；前两条作为补充兜底。
   */
  const sessionIsArchived = segmentArchived
    || (!!ctx?.session_id && archivedSessionIds?.has(ctx.session_id) === true)
    || ctx?.session_exists === false

  const isClickable = forceClickable || !!adapter.DiffPreview

  const menuAction = useCallback((fn: () => void) => () => {
    setShowMenu(false)
    fn()
  }, [])

  const triggerVisible = showMenu || isSelected

  return (
    <div
      className={`group relative py-2 border-b border-border last:border-0 ${isClickable ? "cursor-pointer" : ""} ${isCurrent ? "bg-success/10 rounded" : isSelected ? "bg-muted/60 rounded" : ""}`}
      onClick={isClickable ? onSelect : undefined}
    >
      <div className="flex items-start gap-2">
        {/* Timeline dot */}
        <div className="mt-1.5 flex-shrink-0">
          <div
            className={`w-2 h-2 rounded-full ${
              isCurrent
                ? "bg-success ring-2 ring-success/30"
                : item.is_named
                  ? "bg-info"
                  : isAgent
                    ? "bg-type-agent"
                    : item.editor_type === "system"
                      ? "bg-muted-foreground/40"
                      : "bg-muted-foreground"
            }`}
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <div className="flex gap-1">
              <input
                type="text"
                value={editName}
                onChange={(e) => onEditNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveEdit()
                  if (e.key === "Escape") onCancelEdit()
                }}
                className="flex-1 min-w-0 text-body px-1 py-0.5 border border-border rounded bg-background text-foreground"
                autoFocus
              />
              <button
                onClick={onSaveEdit}
                className="text-body px-2 py-0.5 rounded bg-info text-white hover:bg-info whitespace-nowrap"
              >
                {labels?.save ?? "保存"}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1 min-w-0">
              {item.is_named && (
                <span className="text-body font-medium text-foreground truncate min-w-0">
                  {item.name}
                </span>
              )}
              {isCurrent && (
                <span className="text-caption px-1 py-0.5 rounded bg-success/15 text-success font-medium whitespace-nowrap flex-shrink-0">
                  {labels?.current ?? "当前"}
                </span>
              )}
              {item.pinned && <span className="text-body text-warning flex-shrink-0">📌</span>}
              {isAgent && (
                <span className="text-caption px-1 py-0.5 rounded bg-type-agent/10 text-type-agent inline-flex items-center gap-0.5 whitespace-nowrap flex-shrink-0">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
                  </svg>
                  AI
                </span>
              )}
              {/* QC-02.A: 含子任务徽章（Agent 派生了子会话，带具体 label 或 count） */}
              {isAgent && hasSubTasks && (
                <span
                  className="text-caption px-1 py-0.5 rounded bg-accent/10 text-accent/80 inline-flex items-center gap-0.5 whitespace-nowrap flex-shrink-0 min-w-0 max-w-[180px]"
                  title={subTaskBadgeText}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                    <path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  <span className="truncate min-w-0">{subTaskBadgeText}</span>
                </span>
              )}
              {/* QC-18 / PRD §3.5: 纯用户编辑显示"由你手动编辑"标签 */}
              {isUserEdit && labels?.editorUserManual && (
                <span className="text-caption px-1 py-0.5 rounded bg-muted text-muted-foreground/80 inline-flex items-center gap-0.5 whitespace-nowrap flex-shrink-0">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                  </svg>
                  {labels.editorUserManual}
                </span>
              )}
              {isAgent && item.agent_run_id && onViewConversation && !(chatApiBase && apiToken && hasConversationContext) && (
                <button
                  className="text-body text-accent hover:underline"
                  onClick={(e) => {
                    e.stopPropagation()
                    const ctx = item.checkpoint_context
                    onViewConversation(item.agent_run_id!, {
                      sessionId: ctx?.session_id ?? undefined,
                      messageId: ctx?.assistant_message_id ?? ctx?.user_message_id ?? undefined,
                    })
                  }}
                >
                  {labels?.viewConversation ?? '查看对话'}
                </button>
              )}
              {item.editor_type === "system" && (
                <span className="text-caption px-1 py-0.5 rounded bg-muted text-muted-foreground inline-flex items-center gap-0.5 whitespace-nowrap flex-shrink-0">
                  {labels?.editorSystem ?? "系统"}
                </span>
              )}
            </div>
          )}

          <div className="text-body text-muted-foreground mt-0.5 truncate" title={description}>{description}</div>

          {/* User prompt preview for AI edits */}
          {isAgent && userPromptPreview && (
            <div className="mt-0.5 flex items-start gap-1 bg-muted/60 rounded px-1.5 py-0.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 text-muted-foreground/60">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span className="text-caption text-muted-foreground/60 truncate min-w-0" title={userPromptPreview}>
                {userPromptPreview}
              </span>
            </div>
          )}

          {/* "View conversation segment" button */}
          {isAgent && item.agent_run_id && chatApiBase && apiToken && hasConversationContext && (
            <div className="mt-0.5" onClick={(e) => e.stopPropagation()}>
              {sessionIsArchived ? (
                <span
                  className="text-body text-muted-foreground/60 cursor-default inline-flex items-center gap-1"
                  title={labels?.conversationSessionArchived ?? '原始对话已归档'}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
                    <path d="m21 8-2-2H5L3 8" /><rect x="3" y="8" width="18" height="12" rx="1" /><path d="M10 12h4" />
                  </svg>
                  {labels?.conversationSessionArchived ?? '原始对话已归档'}
                </span>
              ) : (
                <button
                  ref={segmentTriggerRef}
                  className="text-body text-accent/80 hover:text-accent hover:underline"
                  onClick={() => setShowSegment((v) => !v)}
                >
                  {labels?.viewConversationSegment ?? '查看对话片段'}
                </button>
              )}
              {showSegment && !sessionIsArchived && (
                <ConversationSegmentPopover
                  chatApiBase={chatApiBase}
                  token={apiToken}
                  sessionId={item.checkpoint_context!.session_id!}
                  messageId={item.checkpoint_context!.assistant_message_id || item.checkpoint_context!.user_message_id || ''}
                  subConversations={subConversations}
                  labels={labels}
                  onNavigateToChat={(sessionId, messageId) => {
                    setShowSegment(false)
                    if (onViewConversation && item.agent_run_id) {
                      onViewConversation(item.agent_run_id, { sessionId, messageId })
                    }
                  }}
                  onClose={(opts) => {
                    setShowSegment(false)
                    if (opts?.sessionArchived) {
                      setSegmentArchived(true)
                      // QC-12: 上报父级缓存，其他同 session 版本条目可立即预置灰
                      const archivedId = item.checkpoint_context?.session_id
                      if (archivedId) onSessionArchived?.(archivedId)
                    }
                  }}
                  triggerRef={segmentTriggerRef}
                />
              )}
            </div>
          )}

          {item.expired_at && (
            <div
              className="text-caption text-muted-foreground/60 truncate"
              title={labels?.expiresAtTooltip
                ?? '到期后系统将自动清理该版本；命名或置顶版本不过期。'}
            >
              {labels?.expiresAt ?? "过期于"} {formatTime(item.expired_at, locale, labels)}
            </div>
          )}
        </div>

        {/* Trigger: ⋯ button or confirm-restore inline buttons */}
        {canManageVersions && !isEditing && (
          <div className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            {isConfirmingRestore ? (
              <div className="flex gap-1">
                <button onClick={onConfirmRestore} disabled={isRestoring} className="text-caption px-1.5 py-0.5 rounded bg-destructive text-white disabled:opacity-50 whitespace-nowrap">
                  {isRestoring
                    ? (labels?.loading ?? "...")
                    : (labels?.confirmRestore ?? "确认还原到此版本?")}
                </button>
                <button onClick={onCancelRestore} disabled={isRestoring} className="text-caption px-1.5 py-0.5 rounded bg-muted disabled:opacity-50 whitespace-nowrap">
                  {labels?.cancel ?? "取消"}
                </button>
              </div>
            ) : (
              <button
                ref={triggerRef}
                onClick={() => showMenu ? closeMenu() : openMenu()}
                onKeyDown={(e) => { if (e.key === "Escape" && showMenu) { e.stopPropagation(); closeMenu() } }}
                className={`w-6 h-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground transition-opacity focus-visible:opacity-100 ${triggerVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                aria-label={labels?.actions ?? "操作"}
                aria-expanded={showMenu}
                aria-haspopup="menu"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Action dropdown menu (fixed positioning to escape overflow clipping) */}
      {canManageVersions && showMenu && !isConfirmingRestore && (
        <div
          ref={menuRef}
          role="menu"
          style={menuStyle}
          className="rounded-md border border-border bg-card shadow-md py-1 z-dropdown"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onMenuKeyDown}
        >
          <button role="menuitem" onClick={menuAction(onRequestRestore)} className="flex w-full items-center px-3 py-1.5 text-body hover:bg-muted text-left">
            {labels?.restore ?? "还原到此版本"}
          </button>
          <button role="menuitem" onClick={menuAction(onStartEdit)} className="flex w-full items-center px-3 py-1.5 text-body hover:bg-muted text-left">
            {labels?.nameVersion ?? "命名此版本"}
          </button>
          {onUnname && (
            <button role="menuitem" onClick={menuAction(onUnname)} className="flex w-full items-center px-3 py-1.5 text-body hover:bg-muted text-left text-destructive/80">
              {labels?.unname ?? "取消命名"}
            </button>
          )}
          <button role="menuitem" onClick={menuAction(onTogglePin)} className="flex w-full items-center px-3 py-1.5 text-body hover:bg-muted text-left">
            {item.pinned ? (labels?.unpin ?? "取消置顶") : (labels?.pin ?? "置顶")}
          </button>
        </div>
      )}
    </div>
  )
}

function formatTime(isoString: string, locale?: string, labels?: VersionPanelLabels): string {
  if (labels?.formatRelativeTime) return labels.formatRelativeTime(isoString)
  try {
    const d = new Date(isoString)
    const now = new Date()
    const isZh = !locale || locale.startsWith("zh")
    const diff = now.getTime() - d.getTime()

    if (diff < 0) {
      const futureMinutes = Math.ceil(Math.abs(diff) / 60000)
      if (futureMinutes <= 1) {
        return labels?.lessThanMinuteFromNow ?? (isZh ? "1 分钟内" : "in <1m")
      }
      if (futureMinutes < 60) {
        return labels?.minutesFromNow?.(futureMinutes) ?? (isZh ? `${futureMinutes} 分钟后` : `in ${futureMinutes}m`)
      }
      const futureHours = Math.ceil(futureMinutes / 60)
      if (futureHours < 24) {
        return labels?.hoursFromNow?.(futureHours) ?? (isZh ? `${futureHours} 小时后` : `in ${futureHours}h`)
      }
      const futureDays = Math.ceil(futureHours / 24)
      if (futureDays <= 7) {
        return labels?.daysFromNow?.(futureDays) ?? (isZh ? `${futureDays} 天后` : `in ${futureDays}d`)
      }
      return d.toLocaleDateString(locale, { month: "short", day: "numeric" })
    }

    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return labels?.justNow ?? (isZh ? "刚刚" : "Just now")
    if (minutes < 60) return labels?.minutesAgo?.(minutes) ?? (isZh ? `${minutes} 分钟前` : `${minutes}m ago`)
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return labels?.hoursAgo?.(hours) ?? (isZh ? `${hours} 小时前` : `${hours}h ago`)
    const days = Math.floor(hours / 24)
    if (days < 7) return labels?.daysAgo?.(days) ?? (isZh ? `${days} 天前` : `${days}d ago`)
    return d.toLocaleDateString(locale, { month: "short", day: "numeric" })
  } catch {
    return isoString
  }
}

// ── UX-6: 时间分组 ──────────────────────────────────────

interface VersionTimeSection {
  label: string
  items: VersionHistoryItem[]
}

function sortPinnedVersionsFirst(versions: VersionHistoryItem[]): VersionHistoryItem[] {
  return versions
    .map((version, index) => ({ version, index }))
    .sort((a, b) => {
      if (a.version.pinned !== b.version.pinned) {
        return a.version.pinned ? -1 : 1
      }
      return a.index - b.index
    })
    .map(({ version }) => version)
}

function groupVersionsForDisplay(versions: VersionHistoryItem[], locale?: string, labels?: VersionPanelLabels): VersionTimeSection[] {
  const pinnedItems = versions.filter((version) => version.pinned)
  const regularItems = versions.filter((version) => !version.pinned)
  const sections = groupVersionsByTime(regularItems, locale, labels)

  if (pinnedItems.length === 0) return sections

  return [
    {
      label: labels?.pinnedVersions ?? "置顶",
      items: pinnedItems,
    },
    ...sections,
  ]
}

function isSameDay(d1: Date, d2: Date): boolean {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate()
}

function isSameWeek(d1: Date, d2: Date): boolean {
  const startOfWeek = (d: Date) => {
    const day = d.getDay() || 7
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 1)
  }
  return Math.abs(startOfWeek(d1).getTime() - startOfWeek(d2).getTime()) < 86400000
}

function getTimeSectionLabel(isoString: string, locale?: string, labels?: VersionPanelLabels): string {
  if (labels?.formatTimeSectionLabel) return labels.formatTimeSectionLabel(isoString)
  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return isoString
    const now = new Date()
    const isZh = !locale || locale.startsWith("zh")

    if (isSameDay(date, now)) return labels?.today ?? (isZh ? "今天" : "Today")

    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (isSameDay(date, yesterday)) return labels?.yesterday ?? (isZh ? "昨天" : "Yesterday")

    if (isSameWeek(date, now)) return labels?.earlierThisWeek ?? (isZh ? "本周更早" : "Earlier This Week")

    return date.toLocaleDateString(locale || "zh-CN", { year: "numeric", month: "long", day: "numeric" })
  } catch {
    return isoString
  }
}

function groupVersionsByTime(versions: VersionHistoryItem[], locale?: string, labels?: VersionPanelLabels): VersionTimeSection[] {
  if (versions.length === 0) return []

  const sections: VersionTimeSection[] = []
  let currentLabel = ""
  let currentItems: VersionHistoryItem[] = []

  for (const v of versions) {
    const label = getTimeSectionLabel(v.created_at, locale, labels)
    if (label !== currentLabel) {
      if (currentItems.length > 0) {
        sections.push({ label: currentLabel, items: currentItems })
      }
      currentLabel = label
      currentItems = [v]
    } else {
      currentItems.push(v)
    }
  }

  if (currentItems.length > 0) {
    sections.push({ label: currentLabel, items: currentItems })
  }

  return sections
}
