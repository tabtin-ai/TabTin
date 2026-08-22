/**
 * SpaceResourceTree — 左侧栏内嵌的「云端应用」资源目录
 *
 * 对齐 Electron DesktopPanel 的「云端应用」分组：列出当前 Space 的文档与表格，
 * 可展开看条目、点击直接导航到对应编辑路由。作为 WebSidebar 的一段嵌入在
 * 「个人身份 → Agent 列表」下方（不再是独立的一列面板）。
 * 数据走 useSpaceResources（与 SpaceHome 共享，同一份缓存）。
 *
 * @see apps/tabtin-electron/src/renderer/src/components/context-space/DesktopPanel.tsx
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  FileText,
  Table2,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react'
import {
  useSpaceStore,
  useOrganizationStore,
  useSpaceListStore,
} from '@tabtin/app-shell'
import { useSpaceResources } from '@/features/space/useSpaceResources'
import { docPath, spaceHomePath, tablePath } from '@/features/space/spaceRoutes'
import { useShareNavigation } from '@/components/layout/ShareNavigationContext'
import { cn } from '@/utils/cn'

const EXPAND_STORAGE_KEY = 'tabtin:web:resourceTree:expanded'

type ResourceAppId = 'tabdoc' | 'tabdata'

function loadExpanded(): Record<ResourceAppId, boolean> {
  try {
    const raw = localStorage.getItem(EXPAND_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<ResourceAppId, boolean>>
      return { tabdoc: parsed.tabdoc ?? true, tabdata: parsed.tabdata ?? true }
    }
  } catch {
    /* noop */
  }
  return { tabdoc: true, tabdata: true }
}

function saveExpanded(state: Record<ResourceAppId, boolean>) {
  try {
    localStorage.setItem(EXPAND_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* noop */
  }
}

interface ResourceChild {
  id: string
  title: string
  icon?: string | null
  isActive: boolean
  onClick: () => void
}

export const SpaceResourceTree: React.FC = () => {
  const { t } = useTranslation('space')
  const navigate = useNavigate()
  const params = useParams<{ documentId?: string; tableId?: string }>()
  const { activeShare } = useShareNavigation()

  const selectedSpace = useSpaceStore((state) => state.selectedSpace)
  const selectedWorkspace = useOrganizationStore((state) => state.selectedOrganization)
  const selectedSpaceKind = useSpaceListStore((state) => state.selectedSpaceKind)

  const organizationId = selectedWorkspace?.id ?? null
  const spaceId = selectedSpace?.id ?? null
  const isWorkspace = selectedSpaceKind === 'workspace' && Boolean(selectedSpace)

  const documents = useSpaceResources((state) => state.documents)
  const tables = useSpaceResources((state) => state.tables)
  const isLoading = useSpaceResources((state) => state.isLoading)
  const docsError = useSpaceResources((state) => state.docsError)
  const tablesError = useSpaceResources((state) => state.tablesError)
  const load = useSpaceResources((state) => state.load)
  const reset = useSpaceResources((state) => state.reset)

  const [expanded, setExpanded] = useState(loadExpanded)

  useEffect(() => {
    if (activeShare?.kind === 'doc') {
      setExpanded((prev) => {
        if (prev.tabdoc) return prev
        const next = { ...prev, tabdoc: true }
        saveExpanded(next)
        return next
      })
    }
  }, [activeShare?.kind])

  useEffect(() => {
    if (isWorkspace && organizationId && spaceId) {
      void load(organizationId, spaceId)
    } else {
      reset()
    }
  }, [isWorkspace, organizationId, spaceId, load, reset])

  const toggleExpand = useCallback((appId: ResourceAppId) => {
    setExpanded((prev) => {
      const next = { ...prev, [appId]: !prev[appId] }
      saveExpanded(next)
      return next
    })
  }, [])

  const visibleDocuments = useMemo(
    () => documents.filter((doc) => doc.status !== 'archived'),
    [documents],
  )
  const visibleTables = useMemo(
    () => tables.filter((table) => table.visibility !== 'system'),
    [tables],
  )

  const goHome = useCallback(() => {
    navigate(spaceHomePath(organizationId, spaceId))
  }, [navigate, organizationId, spaceId])

  const shareDocId = activeShare?.kind === 'doc' ? activeShare.documentId ?? null : null
  const shareTabId = shareDocId ?? (activeShare?.kind === 'doc' ? `share:${activeShare.shareId}` : null)

  const docChildren = useMemo<ResourceChild[]>(() => {
    const mapped: ResourceChild[] = visibleDocuments.map((doc) => ({
      id: doc.id,
      title: doc.title?.trim() || t('home.untitledDoc'),
      icon: doc.icon,
      // 分享路由没有 documentId；用 ShareNavigationContext 对齐高亮，避免误亮无关文档
      isActive:
        params.documentId === doc.id
        || (shareDocId != null && shareDocId === doc.id),
      onClick: () => navigate(docPath(organizationId, spaceId, doc.id)),
    }))

    // 分享文档不在当前 Space 资源列表里时，插入一条「当前分享」伪页签，
    // 让侧栏也能看到打开中的文档（对齐自有 TabDoc 的页签可见性）。
    if (
      activeShare?.kind === 'doc'
      && shareTabId
      && !mapped.some((item) => item.id === shareDocId || item.id === shareTabId)
    ) {
      mapped.unshift({
        id: shareTabId,
        title: activeShare.title?.trim() || t('home.untitledDoc'),
        icon: activeShare.icon ?? null,
        isActive: true,
        onClick: () => undefined,
      })
    }

    return mapped
  }, [
    visibleDocuments,
    params.documentId,
    navigate,
    organizationId,
    spaceId,
    t,
    activeShare,
    shareDocId,
    shareTabId,
  ])

  const tableChildren = useMemo<ResourceChild[]>(
    () =>
      visibleTables.map((table) => ({
        id: table.id,
        title: table.name,
        icon: table.icon,
        isActive: params.tableId === table.id,
        onClick: () => navigate(tablePath(organizationId, spaceId, table.id)),
      })),
    [visibleTables, params.tableId, navigate, organizationId, spaceId],
  )

  if (!isWorkspace) return null

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-2 pt-1 pb-1">
        <span className="text-caption font-medium uppercase tracking-wide text-muted-foreground/50">
          {t('panel.cloudResources')}
        </span>
        <button
          type="button"
          onClick={() => {
            if (organizationId && spaceId) void load(organizationId, spaceId, { force: true })
          }}
          disabled={isLoading}
          title={t('home.refreshContent')}
          className="shrink-0 h-5 w-5 rounded flex items-center justify-center text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3 w-3', isLoading && 'animate-spin')} />
        </button>
      </div>

      <ResourceAppRow
        icon={FileText}
        emoji="📄"
        label={t('home.docSection')}
        count={visibleDocuments.length}
        expanded={expanded.tabdoc}
        onToggle={() => toggleExpand('tabdoc')}
        onOpenHome={goHome}
        isLoading={isLoading}
        error={docsError}
        items={docChildren}
        emptyLabel={t('home.noDocs')}
        viewAllLabel={t('panel.viewAll')}
      />

      <ResourceAppRow
        icon={Table2}
        emoji="📊"
        label={t('home.tableSection')}
        count={visibleTables.length}
        expanded={expanded.tabdata}
        onToggle={() => toggleExpand('tabdata')}
        onOpenHome={goHome}
        isLoading={isLoading}
        error={tablesError}
        items={tableChildren}
        emptyLabel={t('home.noTables')}
        viewAllLabel={t('panel.viewAll')}
      />
    </div>
  )
}

interface ResourceAppRowProps {
  icon: LucideIcon
  emoji: string
  label: string
  count: number
  expanded: boolean
  onToggle: () => void
  onOpenHome: () => void
  isLoading: boolean
  error: string | null
  items: ResourceChild[]
  emptyLabel: string
  viewAllLabel: string
}

function ResourceAppRow({
  emoji,
  label,
  count,
  expanded,
  onToggle,
  onOpenHome,
  isLoading,
  error,
  items,
  emptyLabel,
  viewAllLabel,
}: ResourceAppRowProps) {
  return (
    <div>
      <div className="flex items-center min-w-0 mx-1 rounded-md transition-colors hover:bg-muted/30 group">
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 h-7 w-5 flex items-center justify-center text-muted-foreground/50 hover:text-foreground transition-colors"
          aria-label={label}
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 transition-transform duration-150', expanded && 'rotate-90')}
          />
        </button>
        <button
          type="button"
          onClick={onOpenHome}
          className="flex-1 flex items-center gap-2 min-w-0 py-1.5 pr-2 text-left"
        >
          <span className="shrink-0 text-body leading-none">{emoji}</span>
          <span className="flex-1 truncate text-body text-foreground/90" title={label}>
            {label}
          </span>
          {count > 0 && (
            <span className="shrink-0 text-caption text-muted-foreground/50 tabular-nums">{count}</span>
          )}
        </button>
      </div>

      {expanded && (
        <div className="flex flex-col gap-px mb-0.5">
          {error ? (
            <div className="pl-8 pr-3 py-1 text-caption text-destructive">{error}</div>
          ) : items.length === 0 ? (
            !isLoading && (
              <div className="pl-8 pr-3 py-1 text-caption text-muted-foreground/50">{emptyLabel}</div>
            )
          ) : (
            <>
              {items.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  onClick={child.onClick}
                  className={cn(
                    'flex items-center gap-2 min-w-0 mx-1 pl-7 pr-2 py-1 rounded-md text-left transition-colors',
                    child.isActive
                      ? 'bg-accent/15 text-foreground'
                      : 'text-foreground/70 hover:bg-muted/30 hover:text-foreground',
                  )}
                >
                  {child.icon ? (
                    <span className="shrink-0 text-caption leading-none">{child.icon}</span>
                  ) : null}
                  <span className="flex-1 truncate text-body" title={child.title}>
                    {child.title}
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={onOpenHome}
                className="mx-1 pl-7 pr-2 py-1 text-left text-caption text-muted-foreground/60 hover:text-accent transition-colors"
              >
                {viewAllLabel}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
