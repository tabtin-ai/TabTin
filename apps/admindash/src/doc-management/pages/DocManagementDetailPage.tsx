import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  archiveAdminDoc,
  getAdminDocDetail,
  restoreAdminDocRevision,
  restoreAdminDocStatus,
  trashAdminDoc,
  untrashAdminDoc,
  updateAdminDocPermissions,
} from '@/doc-management/api/doc-management'
import type {
  AdminDocDetailResponse,
  AdminDocPermissionInput,
  DocManagementPermissionDraft,
} from '@/doc-management/types'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import { Archive, ArrowLeft, Loader2, RotateCcw, Save } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

function createLocalId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function toPermissionDrafts(data: AdminDocDetailResponse | null): DocManagementPermissionDraft[] {
  if (!data || data.permissions.length === 0) {
    return []
  }

  return data.permissions.map((entry) => ({
    local_id: entry.id || createLocalId(),
    subject_type: entry.subject_type === 'role' ? 'role' : 'user',
    subject_id: entry.subject_id,
    permission:
      entry.permission === 'admin' ? 'admin' : entry.permission === 'editor' ? 'editor' : 'viewer',
    is_active: entry.is_active,
  }))
}

export function DocManagementDetailPage() {
  const navigate = useNavigate()
  const { documentId = '' } = useParams<{ documentId: string }>()

  const [data, setData] = useState<AdminDocDetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [permissionDrafts, setPermissionDrafts] = useState<DocManagementPermissionDraft[]>([])
  const [savingPermissions, setSavingPermissions] = useState(false)
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null)
  const [statusActionLoading, setStatusActionLoading] = useState(false)
  const [pendingSensitiveAction, setPendingSensitiveAction] = useState<
    | { type: 'archive'; title: string }
    | { type: 'restore'; title: string }
    | { type: 'trash'; title: string }
    | { type: 'untrash'; title: string }
    | { type: 'restore_version'; versionId: string; versionLabel: string; version?: number | null }
    | { type: 'permissions'; title: string; entries: AdminDocPermissionInput[] }
    | null
  >(null)

  const loadDetail = useCallback(async () => {
    if (!documentId) {
      return
    }

    setLoading(true)
    setError(null)
    setActionMessage(null)
    setActionError(null)

    try {
      const response = await getAdminDocDetail(documentId)
      setData(response)
      setPermissionDrafts(toPermissionDrafts(response))
    } catch (detailError: unknown) {
      setError(getErrorMessage(detailError, '加载文档详情失败'))
    } finally {
      setLoading(false)
    }
  }, [documentId])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  const handleRestore = async (versionIndex: number) => {
    if (!documentId || !data) {
      return
    }
    const version = data.recent_versions[versionIndex]
    if (!version) {
      return
    }

    setPendingSensitiveAction({
      type: 'restore_version',
      versionId: version.id,
      version: version.version,
      versionLabel: version.version ? `v${version.version}` : '未编号快照',
    })
  }

  const handlePermissionFieldChange = (
    localId: string,
    patch: Partial<DocManagementPermissionDraft>
  ) => {
    setPermissionDrafts((previous) =>
      previous.map((item) => (item.local_id === localId ? { ...item, ...patch } : item))
    )
  }

  const handleAddPermission = () => {
    setPermissionDrafts((previous) => [
      ...previous,
      {
        local_id: createLocalId(),
        subject_type: 'user',
        subject_id: '',
        permission: 'viewer',
        is_active: true,
      },
    ])
  }

  const handleRemovePermission = (localId: string) => {
    setPermissionDrafts((previous) => previous.filter((item) => item.local_id !== localId))
  }

  const handleSavePermissions = () => {
    if (!documentId) {
      return
    }

    const normalizedEntries: AdminDocPermissionInput[] = permissionDrafts.map((item) => ({
      subject_type: item.subject_type,
      subject_id: item.subject_id.trim(),
      permission: item.permission,
      is_active: Boolean(item.is_active),
    }))

    if (normalizedEntries.some((item) => !item.subject_id)) {
      setActionError('权限项 subject_id 不能为空')
      return
    }

    setActionMessage(null)
    setActionError(null)
    setPendingSensitiveAction({
      type: 'permissions',
      title: data?.document.title || documentId,
      entries: normalizedEntries,
    })
  }

  const handleArchiveStatus = async () => {
    if (!documentId || !data || statusActionLoading) {
      return
    }
    setPendingSensitiveAction({ type: 'archive', title: data.document.title })
  }

  const handleRestoreStatus = async () => {
    if (!documentId || !data || statusActionLoading) {
      return
    }
    setPendingSensitiveAction({ type: 'restore', title: data.document.title })
  }

  const handleTrashStatus = async () => {
    if (!documentId || !data || statusActionLoading) {
      return
    }
    setPendingSensitiveAction({ type: 'trash', title: data.document.title })
  }

  const handleUntrashStatus = async () => {
    if (!documentId || !data || statusActionLoading) {
      return
    }
    setPendingSensitiveAction({ type: 'untrash', title: data.document.title })
  }

  const handleConfirmSensitiveAction = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingSensitiveAction || !documentId) {
      return
    }
    setActionMessage(null)
    setActionError(null)
    if (pendingSensitiveAction.type === 'permissions') {
      setSavingPermissions(true)
    } else {
      setStatusActionLoading(true)
    }
    try {
      if (pendingSensitiveAction.type === 'archive') {
        const response = await archiveAdminDoc(documentId, payload)
        setActionMessage(response.message || '文档归档成功')
      } else if (pendingSensitiveAction.type === 'restore') {
        const response = await restoreAdminDocStatus(documentId, payload)
        setActionMessage(response.message || '文档恢复成功')
      } else if (pendingSensitiveAction.type === 'trash') {
        const response = await trashAdminDoc(documentId, payload)
        setActionMessage(response.message || '文档已逻辑删除')
      } else if (pendingSensitiveAction.type === 'untrash') {
        const response = await untrashAdminDoc(documentId, payload)
        setActionMessage(response.message || '文档已从回收站恢复')
      } else if (pendingSensitiveAction.type === 'permissions') {
        const response = await updateAdminDocPermissions(
          documentId,
          pendingSensitiveAction.entries,
          payload
        )
        setActionMessage(response.message || '权限覆盖已更新')
      } else {
        setRestoringVersionId(pendingSensitiveAction.versionId)
        const response = await restoreAdminDocRevision(documentId, {
          version: pendingSensitiveAction.version ?? undefined,
          versionId: pendingSensitiveAction.versionId,
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        setActionMessage(response.message || `已恢复到 ${pendingSensitiveAction.versionLabel}`)
      }
      setPendingSensitiveAction(null)
      await loadDetail()
    } catch (statusError: unknown) {
      setActionError(getErrorMessage(statusError, '文档治理失败'))
    } finally {
      setStatusActionLoading(false)
      setSavingPermissions(false)
      setRestoringVersionId(null)
    }
  }

  const getSensitiveDialogConfig = () => {
    if (!pendingSensitiveAction) {
      return null
    }
    if (pendingSensitiveAction.type === 'archive') {
      return {
        title: '归档文档',
        targetLabel: pendingSensitiveAction.title,
        impact: '该操作会归档当前文档，不会影响客户端其他数据。',
        confirmText: '归档',
      }
    }
    if (pendingSensitiveAction.type === 'permissions') {
      return {
        title: '更新文档权限覆盖',
        targetLabel: pendingSensitiveAction.title,
        impact: '该操作会覆盖当前文档后台权限条目，可能改变用户对文档的可见和编辑能力。',
        confirmText: '更新权限',
      }
    }
    if (pendingSensitiveAction.type === 'restore') {
      return {
        title: '恢复文档',
        targetLabel: pendingSensitiveAction.title,
        impact: '该操作会恢复当前文档，不会影响客户端其他数据。',
        confirmText: '恢复',
      }
    }
    if (pendingSensitiveAction.type === 'trash') {
      return {
        title: '逻辑删除文档',
        targetLabel: pendingSensitiveAction.title,
        impact: '该操作会将当前文档移入回收站，文档将不可编辑、不可分享，可从回收站恢复。',
        confirmText: '逻辑删除',
      }
    }
    if (pendingSensitiveAction.type === 'untrash') {
      return {
        title: '从回收站恢复文档',
        targetLabel: pendingSensitiveAction.title,
        impact: '该操作会将当前文档从回收站恢复到删除前状态。',
        confirmText: '恢复',
      }
    }
    return {
      title: '恢复文档版本',
      targetLabel: pendingSensitiveAction.versionLabel,
      impact: '该操作会将文档回滚到指定历史版本，并覆盖当前最新内容。',
      confirmText: '恢复版本',
    }
  }

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div>
          <h1 className="text-title font-semibold">文档详情</h1>
        </div>
        <div className="flex items-center gap-2">
          {data ? (
            data.document.is_trashed ? (
              <PermissionGate permission={ADMIN_PERMISSION.DOC_RESTORE}>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleUntrashStatus()}
                  disabled={statusActionLoading}
                >
                  {statusActionLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="mr-2 h-4 w-4" />
                  )}
                  回收站恢复
                </Button>
              </PermissionGate>
            ) : (
              <>
                {data.document.status === 'active' ? (
                  <PermissionGate permission={ADMIN_PERMISSION.DOC_DELETE}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleArchiveStatus()}
                      disabled={statusActionLoading}
                    >
                      {statusActionLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Archive className="mr-2 h-4 w-4" />
                      )}
                      归档文档
                    </Button>
                  </PermissionGate>
                ) : (
                  <PermissionGate permission={ADMIN_PERMISSION.DOC_RESTORE}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleRestoreStatus()}
                      disabled={statusActionLoading}
                    >
                      {statusActionLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RotateCcw className="mr-2 h-4 w-4" />
                      )}
                      恢复文档
                    </Button>
                  </PermissionGate>
                )}
                <PermissionGate permission={ADMIN_PERMISSION.DOC_DELETE}>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void handleTrashStatus()}
                    disabled={statusActionLoading}
                  >
                    {statusActionLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Archive className="mr-2 h-4 w-4" />
                    )}
                    逻辑删除
                  </Button>
                </PermissionGate>
              </>
            )
          ) : null}
          <Button size="sm" variant="outline" onClick={() => navigate('/docs')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回列表
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-muted/5 p-4">
        {loading && (
          <div className="rounded-md border bg-background px-3 py-8 text-center text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载详情中...
            </span>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && data && (
          <div className="space-y-4">
            <div className="rounded-md border bg-background p-4">
              <div className="flex items-center gap-2">
                <h2 className="text-subtitle font-semibold">{data.document.title}</h2>
                <Badge
                  variant={
                    data.document.is_trashed
                      ? 'destructive'
                      : data.document.status === 'active'
                        ? 'success'
                        : 'outline'
                  }
                >
                  {data.document.is_trashed
                    ? '逻辑删除'
                    : data.document.status === 'active'
                      ? '活跃'
                      : '已归档'}
                </Badge>
              </div>
              {data.document.is_trashed ? (
                <div className="mt-2 text-body text-muted-foreground">
                  删除时间：{formatDateTime(data.document.trashed_at)}
                </div>
              ) : null}
              <div className="mt-2 text-body text-muted-foreground">ID: {data.document.id}</div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-body text-muted-foreground">组织</div>
                <div className="mt-1 text-body font-medium">
                  {data.document.organization_name || data.document.organization_id}
                </div>
              </div>
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-body text-muted-foreground">项目</div>
                <div className="mt-1 text-body font-medium">
                  {data.document.space_name || data.document.space_id}
                </div>
              </div>
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-body text-muted-foreground">当前版本</div>
                <div className="mt-1 text-body font-medium">v{data.document.latest_version}</div>
              </div>
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-body text-muted-foreground">更新时间</div>
                <div className="mt-1 text-body font-medium">
                  {formatDateTime(data.document.updated_at)}
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-body text-muted-foreground">版本快照总数</div>
                <div className="mt-1 text-body font-medium">{data.stats.total_versions}</div>
              </div>
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-body text-muted-foreground">权限覆盖总数</div>
                <div className="mt-1 text-body font-medium">
                  {data.stats.total_permission_overrides}
                </div>
              </div>
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-body text-muted-foreground">激活权限覆盖</div>
                <div className="mt-1 text-body font-medium">
                  {data.stats.active_permission_overrides}
                </div>
              </div>
            </div>

            <div className="rounded-md border bg-background p-4">
              <div className="mb-2 text-body font-medium">内容预览（纯文本）</div>
              <div className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-body text-muted-foreground">
                {data.content_plaintext || '暂无内容'}
              </div>
            </div>

            <div className="rounded-md border bg-background p-4">
              <div className="mb-3 text-body font-medium">版本历史</div>
              {data.recent_versions.length === 0 ? (
                <div className="text-body text-muted-foreground">暂无版本</div>
              ) : (
                <div className="space-y-2">
                  {data.recent_versions.map((version, index) => (
                    <div key={version.id} className="rounded border px-3 py-2 text-body">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          {version.version ? `v${version.version}` : '未编号快照'}
                        </span>
                        <span className="text-muted-foreground">
                          {formatDateTime(version.last_saved_at || version.created_at)}
                        </span>
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        创建人：{version.created_by_name || version.created_by_id || '—'}
                      </div>
                      <div className="mt-2">
                        <PermissionGate permission={ADMIN_PERMISSION.DOC_RESTORE}>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              restoringVersionId !== null ||
                              data.document.is_trashed ||
                              (version.version !== null &&
                                version.version !== undefined &&
                                data.document.latest_version === version.version)
                            }
                            onClick={() => void handleRestore(index)}
                          >
                            {restoringVersionId === version.id ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCcw className="mr-1 h-3 w-3" />
                            )}
                            恢复到此版本
                          </Button>
                        </PermissionGate>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-md border bg-background p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-body font-medium">权限覆盖</div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={handleAddPermission}>
                    新增权限项
                  </Button>
                  <PermissionGate permission={ADMIN_PERMISSION.DOC_PERMISSION_UPDATE}>
                    <Button size="sm" onClick={handleSavePermissions} disabled={savingPermissions}>
                      {savingPermissions ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Save className="mr-1 h-3 w-3" />
                      )}
                      保存权限
                    </Button>
                  </PermissionGate>
                </div>
              </div>

              {permissionDrafts.length === 0 ? (
                <div className="text-body text-muted-foreground">
                  当前无文档级权限覆盖（默认继承项目权限）
                </div>
              ) : (
                <div className="space-y-2">
                  {permissionDrafts.map((item) => (
                    <div
                      key={item.local_id}
                      className="grid gap-2 rounded border p-2 md:grid-cols-[120px_1fr_120px_120px_auto]"
                    >
                      <Select
                        value={item.subject_type}
                        onValueChange={(value) =>
                          handlePermissionFieldChange(item.local_id, {
                            subject_type: value === 'role' ? 'role' : 'user',
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="主体类型" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="user">user</SelectItem>
                          <SelectItem value="role">role</SelectItem>
                        </SelectContent>
                      </Select>

                      <Input
                        placeholder={
                          item.subject_type === 'role' ? 'owner/admin/editor/viewer' : '用户 ID'
                        }
                        value={item.subject_id}
                        onChange={(event) =>
                          handlePermissionFieldChange(item.local_id, {
                            subject_id: event.target.value,
                          })
                        }
                      />

                      <Select
                        value={item.permission}
                        onValueChange={(value) =>
                          handlePermissionFieldChange(item.local_id, {
                            permission:
                              value === 'admin'
                                ? 'admin'
                                : value === 'editor'
                                  ? 'editor'
                                  : 'viewer',
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="权限" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="viewer">viewer</SelectItem>
                          <SelectItem value="editor">editor</SelectItem>
                          <SelectItem value="admin">admin</SelectItem>
                        </SelectContent>
                      </Select>

                      <Select
                        value={item.is_active ? 'active' : 'inactive'}
                        onValueChange={(value) =>
                          handlePermissionFieldChange(item.local_id, {
                            is_active: value === 'active',
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="状态" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">active</SelectItem>
                          <SelectItem value="inactive">inactive</SelectItem>
                        </SelectContent>
                      </Select>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRemovePermission(item.local_id)}
                      >
                        删除
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {actionError ? (
              <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
                {actionError}
              </div>
            ) : null}

            {actionMessage ? (
              <div className="rounded border border-success/30 bg-success/10 px-3 py-2 text-body text-success">
                {actionMessage}
              </div>
            ) : null}
          </div>
        )}
      </div>
      <SensitiveActionConfirmDialog
        open={Boolean(pendingSensitiveAction)}
        title={getSensitiveDialogConfig()?.title ?? ''}
        targetLabel={getSensitiveDialogConfig()?.targetLabel ?? ''}
        impact={getSensitiveDialogConfig()?.impact ?? ''}
        confirmText={getSensitiveDialogConfig()?.confirmText}
        loading={statusActionLoading || restoringVersionId !== null}
        onCancel={() => setPendingSensitiveAction(null)}
        onConfirm={(payload) => void handleConfirmSensitiveAction(payload)}
      />
    </div>
  )
}
