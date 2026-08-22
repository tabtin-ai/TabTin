/**
 * SpaceHome — 选中 Space 后的主内容区
 *
 * 展示当前 space 的文档与表格列表，点击进入对应编辑路由。
 * 未选中 space 时展示空状态引导。
 * 数据来自 app-shell 的 useSpaceStore（space 选中状态）
 * + tabdoc-ui listDocuments / table-core TableApiService。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Table2, FileText, LayoutList, LayoutGrid } from 'lucide-react'
import {
  useSpaceStore,
  useOrganizationStore,
  useSpaceListStore,
} from '@tabtin/app-shell'
import { useSpaceResources } from '@/features/space/useSpaceResources'
import { docPath, tablePath } from '@/features/space/spaceRoutes'
import { cn } from '@/utils/cn'
import {
  SpaceResourceSection,
  type SpaceResourceCard,
} from './SpaceResourceSection'

type ViewMode = 'list' | 'grid'
const VIEW_MODE_KEY = 'tabtin:web:spaceHome:viewMode'
function loadViewMode(): ViewMode {
  try { return localStorage.getItem(VIEW_MODE_KEY) === 'grid' ? 'grid' : 'list' } catch { return 'list' }
}
function saveViewMode(m: ViewMode) {
  try { localStorage.setItem(VIEW_MODE_KEY, m) } catch { /* noop */ }
}

function formatUpdatedAt(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString()
}

export function SpaceHome() {
  const { t } = useTranslation('space')
  const navigate = useNavigate()

  const selectedSpace = useSpaceStore(state => state.selectedSpace)
  const selectedWorkspace = useOrganizationStore(state => state.selectedOrganization)
  const selectedSpaceKind = useSpaceListStore(state => state.selectedSpaceKind)

  const documents = useSpaceResources(state => state.documents)
  const tables = useSpaceResources(state => state.tables)
  const isLoading = useSpaceResources(state => state.isLoading)
  const docsError = useSpaceResources(state => state.docsError)
  const tablesError = useSpaceResources(state => state.tablesError)
  const loadResources = useSpaceResources(state => state.load)
  const resetResources = useSpaceResources(state => state.reset)

  const organizationId = selectedWorkspace?.id ?? null
  const spaceId = selectedSpace?.id ?? null

  useEffect(() => {
    if (organizationId && spaceId && selectedSpaceKind === 'workspace') {
      void loadResources(organizationId, spaceId)
    } else {
      resetResources()
    }
  }, [organizationId, spaceId, selectedSpaceKind, loadResources, resetResources])

  const visibleDocuments = useMemo(
    () => documents.filter((doc) => doc.status !== 'archived'),
    [documents],
  )

  const visibleTables = useMemo(
    () => tables.filter((table) => table.visibility !== 'system'),
    [tables],
  )

  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode)
  const toggleViewMode = useCallback(() => {
    setViewMode(prev => {
      const next = prev === 'list' ? 'grid' : 'list'
      saveViewMode(next)
      return next
    })
  }, [])

  const handleRefresh = () => {
    if (!organizationId || !spaceId) return
    void loadResources(organizationId, spaceId, { force: true })
  }

  const handleOpenDoc = useCallback((documentId: string) => {
    navigate(docPath(organizationId, spaceId, documentId))
  }, [navigate, organizationId, spaceId])

  const handleOpenTable = useCallback((tableId: string) => {
    navigate(tablePath(organizationId, spaceId, tableId))
  }, [navigate, organizationId, spaceId])

  const docCards = useMemo<SpaceResourceCard[]>(
    () =>
      visibleDocuments.map((doc) => {
        const updatedAt = formatUpdatedAt(doc.updated_at)
        return {
          id: doc.id,
          title: doc.title?.trim() || t('home.untitledDoc'),
          icon: doc.icon,
          coverImage: doc.cover_image,
          listMeta: updatedAt ? <span>{updatedAt}</span> : null,
          gridMeta: updatedAt ? <span>{updatedAt}</span> : null,
          onClick: () => handleOpenDoc(doc.id),
        }
      }),
    [visibleDocuments, t, handleOpenDoc],
  )

  const tableCards = useMemo<SpaceResourceCard[]>(
    () =>
      visibleTables.map((table) => {
        const meta = (
          <>
            <span>{t('home.rowCount', { count: table.row_count ?? 0 })}</span>
            <span>·</span>
            <span>{t('home.fieldCount', { count: table.field_count ?? 0 })}</span>
          </>
        )
        return {
          id: table.id,
          title: table.name,
          icon: table.icon,
          previewText: table.description,
          listMeta: meta,
          gridMeta: meta,
          onClick: () => handleOpenTable(table.id),
        }
      }),
    [visibleTables, t, handleOpenTable],
  )

  if (!selectedSpace || selectedSpaceKind !== 'workspace') {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="text-display">🗂️</div>
          <h2 className="text-title font-medium text-foreground/80">
            {t('home.emptyTitle')}
          </h2>
          <p className="text-body text-muted-foreground max-w-xs">
            {t('home.emptyDescription')}
          </p>
        </div>
      </div>
    )
  }

  const showInitialLoading = isLoading && documents.length === 0 && tables.length === 0

  return (
    <div className="h-full flex flex-col min-w-0 w-full">
      {/* Header */}
      <div className="border-b border-border/50 bg-background/90 px-6 py-5 flex-shrink-0 min-w-0 w-full">
        <div className="flex items-center gap-3">
          <span className="text-heading">{selectedSpace.icon || '🗂️'}</span>
          <div className="min-w-0">
            <h1 className="text-title font-semibold text-foreground truncate">
              {selectedSpace.name}
            </h1>
            {selectedSpace.description && (
              <p className="text-body text-muted-foreground truncate mt-0.5">
                {selectedSpace.description}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 min-w-0 w-full">
        <div className="flex items-center justify-end gap-2 mb-6 min-w-0 w-full">
          <div className="flex items-center rounded-md border border-border/40 bg-muted/20 p-0.5">
            <button
              type="button"
              className={cn('rounded p-1 transition-colors', viewMode === 'list' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}
              onClick={() => { if (viewMode !== 'list') toggleViewMode() }}
              title={t('home.listView', { defaultValue: '列表视图' })}
            >
              <LayoutList className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={cn('rounded p-1 transition-colors', viewMode === 'grid' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}
              onClick={() => { if (viewMode !== 'grid') toggleViewMode() }}
              title={t('home.gridView', { defaultValue: '宫格视图' })}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isLoading}
            className="h-7 px-2 rounded-md text-body text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50 flex items-center gap-1"
          >
            <RefreshCw className={cn('h-3 w-3', isLoading && 'animate-spin')} />
            {t('home.refreshContent')}
          </button>
        </div>

        {showInitialLoading && (
          <div className="text-body text-muted-foreground py-8 text-center">
            {t('home.loadingContent')}
          </div>
        )}

        <SpaceResourceSection
          className="mb-8"
          title={t('home.docSection')}
          countLabel={isLoading ? null : t('home.docCount', { count: visibleDocuments.length })}
          icon={FileText}
          gridGradientClass="from-amber-500/20 to-amber-600/8 dark:from-amber-400/25 dark:to-amber-500/10"
          gridIconClass="text-amber-600/35 dark:text-amber-400/40"
          typeLabel="TabDoc"
          openLabel={t('home.openDoc')}
          emptyLabel={t('home.noDocs')}
          error={docsError}
          isLoading={isLoading}
          viewMode={viewMode}
          cards={docCards}
        />

        <SpaceResourceSection
          title={t('home.tableSection')}
          countLabel={isLoading ? null : t('home.tableCount', { count: visibleTables.length })}
          icon={Table2}
          gridGradientClass="from-blue-500/20 to-blue-600/8 dark:from-blue-400/25 dark:to-blue-500/10"
          gridIconClass="text-info/35 dark:text-info/40"
          typeLabel="TabData"
          openLabel={t('home.openTable')}
          emptyLabel={t('home.noTables')}
          error={tablesError}
          isLoading={isLoading}
          viewMode={viewMode}
          cards={tableCards}
        />
      </div>
    </div>
  )
}
