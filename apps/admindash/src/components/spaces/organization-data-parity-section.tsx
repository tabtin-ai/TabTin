import {
  type TrashSensitiveActionPayload,
  type TrashedResource,
  type TrashedSpace,
  trashAdminApi,
} from '@/api/trash-admin'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { ADMIN_PERMISSION, hasAdminPermission } from '@/lib/admin-permissions'
import { useAuthStore } from '@/stores/auth-store'
import { Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  displayPerson,
  formatDateTime,
  itemTypeLabel,
  spaceTypeLabel,
} from './organization-data-shared'

const PREVIEW_LIMIT = 20

function getDaysLeft(trashedAt: string | null, retentionDays = 30): number {
  if (!trashedAt) return retentionDays
  const diff = Date.now() - new Date(trashedAt).getTime()
  return Math.max(0, retentionDays - Math.floor(diff / 86400000))
}

function ExpiryBadge({ daysLeft }: { daysLeft: number }) {
  if (daysLeft === 0) {
    return <Badge variant="destructive">已过期</Badge>
  }
  if (daysLeft <= 3) {
    return <Badge variant="warning">{daysLeft} 天内过期</Badge>
  }
  return <Badge variant="outline">{daysLeft} 天后过期</Badge>
}

type PendingSensitiveAction =
  | { type: 'restore-resource'; item: TrashedResource }
  | { type: 'delete-resource'; item: TrashedResource }
  | { type: 'empty-resources' }
  | { type: 'restore-space'; item: TrashedSpace }
  | { type: 'delete-space'; item: TrashedSpace }

type TrashKindFilter = 'all' | 'space' | 'content'

type UnifiedTrashRow =
  | {
      kind: 'space'
      id: string
      name: string
      typeLabel: string
      createdByName?: string | null
      createdBy?: string | null
      trashedByName?: string | null
      trashedBy?: string | null
      trashedAt: string | null
      space: TrashedSpace
    }
  | {
      kind: 'content'
      id: string
      name: string
      typeLabel: string
      createdByName?: string | null
      createdBy?: string | null
      trashedByName?: string | null
      trashedBy?: string | null
      trashedAt: string | null
      resource: TrashedResource
    }

export interface OrganizationDataParitySectionProps {
  organizationId: string
  /** 外部触发刷新（如资源列表删除进回收站后） */
  refreshToken?: number
  /** 恢复成功后回调，用于刷新上方资源列表 */
  onRestored?: () => void
}

/**
 * 组织详情「数据与回收」：统一资源回收站（空间 + 文档/表格等）。
 */
export function OrganizationDataParitySection({
  organizationId,
  refreshToken = 0,
  onRestored,
}: OrganizationDataParitySectionProps) {
  const { adminPermissions } = useAuthStore()
  const canListTrash = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.TRASH_LIST)
  const { show: showToast, element: toastEl } = useSimpleToast()

  const [resources, setResources] = useState<TrashedResource[]>([])
  const [resourceTotal, setResourceTotal] = useState(0)
  const [spaces, setSpaces] = useState<TrashedSpace[]>([])
  const [spaceTotal, setSpaceTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<TrashKindFilter>('all')

  const [pendingAction, setPendingAction] = useState<PendingSensitiveAction | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const trashHref = `/trash?organization_id=${encodeURIComponent(organizationId)}`
  const trashExpiringHref = `${trashHref}&attention=expiring`

  const refreshAll = useCallback(async () => {
    // 引用 refreshToken：父级交叉刷新时重建回调并触发下方 effect
    void refreshToken
    if (!organizationId.trim() || !canListTrash) {
      setResources([])
      setResourceTotal(0)
      setSpaces([])
      setSpaceTotal(0)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const [resourceData, spaceData] = await Promise.all([
        trashAdminApi.listResources({
          organization_id: organizationId,
          page: 1,
          page_size: PREVIEW_LIMIT,
        }),
        trashAdminApi.listTrashedSpaces({
          organization_id: organizationId,
          page: 1,
          page_size: PREVIEW_LIMIT,
        }),
      ])
      setResources(resourceData.items ?? [])
      setResourceTotal(resourceData.total ?? 0)
      setSpaces(spaceData.items ?? [])
      setSpaceTotal(spaceData.total ?? 0)
    } catch (err) {
      setResources([])
      setResourceTotal(0)
      setSpaces([])
      setSpaceTotal(0)
      setError(err instanceof Error ? err.message : '加载回收站失败')
    } finally {
      setLoading(false)
    }
  }, [canListTrash, organizationId, refreshToken])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  const unifiedRows = useMemo(() => {
    const spaceRows: UnifiedTrashRow[] = spaces.map((item) => ({
      kind: 'space',
      id: `space:${item.id}`,
      name: item.name || '（未命名空间）',
      typeLabel: spaceTypeLabel(item.type, '协作空间'),
      createdByName: item.created_by_name,
      createdBy: item.created_by,
      trashedByName: item.trashed_by_name,
      trashedBy: item.trashed_by,
      trashedAt: item.trashed_at,
      space: item,
    }))
    const contentRows: UnifiedTrashRow[] = resources.map((item) => ({
      kind: 'content',
      id: `content:${item.id}`,
      name: item.title || '（无标题）',
      typeLabel: itemTypeLabel(item.item_type, '未知类型'),
      createdByName: item.created_by_name,
      createdBy: item.created_by,
      trashedByName: item.trashed_by_name,
      trashedBy: item.trashed_by,
      trashedAt: item.trashed_at,
      resource: item,
    }))
    const merged = [...spaceRows, ...contentRows].sort((a, b) => {
      const ta = a.trashedAt ? new Date(a.trashedAt).getTime() : 0
      const tb = b.trashedAt ? new Date(b.trashedAt).getTime() : 0
      return tb - ta
    })
    if (kindFilter === 'space') return merged.filter((row) => row.kind === 'space')
    if (kindFilter === 'content') return merged.filter((row) => row.kind === 'content')
    return merged
  }, [spaces, resources, kindFilter])

  const totalAll = spaceTotal + resourceTotal

  const getSensitiveDialogConfig = () => {
    if (!pendingAction) return null
    switch (pendingAction.type) {
      case 'restore-resource':
        return {
          title: '恢复资源',
          targetLabel: pendingAction.item.title || pendingAction.item.id,
          impact: '该资源将从回收站恢复，客户端可能重新可见。',
          confirmText: '确认恢复',
        }
      case 'delete-resource':
        return {
          title: '永久删除资源',
          targetLabel: pendingAction.item.title || pendingAction.item.id,
          impact: '该资源将被永久删除，不可撤销。',
          confirmText: '永久删除',
        }
      case 'empty-resources':
        return {
          title: '清空内容资源回收站',
          targetLabel: `组织 ${organizationId}`,
          impact: `将永久删除本组织回收站内全部 ${resourceTotal.toLocaleString()} 条内容资源（文档/表格等），不可撤销。已删除的协作空间不会被清空。`,
          confirmText: '清空内容资源',
        }
      case 'restore-space':
        return {
          title: '恢复协作空间',
          targetLabel: pendingAction.item.name || pendingAction.item.id,
          impact: '该协作空间将从回收站恢复，并级联恢复随空间删除的子资源。',
          confirmText: '确认恢复',
        }
      case 'delete-space':
        return {
          title: '永久删除协作空间',
          targetLabel: pendingAction.item.name || pendingAction.item.id,
          impact: '该协作空间及其关联资源将被永久删除，不可撤销。',
          confirmText: '永久删除',
        }
      default:
        return null
    }
  }

  const handleConfirmSensitiveAction = async (payload: TrashSensitiveActionPayload) => {
    if (!pendingAction) return
    setActionLoading(true)
    const actionType = pendingAction.type
    try {
      if (pendingAction.type === 'restore-resource') {
        setBusyId(`content:${pendingAction.item.id}`)
        const result = await trashAdminApi.restoreResource(pendingAction.item.id, payload)
        showToast(result.message || `已恢复「${pendingAction.item.title || '无标题'}」`)
      } else if (pendingAction.type === 'delete-resource') {
        setBusyId(`content:${pendingAction.item.id}`)
        await trashAdminApi.permanentDelete(pendingAction.item.id, payload)
        showToast(`已永久删除「${pendingAction.item.title || '无标题'}」`)
      } else if (pendingAction.type === 'empty-resources') {
        const result = await trashAdminApi.emptyOrganizationResourceTrash(organizationId, payload)
        const deleted = result.data?.deleted_count ?? 0
        showToast(result.message || `已清空 ${deleted} 条内容资源`)
      } else if (pendingAction.type === 'restore-space') {
        setBusyId(`space:${pendingAction.item.id}`)
        const result = await trashAdminApi.restoreSpace(pendingAction.item.id, payload)
        showToast(result.message || `已恢复协作空间「${pendingAction.item.name}」`)
      } else if (pendingAction.type === 'delete-space') {
        setBusyId(`space:${pendingAction.item.id}`)
        const result = await trashAdminApi.permanentDeleteSpace(pendingAction.item.id, payload)
        showToast(result.message || `已永久删除协作空间「${pendingAction.item.name}」`)
      }
      setPendingAction(null)
      await refreshAll()
      if (actionType === 'restore-resource' || actionType === 'restore-space') {
        onRestored?.()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败'
      showToast(message, 'error')
    } finally {
      setActionLoading(false)
      setBusyId(null)
    }
  }

  if (!organizationId.trim()) {
    return null
  }

  const dialogConfig = getSensitiveDialogConfig()

  return (
    <div className="space-y-3">
      {toastEl}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-subtitle">
                <Trash2 className="h-4 w-4" />
                资源回收站
              </CardTitle>
              <CardDescription className="mt-1 max-w-3xl">
                合并展示本组织已删除的协作空间与内容资源（文档 / 表格等），可代恢复或永久删除。
              </CardDescription>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refreshAll()}
                disabled={loading || !canListTrash}
                aria-label="刷新回收站"
              >
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </Button>
              <PermissionGate permission={ADMIN_PERMISSION.TRASH_CLEANUP}>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!canListTrash || resourceTotal === 0 || actionLoading}
                  onClick={() => setPendingAction({ type: 'empty-resources' })}
                >
                  清空内容资源
                </Button>
              </PermissionGate>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <Tabs
            value={kindFilter}
            onValueChange={(value) => setKindFilter(value as TrashKindFilter)}
          >
            <TabsList className="flex h-auto flex-wrap">
              <TabsTrigger value="all">
                全部
                <Badge variant="secondary" className="ml-1.5 tabular-nums">
                  {totalAll}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="space">
                空间
                <Badge variant="secondary" className="ml-1.5 tabular-nums">
                  {spaceTotal}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="content">
                内容资源
                <Badge variant="secondary" className="ml-1.5 tabular-nums">
                  {resourceTotal}
                </Badge>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {!canListTrash ? (
            <div className="rounded-md border border-dashed px-3 py-6 text-center text-body text-muted-foreground">
              当前账号缺少 <code className="text-caption">trash:list</code> 权限，无法预览列表。
            </div>
          ) : error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
              {error}
            </div>
          ) : loading && unifiedRows.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-body text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载回收站…
            </div>
          ) : unifiedRows.length === 0 ? (
            <div className="rounded-md border border-dashed px-3 py-6 text-center text-body text-muted-foreground">
              本组织回收站为空
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-caption text-muted-foreground">
                <span>
                  预览 {unifiedRows.length} 条
                  {kindFilter === 'all' && totalAll > unifiedRows.length
                    ? ` · 共约 ${totalAll.toLocaleString()} 条`
                    : null}
                </span>
                <Link to={trashExpiringHref} className="text-caption text-primary hover:underline">
                  查看即将过期
                </Link>
              </div>
              <div className="overflow-auto rounded-md border bg-background">
                <table className="min-w-full text-body">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">名称</th>
                      <th className="px-3 py-2 text-left font-medium">分类</th>
                      <th className="px-3 py-2 text-left font-medium">类型</th>
                      <th className="px-3 py-2 text-left font-medium">创建人</th>
                      <th className="px-3 py-2 text-left font-medium">删除人</th>
                      <th className="px-3 py-2 text-left font-medium">删除时间</th>
                      <th className="px-3 py-2 text-left font-medium">过期</th>
                      <th className="px-3 py-2 text-left font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unifiedRows.map((row) => {
                      const daysLeft = getDaysLeft(row.trashedAt)
                      const busy = busyId === row.id
                      return (
                        <tr key={row.id} className="border-t">
                          <td className="px-3 py-2 font-medium">{row.name}</td>
                          <td className="px-3 py-2">
                            <Badge variant={row.kind === 'space' ? 'outline' : 'secondary'}>
                              {row.kind === 'space' ? '空间' : '内容'}
                            </Badge>
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant="secondary">{row.typeLabel}</Badge>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {displayPerson(row.createdByName, row.createdBy)}
                          </td>
                          <td className="px-3 py-2">
                            {displayPerson(row.trashedByName, row.trashedBy)}
                          </td>
                          <td className="px-3 py-2">{formatDateTime(row.trashedAt)}</td>
                          <td className="px-3 py-2">
                            <ExpiryBadge daysLeft={daysLeft} />
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              <PermissionGate permission={ADMIN_PERMISSION.TRASH_RESTORE}>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy || actionLoading}
                                  onClick={() =>
                                    setPendingAction(
                                      row.kind === 'space'
                                        ? { type: 'restore-space', item: row.space }
                                        : { type: 'restore-resource', item: row.resource }
                                    )
                                  }
                                >
                                  {busy &&
                                  (pendingAction?.type === 'restore-space' ||
                                    pendingAction?.type === 'restore-resource') ? (
                                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                                  )}
                                  恢复
                                </Button>
                              </PermissionGate>
                              <PermissionGate permission={ADMIN_PERMISSION.TRASH_DELETE}>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={busy || actionLoading}
                                  onClick={() =>
                                    setPendingAction(
                                      row.kind === 'space'
                                        ? { type: 'delete-space', item: row.space }
                                        : { type: 'delete-resource', item: row.resource }
                                    )
                                  }
                                >
                                  永久删除
                                </Button>
                              </PermissionGate>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <SensitiveActionConfirmDialog
        open={Boolean(pendingAction && dialogConfig)}
        title={dialogConfig?.title ?? ''}
        targetLabel={dialogConfig?.targetLabel ?? ''}
        impact={dialogConfig?.impact ?? ''}
        confirmText={dialogConfig?.confirmText}
        loading={actionLoading}
        onCancel={() => {
          if (actionLoading) return
          setPendingAction(null)
        }}
        onConfirm={(payload) => void handleConfirmSensitiveAction(payload)}
      />
    </div>
  )
}
