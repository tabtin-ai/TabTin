import { getUserDetail } from '@/api/users'
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
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import {
  batchDeleteAdminOssFiles,
  getAdminOssFileDetail,
  getAdminOssFiles,
  repairAdminOssFileOrganizations,
} from '@/oss-management/api/oss-management'
import type {
  AdminOssBatchDeleteResponse,
  AdminOssBatchRepairOrganizationResponse,
  AdminOssFileDetailResponse,
  AdminOssFileItem,
  AdminOssFileListResponse,
  AdminOssOrganizationRepairAssessment,
  OssFileStatusFilter,
  OssFileTypeFilter,
  OssOrganizationRepairReasonFilter,
  OssOrganizationRepairStateFilter,
} from '@/oss-management/types'
import type { UserDetailResponse } from '@/types/user'
import {
  AlertCircle,
  Copy,
  Database,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
}

function compactId(value?: string | null, start = 8, end = 4): string {
  if (!value) return '—'
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
}

function maskSensitivePath(value?: string | null): string {
  if (!value) return '—'
  if (value.length <= 4) return '****'
  if (value.length <= 18) return `${value.slice(0, 2)}...${value.slice(-2)}`
  return `${value.slice(0, 10)}...${value.slice(-8)}`
}

function CompactMetric({
  label,
  value,
  icon: Icon,
  onClick,
}: {
  label: string
  value: number | string | undefined
  icon: ComponentType<{ className?: string }>
  onClick?: () => void
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-lg border bg-background px-4 py-3 text-left"
    >
      <div>
        <div className="text-caption text-muted-foreground">{label}</div>
        <div className="mt-1 text-title font-semibold tabular-nums">{value ?? 0}</div>
      </div>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </Comp>
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
      <span className="max-w-[360px] break-words text-right">{value || '—'}</span>
    </div>
  )
}

function buildFileStatusBadgeVariant(
  status: string
): 'secondary' | 'destructive' | 'success' | 'outline' {
  if (status === 'failed') {
    return 'destructive'
  }
  if (status === 'completed') {
    return 'success'
  }
  if (status === 'deleted') {
    return 'outline'
  }
  return 'secondary'
}

function buildRepairStateLabel(state: OssOrganizationRepairStateFilter | string): string {
  switch (state) {
    case 'repairable':
      return '可修复'
    case 'conflict':
      return '证据冲突'
    case 'insufficient_evidence':
      return '证据不足'
    case 'lookup_error':
      return '查询失败'
    case 'owned':
      return '已归属'
    case 'deleted':
      return '已删除'
    default:
      return '待判定'
  }
}

function buildRepairStateBadgeVariant(
  state: OssOrganizationRepairStateFilter | string
): 'secondary' | 'destructive' | 'success' | 'outline' | 'warning' {
  switch (state) {
    case 'repairable':
      return 'success'
    case 'conflict':
      return 'destructive'
    case 'insufficient_evidence':
      return 'warning'
    case 'lookup_error':
      return 'outline'
    case 'owned':
      return 'secondary'
    case 'deleted':
      return 'outline'
    default:
      return 'outline'
  }
}

function buildRepairAssessmentCaption(
  assessment?: AdminOssOrganizationRepairAssessment | null
): string {
  if (!assessment) {
    return '暂未评估'
  }
  if (assessment.repair_state === 'repairable' && assessment.resolved_organization_id) {
    return `建议归属到 ${assessment.resolved_organization_id}`
  }
  return assessment.reason || buildRepairStateLabel(assessment.repair_state)
}

function buildRepairFilterHint(
  repairState: OssOrganizationRepairStateFilter,
  repairReasonCode: OssOrganizationRepairReasonFilter
): string {
  if (repairReasonCode === 'missing_organization_evidence') {
    return '当前聚焦“缺少归属证据”的文件。优先检查 UploadTask.organization_id、AttachmentReference.organization_id 和历史 metadata.organization_id 是否漏写。'
  }
  if (repairReasonCode === 'attachment_reference_lookup_error') {
    return '当前聚焦“附件引用查询失败”的文件。优先排查 tabdata/AttachmentReference 查询链路是否可用，再刷新列表重新评估。'
  }
  if (repairReasonCode === 'multiple_reference_organizations') {
    return '当前聚焦“多引用冲突”的文件。建议先确认仍有效的附件引用，再决定最终归属。'
  }
  if (repairReasonCode === 'multiple_upload_task_organizations') {
    return '当前聚焦“多任务冲突”的文件。建议先核对真实上传来源，再处理归属。'
  }
  if (repairReasonCode === 'cross_source_organization_conflict') {
    return '当前聚焦“交叉证据冲突”的文件。引用链路和上传任务给出的组织不一致，需要人工裁决。'
  }
  if (repairState === 'repairable') {
    return '当前聚焦可自动修复文件。建议先预览，再执行批量归属修复。'
  }
  if (repairState === 'conflict') {
    return '当前聚焦证据冲突文件。自动修复已停用，请先人工确认最终归属。'
  }
  if (repairState === 'insufficient_evidence') {
    return '当前聚焦待人工补证据文件。建议优先补齐上传任务、附件引用或历史 metadata 归属。'
  }
  if (repairState === 'lookup_error') {
    return '当前聚焦查询失败文件。建议先排查依赖模块和查询链路，再重新评估。'
  }
  return ''
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim()
  )
}

function buildUserManagementPath(uploadUser: string): string {
  const normalized = uploadUser.trim()
  if (!normalized) {
    return '/users'
  }

  const searchParams = new URLSearchParams()
  searchParams.set('keyword', normalized)
  if (isUuidLike(normalized)) {
    searchParams.set('userId', normalized)
  }

  return `/users?${searchParams.toString()}`
}

const fileTypeOptions: Array<{ value: OssFileTypeFilter; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'image', label: '图片' },
  { value: 'document', label: '文档' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'archive', label: '压缩包' },
  { value: 'other', label: '其他' },
]

const statusOptions: Array<{ value: OssFileStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'completed', label: '已完成' },
  { value: 'uploading', label: '上传中' },
  { value: 'failed', label: '失败' },
  { value: 'deleted', label: '已删除' },
]

type PublicFilter = 'all' | 'public' | 'private'

const repairStateOptions: Array<{
  value: OssOrganizationRepairStateFilter
  label: string
}> = [
  { value: 'all', label: '全部判定' },
  { value: 'repairable', label: '仅看可修复' },
  { value: 'conflict', label: '仅看证据冲突' },
  { value: 'insufficient_evidence', label: '仅看证据不足' },
  { value: 'lookup_error', label: '仅看查询失败' },
  { value: 'owned', label: '仅看已归属' },
  { value: 'deleted', label: '仅看已删除' },
]

const repairReasonOptions: Array<{
  value: OssOrganizationRepairReasonFilter
  label: string
}> = [
  { value: 'all', label: '全部原因' },
  { value: 'unique_reference_organization', label: '可修复 · 引用唯一' },
  { value: 'unique_upload_task_organization', label: '可修复 · 任务唯一' },
  { value: 'unique_reference_and_upload_task_organization', label: '可修复 · 双证据一致' },
  { value: 'multiple_reference_organizations', label: '冲突 · 多引用' },
  { value: 'multiple_upload_task_organizations', label: '冲突 · 多任务' },
  { value: 'cross_source_organization_conflict', label: '冲突 · 交叉冲突' },
  { value: 'missing_organization_evidence', label: '待人工 · 缺证据' },
  { value: 'attachment_reference_lookup_error', label: '待人工 · 查询失败' },
  { value: 'already_owned', label: '已归属' },
  { value: 'file_deleted', label: '已删除' },
]

export function OssManagementPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const organizationIdFilter = searchParams.get('organization_id') || ''
  const spaceIdFilter = searchParams.get('space_id') || ''

  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [fileType, setFileType] = useState<OssFileTypeFilter>('all')
  const [status, setStatus] = useState<OssFileStatusFilter>('all')
  const [publicFilter, setPublicFilter] = useState<PublicFilter>('all')
  const [orphanOnly, setOrphanOnly] = useState(false)
  const [unownedOnly, setUnownedOnly] = useState(false)
  const [repairState, setRepairState] = useState<OssOrganizationRepairStateFilter>('all')
  const [repairReasonCode, setRepairReasonCode] = useState<OssOrganizationRepairReasonFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const [data, setData] = useState<AdminOssFileListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false)
  const [detail, setDetail] = useState<AdminOssFileDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [uploaderDetail, setUploaderDetail] = useState<UserDetailResponse | null>(null)
  const [uploaderLoading, setUploaderLoading] = useState(false)
  const [uploaderError, setUploaderError] = useState<string | null>(null)

  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([])
  const [pendingSensitiveAction, setPendingSensitiveAction] = useState<
    { type: 'delete'; fileIds: string[] } | { type: 'repair_organization'; fileIds: string[] } | null
  >(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  const loadFiles = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await getAdminOssFiles({
        keyword: keyword || undefined,
        file_type: fileType,
        status,
        is_public: publicFilter === 'all' ? undefined : publicFilter === 'public',
        orphan_only: orphanOnly || undefined,
        unowned_only: unownedOnly || undefined,
        repair_state: repairState,
        repair_reason_code: repairReasonCode,
        organization_id: organizationIdFilter || undefined,
        space_id: spaceIdFilter || undefined,
        page,
        page_size: pageSize,
      })
      setData(response)
    } catch (loadError: unknown) {
      setError(resolveErrorMessage(loadError, '加载资源列表失败'))
    } finally {
      setLoading(false)
    }
  }, [
    fileType,
    keyword,
    orphanOnly,
    page,
    pageSize,
    publicFilter,
    repairReasonCode,
    repairState,
    status,
    unownedOnly,
    organizationIdFilter,
    spaceIdFilter,
  ])

  const reloadSelectedDetail = useCallback(async () => {
    if (!selectedFileId) {
      setDetail(null)
      return
    }
    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await getAdminOssFileDetail(selectedFileId)
      setDetail(response)
    } catch (loadError: unknown) {
      setDetailError(resolveErrorMessage(loadError, '加载资源详情失败'))
    } finally {
      setDetailLoading(false)
    }
  }, [selectedFileId])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  useEffect(() => {
    if (!data) {
      return
    }
    const currentIds = new Set(data.items.map((item) => item.id))
    setSelectedFileIds((prev) => prev.filter((item) => currentIds.has(item)))

    if (!data.items.length) {
      setSelectedFileId(null)
      setDetail(null)
      setDetailDrawerOpen(false)
      return
    }
    if (selectedFileId && !currentIds.has(selectedFileId)) {
      setSelectedFileId(null)
      setDetail(null)
      setDetailDrawerOpen(false)
    }
  }, [data, selectedFileId])

  useEffect(() => {
    if (!selectedFileId || !detailDrawerOpen) {
      setDetail(null)
      return
    }

    let cancelled = false
    const run = async () => {
      setDetailLoading(true)
      setDetailError(null)
      try {
        const response = await getAdminOssFileDetail(selectedFileId)
        if (!cancelled) {
          setDetail(response)
        }
      } catch (loadError: unknown) {
        if (!cancelled) {
          setDetailError(resolveErrorMessage(loadError, '加载资源详情失败'))
        }
      } finally {
        if (!cancelled) {
          setDetailLoading(false)
        }
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [detailDrawerOpen, selectedFileId])

  useEffect(() => {
    const uploadUser = detail?.file.upload_user?.trim() || ''
    if (!uploadUser || !isUuidLike(uploadUser)) {
      setUploaderDetail(null)
      setUploaderError(null)
      setUploaderLoading(false)
      return
    }

    let cancelled = false
    const run = async () => {
      setUploaderLoading(true)
      setUploaderError(null)
      try {
        const response = await getUserDetail(uploadUser)
        if (!cancelled) {
          setUploaderDetail(response)
        }
      } catch (loadError: unknown) {
        if (!cancelled) {
          setUploaderDetail(null)
          setUploaderError(resolveErrorMessage(loadError, '加载上传用户详情失败'))
        }
      } finally {
        if (!cancelled) {
          setUploaderLoading(false)
        }
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [detail?.file.upload_user])

  const handleSearch = () => {
    setPage(1)
    setKeyword(keywordInput.trim())
  }

  const summary = data?.summary
  const pagination = data?.pagination
  const repairFilterHint = useMemo(
    () => buildRepairFilterHint(repairState, repairReasonCode),
    [repairReasonCode, repairState]
  )

  const currentPageIds = useMemo(() => (data?.items ?? []).map((item) => item.id), [data?.items])
  const repairablePageIds = useMemo(
    () =>
      (data?.items ?? [])
        .filter((item) => item.organization_repair?.repair_state === 'repairable')
        .map((item) => item.id),
    [data?.items]
  )

  const selectedCount = selectedFileIds.length
  const selectedOnPageCount = currentPageIds.filter((id) => selectedFileIds.includes(id)).length
  const selectedRepairableOnPageCount = repairablePageIds.filter((id) =>
    selectedFileIds.includes(id)
  ).length
  const allSelectedOnPage =
    currentPageIds.length > 0 && selectedOnPageCount === currentPageIds.length

  const hasPrevPage = Boolean(pagination && pagination.page > 1)
  const hasNextPage = Boolean(pagination && pagination.page < pagination.total_pages)

  const selectedFileSummary: AdminOssFileItem | null = useMemo(
    () => data?.items.find((item) => item.id === selectedFileId) ?? null,
    [data?.items, selectedFileId]
  )

  const toggleSelectAllOnPage = () => {
    if (allSelectedOnPage) {
      setSelectedFileIds((prev) => prev.filter((id) => !currentPageIds.includes(id)))
      return
    }
    setSelectedFileIds((prev) => {
      const merged = new Set(prev)
      for (const id of currentPageIds) {
        merged.add(id)
      }
      return Array.from(merged)
    })
  }

  const toggleSelectFile = (fileId: string) => {
    setSelectedFileIds((prev) => {
      if (prev.includes(fileId)) {
        return prev.filter((id) => id !== fileId)
      }
      return [...prev, fileId]
    })
  }

  const handleSelectRepairableOnPage = () => {
    if (!repairablePageIds.length) {
      return
    }
    setSelectedFileIds((prev) => {
      const merged = new Set(prev)
      for (const id of repairablePageIds) {
        merged.add(id)
      }
      return Array.from(merged)
    })
  }

  const focusRepairableFiles = () => {
    setPage(1)
    setOrphanOnly(false)
    setUnownedOnly(true)
    setRepairState('repairable')
    setRepairReasonCode('all')
  }

  const buildBatchMessage = (response: AdminOssBatchDeleteResponse): string => {
    if (!response.skipped.length) {
      return response.message
    }
    const preview = response.skipped
      .slice(0, 3)
      .map((item) => `${item.file_id}: ${item.reason}`)
      .join('；')
    return `${response.message}。示例跳过原因：${preview}`
  }

  const buildRepairMessage = (response: AdminOssBatchRepairOrganizationResponse): string => {
    const conflictCount = response.results.filter((item) => item.repair_state === 'conflict').length
    const insufficientCount = response.results.filter(
      (item) => item.repair_state === 'insufficient_evidence'
    ).length
    const lookupErrorCount = response.results.filter(
      (item) => item.repair_state === 'lookup_error'
    ).length
    const skippedPreview = response.results
      .filter((item) => !item.repaired && item.reason)
      .slice(0, 3)
      .map((item) => `${item.file_id}: ${item.reason}`)
      .join('；')
    const breakdown = [
      response.repaired_count > 0 ? `可修复 ${response.repaired_count}` : '',
      conflictCount > 0 ? `冲突 ${conflictCount}` : '',
      insufficientCount > 0 ? `证据不足 ${insufficientCount}` : '',
      lookupErrorCount > 0 ? `查询失败 ${lookupErrorCount}` : '',
    ]
      .filter(Boolean)
      .join('，')
    if (!skippedPreview) {
      return breakdown ? `${response.message}。${breakdown}` : response.message
    }
    return `${response.message}${breakdown ? `。${breakdown}` : ''}。示例跳过原因：${skippedPreview}`
  }

  const handleBatchDelete = async (dryRun: boolean) => {
    if (!selectedFileIds.length) {
      setActionError('请先选择至少 1 个文件')
      return
    }
    if (!dryRun) {
      setPendingSensitiveAction({ type: 'delete', fileIds: [...selectedFileIds] })
      return
    }

    const currentSelectedFileId = selectedFileId
    const selectedDetailAffected = Boolean(
      currentSelectedFileId && selectedFileIds.includes(currentSelectedFileId)
    )

    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const response = await batchDeleteAdminOssFiles(selectedFileIds, { dryRun: true })
      setActionMessage(buildBatchMessage(response))
      if (!dryRun) {
        setSelectedFileIds([])
      }

      await loadFiles()
      if (selectedDetailAffected) {
        await reloadSelectedDetail()
      }
    } catch (actionErr: unknown) {
      setActionError(resolveErrorMessage(actionErr, '批量删除失败'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleRepairOrganization = async (dryRun: boolean) => {
    if (!selectedFileIds.length) {
      setActionError('请先选择至少 1 个文件')
      return
    }
    if (!dryRun) {
      setPendingSensitiveAction({ type: 'repair_organization', fileIds: [...selectedFileIds] })
      return
    }

    const currentSelectedFileId = selectedFileId
    const selectedDetailAffected = Boolean(
      currentSelectedFileId && selectedFileIds.includes(currentSelectedFileId)
    )

    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const response = await repairAdminOssFileOrganizations(selectedFileIds, { dryRun: true })
      setActionMessage(buildRepairMessage(response))
      if (!dryRun) {
        setSelectedFileIds([])
      }

      await loadFiles()
      if (selectedDetailAffected) {
        await reloadSelectedDetail()
      }
    } catch (actionErr: unknown) {
      setActionError(resolveErrorMessage(actionErr, '修复文件归属失败'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleConfirmSensitiveAction = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingSensitiveAction) {
      return
    }
    const targetIds = pendingSensitiveAction.fileIds
    const currentSelectedFileId = selectedFileId
    const selectedDetailAffected = Boolean(
      currentSelectedFileId && targetIds.includes(currentSelectedFileId)
    )
    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)
    try {
      if (pendingSensitiveAction.type === 'delete') {
        const response = await batchDeleteAdminOssFiles(targetIds, {
          dryRun: false,
          sensitive: payload,
        })
        setActionMessage(buildBatchMessage(response))
      } else {
        const response = await repairAdminOssFileOrganizations(targetIds, {
          dryRun: false,
          sensitive: payload,
        })
        setActionMessage(buildRepairMessage(response))
      }
      setPendingSensitiveAction(null)
      setSelectedFileIds([])
      await loadFiles()
      if (selectedDetailAffected) {
        await reloadSelectedDetail()
      }
    } catch (actionErr: unknown) {
      setActionError(resolveErrorMessage(actionErr, '批量治理失败'))
    } finally {
      setActionLoading(false)
    }
  }

  const getSensitiveDialogConfig = () => {
    if (!pendingSensitiveAction) {
      return null
    }
    const count = pendingSensitiveAction.fileIds.length
    if (pendingSensitiveAction.type === 'delete') {
      return {
        title: '批量删除 OSS 文件',
        targetLabel: `共 ${count} 个文件`,
        impact: `该操作会影响当前选中的 ${count} 个文件并执行删除，不会影响客户端其他数据。`,
        confirmText: '删除文件',
      }
    }
    return {
      title: '批量修复文件归属',
      targetLabel: `共 ${count} 个文件`,
      impact: `该操作会影响当前选中的 ${count} 个文件归属并写入治理结果，不会影响客户端其他数据。`,
      confirmText: '修复归属',
    }
  }

  const handleRefresh = async () => {
    setActionError(null)
    setActionMessage(null)
    await loadFiles()
    if (selectedFileId && detailDrawerOpen) {
      await reloadSelectedDetail()
    }
  }

  const openFileDetail = (fileId: string) => {
    setSelectedFileId(fileId)
    setDetailDrawerOpen(true)
  }

  const copyFileId = async (fileId: string) => {
    try {
      await navigator.clipboard.writeText(fileId)
    } catch {
      setActionError('复制文件 ID 失败')
    }
  }

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div>
          <h1 className="text-title font-semibold">资源 / Assets</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => navigate('/assets/operations')}>
            任务
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleRefresh()}
            disabled={loading || detailLoading}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 border-b bg-muted/5 px-6 py-3 lg:grid-cols-4">
        <CompactMetric label="文件总数" value={summary?.total_files} icon={Database} />
        <CompactMetric
          label="私有文件"
          value={summary?.private_files}
          icon={ShieldAlert}
          onClick={() => {
            setPage(1)
            setPublicFilter('private')
          }}
        />
        <CompactMetric
          label="孤儿文件"
          value={summary?.orphan_files}
          icon={Trash2}
          onClick={() => {
            setPage(1)
            setOrphanOnly(!orphanOnly)
          }}
        />
        <CompactMetric
          label="存储异常"
          value={(summary?.failed_files ?? 0) + (summary?.unowned_files ?? 0)}
          icon={AlertCircle}
          onClick={() => {
            setPage(1)
            setUnownedOnly(true)
          }}
        />
      </div>

      <div className="space-y-3 border-b bg-muted/10 px-6 py-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(240px,2fr)_140px_150px_140px_170px_1fr_auto_auto]">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="文件 ID / 文件名 / Organization"
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleSearch()
                }
              }}
            />
          </div>
          <Select
            value={fileType}
            onValueChange={(value) => {
              setPage(1)
              setFileType(value as OssFileTypeFilter)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="文件类型" />
            </SelectTrigger>
            <SelectContent>
              {fileTypeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={repairState}
            onValueChange={(value) => {
              const nextValue = value as OssOrganizationRepairStateFilter
              setPage(1)
              setRepairState(nextValue)
              setRepairReasonCode('all')
              if (nextValue === 'owned' || nextValue === 'deleted') {
                setUnownedOnly(false)
              }
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="归属状态" />
            </SelectTrigger>
            <SelectContent>
              {repairStateOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={publicFilter}
            onValueChange={(value) => {
              setPage(1)
              setPublicFilter(value as PublicFilter)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="访问权限" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部访问</SelectItem>
              <SelectItem value="public">公开</SelectItem>
              <SelectItem value="private">私有</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={repairReasonCode}
            onValueChange={(value) => {
              const nextValue = value as OssOrganizationRepairReasonFilter
              setPage(1)
              setRepairReasonCode(nextValue)
              if (nextValue === 'missing_organization_evidence') {
                setUnownedOnly(true)
                setRepairState('insufficient_evidence')
              } else if (nextValue === 'attachment_reference_lookup_error') {
                setUnownedOnly(true)
                setRepairState('lookup_error')
              } else if (
                nextValue === 'multiple_reference_organizations' ||
                nextValue === 'multiple_upload_task_organizations' ||
                nextValue === 'cross_source_organization_conflict'
              ) {
                setUnownedOnly(true)
                setRepairState('conflict')
              } else if (
                nextValue === 'unique_reference_organization' ||
                nextValue === 'unique_upload_task_organization' ||
                nextValue === 'unique_reference_and_upload_task_organization'
              ) {
                setUnownedOnly(true)
                setRepairState('repairable')
              }
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="风险状态" />
            </SelectTrigger>
            <SelectContent>
              {repairReasonOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(value) => {
              setPage(1)
              setStatus(value as OssFileStatusFilter)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="更新时间" />
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={handleSearch}>
            查询
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setPage(1)
              setKeywordInput('')
              setKeyword('')
              setFileType('all')
              setStatus('all')
              setPublicFilter('all')
              setOrphanOnly(false)
              setUnownedOnly(false)
              setRepairState('all')
              setRepairReasonCode('all')
            }}
          >
            重置
          </Button>
        </div>
        <div className="flex items-center justify-between text-body text-muted-foreground">
          <span>共 {pagination?.total ?? 0} 条结果</span>
          {repairFilterHint ? (
            <span className="line-clamp-1 max-w-[560px] text-right">{repairFilterHint}</span>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-hidden bg-muted/5 p-4">
        {actionError && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {actionError}
          </div>
        )}
        {actionMessage && (
          <div className="mb-4 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-body text-success">
            {actionMessage}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        )}

        <div className="h-full min-h-0">
          <div className="flex h-full min-h-0 flex-col rounded-md border bg-background">
            {(selectedCount > 0 || repairablePageIds.length > 0) && (
              <div
                className={`flex flex-wrap items-center gap-2 border-b px-3 py-2 text-body ${selectedCount > 0 ? 'border-warning/40 bg-warning/10' : 'border-success/40 bg-success/10'}`}
              >
                <span
                  className={`font-medium ${selectedCount > 0 ? 'text-warning' : 'text-success'}`}
                >
                  {selectedCount > 0
                    ? `已选择 ${selectedCount} 个文件`
                    : `当前页可自动修复 ${repairablePageIds.length} 个文件`}
                </span>
                {repairablePageIds.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2"
                    disabled={actionLoading || loading}
                    onClick={handleSelectRepairableOnPage}
                  >
                    选中当前页可修复
                    {selectedRepairableOnPageCount > 0
                      ? `（已选 ${selectedRepairableOnPageCount}）`
                      : ''}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  disabled={actionLoading || loading}
                  onClick={focusRepairableFiles}
                >
                  仅看可修复
                </Button>
                {selectedCount > 0 && (
                  <>
                    <PermissionGate permission={ADMIN_PERMISSION.ASSET_REPAIR}>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2"
                        disabled={actionLoading || loading}
                        onClick={() => void handleRepairOrganization(true)}
                      >
                        预览归属修复
                      </Button>
                    </PermissionGate>
                    <PermissionGate permission={ADMIN_PERMISSION.ASSET_REPAIR}>
                      <Button
                        size="sm"
                        className="h-7 px-2"
                        disabled={actionLoading || loading}
                        onClick={() => void handleRepairOrganization(false)}
                      >
                        执行归属修复
                      </Button>
                    </PermissionGate>
                    <PermissionGate permission={ADMIN_PERMISSION.ASSET_DELETE}>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2"
                        disabled={actionLoading || loading}
                        onClick={() => void handleBatchDelete(true)}
                      >
                        模拟删除
                      </Button>
                    </PermissionGate>
                    <PermissionGate permission={ADMIN_PERMISSION.ASSET_DELETE}>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 px-2"
                        disabled={actionLoading || loading}
                        onClick={() => void handleBatchDelete(false)}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        批量删除
                      </Button>
                    </PermissionGate>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      disabled={actionLoading || loading}
                      onClick={() => setSelectedFileIds([])}
                    >
                      清空选择
                    </Button>
                  </>
                )}
              </div>
            )}

            <div className="overflow-hidden border-b">
              <table className="min-w-full text-body">
                <thead className="bg-muted/30 text-muted-foreground">
                  <tr>
                    <th className="w-10 px-3 py-2 text-left font-medium">
                      <input
                        type="checkbox"
                        checked={allSelectedOnPage}
                        onChange={toggleSelectAllOnPage}
                        disabled={loading || actionLoading || currentPageIds.length === 0}
                      />
                    </th>
                    <th className="px-3 py-2 text-left font-medium">文件</th>
                    <th className="px-3 py-2 text-left font-medium">Organization</th>
                    <th className="px-3 py-2 text-left font-medium">类型</th>
                    <th className="px-3 py-2 text-left font-medium">大小</th>
                    <th className="px-3 py-2 text-left font-medium">访问权限</th>
                    <th className="px-3 py-2 text-left font-medium">归属状态</th>
                    <th className="px-3 py-2 text-left font-medium">风险</th>
                    <th className="px-3 py-2 text-left font-medium">更新时间</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
              </table>
            </div>

            <div className="flex-1 overflow-hidden">
              {loading ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载资源中...
                </div>
              ) : !data?.items.length ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  当前筛选条件下无资源数据
                </div>
              ) : (
                <ScrollArea className="h-full">
                  <table className="min-w-full text-body">
                    <tbody>
                      {data.items.map((item) => {
                        const isActive = item.id === selectedFileId
                        const isChecked = selectedFileIds.includes(item.id)
                        return (
                          <tr
                            key={item.id}
                            className={`h-16 cursor-pointer border-t transition-colors ${isActive ? 'bg-primary/5' : 'hover:bg-muted/20'}`}
                            tabIndex={0}
                            onClick={() => openFileDetail(item.id)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                openFileDetail(item.id)
                              }
                            }}
                          >
                            <td className="w-10 px-3 py-3 align-top">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onClick={(event) => event.stopPropagation()}
                                onChange={() => toggleSelectFile(item.id)}
                                disabled={loading || actionLoading}
                              />
                            </td>
                            <td className="px-3 py-3 align-top">
                              <div className="max-w-[280px] truncate font-medium">
                                {item.file_name}
                              </div>
                              <button
                                type="button"
                                className="mt-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void copyFileId(item.id)
                                }}
                              >
                                {compactId(item.id)}
                                <Copy className="h-3 w-3" />
                              </button>
                            </td>
                            <td className="px-3 py-3 align-top text-body">
                              <div className="max-w-[180px] truncate">
                                {item.organization_id ? (
                                  <EntityLink type="organization" id={item.organization_id} />
                                ) : (
                                  '未归属'
                                )}
                              </div>
                              <div className="max-w-[180px] truncate text-muted-foreground">
                                {item.space_id ? (
                                  <EntityLink type="space" id={item.space_id} />
                                ) : (
                                  '—'
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-3 align-top">
                              <Badge variant="secondary">{item.file_type}</Badge>
                            </td>
                            <td className="px-3 py-3 align-top text-body">
                              {item.file_size_display || '—'}
                            </td>
                            <td className="px-3 py-3 align-top">
                              <Badge variant={item.is_public ? 'warning' : 'outline'}>
                                {item.is_public ? '公开' : '私有'}
                              </Badge>
                            </td>
                            <td className="px-3 py-3 align-top">
                              <Badge
                                variant={item.organization_id ? 'secondary' : 'warning'}
                                className="max-w-[140px] truncate"
                              >
                                {item.organization_id ? '已归属' : '未归属'}
                              </Badge>
                            </td>
                            <td className="px-3 py-3 align-top">
                              {item.organization_repair &&
                              item.organization_repair.repair_state !== 'owned' ? (
                                <Badge
                                  variant={buildRepairStateBadgeVariant(
                                    item.organization_repair.repair_state
                                  )}
                                >
                                  {buildRepairStateLabel(item.organization_repair.repair_state)}
                                </Badge>
                              ) : item.ref_count === 0 ? (
                                <Badge variant="warning">孤儿</Badge>
                              ) : (
                                <Badge variant={buildFileStatusBadgeVariant(item.status)}>
                                  {item.status}
                                </Badge>
                              )}
                            </td>
                            <td className="px-3 py-3 align-top text-body text-muted-foreground">
                              {formatDateTime(item.updated_at)}
                            </td>
                            <td className="px-3 py-3 text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    openFileDetail(item.id)
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
                                    openFileDetail(item.id)
                                  }}
                                  aria-label="更多"
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </ScrollArea>
              )}
            </div>

            <div className="flex items-center justify-between border-t px-3 py-2 text-body text-muted-foreground">
              <span>
                共 {pagination?.total ?? 0} 条，当前第 {pagination?.page ?? 1} /{' '}
                {pagination?.total_pages ?? 1} 页
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
                  disabled={!hasPrevPage || loading}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!hasNextPage || loading}
                  onClick={() => setPage((prev) => prev + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <Dialog
        open={detailDrawerOpen}
        onOpenChange={(open) => {
          setDetailDrawerOpen(open)
          if (!open) setSelectedFileId(null)
        }}
      >
        <DialogContent className="left-auto right-0 top-0 h-screen max-w-[640px] translate-x-0 translate-y-0 grid-rows-[auto_1fr] gap-0 rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-5 py-4">
            <div className="flex items-start justify-between gap-4 pr-8">
              <div className="min-w-0">
                <DialogTitle className="truncate">
                  {detail?.file.file_name || selectedFileSummary?.file_name || '资源详情'}
                </DialogTitle>
                <div className="mt-1 text-body text-muted-foreground">
                  {selectedFileId ? compactId(selectedFileId, 10, 6) : '—'}
                </div>
              </div>
              {selectedFileId ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(`/assets/${selectedFileId}`)}
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
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
                  {detailError}
                </div>
              ) : detail?.file ? (
                <Tabs defaultValue="overview">
                  <TabsList className="grid w-full grid-cols-5">
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="owner">归属</TabsTrigger>
                    <TabsTrigger value="storage">存储</TabsTrigger>
                    <TabsTrigger value="risk">风险</TabsTrigger>
                    <TabsTrigger value="audit">审计</TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="space-y-4">
                    <div className="rounded-md border p-3 text-body">
                      <InfoRow label="asset_id" value={detail.file.id} />
                      <InfoRow label="文件名" value={detail.file.file_name} />
                      <InfoRow label="类型" value={detail.file.file_type} />
                      <InfoRow label="大小" value={detail.file.file_size_display} />
                      <InfoRow label="访问权限" value={detail.file.is_public ? '公开' : '私有'} />
                      <InfoRow label="状态" value={detail.file.status} />
                    </div>
                  </TabsContent>
                  <TabsContent value="owner" className="space-y-4">
                    <div className="rounded-md border p-3 text-body">
                      <InfoRow
                        label="organization_id"
                        value={
                          detail.file.organization_id ? (
                            <EntityLink type="organization" id={detail.file.organization_id} />
                          ) : (
                            '未归属'
                          )
                        }
                      />
                      <InfoRow
                        label="space_id"
                        value={
                          detail.file.space_id ? (
                            <EntityLink type="space" id={detail.file.space_id} />
                          ) : (
                            '—'
                          )
                        }
                      />
                      <InfoRow label="owner" value={detail.file.upload_user || '—'} />
                      <InfoRow label="来源" value={detail.file.upload_source || '—'} />
                    </div>
                    {detail.file.upload_user?.trim() ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          navigate(buildUserManagementPath(detail.file.upload_user || ''))
                        }
                      >
                        <ExternalLink className="mr-2 h-4 w-4" />
                        查看用户
                      </Button>
                    ) : null}
                    {uploaderLoading ? (
                      <div className="text-body text-muted-foreground">解析用户中...</div>
                    ) : uploaderDetail?.user ? (
                      <div className="rounded-md border p-3 text-body">
                        <InfoRow label="用户" value={uploaderDetail.user.display_name} />
                        <InfoRow label="邮箱" value={uploaderDetail.user.email || '未绑定'} />
                        <InfoRow label="状态" value={uploaderDetail.user.status} />
                      </div>
                    ) : uploaderError ? (
                      <div className="text-body text-muted-foreground">{uploaderError}</div>
                    ) : null}
                  </TabsContent>
                  <TabsContent value="storage">
                    <div className="rounded-md border p-3 text-body">
                      <InfoRow
                        label="masked_file_key"
                        value={maskSensitivePath(detail.file.file_key)}
                      />
                      <InfoRow
                        label="masked_file_path"
                        value={maskSensitivePath(detail.file.file_path)}
                      />
                      <InfoRow label="bucket" value={maskSensitivePath(detail.file.bucket_name)} />
                      <InfoRow
                        label="下载 / 查看"
                        value={`${detail.file.download_count} / ${detail.file.view_count}`}
                      />
                      <InfoRow label="created_at" value={formatDateTime(detail.file.created_at)} />
                      <InfoRow label="updated_at" value={formatDateTime(detail.file.updated_at)} />
                    </div>
                  </TabsContent>
                  <TabsContent value="risk" className="space-y-4">
                    <div className="rounded-md border p-3 text-body">
                      <InfoRow label="引用数" value={detail.file.ref_count} />
                      <InfoRow
                        label="归属判定"
                        value={
                          detail.file.organization_repair
                            ? buildRepairStateLabel(detail.file.organization_repair.repair_state)
                            : '暂无'
                        }
                      />
                      <InfoRow
                        label="原因"
                        value={
                          detail.file.organization_repair
                            ? buildRepairAssessmentCaption(detail.file.organization_repair)
                            : '—'
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      {detail.references.length ? (
                        detail.references.map((reference) => (
                          <div
                            key={reference.reference_id}
                            className="rounded-md border px-3 py-2 text-body"
                          >
                            <div className="font-medium">{reference.organization_id}</div>
                            <div className="mt-1 text-caption text-muted-foreground">
                              {reference.table_id} / {reference.field_id} /{' '}
                              {reference.record_id || '—'}
                            </div>
                          </div>
                        ))
                      ) : (
                        <EmptyNote>暂无引用</EmptyNote>
                      )}
                    </div>
                  </TabsContent>
                  <TabsContent value="audit" className="space-y-4">
                    <div className="space-y-2">
                      {detail.related_tasks.length ? (
                        detail.related_tasks.map((task) => (
                          <div key={task.task_id} className="rounded-md border px-3 py-2 text-body">
                            <div className="font-medium">{task.task_name}</div>
                            <div className="mt-1 text-caption text-muted-foreground">
                              {task.task_type} · {task.status} · {formatDateTime(task.created_at)}
                            </div>
                          </div>
                        ))
                      ) : (
                        <EmptyNote>暂无任务</EmptyNote>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              ) : (
                <EmptyNote />
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
        loading={actionLoading}
        onCancel={() => setPendingSensitiveAction(null)}
        onConfirm={(payload) => void handleConfirmSensitiveAction(payload)}
      />
    </div>
  )
}
