import { EntityLink } from '@/components/admin/EntityLink'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PageSizeSelect } from '@/components/ui/pagination'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  archiveAdminDoc,
  batchArchiveDocs,
  batchRestoreDocs,
  batchTrashDocs,
  batchUntrashDocs,
  getAdminDocDetail,
  getAdminDocs,
  restoreAdminDocRevision,
  restoreAdminDocStatus,
  trashAdminDoc,
  untrashAdminDoc,
} from '@/doc-management/api/doc-management'
import type {
  AdminDocBatchMutationResponse,
  AdminDocDetailResponse,
  AdminDocListResponse,
  DocStatusFilter,
} from '@/doc-management/types'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import {
  Archive,
  Copy,
  FileText,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

function buildBatchResultMessage(response: AdminDocBatchMutationResponse): string {
  if (!response.skipped.length) {
    return response.message
  }
  const preview = response.skipped
    .slice(0, 3)
    .map((item) => `${item.document_id}: ${item.reason}`)
    .join('；')
  return `${response.message}。示例跳过原因：${preview}`
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function compactId(value?: string | null, start = 8, end = 4): string {
  if (!value) return '—'
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
}

function CompactMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number | string | undefined
  icon: ComponentType<{ className?: string }>
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-background px-4 py-3">
      <div>
        <div className="text-caption text-muted-foreground">{label}</div>
        <div className="mt-1 text-title font-semibold tabular-nums">{value ?? 0}</div>
      </div>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </div>
  )
}

function EmptyNote({ children = '暂无记录' }: { children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
      {children}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[320px] break-words text-right">{value || '—'}</span>
    </div>
  )
}

function getStatusLabel(status: string) {
  if (status === 'active') return '活跃'
  if (status === 'archived') return '已归档'
  if (status === 'trashed') return '逻辑删除'
  return status || '—'
}

const statusOptions: Array<{ value: DocStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '活跃' },
  { value: 'archived', label: '已归档' },
  { value: 'trashed', label: '逻辑删除' },
]

type PermissionOverrideFilter = 'all' | 'yes' | 'no'

type PendingDocSensitiveAction =
  | { type: 'batch_archive'; documentIds: string[] }
  | { type: 'batch_restore'; documentIds: string[] }
  | { type: 'batch_trash'; documentIds: string[] }
  | { type: 'batch_untrash'; documentIds: string[] }
  | { type: 'single_archive'; documentId: string; title: string }
  | { type: 'single_restore'; documentId: string; title: string }
  | { type: 'single_trash'; documentId: string; title: string }
  | { type: 'single_untrash'; documentId: string; title: string }
  | { type: 'restore_version'; documentId: string; versionId: string; version?: number | null }

const permissionOverrideOptions: Array<{ value: PermissionOverrideFilter; label: string }> = [
  { value: 'all', label: '全部权限模式' },
  { value: 'yes', label: '有权限覆盖' },
  { value: 'no', label: '无权限覆盖' },
]

export function DocManagementPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialOrganizationId = searchParams.get('organization_id') || ''
  const initialSpaceId = searchParams.get('space_id') || ''
  const initialUpdatedById = searchParams.get('updated_by_id') || searchParams.get('user_id') || ''

  const [keywordInput, setKeywordInput] = useState('')
  const [organizationInput, setOrganizationInput] = useState(initialOrganizationId)
  const [spaceInput, setSpaceInput] = useState(initialSpaceId)
  const [updatedByInput, setUpdatedByInput] = useState(initialUpdatedById)

  const [keyword, setKeyword] = useState('')
  const [organizationId, setOrganizationId] = useState(initialOrganizationId)
  const [spaceId, setSpaceId] = useState(initialSpaceId)
  const [updatedById, setUpdatedById] = useState(initialUpdatedById)
  const [status, setStatus] = useState<DocStatusFilter>('all')
  const [hasPermissionOverride, setHasPermissionOverride] =
    useState<PermissionOverrideFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const [listData, setListData] = useState<AdminDocListResponse | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false)
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([])

  const [detail, setDetail] = useState<AdminDocDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [listActionLoading, setListActionLoading] = useState(false)
  const [listActionError, setListActionError] = useState<string | null>(null)
  const [listActionMessage, setListActionMessage] = useState<string | null>(null)

  const [detailActionLoading, setDetailActionLoading] = useState(false)
  const [detailActionError, setDetailActionError] = useState<string | null>(null)
  const [detailActionMessage, setDetailActionMessage] = useState<string | null>(null)
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null)
  const [pendingSensitiveAction, setPendingSensitiveAction] =
    useState<PendingDocSensitiveAction | null>(null)

  const loadDocs = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      const response = await getAdminDocs({
        keyword: keyword || undefined,
        status,
        organization_id: organizationId || undefined,
        space_id: spaceId || undefined,
        updated_by_id: updatedById || undefined,
        has_permission_override:
          hasPermissionOverride === 'all' ? undefined : hasPermissionOverride === 'yes',
        page,
        page_size: pageSize,
      })
      setListData(response)
    } catch (loadError: unknown) {
      setListError(getErrorMessage(loadError, '加载文档列表失败'))
    } finally {
      setListLoading(false)
    }
  }, [hasPermissionOverride, keyword, page, pageSize, spaceId, status, updatedById, organizationId])

  const loadDetail = useCallback(async (documentId: string) => {
    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await getAdminDocDetail(documentId)
      setDetail(response)
    } catch (loadError: unknown) {
      setDetailError(getErrorMessage(loadError, '加载文档详情失败'))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDocs()
  }, [loadDocs])

  useEffect(() => {
    if (!listData) {
      return
    }
    const currentIds = new Set(listData.items.map((item) => item.id))
    setSelectedDocumentIds((previous) => previous.filter((item) => currentIds.has(item)))
  }, [listData])

  useEffect(() => {
    if (!selectedDocumentId || !detailDrawerOpen) {
      setDetail(null)
      return
    }
    void loadDetail(selectedDocumentId)
  }, [detailDrawerOpen, loadDetail, selectedDocumentId])

  const selectedDocFromList = useMemo(
    () => listData?.items.find((item) => item.id === selectedDocumentId) ?? null,
    [listData?.items, selectedDocumentId]
  )

  const summary = listData?.summary
  const pagination = listData?.pagination

  const currentPageDocumentIds = useMemo(
    () => (listData?.items ?? []).map((item) => item.id),
    [listData?.items]
  )
  const selectedDocumentsOnPage = useMemo(
    () => (listData?.items ?? []).filter((item) => selectedDocumentIds.includes(item.id)),
    [listData?.items, selectedDocumentIds]
  )

  const selectedCount = selectedDocumentIds.length
  const selectedHasTrashed = selectedDocumentsOnPage.some((item) => item.is_trashed)
  const selectedAllTrashed =
    selectedDocumentsOnPage.length > 0 && selectedDocumentsOnPage.every((item) => item.is_trashed)
  const selectedOnPageCount = currentPageDocumentIds.filter((id) =>
    selectedDocumentIds.includes(id)
  ).length
  const allSelectedOnPage =
    currentPageDocumentIds.length > 0 && selectedOnPageCount === currentPageDocumentIds.length

  const hasPrevPage = Boolean(pagination && pagination.page > 1)
  const hasNextPage = Boolean(pagination && pagination.page < pagination.total_pages)

  const handleApplyFilters = () => {
    setPage(1)
    setKeyword(keywordInput.trim())
    setOrganizationId(organizationInput.trim())
    setSpaceId(spaceInput.trim())
    setUpdatedById(updatedByInput.trim())
  }

  const handleRefresh = () => {
    setListActionError(null)
    setListActionMessage(null)
    setDetailActionError(null)
    setDetailActionMessage(null)
    void loadDocs()
    if (selectedDocumentId && detailDrawerOpen) {
      void loadDetail(selectedDocumentId)
    }
  }

  const openDocumentDetail = (documentId: string) => {
    setSelectedDocumentId(documentId)
    setDetailDrawerOpen(true)
    setDetailActionError(null)
    setDetailActionMessage(null)
  }

  const copyDocumentId = async (documentId: string) => {
    try {
      await navigator.clipboard.writeText(documentId)
    } catch {
      setListActionError('复制文档 ID 失败')
    }
  }

  const toggleSelectAllOnPage = () => {
    if (allSelectedOnPage) {
      setSelectedDocumentIds((previous) =>
        previous.filter((id) => !currentPageDocumentIds.includes(id))
      )
      return
    }
    setSelectedDocumentIds((previous) => {
      const merged = new Set(previous)
      for (const id of currentPageDocumentIds) {
        merged.add(id)
      }
      return Array.from(merged)
    })
  }

  const toggleSelectDocument = (documentId: string) => {
    setSelectedDocumentIds((previous) => {
      if (previous.includes(documentId)) {
        return previous.filter((id) => id !== documentId)
      }
      return [...previous, documentId]
    })
  }

  const handleBatchArchive = async (dryRun: boolean) => {
    if (!selectedDocumentIds.length) {
      setListActionError('请先选择至少 1 篇文档')
      return
    }

    if (!dryRun) {
      setPendingSensitiveAction({ type: 'batch_archive', documentIds: [...selectedDocumentIds] })
      return
    }

    setListActionLoading(true)
    setListActionError(null)
    setListActionMessage(null)
    try {
      const response = await batchArchiveDocs(selectedDocumentIds, { dryRun: true })
      setListActionMessage(buildBatchResultMessage(response))
      if (!dryRun) {
        setSelectedDocumentIds([])
      }
      await loadDocs()
      if (selectedDocumentId && detailDrawerOpen) {
        await loadDetail(selectedDocumentId)
      }
    } catch (actionError: unknown) {
      setListActionError(getErrorMessage(actionError, '批量归档失败'))
    } finally {
      setListActionLoading(false)
    }
  }

  const handleBatchRestore = async () => {
    if (!selectedDocumentIds.length) {
      setListActionError('请先选择至少 1 篇文档')
      return
    }
    setPendingSensitiveAction({ type: 'batch_restore', documentIds: [...selectedDocumentIds] })
  }

  const handleBatchTrash = async (dryRun: boolean) => {
    if (!selectedDocumentIds.length) {
      setListActionError('请先选择至少 1 篇文档')
      return
    }

    if (!dryRun) {
      setPendingSensitiveAction({ type: 'batch_trash', documentIds: [...selectedDocumentIds] })
      return
    }

    setListActionLoading(true)
    setListActionError(null)
    setListActionMessage(null)
    try {
      const response = await batchTrashDocs(selectedDocumentIds, { dryRun: true })
      setListActionMessage(buildBatchResultMessage(response))
      await loadDocs()
    } catch (actionError: unknown) {
      setListActionError(getErrorMessage(actionError, '批量逻辑删除失败'))
    } finally {
      setListActionLoading(false)
    }
  }

  const handleBatchUntrash = async () => {
    if (!selectedDocumentIds.length) {
      setListActionError('请先选择至少 1 篇文档')
      return
    }
    setPendingSensitiveAction({ type: 'batch_untrash', documentIds: [...selectedDocumentIds] })
  }

  const handleStatusAction = async (action: 'archive' | 'restore' | 'trash' | 'untrash') => {
    if (!selectedDocumentId || !detail) {
      return
    }

    const type =
      action === 'archive'
        ? 'single_archive'
        : action === 'restore'
          ? 'single_restore'
          : action === 'trash'
            ? 'single_trash'
            : 'single_untrash'

    setPendingSensitiveAction({
      type,
      documentId: selectedDocumentId,
      title: detail.document.title,
    })
  }

  const handleRestoreVersion = async (versionId: string, version?: number | null) => {
    if (!selectedDocumentId) {
      return
    }
    setPendingSensitiveAction({
      type: 'restore_version',
      documentId: selectedDocumentId,
      versionId,
      version,
    })
  }

  const handleConfirmSensitiveAction = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingSensitiveAction) {
      return
    }
    setListActionError(null)
    setListActionMessage(null)
    setDetailActionError(null)
    setDetailActionMessage(null)

    try {
      if (pendingSensitiveAction.type === 'batch_archive') {
        setListActionLoading(true)
        const response = await batchArchiveDocs(pendingSensitiveAction.documentIds, {
          dryRun: false,
          sensitive: payload,
        })
        setListActionMessage(buildBatchResultMessage(response))
        setSelectedDocumentIds([])
      } else if (pendingSensitiveAction.type === 'batch_restore') {
        setListActionLoading(true)
        const response = await batchRestoreDocs(pendingSensitiveAction.documentIds, {
          dryRun: false,
          sensitive: payload,
        })
        setListActionMessage(buildBatchResultMessage(response))
        setSelectedDocumentIds([])
      } else if (pendingSensitiveAction.type === 'batch_trash') {
        setListActionLoading(true)
        const response = await batchTrashDocs(pendingSensitiveAction.documentIds, {
          dryRun: false,
          sensitive: payload,
        })
        setListActionMessage(buildBatchResultMessage(response))
        setSelectedDocumentIds([])
      } else if (pendingSensitiveAction.type === 'batch_untrash') {
        setListActionLoading(true)
        const response = await batchUntrashDocs(pendingSensitiveAction.documentIds, {
          dryRun: false,
          sensitive: payload,
        })
        setListActionMessage(buildBatchResultMessage(response))
        setSelectedDocumentIds([])
      } else if (pendingSensitiveAction.type === 'single_archive') {
        setDetailActionLoading(true)
        const response = await archiveAdminDoc(pendingSensitiveAction.documentId, payload)
        setDetailActionMessage(response.message)
      } else if (pendingSensitiveAction.type === 'single_restore') {
        setDetailActionLoading(true)
        const response = await restoreAdminDocStatus(pendingSensitiveAction.documentId, payload)
        setDetailActionMessage(response.message)
      } else if (pendingSensitiveAction.type === 'single_trash') {
        setDetailActionLoading(true)
        const response = await trashAdminDoc(pendingSensitiveAction.documentId, payload)
        setDetailActionMessage(response.message)
      } else if (pendingSensitiveAction.type === 'single_untrash') {
        setDetailActionLoading(true)
        const response = await untrashAdminDoc(pendingSensitiveAction.documentId, payload)
        setDetailActionMessage(response.message)
      } else {
        setRestoringVersionId(pendingSensitiveAction.versionId)
        const response = await restoreAdminDocRevision(pendingSensitiveAction.documentId, {
          version: pendingSensitiveAction.version ?? undefined,
          versionId: pendingSensitiveAction.versionId,
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        setDetailActionMessage(response.message || '版本恢复成功')
      }

      const currentSelectedId =
        pendingSensitiveAction.type === 'batch_archive' ||
        pendingSensitiveAction.type === 'batch_restore' ||
        pendingSensitiveAction.type === 'batch_trash' ||
        pendingSensitiveAction.type === 'batch_untrash'
          ? selectedDocumentId
          : pendingSensitiveAction.documentId
      await loadDocs()
      if (currentSelectedId && detailDrawerOpen) {
        await loadDetail(currentSelectedId)
      }
      setPendingSensitiveAction(null)
    } catch (actionError: unknown) {
      const message = getErrorMessage(actionError, '治理操作失败')
      if (
        pendingSensitiveAction.type === 'batch_archive' ||
        pendingSensitiveAction.type === 'batch_restore' ||
        pendingSensitiveAction.type === 'batch_trash' ||
        pendingSensitiveAction.type === 'batch_untrash'
      ) {
        setListActionError(message)
      } else {
        setDetailActionError(message)
      }
    } finally {
      setListActionLoading(false)
      setDetailActionLoading(false)
      setRestoringVersionId(null)
    }
  }

  const getSensitiveDialogConfig = () => {
    if (!pendingSensitiveAction) {
      return null
    }
    if (pendingSensitiveAction.type === 'batch_archive') {
      const count = pendingSensitiveAction.documentIds.length
      return {
        title: '批量归档文档',
        targetLabel: `共 ${count} 篇文档`,
        impact: `该操作会影响当前选中的 ${count} 篇文档，将其标记为归档状态，不会影响客户端其他数据。`,
        confirmText: '归档',
      }
    }
    if (pendingSensitiveAction.type === 'batch_restore') {
      const count = pendingSensitiveAction.documentIds.length
      return {
        title: '批量恢复文档',
        targetLabel: `共 ${count} 篇文档`,
        impact: `该操作会影响当前选中的 ${count} 篇文档，将其恢复为可用状态，不会影响客户端其他数据。`,
        confirmText: '恢复',
      }
    }
    if (pendingSensitiveAction.type === 'batch_trash') {
      const count = pendingSensitiveAction.documentIds.length
      return {
        title: '批量逻辑删除文档',
        targetLabel: `共 ${count} 篇文档`,
        impact: `该操作会将当前选中的 ${count} 篇文档移入回收站，文档将不可编辑、不可分享，可从回收站恢复。`,
        confirmText: '逻辑删除',
      }
    }
    if (pendingSensitiveAction.type === 'batch_untrash') {
      const count = pendingSensitiveAction.documentIds.length
      return {
        title: '批量从回收站恢复文档',
        targetLabel: `共 ${count} 篇文档`,
        impact: `该操作会将当前选中的 ${count} 篇文档从回收站恢复到删除前状态。`,
        confirmText: '恢复',
      }
    }
    if (pendingSensitiveAction.type === 'single_archive') {
      return {
        title: '归档文档',
        targetLabel: pendingSensitiveAction.title,
        impact: '该操作会归档当前文档，不会影响客户端其他数据。',
        confirmText: '归档',
      }
    }
    if (pendingSensitiveAction.type === 'single_restore') {
      return {
        title: '恢复文档',
        targetLabel: pendingSensitiveAction.title,
        impact: '该操作会恢复当前文档，不会影响客户端其他数据。',
        confirmText: '恢复',
      }
    }
    if (pendingSensitiveAction.type === 'single_trash') {
      return {
        title: '逻辑删除文档',
        targetLabel: pendingSensitiveAction.title,
        impact: '该操作会将当前文档移入回收站，文档将不可编辑、不可分享，可从回收站恢复。',
        confirmText: '逻辑删除',
      }
    }
    if (pendingSensitiveAction.type === 'single_untrash') {
      return {
        title: '从回收站恢复文档',
        targetLabel: pendingSensitiveAction.title,
        impact: '该操作会将当前文档从回收站恢复到删除前状态。',
        confirmText: '恢复',
      }
    }
    return {
      title: '恢复文档版本',
      targetLabel:
        pendingSensitiveAction.version === null || pendingSensitiveAction.version === undefined
          ? `版本 ID: ${pendingSensitiveAction.versionId}`
          : `版本 v${pendingSensitiveAction.version}`,
      impact: '该操作会将文档内容回滚到指定版本，并覆盖当前最新内容。',
      confirmText: '恢复版本',
    }
  }

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div>
          <h1 className="text-title font-semibold">文档</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => navigate('/docs/operations')}>
            任务
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            disabled={listLoading || detailLoading}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 border-b bg-muted/5 px-6 py-3 lg:grid-cols-4">
        <CompactMetric label="总文档" value={summary?.total_documents} icon={FileText} />
        <CompactMetric label="活跃文档" value={summary?.active_documents} icon={FileText} />
        <CompactMetric
          label="权限风险"
          value={summary?.documents_with_permission_overrides}
          icon={Archive}
        />
        <CompactMetric label="逻辑删除" value={summary?.trashed_documents} icon={RotateCcw} />
      </div>

      <div className="space-y-3 border-b bg-muted/10 px-6 py-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,2fr)_160px_160px_1fr_1fr_auto_auto]">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="文档 ID / 标题 / Organization"
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleApplyFilters()
                }
              }}
            />
          </div>

          <Select
            value={status}
            onValueChange={(value) => {
              setPage(1)
              setStatus(value as DocStatusFilter)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="状态" />
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={hasPermissionOverride}
            onValueChange={(value) => {
              setPage(1)
              setHasPermissionOverride(value as PermissionOverrideFilter)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="权限风险" />
            </SelectTrigger>
            <SelectContent>
              {permissionOverrideOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            placeholder="organization_id"
            value={organizationInput}
            onChange={(event) => setOrganizationInput(event.target.value)}
          />
          <Input
            placeholder="更新人 ID"
            value={updatedByInput}
            onChange={(event) => setUpdatedByInput(event.target.value)}
          />
          <Button size="sm" onClick={handleApplyFilters}>
            查询
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setKeywordInput('')
              setOrganizationInput('')
              setSpaceInput('')
              setUpdatedByInput('')
              setKeyword('')
              setOrganizationId('')
              setSpaceId('')
              setUpdatedById('')
              setStatus('all')
              setHasPermissionOverride('all')
              setPage(1)
            }}
          >
            重置
          </Button>
        </div>
        <div className="flex items-center justify-between text-body text-muted-foreground">
          <span>共 {pagination?.total ?? 0} 条结果</span>
          <Input
            className="h-8 max-w-[220px]"
            placeholder="space_id（可选）"
            value={spaceInput}
            onChange={(event) => setSpaceInput(event.target.value)}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-muted/5 p-4">
        <div className="rounded-md border bg-background">
          {selectedCount > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b bg-warning/10 px-3 py-2 text-body">
              <span className="font-medium text-warning">已选择 {selectedCount} 篇</span>
              <PermissionGate permission={ADMIN_PERMISSION.DOC_DELETE}>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  disabled={listActionLoading || listLoading || selectedHasTrashed}
                  onClick={() => void handleBatchArchive(true)}
                >
                  模拟归档
                </Button>
              </PermissionGate>
              <PermissionGate permission={ADMIN_PERMISSION.DOC_DELETE}>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  disabled={listActionLoading || listLoading || selectedHasTrashed}
                  onClick={() => void handleBatchArchive(false)}
                >
                  批量归档
                </Button>
              </PermissionGate>
              <PermissionGate permission={ADMIN_PERMISSION.DOC_RESTORE}>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  disabled={listActionLoading || listLoading || selectedHasTrashed}
                  onClick={() => void handleBatchRestore()}
                >
                  批量恢复
                </Button>
              </PermissionGate>
              <PermissionGate permission={ADMIN_PERMISSION.DOC_DELETE}>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  disabled={listActionLoading || listLoading || selectedHasTrashed}
                  onClick={() => void handleBatchTrash(true)}
                >
                  模拟逻辑删除
                </Button>
              </PermissionGate>
              <PermissionGate permission={ADMIN_PERMISSION.DOC_DELETE}>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 px-2"
                  disabled={listActionLoading || listLoading || selectedHasTrashed}
                  onClick={() => void handleBatchTrash(false)}
                >
                  批量逻辑删除
                </Button>
              </PermissionGate>
              <PermissionGate permission={ADMIN_PERMISSION.DOC_RESTORE}>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  disabled={listActionLoading || listLoading || !selectedAllTrashed}
                  onClick={() => void handleBatchUntrash()}
                >
                  回收站恢复
                </Button>
              </PermissionGate>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                disabled={listActionLoading || listLoading}
                onClick={() => setSelectedDocumentIds([])}
              >
                清除
              </Button>
            </div>
          ) : null}

          {listActionMessage ? (
            <div className="border-b border-success/30 bg-success/10 px-3 py-2 text-body text-success">
              {listActionMessage}
            </div>
          ) : null}
          {listActionError ? (
            <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
              {listActionError}
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <table className="min-w-full text-body">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-2 text-left font-medium">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={allSelectedOnPage}
                      onChange={toggleSelectAllOnPage}
                      aria-label="全选当前页文档"
                    />
                  </th>
                  <th className="px-4 py-2 text-left font-medium">文档</th>
                  <th className="px-4 py-2 text-left font-medium">Organization</th>
                  <th className="px-4 py-2 text-left font-medium">状态</th>
                  <th className="px-4 py-2 text-left font-medium">权限风险</th>
                  <th className="px-4 py-2 text-left font-medium">版本</th>
                  <th className="px-4 py-2 text-left font-medium">更新时间</th>
                  <th className="px-4 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {listLoading ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                      加载中...
                    </td>
                  </tr>
                ) : listError ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-destructive">
                      {listError}
                    </td>
                  </tr>
                ) : listData?.items.length ? (
                  listData.items.map((item) => {
                    const isChecked = selectedDocumentIds.includes(item.id)
                    const hasRisk = item.permission_override_count > 0
                    return (
                      <tr
                        key={item.id}
                        className="h-16 cursor-pointer hover:bg-muted/30"
                        tabIndex={0}
                        onClick={() => openDocumentDetail(item.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            openDocumentDetail(item.id)
                          }
                        }}
                      >
                        <td className="px-4 py-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-primary"
                            checked={isChecked}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => toggleSelectDocument(item.id)}
                            aria-label={`选择文档 ${item.title}`}
                          />
                        </td>
                        <td className="max-w-[320px] px-4 py-2">
                          <div className="flex items-center gap-2 font-medium">
                            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="truncate">{item.title}</span>
                          </div>
                          <button
                            type="button"
                            className="mt-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation()
                              void copyDocumentId(item.id)
                            }}
                          >
                            {compactId(item.id)}
                            <Copy className="h-3 w-3" />
                          </button>
                        </td>
                        <td className="max-w-[220px] px-4 py-2 text-muted-foreground">
                          <div className="truncate">
                            <EntityLink
                              type="organization"
                              id={item.organization_id}
                              label={item.organization_name || item.organization_id}
                            />
                          </div>
                          <div className="mt-1 truncate text-caption">
                            <EntityLink
                              type="space"
                              id={item.space_id}
                              label={item.space_name || item.space_id}
                            />
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <Badge
                            variant={
                              item.is_trashed
                                ? 'destructive'
                                : item.status === 'active'
                                  ? 'success'
                                  : 'outline'
                            }
                          >
                            {item.is_trashed ? '逻辑删除' : getStatusLabel(item.status)}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={hasRisk ? 'warning' : 'outline'}>
                            {hasRisk ? `${item.permission_override_count} 项` : '无'}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <div>v{item.latest_version}</div>
                          <div className="mt-1 text-caption text-muted-foreground">
                            {item.version_count} 快照
                          </div>
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {formatDateTime(item.updated_at)}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(event) => {
                                event.stopPropagation()
                                openDocumentDetail(item.id)
                              }}
                            >
                              详情
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              onClick={(event) => {
                                event.stopPropagation()
                                openDocumentDetail(item.id)
                              }}
                              aria-label="更多"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                ) : (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                      暂无文档
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t px-4 py-2 text-body text-muted-foreground">
            <span>
              页码 {pagination?.page ?? 0}/{pagination?.total_pages ?? 0}
            </span>
            <div className="flex items-center gap-2">
              <PageSizeSelect
                value={pageSize}
                onChange={(nextPageSize) => {
                  setPageSize(nextPageSize)
                  setPage(1)
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!hasPrevPage || listLoading}
                onClick={() => setPage((previous) => Math.max(previous - 1, 1))}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!hasNextPage || listLoading}
                onClick={() =>
                  setPage((previous) =>
                    pagination
                      ? Math.min(previous + 1, pagination.total_pages || previous + 1)
                      : previous + 1
                  )
                }
              >
                下一页
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={detailDrawerOpen}
        onOpenChange={(open) => {
          setDetailDrawerOpen(open)
          if (!open) {
            setSelectedDocumentId(null)
          }
        }}
      >
        <DialogContent className="left-auto right-0 top-0 h-screen max-w-[620px] translate-x-0 translate-y-0 grid-rows-[auto_1fr] gap-0 rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-5 py-4">
            <div className="flex items-start justify-between gap-4 pr-8">
              <div className="min-w-0">
                <DialogTitle className="truncate">
                  {detail?.document.title || selectedDocFromList?.title || '文档详情'}
                </DialogTitle>
                <div className="mt-1 text-body text-muted-foreground">
                  {selectedDocumentId ? compactId(selectedDocumentId, 10, 6) : '—'}
                </div>
              </div>
              {selectedDocumentId ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(`/docs/${selectedDocumentId}`)}
                >
                  完整详情
                </Button>
              ) : null}
            </div>
          </DialogHeader>

          <ScrollArea className="min-h-0">
            <div className="p-5">
              {detailLoading ? (
                <div className="flex min-h-[360px] items-center justify-center text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载中...
                </div>
              ) : detailError ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
                  {detailError}
                </div>
              ) : detail ? (
                <Tabs defaultValue="overview">
                  <TabsList className="grid w-full grid-cols-5">
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="permissions">权限</TabsTrigger>
                    <TabsTrigger value="versions">版本</TabsTrigger>
                    <TabsTrigger value="history">历史</TabsTrigger>
                    <TabsTrigger value="audit">审计</TabsTrigger>
                  </TabsList>

                  <TabsContent value="overview" className="space-y-4">
                    {detailActionMessage ? (
                      <div className="rounded border border-success/30 bg-success/10 px-3 py-2 text-body text-success">
                        {detailActionMessage}
                      </div>
                    ) : null}
                    {detailActionError ? (
                      <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
                        {detailActionError}
                      </div>
                    ) : null}
                    <div className="rounded-md border p-3">
                      <InfoRow
                        label="状态"
                        value={
                          <Badge
                            variant={
                              detail.document.is_trashed
                                ? 'destructive'
                                : detail.document.status === 'active'
                                  ? 'success'
                                  : 'outline'
                            }
                          >
                            {detail.document.is_trashed
                              ? '逻辑删除'
                              : getStatusLabel(detail.document.status)}
                          </Badge>
                        }
                      />
                      {detail.document.is_trashed ? (
                        <InfoRow
                          label="删除时间"
                          value={formatDateTime(detail.document.trashed_at)}
                        />
                      ) : null}
                      <InfoRow
                        label="Organization"
                        value={
                          <EntityLink
                            type="organization"
                            id={detail.document.organization_id}
                            label={detail.document.organization_name || detail.document.organization_id}
                          />
                        }
                      />
                      <InfoRow
                        label="Space"
                        value={
                          <EntityLink
                            type="space"
                            id={detail.document.space_id}
                            label={detail.document.space_name || detail.document.space_id}
                          />
                        }
                      />
                      <InfoRow label="最新版本" value={`v${detail.document.latest_version}`} />
                      <InfoRow
                        label="更新时间"
                        value={formatDateTime(detail.document.updated_at)}
                      />
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="mb-2 font-medium">操作</div>
                      <div className="flex flex-wrap gap-2">
                        {!detail.document.is_trashed ? (
                          <PermissionGate
                            permission={
                              detail.document.status === 'active'
                                ? ADMIN_PERMISSION.DOC_DELETE
                                : ADMIN_PERMISSION.DOC_RESTORE
                            }
                          >
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void handleStatusAction(
                                  detail.document.status === 'active' ? 'archive' : 'restore'
                                )
                              }
                              disabled={detailActionLoading}
                            >
                              {detailActionLoading ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : detail.document.status === 'active' ? (
                                <Archive className="mr-2 h-4 w-4" />
                              ) : (
                                <RotateCcw className="mr-2 h-4 w-4" />
                              )}
                              {detail.document.status === 'active' ? '归档' : '恢复'}
                            </Button>
                          </PermissionGate>
                        ) : null}
                        <PermissionGate
                          permission={
                            detail.document.is_trashed
                              ? ADMIN_PERMISSION.DOC_RESTORE
                              : ADMIN_PERMISSION.DOC_DELETE
                          }
                        >
                          <Button
                            size="sm"
                            variant={detail.document.is_trashed ? 'outline' : 'destructive'}
                            onClick={() =>
                              void handleStatusAction(
                                detail.document.is_trashed ? 'untrash' : 'trash'
                              )
                            }
                            disabled={detailActionLoading}
                          >
                            {detailActionLoading ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : detail.document.is_trashed ? (
                              <RotateCcw className="mr-2 h-4 w-4" />
                            ) : (
                              <Archive className="mr-2 h-4 w-4" />
                            )}
                            {detail.document.is_trashed ? '回收站恢复' : '逻辑删除'}
                          </Button>
                        </PermissionGate>
                      </div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="mb-2 font-medium">内容预览</div>
                      <div className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-body text-muted-foreground">
                        {detail.content_plaintext || '暂无内容'}
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="permissions">
                    {detail.permissions.length ? (
                      <div className="space-y-2">
                        {detail.permissions.slice(0, 12).map((permission) => (
                          <div
                            key={permission.id}
                            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-body"
                          >
                            <div className="min-w-0 truncate">
                              {permission.subject_type}:{permission.subject_id}
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline">{permission.permission}</Badge>
                              <Badge variant={permission.is_active ? 'success' : 'secondary'}>
                                {permission.is_active ? '启用' : '停用'}
                              </Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyNote>暂无记录</EmptyNote>
                    )}
                  </TabsContent>

                  <TabsContent value="versions">
                    {detail.recent_versions.length ? (
                      <div className="space-y-2">
                        {detail.recent_versions.slice(0, 10).map((version) => (
                          <div key={version.id} className="rounded-md border px-3 py-2 text-body">
                            <div className="flex items-center justify-between gap-3">
                              <div className="font-medium">
                                {version.version ? `v${version.version}` : compactId(version.id)}
                              </div>
                              <PermissionGate permission={ADMIN_PERMISSION.DOC_RESTORE}>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2"
                                  disabled={
                                    restoringVersionId !== null ||
                                    detail.document.is_trashed ||
                                    (version.version !== null &&
                                      version.version !== undefined &&
                                      version.version === detail.document.latest_version)
                                  }
                                  onClick={() =>
                                    void handleRestoreVersion(version.id, version.version)
                                  }
                                >
                                  {restoringVersionId === version.id ? (
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                  ) : (
                                    <RotateCcw className="mr-1 h-3 w-3" />
                                  )}
                                  恢复
                                </Button>
                              </PermissionGate>
                            </div>
                            <div className="mt-1 text-caption text-muted-foreground">
                              {formatDateTime(version.last_saved_at || version.created_at)} ·{' '}
                              {version.created_by_name || version.created_by_id || '—'}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyNote>暂无记录</EmptyNote>
                    )}
                  </TabsContent>

                  <TabsContent value="history">
                    <div className="rounded-md border p-3">
                      <InfoRow
                        label="创建时间"
                        value={formatDateTime(detail.document.created_at)}
                      />
                      <InfoRow
                        label="创建人"
                        value={
                          detail.document.created_by_id ? (
                            <EntityLink
                              type="user"
                              id={detail.document.created_by_id}
                              label={
                                detail.document.created_by_name || detail.document.created_by_id
                              }
                            />
                          ) : (
                            '—'
                          )
                        }
                      />
                      <InfoRow
                        label="更新人"
                        value={
                          detail.document.updated_by_id ? (
                            <EntityLink
                              type="user"
                              id={detail.document.updated_by_id}
                              label={
                                detail.document.updated_by_name || detail.document.updated_by_id
                              }
                            />
                          ) : (
                            '—'
                          )
                        }
                      />
                      <InfoRow label="快照数" value={detail.stats.total_versions} />
                    </div>
                  </TabsContent>

                  <TabsContent value="audit">
                    <EmptyNote>暂无记录</EmptyNote>
                  </TabsContent>
                </Tabs>
              ) : (
                <EmptyNote>暂无记录</EmptyNote>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <SensitiveActionConfirmDialog
        open={Boolean(pendingSensitiveAction)}
        title={getSensitiveDialogConfig()?.title ?? ''}
        targetLabel={getSensitiveDialogConfig()?.targetLabel ?? ''}
        impact={getSensitiveDialogConfig()?.impact ?? ''}
        confirmText={getSensitiveDialogConfig()?.confirmText}
        loading={listActionLoading || detailActionLoading || restoringVersionId !== null}
        onCancel={() => setPendingSensitiveAction(null)}
        onConfirm={(payload) => void handleConfirmSensitiveAction(payload)}
      />
    </div>
  )
}
