import { joinApiPath } from '@tabtin/config'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Trash2, RotateCcw, RefreshCw, AlertTriangle,
  FileText, Table2, Presentation, Code2,
} from 'lucide-react'
import { Button, ConfirmDialog, toast } from '@components/ui'
import type { Organization } from '@tabtin/app-shell'
import { SpaceApiService, type TrashedItem } from '@tabtin/app-shell'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import { API_CONFIG } from '@/config/api'
import { contextRegistry } from '@/components/context-space/registry/instance'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SETTINGS_HINT, SETTINGS_ROW_HOVER, SETTINGS_SECTION_TITLE, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE, SETTINGS_TEXT_MICRO } from '../settingsUi'
interface OrganizationResourceTrashPanelProps {
  organization: Organization
  /** 保留入参兼容；个人回收站不再依赖组织管理员角色 */
  canManageOrganization?: boolean
  embedded?: boolean
}

const ITEM_TYPE_ICON: Record<string, React.FC<{ className?: string }>> = {
  tabdoc: FileText,
  tabdata: Table2,
  tabslide: Presentation,
  tabcode: Code2,
  // normalizeBackendType('tabfiles') → 'file'
  tabfiles: FileText,
  file: FileText,
}

const formatTime = (value?: string | null) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

const DEFAULT_RETENTION_DAYS = 30

const getDaysLeft = (trashedAt: string | null, retentionDays: number): number => {
  if (!trashedAt) return retentionDays
  const trashed = new Date(trashedAt)
  const now = new Date()
  const diffMs = now.getTime() - trashed.getTime()
  const daysPassed = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  return Math.max(0, retentionDays - daysPassed)
}

export const OrganizationResourceTrashPanel: React.FC<OrganizationResourceTrashPanelProps> = ({
  organization,
  embedded = false,
}) => {
  const { t } = useTranslation('organization')

  const [items, setItems] = useState<TrashedItem[]>([])
  const [retentionDays, setRetentionDays] = useState(DEFAULT_RETENTION_DAYS)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionId, setActionId] = useState<string | null>(null)
  const [emptyConfirm, setEmptyConfirm] = useState(false)
  const [deleteConfirmItem, setDeleteConfirmItem] = useState<TrashedItem | null>(null)

  const loadItems = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const resp = await SpaceApiService.listOrganizationTrashedItems(organization.id)
      setRetentionDays(Number.isFinite(resp.retention_days) && (resp.retention_days ?? 0) > 0
        ? Number(resp.retention_days)
        : DEFAULT_RETENTION_DAYS)
      setItems(resp.items.map(item => ({
        ...item,
        item_type: contextRegistry.normalizeBackendType(item.item_type),
      })))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('resourceTrash.loadFailed'))
    } finally {
      setIsLoading(false)
    }
  }, [organization.id, t])

  useEffect(() => {
    void loadItems()
  }, [loadItems])

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const aTs = Date.parse(a.trashed_at || a.updated_at || '')
      const bTs = Date.parse(b.trashed_at || b.updated_at || '')
      return (Number.isNaN(bTs) ? 0 : bTs) - (Number.isNaN(aTs) ? 0 : aTs)
    })
  }, [items])

  const handleRestore = useCallback(async (item: TrashedItem) => {
    setActionId(item.id)
    try {
      const moduleApi = getModuleApi(item.item_type, organization.id, item.space_id)
      if (!moduleApi) {
        toast.error(t('resourceTrash.restoreFailed'))
        return
      }
      await moduleApi.restore(item.resource_id || item.id)
      setItems(prev => prev.filter(i => i.id !== item.id))
      toast.success(t('resourceTrash.restoreSuccess', { name: item.title }))
    } catch (err) {
      const msg = err instanceof Error ? err.message.trim() : ''
      const isQuotaError = /storage quota|quota exceeded|存储空间不足|已达上限|max_documents|max_tables|配额/i.test(msg)
      // 优先展示后端原因（如「组织可创建文档数量已达上限：已用 20 / 上限 20」）
      if (msg && !/^POST\s+\/.+failed$/i.test(msg)) {
        toast.error(msg)
      } else if (isQuotaError) {
        toast.error(t('resourceTrash.quotaExceeded'))
      } else {
        toast.error(t('resourceTrash.restoreFailed'))
      }
    } finally {
      setActionId(null)
    }
  }, [organization.id, t])

  const confirmPermanentDelete = useCallback(async () => {
    if (!deleteConfirmItem) return
    const item = deleteConfirmItem
    setDeleteConfirmItem(null)
    setActionId(item.id)
    try {
      const moduleApi = getModuleApi(item.item_type, organization.id, item.space_id)
      if (!moduleApi) {
        toast.error(t('resourceTrash.deleteFailed'))
        return
      }
      await moduleApi.permanentDelete(item.resource_id || item.id)
      setItems(prev => prev.filter(i => i.id !== item.id))
      toast.success(t('resourceTrash.deleteSuccess'))
    } catch {
      // 后端可能已清掉 ContextItem 却在物理删除时报错；刷新列表避免假失败残留
      toast.error(t('resourceTrash.deleteFailed'))
      await loadItems()
    } finally {
      setActionId(null)
    }
  }, [deleteConfirmItem, organization.id, t, loadItems])

  const handleEmptyTrash = useCallback(async () => {
    if (!emptyConfirm) {
      setEmptyConfirm(true)
      return
    }
    setEmptyConfirm(false)
    setIsLoading(true)
    try {
      await SpaceApiService.emptyOrganizationTrash(organization.id)
      setError(null)
      await loadItems()
    } catch {
      toast.error(t('resourceTrash.emptyTrashFailed'))
    } finally {
      setIsLoading(false)
    }
  }, [organization.id, emptyConfirm, t, loadItems])

  const toolbar = (
    <div className="mb-3 flex items-center justify-end gap-2">
      {sortedItems.length > 0 && (
        <span className={SETTINGS_HINT}>
          {t('resourceTrash.itemCount', { count: sortedItems.length })}
        </span>
      )}
      {sortedItems.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleEmptyTrash}
          disabled={isLoading}
          className={cn(
            'h-6 px-2', SETTINGS_TEXT_MICRO,
            emptyConfirm
              ? 'text-destructive hover:text-destructive hover:bg-destructive/10'
              : 'text-muted-foreground/60 hover:text-foreground',
          )}
        >
          {emptyConfirm ? t('resourceTrash.emptyTrashConfirm') : t('resourceTrash.emptyTrash')}
        </Button>
      )}
      <button
        type="button"
        onClick={() => { setEmptyConfirm(false); void loadItems() }}
        disabled={isLoading}
        title={t('resourceTrash.refresh')}
        className="h-8 w-8 shrink-0 rounded-md flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-muted/30 transition-colors"
      >
        <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
      </button>
    </div>
  )

  const body = (
    <>
      {embedded ? toolbar : null}

      {error && (
        <div className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive', 'rounded-md border border-destructive/20 bg-destructive/5 px-3 py-1.5 flex items-center gap-1.5')}>
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {error}
        </div>
      )}

      {isLoading && sortedItems.length === 0 && (
        <p className={SETTINGS_HINT}>{t('resourceTrash.loading')}</p>
      )}

      {!isLoading && !error && sortedItems.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Trash2 className="h-8 w-8 text-muted-foreground/20 mb-3" />
          <p className={SETTINGS_SECTION_TITLE}>{t('resourceTrash.empty')}</p>
          <p className={cn(SETTINGS_HINT, 'mt-1')}>{t('resourceTrash.emptyHint', { days: retentionDays })}</p>
        </div>
      )}

      {sortedItems.length > 0 && (
        <div className="space-y-0.5">
          {sortedItems.map(item => {
            const Icon = ITEM_TYPE_ICON[item.item_type] || FileText
            const daysLeft = getDaysLeft(item.trashed_at, retentionDays)
            const isActing = actionId === item.id
            return (
              <div
                key={item.id}
                className={cn('group flex items-center justify-between gap-3 rounded-interactive px-3 py-2', SETTINGS_ROW_HOVER)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                  <div className="min-w-0">
                    <div className="truncate text-body text-foreground/80">
                      {item.title || t('resourceTrash.untitled')}
                    </div>
                    <div className={cn(SETTINGS_TEXT_META, 'text-muted-foreground/40')}>
                      <span className="capitalize">{t(`resourceTrash.itemTypes.${item.item_type}`, { defaultValue: item.item_type })}</span>
                      {' · '}
                      {t('resourceTrash.trashedAt', { time: formatTime(item.trashed_at) })}
                      {daysLeft > 0 && (
                        <>
                          {' · '}
                          <span className={cn(daysLeft <= 7 && 'text-warning')}>
                            {t('resourceTrash.daysLeft', { days: daysLeft })}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isActing}
                    onClick={() => { void handleRestore(item) }}
                    className="shrink-0 h-7 text-body"
                  >
                    <RotateCcw className={cn('h-[1em] w-[1em] mr-1', isActing && 'animate-spin')} />
                    {t('resourceTrash.restore')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isActing}
                    onClick={() => setDeleteConfirmItem(item)}
                    className="shrink-0 h-7 text-body text-destructive hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-[1em] w-[1em] mr-1" />
                    {t('resourceTrash.permanentDelete')}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteConfirmItem}
        onOpenChange={(open) => { if (!open) setDeleteConfirmItem(null) }}
        title={t('resourceTrash.deleteConfirmTitle')}
        description={t('resourceTrash.deleteConfirm', { name: deleteConfirmItem?.title || t('resourceTrash.untitled') })}
        variant="destructive"
        onConfirm={confirmPermanentDelete}
      />
    </>
  )

  if (embedded) {
    return body
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Trash2 className="h-4 w-4" />}
        title={t('resourceTrash.title')}
        subtitle={t('resourceTrash.subtitle')}
        meta={toolbar}
      />
      {body}
    </SettingsPanelLayout>
  )
}

async function makeTrashRequest(url: string, method: 'POST' | 'DELETE') {
  const token = await getAuthToken()
  const resp = await adapterApiRequest({
    url: joinApiPath(API_CONFIG.baseURL, `${url}`),
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!resp || resp.status !== 200) {
    const data = resp?.data as {
      message?: string
      detail?: string
      data?: { detail?: string }
      error?: { message?: string }
    } | undefined
    // Django validation_error_response：具体原因在 data.detail / data.data.detail
    const detail =
      (typeof data?.detail === 'string' && data.detail) ||
      (typeof data?.data?.detail === 'string' && data.data.detail) ||
      (typeof data?.message === 'string' && data.message) ||
      (typeof data?.error?.message === 'string' && data.error.message) ||
      ''
    throw new Error(detail || `${method} ${url} failed`)
  }
  return resp.data
}

interface ModuleTrashApi {
  restore: (id: string) => Promise<unknown>
  permanentDelete: (id: string) => Promise<unknown>
}

// 恢复 / 永久删除仍走各模块 REST（按 resource_id 定位，不依赖回收站入口挂在哪）。
// TabCode 仍带历史 space_id；TabFiles改走组织级 restore / permanent。
// TabFiles 前端 type 为 `file`（normalizeBackendType），后端 item_type 为 `tabfiles`。
function getModuleApi(
  itemType: string,
  organizationId: string,
  itemSpaceId: string | null | undefined,
): ModuleTrashApi | null {
  const tabfilesApi: ModuleTrashApi = {
    restore: (id) => makeTrashRequest(
      `/context/organizations/${organizationId}/files/${id}/restore`,
      'POST',
    ),
    permanentDelete: (id) => makeTrashRequest(
      `/context/organizations/${organizationId}/files/${id}/permanent`,
      'DELETE',
    ),
  }
  const routes: Record<string, ModuleTrashApi> = {
    tabdoc: {
      restore: (id) => makeTrashRequest(`/tabdoc/documents/${id}/restore-from-trash`, 'POST'),
      permanentDelete: (id) => makeTrashRequest(`/tabdoc/documents/${id}/permanent`, 'DELETE'),
    },
    tabdata: {
      restore: (id) => makeTrashRequest(`/tabdata/tables/${id}/restore-from-trash`, 'POST'),
      permanentDelete: (id) => makeTrashRequest(`/tabdata/tables/${id}/permanent`, 'DELETE'),
    },
    tabslide: {
      restore: (id) => makeTrashRequest(`/tabslide/projects/${id}/restore-from-trash`, 'POST'),
      permanentDelete: (id) => makeTrashRequest(`/tabslide/projects/${id}/permanent`, 'DELETE'),
    },
    tabfiles: tabfilesApi,
    file: tabfilesApi,
  }
  if (itemSpaceId) {
    routes.tabcode = {
      restore: (id) => makeTrashRequest(`/tabcode/spaces/${itemSpaceId}/code-projects/${id}/restore-from-trash`, 'POST'),
      permanentDelete: (id) => makeTrashRequest(`/tabcode/spaces/${itemSpaceId}/code-projects/${id}/permanent`, 'DELETE'),
    }
  }

  return routes[itemType] || null
}
