/**
 * SharedTablePage — 公开表格查看页
 *
 * 通过 share_id 访问；view 可公开查看，edit 需要登录后编辑单元格。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import {
  Table2,
  Lock,
  Copy,
  CheckCircle2,
  Loader2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  LogIn,
  MessageSquare,
  ShieldAlert,
} from 'lucide-react'
import { formatCellValue } from '@tabtin/smartsheet-ui'
import { API_BASE_URL } from '@/config/api'
import { useAuthStore } from '@/stores/auth-store'
import { TablePaneView } from '@/components/table/TablePaneView'
import { configureWebTableRuntime } from '@/features/table/bootstrap'
import { shareAuthHeaders } from './shareAuth'
import { buildCollabViewRecords } from '@tabtin/table-engine/collab'
import { useSharedTableCollab } from './hooks/useShareCollab'
import { shouldPreferCollabShareRecords } from './sharedTableCollabRecords'
import { resolveSharedTableAccess } from './sharedTableAccess'
import { WebRecordFormContainer } from '@/components/table/record/WebRecordFormContainer'
import {
  buildShareScopedRecordDetail,
  extractSharedCellValue as extractCellValue,
  getSharedRecordId as getRecordId,
} from './sharedTableRecordDetail'

interface SharedTableMeta {
  share_id: string
  share_type: string
  table_id?: string | null
  space_id?: string | null
  organization_id?: string | null
  view_id?: string | null
  table_name: string
  table_description: string
  table_icon: string
  has_password: boolean
  permission: string
  requires_login?: boolean
  allow_download: boolean
  fields: SharedTableField[]
  view_name: string | null
}

interface SharedTableField {
  id: string
  name: string
  field_type: string
}

interface SharedTableRecords {
  records: Array<Record<string, unknown>>
  total: number
  page: number
  page_size: number
}

type PageState =
  | { type: 'loading' }
  | { type: 'password'; meta: SharedTableMeta }
  | { type: 'content'; meta: SharedTableMeta; records: SharedTableRecords }
  | { type: 'not_found' }
  | { type: 'expired' }
  | { type: 'login_required' }
  | { type: 'forbidden' }
  | { type: 'error'; message: string }

const baseApiUrl = API_BASE_URL || '/api'
/** 已打开的分享页复查访问权：关闭/收窄后尽快切到失效态 */
const SHARE_ACCESS_RECHECK_INTERVAL_MS = 15_000

function mapTableShareAccessFailure(
  status: number,
  isAuthenticated: boolean,
): PageState {
  if (status === 410) return { type: 'expired' }
  if (status === 404) return { type: 'not_found' }
  if (status === 403) return { type: isAuthenticated ? 'forbidden' : 'login_required' }
  return { type: 'error', message: `加载失败 (${status})` }
}

function permissionLabel(permission: string): string {
  if (permission === 'edit') return '可编辑'
  if (permission === 'comment') return '可评论'
  return '只读'
}

const rejectShareScopedRecordMutation = async (): Promise<never> => {
  throw new Error('可评论分享不允许修改记录')
}

function normalizeAttachmentItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (item && typeof item === 'object') return [item as Record<string, unknown>]
      if (typeof item === 'string' && item.trim()) return [{ name: item }]
      return []
    })
  }
  if (value && typeof value === 'object') return [value as Record<string, unknown>]
  if (typeof value === 'string' && value.trim()) return [{ name: value }]
  return []
}

function getAttachmentName(item: Record<string, unknown>, index: number): string {
  const raw = item.name ?? item.filename ?? item.file_name ?? item.file_id ?? item.reference_id
  return typeof raw === 'string' && raw.trim() ? raw : `附件 ${index + 1}`
}

function getAttachmentUrl(item: Record<string, unknown>): string {
  const raw = item.url ?? item.download_url ?? item.preview_url ?? item.thumbnail_url ?? item.smThumbnailUrl ?? item.lgThumbnailUrl
  return typeof raw === 'string' ? raw : ''
}

function isImageAttachment(item: Record<string, unknown>, url: string, name: string): boolean {
  const mimeType = String(item.mime_type ?? item.mimeType ?? '').toLowerCase()
  if (mimeType.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i.test(url || name)
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

function SharedReadOnlyCell({
  field,
  value,
  onPreviewImage,
}: {
  field: SharedTableField
  value: unknown
  onPreviewImage: (image: { url: string; name: string }) => void
}) {
  if (field.field_type === 'attachment') {
    const items = normalizeAttachmentItems(value)
    if (items.length === 0) return <span className="text-muted-foreground">-</span>

    return (
      <div className="flex max-w-[360px] flex-wrap gap-2">
        {items.map((item, index) => {
          const name = getAttachmentName(item, index)
          const url = getAttachmentUrl(item)
          const isImage = isImageAttachment(item, url, name)
          const key = String(item.reference_id ?? item.file_id ?? url ?? `${name}-${index}`)

          if (isImage && url) {
            return (
              <button
                key={key}
                type="button"
                title={name}
                onClick={() => onPreviewImage({ url, name })}
                className="group inline-flex items-center gap-2 rounded border border-border/60 bg-background p-1 text-left hover:border-primary/50"
              >
                <img
                  src={url}
                  alt={name}
                  loading="lazy"
                  className="h-12 w-16 rounded object-cover"
                />
                <span className="max-w-[120px] truncate text-caption text-muted-foreground group-hover:text-primary">
                  {name}
                </span>
              </button>
            )
          }

          if (url) {
            return (
              <a
                key={key}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                download={name}
                title={name}
                className="inline-flex max-w-[180px] items-center rounded border border-border/60 bg-muted/30 px-2 py-1 text-caption text-primary hover:bg-muted hover:underline"
              >
                <span className="truncate">{name}</span>
              </a>
            )
          }

          return (
            <span
              key={key}
              title={name}
              className="inline-flex max-w-[180px] rounded border border-border/60 bg-muted/30 px-2 py-1 text-caption text-foreground"
            >
              <span className="truncate">{name}</span>
            </span>
          )
        })}
      </div>
    )
  }

  if (field.field_type === 'url') {
    const label = formatCellValue(value, { emptyLabel: '' })
    const href = normalizeUrl(label)
    if (!href) return <span className="text-muted-foreground">-</span>
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={label}
        className="inline-block max-w-[260px] truncate text-primary hover:underline"
      >
        {label}
      </a>
    )
  }

  const display = formatCellValue(value, { emptyLabel: '' })
  return <span title={display}>{display}</span>
}

function SharedTableWorkspace({
  meta,
  shareId,
  password,
  canComment,
}: {
  meta: SharedTableMeta & { table_id: string }
  shareId: string
  password?: string
  canComment: boolean
}) {
  const [configured, setConfigured] = useState(false)
  const shareTableCollab = useSharedTableCollab({
    shareId,
    tableId: meta.table_id,
    password,
    enabled: true,
  })

  useLayoutEffect(() => {
    configureWebTableRuntime({
      organizationId: meta.organization_id ?? null,
      spaceId: meta.space_id ?? null,
      tableShareId: shareId,
      tableSharePassword: password ?? null,
    })
    setConfigured(true)
  }, [meta.space_id, meta.organization_id, password, shareId])

  if (!configured) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="h-screen bg-background">
      <TablePaneView
        tableId={meta.table_id}
        shareCollab={{
          shareId,
          password,
          permission: meta.permission,
          canComment,
          getAuthToken: shareTableCollab.getAuthToken,
          refreshToken: shareTableCollab.refreshToken,
          collabDisabled: shareTableCollab.isFallback,
        }}
      />
    </div>
  )
}

export function SharedTablePage() {
  const { shareId } = useParams<{ shareId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const [state, setState] = useState<PageState>({ type: 'loading' })
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [page, setPage] = useState(1)
  const [savingCellKey, setSavingCellKey] = useState('')
  const [saveMessage, setSaveMessage] = useState('')
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null)
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const pageSize = 50

  const collabTableId = state.type === 'content' ? (state.meta.table_id ?? null) : null
  // view/comment 都使用 share-scoped 只读数据；edit 由完整工作台内的唯一 bridge 负责。
  const collabEnabled = state.type === 'content' && state.meta.permission !== 'edit'
  const tableCollab = useSharedTableCollab({
    shareId: shareId ?? '',
    tableId: collabTableId,
    password,
    enabled: collabEnabled,
  })
  const subscribeSharedCommentChanges = useCallback(
    (onChange: () => void) => tableCollab.onStatelessEvent('table.comment.changed', onChange),
    [tableCollab.onStatelessEvent],
  )

  useEffect(() => {
    setSelectedRecordId(null)
  }, [shareId])

  const loadRecords = useCallback(async (
    meta: SharedTableMeta,
    pg: number,
    pwd?: string,
    options: { nextMeta?: SharedTableMeta; skipState?: boolean } = {},
  ): Promise<SharedTableRecords | null> => {
    setRecordsLoading(true)
    const params = new URLSearchParams({ page: String(pg), page_size: String(pageSize) })
    const headers: Record<string, string> = { ...shareAuthHeaders() }
    if (pwd) headers['X-Table-Share-Password'] = pwd
    try {
      const resp = await fetch(`${baseApiUrl}/tabdata/shared/${shareId}/records?${params}`, { headers })
      if (!resp.ok) {
        const json = await resp.json().catch(() => ({}))
        if (resp.status === 403) {
          const code = json.code
          if (code === 'PASSWORD_REQUIRED' || code === 'INCORRECT_PASSWORD') {
            setState({ type: 'password', meta })
            if (pwd) setPasswordError('密码错误')
            return null
          }
          // organization 限定分享：未登录引导登录，已登录非成员提示无权
          setState({ type: isAuthenticated ? 'forbidden' : 'login_required' })
          return null
        }
        setState({ type: 'error', message: json.message || `HTTP ${resp.status}` })
        return null
      }
      const json = await resp.json()
      const data = json.data ?? json
      if (!options.skipState) {
        setState({ type: 'content', meta: options.nextMeta ?? meta, records: data })
      }
      return data as SharedTableRecords
    } finally {
      setRecordsLoading(false)
    }
  }, [shareId, isAuthenticated])

  useEffect(() => {
    if (!shareId) { setState({ type: 'not_found' }); return }
    let cancelled = false

    void (async () => {
      const resp = await fetch(`${baseApiUrl}/tabdata/shared/${shareId}`, { headers: shareAuthHeaders() })
      if (cancelled) return
      if (!resp.ok) {
        setState(mapTableShareAccessFailure(resp.status, isAuthenticated))
        return
      }

      const json = await resp.json()
      const meta = (json.data ?? json) as SharedTableMeta

      const access = resolveSharedTableAccess({
        shareType: meta.share_type,
        permission: meta.permission,
        requiresLogin: Boolean(meta.requires_login),
        isAuthenticated,
      })
      if (access.requiresLogin) {
        setState({ type: 'login_required' })
        return
      }

      if (meta.has_password) {
        setState({ type: 'password', meta })
        return
      }

      await loadRecords(meta, 1)
    })()

    return () => { cancelled = true }
  }, [shareId, loadRecords, isAuthenticated])

  const recheckShareAccess = useCallback(async () => {
    if (!shareId) return
    if (state.type !== 'content' && state.type !== 'password') return

    const params = new URLSearchParams()
    if (password.trim()) params.set('password', password.trim())
    const query = params.toString()
    const resp = await fetch(
      `${baseApiUrl}/tabdata/shared/${shareId}${query ? `?${query}` : ''}`,
      { headers: shareAuthHeaders() },
    )
    if (!resp.ok) {
      setState(mapTableShareAccessFailure(resp.status, isAuthenticated))
    }
  }, [isAuthenticated, password, shareId, state.type])

  useEffect(() => {
    if (state.type !== 'content' && state.type !== 'password') return

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void recheckShareAccess()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void recheckShareAccess()
      }
    }, SHARE_ACCESS_RECHECK_INTERVAL_MS)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(timer)
    }
  }, [recheckShareAccess, state.type])

  const handlePasswordSubmit = useCallback(async () => {
    if (!password.trim() || state.type !== 'password') return
    const trimmedPassword = password.trim()
    setVerifying(true)
    setPasswordError('')
    try {
      const records = await loadRecords(state.meta, 1, trimmedPassword, { skipState: true })
      if (!records) return

      const params = new URLSearchParams({ password: trimmedPassword })
      const resp = await fetch(`${baseApiUrl}/tabdata/shared/${shareId}?${params}`, {
        headers: shareAuthHeaders(),
      })
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`)
      }
      const json = await resp.json()
      const meta = (json.data ?? json) as SharedTableMeta
      setState({ type: 'content', meta, records })
    } catch {
      setPasswordError('验证失败')
    } finally {
      setVerifying(false)
    }
  }, [loadRecords, password, shareId, state])

  const handlePageChange = useCallback((newPage: number) => {
    if (state.type !== 'content') return
    setSelectedRecordId(null)
    setPage(newPage)
    void loadRecords(state.meta, newPage, password || undefined)
  }, [state, loadRecords, password])

  const handleCopyLink = useCallback(async () => {
    await navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  const handleCellSave = useCallback(async (
    record: Record<string, unknown>,
    field: SharedTableField,
    nextValue: unknown,
  ) => {
    if (!shareId || state.type !== 'content' || state.meta.permission !== 'edit') return

    const recordId = getRecordId(record)
    if (!recordId) {
      setSaveMessage('记录缺少 ID，无法保存')
      return
    }

    const currentValue = extractCellValue(record, field)
    if (Object.is(currentValue, nextValue)) return

    const cellKey = `${recordId}:${field.id}`
    setSavingCellKey(cellKey)
    setSaveMessage('')
    try {
      const resp = await fetch(`${baseApiUrl}/tabdata/shared/${shareId}/records/${recordId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...shareAuthHeaders() },
        body: JSON.stringify({
          field_id: field.id,
          value: nextValue,
          password: password || undefined,
        }),
      })
      if (!resp.ok) {
        const json = await resp.json().catch(() => ({}))
        if (resp.status === 403 && !isAuthenticated) {
          setState({ type: 'login_required' })
          return
        }
        throw new Error(json.message || json.detail || `HTTP ${resp.status}`)
      }
      const json = await resp.json()
      const updatedRecord = (json.data?.record ?? json.record) as Record<string, unknown> | undefined
      if (updatedRecord) {
        setState((current) => {
          if (current.type !== 'content') return current
          return {
            ...current,
            records: {
              ...current.records,
              records: current.records.records.map((item) =>
                getRecordId(item) === recordId ? updatedRecord : item,
              ),
            },
          }
        })
      }
      setSaveMessage('已保存')
      setTimeout(() => setSaveMessage(''), 1500)
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSavingCellKey('')
    }
  }, [isAuthenticated, password, shareId, state])

  const contentMeta = state.type === 'content' ? state.meta : null
  const collabRecordsPayload = useMemo(() => {
    if (!contentMeta?.table_id) return null
    // Collab 未同步完时 isRealtime 可能已为 true，但快照仍空——勿覆盖 REST
    if (
      !shouldPreferCollabShareRecords({
        isRealtime: tableCollab.isRealtime,
        recordsSnapshotSize: tableCollab.recordsSnapshot.size,
        rowOrderLength: tableCollab.rowOrder.length,
      })
    ) {
      return null
    }
    const shareView = tableCollab.viewsMeta.find(
      (view) => String(view.id) === String(contentMeta.view_id ?? ''),
    )
    // share.view_id 为空时回退默认视图，避免 find('') 失败后丢失筛选/排序语义之外的行序
    const fallbackView =
      shareView
      ?? (contentMeta.view_id
        ? null
        : tableCollab.viewsMeta[0] ?? null)
    return buildCollabViewRecords({
      tableId: contentMeta.table_id,
      recordsSnapshot: tableCollab.recordsSnapshot,
      rowOrder: tableCollab.rowOrder,
      fieldsMeta: tableCollab.fieldsMeta,
      view: (fallbackView as never) ?? null,
      page,
      pageSize,
    })
  }, [
    tableCollab.isRealtime,
    tableCollab.recordsSnapshot,
    tableCollab.rowOrder,
    tableCollab.fieldsMeta,
    tableCollab.viewsMeta,
    contentMeta?.table_id,
    contentMeta?.view_id,
    page,
    pageSize,
  ])

  if (state.type === 'loading') {
    return <div className="flex h-screen items-center justify-center bg-background"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }

  if (state.type === 'not_found') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6">
        <AlertCircle className="h-10 w-10 text-muted-foreground" />
        <div className="text-title font-semibold text-foreground">分享不存在</div>
        <div className="text-body text-muted-foreground">链接可能已失效或被删除</div>
      </div>
    )
  }

  if (state.type === 'expired') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6">
        <AlertCircle className="h-10 w-10 text-muted-foreground" />
        <div className="text-title font-semibold text-foreground">分享已过期</div>
      </div>
    )
  }

  if (state.type === 'login_required') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6">
        <Lock className="h-10 w-10 text-muted-foreground" />
        <div className="text-title font-semibold text-foreground">需要登录</div>
        <div className="text-body text-muted-foreground">请登录后查看</div>
        <button
          type="button"
          onClick={() => navigate('/login', { state: { from: location } })}
          className="mt-2 flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-body font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <LogIn className="h-4 w-4" /> 去登录
        </button>
      </div>
    )
  }

  if (state.type === 'forbidden') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6">
        <ShieldAlert className="h-10 w-10 text-muted-foreground" />
        <div className="text-title font-semibold text-foreground">无权查看</div>
        <div className="text-body text-muted-foreground">此分享仅限所属组织成员访问，你的账号不在该组织中</div>
      </div>
    )
  }

  if (state.type === 'error') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6">
        <AlertCircle className="h-10 w-10 text-destructive" />
        <div className="text-title font-semibold text-foreground">加载失败</div>
        <div className="text-body text-muted-foreground">{state.message}</div>
      </div>
    )
  }

  if (state.type === 'password') {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-sm">
          <div className="flex flex-col items-center gap-4">
            <Lock className="h-8 w-8 text-muted-foreground" />
            <div className="text-center">
              <div className="text-subtitle font-semibold text-foreground">
                {state.meta.table_icon && <span className="mr-2">{state.meta.table_icon}</span>}
                {state.meta.table_name || '受保护的表格'}
              </div>
              <div className="mt-1 text-body text-muted-foreground">请输入密码查看</div>
            </div>
            <div className="w-full space-y-3">
              <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handlePasswordSubmit() }}
                placeholder="输入访问密码"
                className="w-full rounded-lg border bg-background px-3 py-2 text-body outline-none focus:ring-2 focus:ring-primary/30" />
              {passwordError && <div className="text-body text-destructive">{passwordError}</div>}
              <button type="button" disabled={verifying || !password.trim()} onClick={() => void handlePasswordSubmit()}
                className="w-full rounded-lg bg-primary px-4 py-2 text-body font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {verifying ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : '确认访问'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const { meta, records } = state
  const displayRecords = collabRecordsPayload
    ? {
        ...records,
        records: collabRecordsPayload.records as Record<string, unknown>[],
        total: collabRecordsPayload.total,
      }
    : records
  const totalPages = Math.ceil(displayRecords.total / pageSize)
  const access = resolveSharedTableAccess({
    shareType: meta.share_type,
    permission: meta.permission,
    requiresLogin: Boolean(meta.requires_login),
    isAuthenticated,
  })
  const isEditable = access.canEdit
  const permLabel = meta.permission === 'edit' && !access.canEdit
    ? '登录后可编辑'
    : permissionLabel(meta.permission)
  const selectedRecordIndex = selectedRecordId
    ? displayRecords.records.findIndex((record) => getRecordId(record) === selectedRecordId)
    : -1
  const selectedRecord = selectedRecordIndex >= 0
    ? displayRecords.records[selectedRecordIndex]
    : null
  const detailModel = selectedRecord && meta.table_id
    ? buildShareScopedRecordDetail(
        {
          tableId: meta.table_id,
          tableName: meta.table_name,
          tableDescription: meta.table_description,
          tableIcon: meta.table_icon,
          organizationId: meta.organization_id,
          spaceId: meta.space_id,
          fields: meta.fields,
        },
        selectedRecord,
      )
    : null

  if (access.useWorkspace && meta.table_id) {
    return (
      <SharedTableWorkspace
        meta={{ ...meta, table_id: meta.table_id }}
        shareId={shareId ?? ''}
        password={password}
        canComment={access.canComment}
      />
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b px-6 py-4">
        <div className="mx-auto max-w-6xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Table2 className="h-5 w-5 text-muted-foreground" />
            <div>
              <h1 className="text-subtitle font-semibold text-foreground">
                {meta.table_icon && <span className="mr-1">{meta.table_icon}</span>}
                {meta.table_name}
              </h1>
              {meta.table_description && (
                <div className="text-body text-muted-foreground mt-0.5">{meta.table_description}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {access.showLoginToEdit ? (
              <button
                type="button"
                onClick={() => navigate('/login', { state: { from: location } })}
                className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-caption text-primary transition-colors hover:bg-primary/20"
              >
                <LogIn className="h-3.5 w-3.5" />
                {permLabel}
              </button>
            ) : (
              <span className={`rounded px-1.5 py-0.5 text-caption ${isEditable ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                {permLabel}
              </span>
            )}
            {meta.permission === 'comment' && !isAuthenticated && (
              <button
                type="button"
                onClick={() => navigate('/login', { state: { from: location } })}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-caption text-primary hover:bg-primary/10"
              >
                <LogIn className="h-3.5 w-3.5" />
                登录后评论
              </button>
            )}
            {isEditable && saveMessage && (
              <span className={`text-caption ${saveMessage === '已保存' ? 'text-muted-foreground' : 'text-destructive'}`}>
                {saveMessage}
              </span>
            )}
            <button type="button" onClick={handleCopyLink} className="ml-2 rounded p-1 hover:bg-muted" title="复制链接">
              {copied ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-4">
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/30">
                {meta.fields.map((field) => (
                  <th key={field.id} className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">
                    {field.name}
                  </th>
                ))}
                {access.canOpenRecordDetail && (
                  <th className="w-28 px-3 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">
                    记录协作
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {displayRecords.records.length === 0 ? (
                <tr>
                  <td
                    colSpan={meta.fields.length + (access.canOpenRecordDetail ? 1 : 0)}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    暂无数据
                  </td>
                </tr>
              ) : (
                displayRecords.records.map((record, rowIdx) => (
                  <tr key={getRecordId(record) || rowIdx} className="border-b last:border-b-0 hover:bg-muted/20">
                    {meta.fields.map((field) => {
                      const val = extractCellValue(record, field)
                      const display = formatCellValue(val, { emptyLabel: '' })
                      const recordId = getRecordId(record)
                      const cellKey = `${recordId}:${field.id}`
                      return (
                        <td key={field.id} className="max-w-[360px] px-3 py-2 align-top text-foreground" title={display}>
                          {isEditable ? (
                            <div className="flex items-center gap-1">
                              <input
                                key={`${cellKey}:${String(val ?? '')}`}
                                defaultValue={String(val ?? '')}
                                disabled={savingCellKey === cellKey || recordsLoading}
                                onBlur={(event) => void handleCellSave(record, field, event.currentTarget.value)}
                                className="min-w-[120px] max-w-[280px] rounded border border-transparent bg-transparent px-1 py-0.5 text-body outline-none hover:border-border focus:border-primary focus:bg-background"
                              />
                              {savingCellKey === cellKey && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
                            </div>
                          ) : (
                            <SharedReadOnlyCell field={field} value={val} onPreviewImage={setPreviewImage} />
                          )}
                        </td>
                      )
                    })}
                    {access.canOpenRecordDetail && (
                      <td className="px-3 py-2 text-right align-middle">
                        <button
                          type="button"
                          onClick={() => setSelectedRecordId(getRecordId(record))}
                          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-body text-primary hover:bg-primary/10"
                          aria-label={`查看记录 ${rowIdx + 1} 的详情与评论`}
                        >
                          <MessageSquare className="h-4 w-4" />
                          评论
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between">
            <div className="text-body text-muted-foreground">
              共 {displayRecords.total} 条，第 {page}/{totalPages} 页
            </div>
            <div className="flex items-center gap-2">
              <button type="button" disabled={page <= 1} onClick={() => handlePageChange(page - 1)}
                className="rounded border px-2 py-1 text-body hover:bg-muted disabled:opacity-50">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button type="button" disabled={page >= totalPages} onClick={() => handlePageChange(page + 1)}
                className="rounded border px-2 py-1 text-body hover:bg-muted disabled:opacity-50">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {access.canComment && detailModel && (
        <WebRecordFormContainer
          open
          onOpenChange={(open) => {
            if (!open) setSelectedRecordId(null)
          }}
          mode="edit"
          table={detailModel.table}
          fields={detailModel.fields}
          record={detailModel.record}
          editingRecordId={detailModel.record.id}
          canNavigatePrev={selectedRecordIndex > 0}
          canNavigateNext={selectedRecordIndex < displayRecords.records.length - 1}
          isReadonly
          loadAttachmentsFromTableApi={false}
          sharedRecordComments={{
            shareId: shareId ?? '',
            password: password || undefined,
          }}
          initialCommentsOpen
          subscribeCommentChanges={subscribeSharedCommentChanges}
          onNavigatePrev={() => {
            const previous = displayRecords.records[selectedRecordIndex - 1]
            if (previous) setSelectedRecordId(getRecordId(previous))
          }}
          onNavigateNext={() => {
            const next = displayRecords.records[selectedRecordIndex + 1]
            if (next) setSelectedRecordId(getRecordId(next))
          }}
          createRecord={rejectShareScopedRecordMutation}
          updateRecord={rejectShareScopedRecordMutation}
        />
      )}

      {previewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setPreviewImage(null)}
        >
          <div className="max-h-full max-w-5xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-3 text-white">
              <div className="truncate text-body font-medium">{previewImage.name}</div>
              <button
                type="button"
                className="rounded bg-white/10 px-2 py-1 text-body hover:bg-white/20"
                onClick={() => setPreviewImage(null)}
              >
                关闭
              </button>
            </div>
            <img
              src={previewImage.url}
              alt={previewImage.name}
              className="max-h-[82vh] max-w-full rounded bg-white object-contain"
            />
          </div>
        </div>
      )}
    </div>
  )
}
