/**
 * SharedDocPage — 公开文档查看/编辑页
 *
 * 通过 share_id 访问；view 可公开查看，comment/edit 需要登录后交互。
 * 支持密码保护；permission=edit 时可编辑并自动保存。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import {
  FileText,
  Lock,
  Download,
  Copy,
  CheckCircle2,
  Loader2,
  AlertCircle,
  LogIn,
  ShieldAlert,
} from 'lucide-react'
import '@tabtin/tabdoc-ui/editor/prosemirror.css'
import type { TabDocHostActions } from '@tabtin/app-host-sdk'
import {
  DocumentCommentsSection,
  HtmlArtifactLoaderProvider,
  HtmlBlockAccessProvider,
  ImageAssetLoaderProvider,
  buildCommentAnchorFromSelection,
  createShareHtmlArtifactLoader,
  createShareImageAssetLoader,
  type BuildCommentAnchorResult,
  type DocumentCommentMentionCandidate,
  type EditorInstance,
} from '@tabtin/tabdoc-ui/editor'
import { TabDocHostActionsProvider, markdownToPlaintext } from '@tabtin/tabdoc-ui'
import { API_BASE_URL, buildHtmlBlockBrowserUrl } from '@/config/api'
import { useAuthStore } from '@/stores/auth-store'
import { useShareNavigation } from '@/components/layout/ShareNavigationContext'
import { getAccessToken, shareAuthHeaders } from './shareAuth'
import { SharedDocCollabRenderer } from './SharedDocCollabRenderer'
import { SharedDocCollabEditor } from './SharedDocCollabEditor'
import { useShareDocEventStream } from './hooks/useShareDocEventStream'
import {
  SharedDocCommentThreadsHost,
  type CommentThreadsCapabilityMode,
} from './commentThreads/SharedDocCommentThreadsHost'
import { canAccessShareComments } from './commentThreads/shareCommentPermission'

interface SharedDocLocationNode {
  id: string
  title: string
  icon?: string
}

interface SharedDocMeta {
  share_id: string
  share_type: string
  title: string
  icon: string
  cover_image: string
  cover_position: number
  cover_position_x?: number
  cover_scale?: number
  has_password: boolean
  permission: string
  requires_login?: boolean
  allow_download: boolean
  allow_copy: boolean
  created_at: string | null
  document_id?: string | null
  space_id?: string | null
  organization_id?: string | null
  location_path?: SharedDocLocationNode[]
}

interface SharedDocContent {
  title: string
  icon: string
  cover_image: string
  description_json: Record<string, unknown> | null
  description_markdown: string
  description_plaintext: string
  font_style: string
  is_full_width: boolean
  tags: string[]
  latest_version: number
  updated_at: string | null
}

interface SharedDocComment {
  id: string
  author_name: string
  author_user_id?: string | null
  author_avatar?: string | null
  author_account_name?: string | null
  selected_text: string
  body: string
  mention_user_ids?: string[]
  created_at: string | null
}

interface SharedMentionCandidateDto {
  user_id: string
  display_name: string
  account_name?: string | null
  avatar?: string | null
  email?: string | null
}

type PageState =
  | { type: 'loading' }
  | { type: 'password'; meta: SharedDocMeta }
  | { type: 'content'; meta: SharedDocMeta; content: SharedDocContent }
  | { type: 'not_found' }
  | { type: 'expired' }
  | { type: 'login_required'; message: string }
  | { type: 'forbidden' }
  | { type: 'error'; message: string }

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

const baseApiUrl = API_BASE_URL || '/api'
const AUTO_SAVE_DELAY_MS = 1200
/** 已打开的分享页复查访问权：收窄/关闭后尽快切到失效态（无需整页手动刷新） */
const SHARE_ACCESS_RECHECK_INTERVAL_MS = 15_000

function mapShareAccessFailure(
  status: number | undefined,
  isAuthenticated: boolean,
): PageState {
  if (status === 410) return { type: 'expired' }
  if (status === 404) return { type: 'not_found' }
  if (status === 403) {
    return isAuthenticated
      ? { type: 'forbidden' }
      : { type: 'login_required', message: '请登录后查看' }
  }
  return { type: 'error', message: `加载失败 (${status ?? 'unknown'})` }
}

function normalizeMentionLabel(value?: string | null): string {
  return (value || '').trim()
}

function buildMentionCandidate(input: {
  userId?: string | null
  displayName?: string | null
  accountName?: string | null
  avatar?: string | null
  email?: string | null
}): DocumentCommentMentionCandidate | null {
  const userId = normalizeMentionLabel(input.userId)
  if (!userId) return null
  const displayName = normalizeMentionLabel(input.displayName)
    || normalizeMentionLabel(input.accountName)
    || userId.slice(0, 8)
  const accountName = normalizeMentionLabel(input.accountName)
  return {
    userId,
    displayName,
    accountName: accountName || null,
    avatar: input.avatar || null,
    email: normalizeMentionLabel(input.email) || null,
    labels: [input.displayName, input.accountName, input.email, userId]
      .map(normalizeMentionLabel)
      .filter(Boolean),
  }
}

function shareRequiresLogin(meta: SharedDocMeta): boolean {
  return Boolean(meta.requires_login) || meta.permission === 'comment' || meta.permission === 'edit'
}

function normalizeCoverPosition(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

function normalizeCoverScale(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(3, Math.max(1, value))
}

function coverBackgroundSize(scale: number): string {
  const normalized = normalizeCoverScale(scale)
  if (normalized <= 1) return 'cover'
  return `${normalized * 100}% auto`
}

async function fetchShareMeta(shareId: string, password?: string): Promise<{ ok: boolean; data?: SharedDocMeta; status?: number }> {
  const params = new URLSearchParams()
  if (password) params.set('password', password)
  const query = params.toString()
  const resp = await fetch(`${baseApiUrl}/tabdoc/shared/${shareId}${query ? `?${query}` : ''}`, { headers: shareAuthHeaders() })
  if (resp.status === 404) return { ok: false, status: 404 }
  if (resp.status === 410) return { ok: false, status: 410 }
  if (!resp.ok) return { ok: false, status: resp.status }
  const json = await resp.json()
  return { ok: true, data: json.data ?? json }
}

async function fetchShareContent(shareId: string, password?: string): Promise<{ ok: boolean; data?: SharedDocContent; error?: string; status?: number }> {
  const url = password
    ? `${baseApiUrl}/tabdoc/shared/${shareId}/verify`
    : `${baseApiUrl}/tabdoc/shared/${shareId}/content`

  const resp = password
    ? await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...shareAuthHeaders() },
        body: JSON.stringify({ password }),
      })
    : await fetch(url, { headers: shareAuthHeaders() })

  if (!resp.ok) {
    const json = await resp.json().catch(() => ({}))
    return { ok: false, error: json.message || json.detail || `HTTP ${resp.status}`, status: resp.status }
  }
  const json = await resp.json()
  return { ok: true, data: json.data ?? json }
}

async function fetchShareComments(shareId: string, password?: string): Promise<{ ok: boolean; data?: SharedDocComment[]; error?: string; status?: number }> {
  const params = new URLSearchParams()
  if (password) params.set('password', password)
  const query = params.toString()
  const url = `${baseApiUrl}/tabdoc/shared/${shareId}/comments${query ? `?${query}` : ''}`
  const resp = await fetch(url, { headers: shareAuthHeaders() })
  if (!resp.ok) {
    const json = await resp.json().catch(() => ({}))
    return { ok: false, error: json.message || json.detail || `HTTP ${resp.status}`, status: resp.status }
  }
  const json = await resp.json()
  const data = json.data ?? json
  return { ok: true, data: data.comments ?? [] }
}

async function fetchShareMentionCandidates(
  shareId: string,
  password?: string,
): Promise<{ ok: boolean; data?: SharedMentionCandidateDto[]; error?: string; status?: number }> {
  const params = new URLSearchParams()
  if (password) params.set('password', password)
  const query = params.toString()
  const url = `${baseApiUrl}/tabdoc/shared/${shareId}/mention-candidates${query ? `?${query}` : ''}`
  const resp = await fetch(url, { headers: shareAuthHeaders() })
  if (!resp.ok) {
    const json = await resp.json().catch(() => ({}))
    return { ok: false, error: json.message || json.detail || `HTTP ${resp.status}`, status: resp.status }
  }
  const json = await resp.json()
  const data = json.data ?? json
  return { ok: true, data: data.candidates ?? [] }
}

async function saveShareContent(
  shareId: string,
  payload: {
    password?: string
    base_version: number
    base_updated_at?: string | null
    content_pm_json: Record<string, unknown>
    content_markdown: string
    content_plaintext: string
  },
): Promise<{ ok: boolean; data?: { latest_version: number; updated_at?: string | null }; error?: string; status?: number }> {
  const resp = await fetch(`${baseApiUrl}/tabdoc/shared/${shareId}/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...shareAuthHeaders() },
    body: JSON.stringify(payload),
  })
  if (!resp.ok) {
    const json = await resp.json().catch(() => ({}))
    const backendMessage =
      typeof json.message === 'string'
        ? json.message
        : typeof json.detail === 'string'
          ? json.detail
          : undefined
    return {
      ok: false,
      error: backendMessage,
      status: resp.status,
    }
  }
  const json = await resp.json()
  return { ok: true, data: json.data ?? json }
}

async function createShareComment(
  shareId: string,
  payload: {
    password?: string
    body: string
    selected_text: string
    author_name: string
    mention_user_ids?: string[]
  },
): Promise<{ ok: boolean; data?: SharedDocComment; error?: string; status?: number }> {
  const resp = await fetch(`${baseApiUrl}/tabdoc/shared/${shareId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...shareAuthHeaders() },
    body: JSON.stringify(payload),
  })
  if (!resp.ok) {
    const json = await resp.json().catch(() => ({}))
    return { ok: false, error: json.message || json.detail || `HTTP ${resp.status}`, status: resp.status }
  }
  const json = await resp.json()
  const data = json.data ?? json
  return { ok: true, data: data.comment }
}

function permissionLabel(permission: string): string | null {
  if (permission === 'view') return '只读'
  if (permission === 'comment') return '可评论'
  if (permission === 'edit') return '可编辑'
  return null
}

export function SharedDocPage() {
  const { shareId } = useParams<{ shareId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const isAuthInitializing = useAuthStore((s) => s.isInitializing)
  const currentUser = useAuthStore((s) => s.user)
  const { setActiveShare } = useShareNavigation()
  const [state, setState] = useState<PageState>({ type: 'loading' })
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveMessage, setSaveMessage] = useState('')
  const [comments, setComments] = useState<SharedDocComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState('')
  const [commentBody, setCommentBody] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const [mentionCandidates, setMentionCandidates] = useState<DocumentCommentMentionCandidate[]>([])
  const [htmlRevokeEpoch, setHtmlRevokeEpoch] = useState(0)
  const [commentCapabilityMode, setCommentCapabilityMode] = useState<CommentThreadsCapabilityMode>('loading')
  const [commentRailOpen, setCommentRailOpen] = useState(false)
  const [activeCommentThreadId, setActiveCommentThreadId] = useState<string | null>(null)
  const [pendingCommentAnchor, setPendingCommentAnchor] = useState<BuildCommentAnchorResult | null>(null)
  const [commentFocusToken, setCommentFocusToken] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  )
  const [threadRealtimeEvent, setThreadRealtimeEvent] = useState<{
    type: string
    action?: string | null
    token: number
  } | null>(null)

  const verifiedPasswordRef = useRef<string | undefined>(undefined)
  const deletedCommentIdsRef = useRef(new Set<string>())
  const editorInstanceRef = useRef<EditorInstance | null>(null)
  const baseVersionRef = useRef<number>(0)
  const baseUpdatedAtRef = useRef<string | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const pendingDraftRef = useRef<{
    pmJson: Record<string, unknown>
    markdown: string
    plaintext: string
  } | null>(null)
  const isSavingRef = useRef(false)

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const htmlArtifactLoader = useMemo(
    () =>
      createShareHtmlArtifactLoader({
        apiBaseUrl: baseApiUrl,
        getAccessToken,
      }),
    [],
  )
  const imageAssetLoader = useMemo(
    () => createShareImageAssetLoader({ apiBaseUrl: baseApiUrl, getAccessToken }),
    [],
  )
  const sharedDocumentId =
    state.type === 'content' || state.type === 'password'
      ? state.meta.document_id ?? undefined
      : undefined
  const htmlBlockAccess = useMemo(
    () => ({
      documentId: sharedDocumentId,
      shareId: shareId ?? undefined,
      password: verifiedPasswordRef.current || password || undefined,
      revokeEpoch: htmlRevokeEpoch,
    }),
    [sharedDocumentId, shareId, password, htmlRevokeEpoch, state.type],
  )
  // 分享页已知 shareId：直接构造稳定 URL，无需再调 browser-link
  const shareHostActions = useMemo((): TabDocHostActions => {
    return {
      async openResource() {},
      async openWebUrl(webInput) {
        window.open(webInput.url, '_blank', 'noopener,noreferrer')
      },
      async openHtmlArtifactInBrowser(browserInput) {
        const url = buildHtmlBlockBrowserUrl(
          browserInput.documentId,
          browserInput.blockId,
          shareId,
          browserInput.fileId,
        )
        if (!url) {
          throw new Error('Public web base URL is required to open HTML block in browser')
        }
        window.open(url, '_blank', 'noopener,noreferrer')
      },
      async createEmbeddedTable() {
        throw new Error('分享页不支持创建嵌入表格')
      },
      async listTables() {
        return []
      },
      async syncResourceMeta() {},
      async syncResourceTitle() {},
    }
  }, [shareId])

  const canComment =
    state.type === 'content' && canAccessShareComments(state.meta.permission)
  const canCommentRealtime = isAuthenticated && canComment
  const useLegacyComments = canComment && commentCapabilityMode === 'legacy'

  const loadComments = useCallback(async () => {
    if (!shareId || state.type !== 'content') return
    if (!canAccessShareComments(state.meta.permission)) {
      setComments([])
      return
    }
    // 线程能力可用时不请求旧 /comments
    if (commentCapabilityMode === 'threads' || commentCapabilityMode === 'loading') {
      return
    }
    setCommentsLoading(true)
    setCommentsError('')
    const result = await fetchShareComments(shareId, verifiedPasswordRef.current)
    setCommentsLoading(false)
    if (!result.ok) {
      setCommentsError(result.error || '评论加载失败')
      return
    }
    setComments(
      (result.data ?? []).filter((comment) => !deletedCommentIdsRef.current.has(comment.id)),
    )
  }, [commentCapabilityMode, shareId, state])

  const startCommentFromSelection = useCallback(() => {
    if (commentCapabilityMode !== 'threads') return
    const editor = editorInstanceRef.current
    if (!editor) return
    // 分享页无 y-prosemirror 依赖：走 blockId/上下文回退锚点
    const built = buildCommentAnchorFromSelection(editor, { yjsCodec: null })
    if (!built) {
      window.alert('请先选择要评论的内容')
      return
    }
    setPendingCommentAnchor(built)
    setActiveCommentThreadId(null)
    setCommentRailOpen(true)
    setCommentFocusToken((token) => token + 1)
  }, [commentCapabilityMode])

  useEffect(() => {
    let cancelled = false
    if (!shareId || state.type !== 'content') {
      setMentionCandidates([])
      return
    }
    if (!canAccessShareComments(state.meta.permission)) {
      setMentionCandidates([])
      return
    }
    void fetchShareMentionCandidates(shareId, verifiedPasswordRef.current)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setMentionCandidates([])
          return
        }
        const seen = new Set<string>()
        const nextCandidates: DocumentCommentMentionCandidate[] = []
        const appendCandidate = (candidate: DocumentCommentMentionCandidate | null) => {
          if (!candidate || seen.has(candidate.userId)) return
          seen.add(candidate.userId)
          nextCandidates.push(candidate)
        }
        for (const item of result.data ?? []) {
          appendCandidate(buildMentionCandidate({
            userId: item.user_id,
            displayName: item.display_name,
            accountName: item.account_name,
            avatar: item.avatar,
            email: item.email,
          }))
        }
        appendCandidate(buildMentionCandidate({
          userId: currentUser?.id,
          displayName: currentUser?.nickname,
          accountName: currentUser?.username,
          avatar: currentUser?.avatar,
          email: currentUser?.email,
        }))
        setMentionCandidates(nextCandidates)
      })
      .catch(() => {
        if (!cancelled) setMentionCandidates([])
      })
    return () => {
      cancelled = true
    }
  }, [
    currentUser?.avatar,
    currentUser?.email,
    currentUser?.id,
    currentUser?.nickname,
    currentUser?.username,
    shareId,
    state,
  ])

  useShareDocEventStream({
    shareId: shareId || '',
    password: verifiedPasswordRef.current,
    enabled: Boolean(shareId) && canCommentRealtime,
    onCommentEvent: (event) => {
      if (!useLegacyComments) return
      if (event.action === 'deleted') {
        deletedCommentIdsRef.current.add(event.commentId)
        setComments((items) => items.filter((item) => item.id !== event.commentId))
        return
      }
      void loadComments()
    },
    onThreadRealtimeEvent: (event) => {
      if (commentCapabilityMode !== 'threads') return
      setThreadRealtimeEvent({
        type: event.type,
        action: event.action,
        token: Date.now(),
      })
    },
    onResync: () => {
      if (useLegacyComments) {
        void loadComments()
        return
      }
      if (commentCapabilityMode === 'threads') {
        setThreadRealtimeEvent({
          type: 'share.events.comment_thread',
          action: 'updated',
          token: Date.now(),
        })
      }
    },
  })

  useEffect(() => {
    if (!shareId) { setState({ type: 'not_found' }); return }
    let cancelled = false

    void (async () => {
      const metaResult = await fetchShareMeta(shareId)
      if (cancelled) return

      if (!metaResult.ok) {
        setState(mapShareAccessFailure(metaResult.status, isAuthenticated))
        return
      }

      const meta = metaResult.data!
      if (shareRequiresLogin(meta)) {
        if (isAuthInitializing) return
        if (!isAuthenticated) {
          setState({ type: 'login_required', message: '此分享需要登录后才能编辑或评论' })
          return
        }
      }
      if (meta.has_password) {
        setState({ type: 'password', meta })
        return
      }

      const contentResult = await fetchShareContent(shareId)
      if (cancelled) return
      if (!contentResult.ok) {
        if (contentResult.status === 403 && !isAuthenticated) {
          setState({ type: 'login_required', message: '此分享需要登录后才能编辑或评论' })
          return
        }
        setState({ type: 'error', message: contentResult.error || '加载内容失败' })
        return
      }
      const content = contentResult.data!
      baseVersionRef.current = content.latest_version ?? 0
      baseUpdatedAtRef.current = content.updated_at
      setState({ type: 'content', meta, content })
    })()

    return () => { cancelled = true }
  }, [shareId, isAuthenticated, isAuthInitializing])

  // ：收窄/关闭分享后，已打开页应尽快失效（首屏只拉一次会继续看内存快照）
  const recheckShareAccess = useCallback(async () => {
    if (!shareId) return
    if (state.type !== 'content' && state.type !== 'password') return

    const metaResult = await fetchShareMeta(shareId, verifiedPasswordRef.current)
    if (!metaResult.ok) {
      // ：同步 revoke 已创建的私有 HTML Blob，避免关掉分享后仍可看内存 iframe。
      setHtmlRevokeEpoch((value) => value + 1)
      setState(mapShareAccessFailure(metaResult.status, isAuthenticated))
    }
  }, [isAuthenticated, shareId, state.type])

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

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (state.type !== 'content') {
      setComments([])
      setCommentCapabilityMode('loading')
      return
    }
    if (!canAccessShareComments(state.meta.permission)) {
      setComments([])
      setCommentCapabilityMode('loading')
      return
    }
    void loadComments()
  }, [state, loadComments])

  useEffect(() => {
    if (useLegacyComments) {
      void loadComments()
    }
  }, [loadComments, useLegacyComments])

  useEffect(() => {
    if (!shareId || state.type !== 'content') {
      setActiveShare(null)
      return
    }
    const { meta, content } = state
    setActiveShare({
      kind: 'doc',
      shareId,
      title: content.title || meta.title || '未命名文档',
      icon: content.icon || meta.icon || undefined,
      documentId: meta.document_id ?? null,
      spaceId: meta.space_id ?? null,
      organizationId: meta.organization_id ?? null,
      locationPath: meta.location_path ?? [],
    })
    return () => setActiveShare(null)
  }, [shareId, state, setActiveShare])

  const flushSave = useCallback(async () => {
    if (!shareId || state.type !== 'content' || state.meta.permission !== 'edit') return
    const draft = pendingDraftRef.current
    if (!draft || isSavingRef.current) return

    isSavingRef.current = true
    setSaveState('saving')
    setSaveMessage('')

    const result = await saveShareContent(shareId, {
      password: verifiedPasswordRef.current,
      base_version: baseVersionRef.current,
      base_updated_at: baseUpdatedAtRef.current,
      content_pm_json: draft.pmJson,
      content_markdown: draft.markdown,
      content_plaintext: draft.plaintext,
    })

    isSavingRef.current = false

    if (!result.ok) {
      setSaveState('error')
      setSaveMessage(
        result.status === 409
          ? '版本冲突，请刷新页面后重试'
          : result.error || '保存失败，请稍后重试',
      )
      return
    }

    if (result.data?.latest_version != null) {
      baseVersionRef.current = result.data.latest_version
    }
    if (result.data?.updated_at) {
      baseUpdatedAtRef.current = result.data.updated_at
    }
    pendingDraftRef.current = null
    setSaveState('saved')
    setSaveMessage('已保存')
    window.setTimeout(() => {
      setSaveState((current) => (current === 'saved' ? 'idle' : current))
      setSaveMessage('')
    }, 2000)
  }, [shareId, state])

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      void flushSave()
    }, AUTO_SAVE_DELAY_MS)
  }, [flushSave])

  const handleEditorUpdate = useCallback((editor: EditorInstance) => {
    if (state.type !== 'content' || state.meta.permission !== 'edit') return
    const markdown = (editor.storage as { markdown?: { getMarkdown?: () => string } }).markdown?.getMarkdown?.() ?? ''
    const pmJson = editor.getJSON() as Record<string, unknown>
    const plaintext = markdownToPlaintext(markdown)
    pendingDraftRef.current = { pmJson, markdown, plaintext }
    setSaveState('idle')
    scheduleSave()
  }, [state, scheduleSave])

  const handlePasswordSubmit = useCallback(async () => {
    if (!shareId || !password.trim()) return
    setVerifying(true)
    setPasswordError('')

    const result = await fetchShareContent(shareId, password.trim())

    if (!result.ok) {
      setVerifying(false)
      if (result.status === 403) setPasswordError('密码错误')
      else setPasswordError(result.error || '验证失败')
      return
    }

    const verifiedPassword = password.trim()
    const verifiedMetaResult = await fetchShareMeta(shareId, verifiedPassword)
    if (!verifiedMetaResult.ok || !verifiedMetaResult.data) {
      setVerifying(false)
      setPasswordError('验证成功，但权限信息加载失败')
      return
    }

    setVerifying(false)
    if (shareRequiresLogin(verifiedMetaResult.data) && !isAuthenticated) {
      setState({ type: 'login_required', message: '此分享需要登录后才能编辑或评论' })
      return
    }
    verifiedPasswordRef.current = verifiedPassword
    const content = result.data!
    baseVersionRef.current = content.latest_version ?? 0
    baseUpdatedAtRef.current = content.updated_at

    if (state.type === 'password') {
      setState({ type: 'content', meta: verifiedMetaResult.data, content })
    }
  }, [shareId, password, state, isAuthenticated])

  const handleCopyLink = useCallback(async () => {
    await navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  const handleDownload = useCallback(() => {
    if (state.type !== 'content') return
    const blob = new Blob([state.content.description_markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${state.content.title || '文档'}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [state])

  const handleSubmitComment = useCallback(async (mentionUserIds: string[]) => {
    if (!shareId || state.type !== 'content') return
    if (!canAccessShareComments(state.meta.permission)) return

    const body = commentBody.trim()
    if (!body) {
      setCommentsError('请输入评论内容')
      return
    }

    setCommentSubmitting(true)
    setCommentsError('')
    const result = await createShareComment(shareId, {
      password: verifiedPasswordRef.current,
      body,
      selected_text: '',
      author_name: '',
      mention_user_ids: mentionUserIds,
    })
    setCommentSubmitting(false)

    if (!result.ok || !result.data) {
      setCommentsError(result.error || '评论发送失败')
      return
    }

    setComments((items) => [...items, result.data!])
    setCommentBody('')
  }, [commentBody, shareId, state])

  const handleCommentBodyChange = useCallback((nextValue: string) => {
    setCommentBody(nextValue)
  }, [])

  const handleEditorReady = useCallback((editor: EditorInstance | null) => {
    editorInstanceRef.current = editor
  }, [])

  if (state.type === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
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
        <div className="text-body text-muted-foreground">此分享链接已超过有效期</div>
      </div>
    )
  }

  if (state.type === 'login_required') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6">
        <Lock className="h-10 w-10 text-muted-foreground" />
        <div className="text-title font-semibold text-foreground">需要登录</div>
        <div className="text-body text-muted-foreground">{state.message}</div>
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
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Lock className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="text-center">
              <div className="text-subtitle font-semibold text-foreground">
                {state.meta.icon && <span className="mr-2">{state.meta.icon}</span>}
                {state.meta.title || '受保护的文档'}
              </div>
              <div className="mt-1 text-body text-muted-foreground">请输入密码以查看内容</div>
            </div>
            <div className="w-full space-y-3">
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handlePasswordSubmit() }}
                placeholder="输入访问密码"
                className="w-full rounded-lg border bg-background px-3 py-2 text-body text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-2 focus:ring-primary/30"
              />
              {passwordError && (
                <div className="text-body text-destructive">{passwordError}</div>
              )}
              <button
                type="button"
                disabled={verifying || !password.trim()}
                onClick={() => void handlePasswordSubmit()}
                className="w-full rounded-lg bg-primary px-4 py-2 text-body font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {verifying ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : '确认访问'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const { meta, content } = state
  const fontClass = content.font_style === 'serif' ? 'font-serif' : content.font_style === 'mono' ? 'font-mono' : 'font-sans'
  const isEditable = meta.permission === 'edit'
  const pageCanComment = canAccessShareComments(meta.permission)
  const permLabel = permissionLabel(meta.permission)
  const verifiedPassword = verifiedPasswordRef.current || password || undefined
  const coverPositionX = normalizeCoverPosition(meta.cover_position_x)
  const coverPositionY = normalizeCoverPosition(meta.cover_position)
  const coverScale = normalizeCoverScale(meta.cover_scale)
  const locationPath = meta.location_path ?? []
  const pathLabel = locationPath
    .map((node) => node.title?.trim() || '未命名')
    .join(' / ')
  return (
    <div className="min-h-screen bg-background">
      {content.cover_image && (
        <div
          className="h-[200px] w-full bg-cover bg-center"
          style={{
            backgroundImage: (() => {
              try {
                const parsed = new URL(content.cover_image)
                if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return `url("${parsed.href.replace(/["\\]/g, '')}")`
              } catch { /* */ }
              return 'none'
            })(),
            backgroundPosition: `${coverPositionX * 100}% ${coverPositionY * 100}%`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: coverBackgroundSize(coverScale),
          }}
        />
      )}

      <div className={`mx-auto px-6 py-8 ${content.is_full_width ? 'max-w-none' : 'max-w-[920px]'}`}>
        <main className="min-w-0">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <FileText className="h-4 w-4 shrink-0" />
                <span className="truncate text-body">{content.title || meta.title || '分享文档'}</span>
                {permLabel && (
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-caption ${isEditable ? 'bg-primary/10 text-primary' : pageCanComment ? 'bg-info/10 text-info' : 'bg-muted'}`}>
                    {permLabel}
                  </span>
                )}
                {isEditable && saveState !== 'idle' && (
                  <span className={`shrink-0 text-caption ${saveState === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {saveState === 'saving' && (
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" /> 保存中…
                      </span>
                    )}
                    {saveState === 'saved' && saveMessage}
                    {saveState === 'error' && saveMessage}
                  </span>
                )}
              </div>
              {pathLabel ? (
                <div className="truncate pl-6 text-caption text-muted-foreground/80" title={pathLabel}>
                  {pathLabel}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              {meta.allow_download && (
                <button type="button" onClick={handleDownload} className="flex items-center gap-1 rounded px-2 py-1 text-body text-muted-foreground hover:bg-muted hover:text-foreground" title="下载 Markdown">
                  <Download className="h-3.5 w-3.5" />
                </button>
              )}
              <button type="button" onClick={handleCopyLink} className="flex items-center gap-1 rounded px-2 py-1 text-body text-muted-foreground hover:bg-muted hover:text-foreground" title="复制链接">
                {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {content.icon && (
            <div className="mb-2 text-display">{content.icon}</div>
          )}

          <h1 className="mb-6 text-display font-semibold text-foreground">{content.title}</h1>

          {content.tags.length > 0 && (
            <div className="mb-6 flex flex-wrap gap-1.5">
              {content.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-muted px-2.5 py-0.5 text-caption text-muted-foreground">{tag}</span>
              ))}
            </div>
          )}

          <div className={`tabdoc-page ${fontClass}`}>
            <TabDocHostActionsProvider value={shareHostActions}>
              <HtmlArtifactLoaderProvider value={htmlArtifactLoader}>
                <ImageAssetLoaderProvider value={imageAssetLoader}>
                  <HtmlBlockAccessProvider value={htmlBlockAccess}>
                  {isEditable ? (
                    <SharedDocCollabEditor
                      shareId={shareId ?? ''}
                      password={verifiedPassword}
                      contentJson={content.description_json}
                      contentMarkdown={content.description_markdown}
                      onFallbackUpdate={handleEditorUpdate}
                      enableComments={pageCanComment && commentCapabilityMode !== 'legacy'}
                      editorRef={editorInstanceRef}
                      onEditorReady={handleEditorReady}
                      onStartComment={
                        commentCapabilityMode === 'threads' ? startCommentFromSelection : undefined
                      }
                      yjsCodec={null}
                    />
                  ) : (
                    <SharedDocCollabRenderer
                      shareId={shareId ?? ''}
                      password={verifiedPassword}
                      contentJson={content.description_json}
                      contentMarkdown={content.description_markdown}
                      enabled
                      enableComments={pageCanComment && commentCapabilityMode !== 'legacy'}
                      editorRef={editorInstanceRef}
                      onEditorReady={handleEditorReady}
                      onStartComment={
                        commentCapabilityMode === 'threads' ? startCommentFromSelection : undefined
                      }
                      yjsCodec={null}
                    />
                  )}
                  </HtmlBlockAccessProvider>
                </ImageAssetLoaderProvider>
              </HtmlArtifactLoaderProvider>
            </TabDocHostActionsProvider>
          </div>

          {content.updated_at && (
            <div className="mt-12 border-t pt-4 text-caption text-muted-foreground">
              最后更新：{new Date(content.updated_at).toLocaleString('zh-CN')}
            </div>
          )}

          {pageCanComment && commentCapabilityMode !== 'legacy' ? (
            <SharedDocCommentThreadsHost
              shareId={shareId ?? ''}
              password={verifiedPassword}
              editorRef={editorInstanceRef}
              yjsCodec={null}
              railOpen={commentRailOpen}
              onRailOpenChange={setCommentRailOpen}
              activeThreadId={activeCommentThreadId}
              onActiveThreadIdChange={setActiveCommentThreadId}
              pendingAnchor={pendingCommentAnchor}
              onPendingAnchorConsumed={() => setPendingCommentAnchor(null)}
              focusComposerToken={commentFocusToken}
              viewportWidth={viewportWidth}
              mentionCandidates={mentionCandidates}
              realtimeEvent={threadRealtimeEvent}
              onCapabilityModeChange={setCommentCapabilityMode}
            />
          ) : null}

          {pageCanComment && useLegacyComments ? (
            <DocumentCommentsSection
              comments={comments}
              value={commentBody}
              onValueChange={handleCommentBodyChange}
              onSubmit={handleSubmitComment}
              mentionCandidates={mentionCandidates}
              currentUserId={currentUser?.id ?? null}
              onRetry={loadComments}
              isLoading={commentsLoading}
              isSubmitting={commentSubmitting}
              error={commentsError}
              labels={{
                title: '全文评论',
                placeholder: '输入评论，试试 @ 提及成员',
                submit: '发送评论',
                retry: '重试',
                loading: '正在加载评论...',
                unknownUser: '用户',
                noMentionResults: '没有匹配的成员',
              }}
              locale="zh-CN"
            />
          ) : null}
        </main>
      </div>
    </div>
  )
}
