/**
 * SharedHtmlPage — HTML 块「在浏览器打开」稳定页
 *
 * 路由：/shared/docs/:documentId/html/:blockId?share_id=
 * - 身份 = documentId + blockId；权限继承文档（成员 ACL / DocumentShare）
 * - 密码只走 POST body，不进 query
 * - 关闭文档分享后外链失效；成员仍可通过登录 ACL 打开
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { AlertCircle, Code2, Loader2, Lock, LogIn, ShieldAlert } from 'lucide-react'
import { API_BASE_URL } from '@/config/api'
import { STORAGE_KEYS } from '@/platform'
import { useAuthStore } from '@/stores/auth-store'
import { getAccessToken, shareAuthHeaders } from './shareAuth'

const TABTIN_WEB_AUTH_HANDOFF_PREFIX = 'tabtin_handoff='

/**
 * Electron tabweb 与本页 localStorage 不共享；打开时可用 hash 一次性注入 access token。
 * hash 不进 HTTP；读完立刻 replaceState 清掉，避免地址栏泄露、也可复制干净 URL。
 */
function consumeTabtinWebAuthHandoff(): boolean {
  if (typeof window === 'undefined') return false
  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash
  if (!rawHash.startsWith(TABTIN_WEB_AUTH_HANDOFF_PREFIX)) return false
  const token = decodeURIComponent(rawHash.slice(TABTIN_WEB_AUTH_HANDOFF_PREFIX.length)).trim()
  const cleanUrl = `${window.location.pathname}${window.location.search}`
  window.history.replaceState(null, '', cleanUrl)
  if (!token) return false
  localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, token)
  return true
}

type PageState =
  | { type: 'loading' }
  | { type: 'ready'; objectUrl: string }
  | { type: 'password'; error?: string }
  | { type: 'login_required' }
  | { type: 'forbidden' }
  | { type: 'not_found' }
  | { type: 'error'; message: string }

const baseApiUrl = API_BASE_URL || '/api'
/** 与 SharedDocPage 同口径：关闭分享后尽快失效已打开页；成员 ACL 仍 200 则不踢 */
const SHARE_ACCESS_RECHECK_INTERVAL_MS = 5_000

function mapAccessFailure(
  status: number,
  code: string | undefined,
  isAuthenticated: boolean,
  message?: string,
): PageState {
  // handoff 只写了 localStorage，zustand 可能仍未 hydrate；有 Bearer 即视为已登录
  const token = getAccessToken()
  const authed = isAuthenticated || Boolean(token)
  if (status === 404 || status === 410) return { type: 'not_found' }
  if (code === 'PASSWORD_REQUIRED') return { type: 'password' }
  if (code === 'INCORRECT_PASSWORD') return { type: 'password', error: '密码错误，请重试' }
  if (status === 401) return { type: 'login_required' }
  if (status === 403) {
    // 坏/过期 JWT：JWTAuthOptional 按匿名处理，API 仍 403 +「Need login」——清掉死 token 引导登录
    const needsLogin =
      !authed ||
      (typeof message === 'string' && /need login/i.test(message))
    if (needsLogin) {
      if (token) {
        try {
          localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN)
        } catch {
          /* ignore */
        }
      }
      return { type: 'login_required' }
    }
    return { type: 'forbidden' }
  }
  return { type: 'error', message: `加载失败 (${status})` }
}

async function readErrorPayload(response: Response): Promise<{ code?: string; message?: string }> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return {}
  try {
    const json = (await response.json()) as { code?: string; message?: string }
    return { code: json.code, message: json.message }
  } catch {
    return {}
  }
}

export function SharedHtmlPage() {
  const { documentId = '', blockId = '' } = useParams<{
    documentId: string
    blockId: string
  }>()
  const [searchParams] = useSearchParams()
  const shareId = (searchParams.get('share_id') || '').trim()
  // 协作未落库时短期 hint；服务端在 ACL / 已校验 DocumentShare + FileUsage 下兜底
  const fileIdHint = (searchParams.get('file_id') || '').trim()
  const location = useLocation()
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const [state, setState] = useState<PageState>({ type: 'loading' })
  const [password, setPassword] = useState('')
  const [verifying, setVerifying] = useState(false)
  const objectUrlRef = useRef<string | null>(null)
  const verifiedPasswordRef = useRef<string | undefined>(undefined)

  const revokeObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [])

  const applyState = useCallback(
    (next: PageState) => {
      if (next.type !== 'ready') {
        revokeObjectUrl()
      }
      setState(next)
    },
    [revokeObjectUrl],
  )

  const fetchBrowserHtml = useCallback(
    async (passwordOverride?: string): Promise<PageState> => {
      if (!documentId || !blockId) return { type: 'not_found' }
      try {
        const response = await fetch(
          `${baseApiUrl}/tabdoc/documents/${encodeURIComponent(documentId)}` +
            `/html-blocks/${encodeURIComponent(blockId)}/browser`,
          {
            method: 'POST',
            headers: {
              Accept: 'text/html,*/*',
              'Content-Type': 'application/json',
              ...shareAuthHeaders(),
            },
            body: JSON.stringify({
              share_id: shareId || '',
              password: passwordOverride ?? verifiedPasswordRef.current ?? '',
              file_id: fileIdHint || '',
            }),
            cache: 'no-store',
          },
        )
        if (!response.ok) {
          const err = await readErrorPayload(response)
          return mapAccessFailure(response.status, err.code, isAuthenticated, err.message)
        }
        const blob = await response.blob()
        revokeObjectUrl()
        const objectUrl = URL.createObjectURL(blob)
        objectUrlRef.current = objectUrl
        return { type: 'ready', objectUrl }
      } catch (error) {
        return {
          type: 'error',
          message: error instanceof Error ? error.message : '加载失败',
        }
      }
    },
    [documentId, blockId, shareId, fileIdHint, isAuthenticated, revokeObjectUrl],
  )

  useEffect(() => {
    let cancelled = false
    verifiedPasswordRef.current = undefined
    setPassword('')
    applyState({ type: 'loading' })
    // 必须在首屏 fetch 前消费 handoff，否则成员 ACL / org 分享会误判匿名
    consumeTabtinWebAuthHandoff()
    void fetchBrowserHtml().then((next) => {
      if (!cancelled) applyState(next)
    })
    return () => {
      cancelled = true
      revokeObjectUrl()
    }
  }, [fetchBrowserHtml, applyState, revokeObjectUrl])

  const handleVerifyPassword = useCallback(async () => {
    if (!password.trim()) return
    setVerifying(true)
    const next = await fetchBrowserHtml(password.trim())
    setVerifying(false)
    if (next.type === 'ready') {
      verifiedPasswordRef.current = password.trim()
    }
    applyState(next)
  }, [password, fetchBrowserHtml, applyState])

  const recheckAccess = useCallback(async () => {
    if (state.type !== 'ready' || !documentId || !blockId) return
    try {
      const response = await fetch(
        `${baseApiUrl}/tabdoc/documents/${encodeURIComponent(documentId)}` +
          `/html-blocks/${encodeURIComponent(blockId)}/browser`,
        {
          method: 'POST',
          headers: {
            Accept: 'text/html,*/*',
            'Content-Type': 'application/json',
            ...shareAuthHeaders(),
          },
          body: JSON.stringify({
            share_id: shareId || '',
            password: verifiedPasswordRef.current || '',
            file_id: fileIdHint || '',
          }),
          cache: 'no-store',
        },
      )
      if (response.ok) {
        // 仍有效（含成员 ACL）：丢弃响应体，保留当前 iframe blob，避免闪烁
        try {
          await response.body?.cancel()
        } catch {
          /* ignore */
        }
        return
      }
      const err = await readErrorPayload(response)
      applyState(mapAccessFailure(response.status, err.code, isAuthenticated, err.message))
    } catch {
      // 网络抖动不立刻收束，等下一轮
    }
  }, [state.type, documentId, blockId, shareId, fileIdHint, isAuthenticated, applyState])

  useEffect(() => {
    if (state.type !== 'ready') return

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void recheckAccess()
      }
    }
    const onFocus = () => {
      void recheckAccess()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void recheckAccess()
      }
    }, SHARE_ACCESS_RECHECK_INTERVAL_MS)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.clearInterval(timer)
    }
  }, [recheckAccess, state.type])

  if (state.type === 'loading') {
    return (
      <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
        <span>加载 HTML 内容...</span>
      </div>
    )
  }

  if (state.type === 'password') {
    return (
      <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-4 px-6">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <Lock className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1 text-center">
          <h1 className="text-title font-medium">需要密码</h1>
          <p className="text-body text-muted-foreground">此内容受文档分享密码保护</p>
        </div>
        <div className="flex w-full max-w-xs flex-col gap-2">
          <input
            type="password"
            className="rounded-md border border-border bg-background px-3 py-2 text-body"
            placeholder="输入密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleVerifyPassword()
            }}
            autoFocus
          />
          {state.error ? (
            <div className="text-body text-destructive">{state.error}</div>
          ) : null}
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-body text-primary-foreground disabled:opacity-50"
            disabled={verifying || !password.trim()}
            onClick={() => void handleVerifyPassword()}
          >
            {verifying ? '验证中…' : '查看'}
          </button>
        </div>
      </div>
    )
  }

  if (state.type === 'login_required') {
    const next = encodeURIComponent(location.pathname + location.search)
    return (
      <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <LogIn className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h1 className="text-title font-medium">需要登录后查看</h1>
          <p className="text-body text-muted-foreground">
            登录后若你是文档成员可直接打开；组织限定分享也需登录
          </p>
        </div>
        <Link
          to={`/login?next=${next}`}
          className="rounded-md bg-primary px-4 py-2 text-body text-primary-foreground"
        >
          去登录
        </Link>
      </div>
    )
  }

  if (state.type === 'forbidden') {
    return (
      <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <ShieldAlert className="size-8" />
        <p>你没有权限查看此内容</p>
      </div>
    )
  }

  if (state.type === 'not_found') {
    return (
      <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <AlertCircle className="size-8" />
        <p>内容不存在，或文档分享已关闭</p>
      </div>
    )
  }

  if (state.type === 'error') {
    return (
      <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <AlertCircle className="size-8" />
        <p>{state.message}</p>
      </div>
    )
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-body text-muted-foreground">
        <Code2 className="size-4" />
        <span>HTML 预览</span>
      </div>
      <iframe
        src={state.objectUrl}
        title="HTML Block"
        className="min-h-0 flex-1 w-full border-0"
        sandbox="allow-scripts allow-popups"
      />
    </div>
  )
}

/** 旧独立 HTML 分享链接已下线：无法映射到 documentId+blockId，直接提示关闭 */
export function LegacySharedHtmlGonePage() {
  return (
    <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
      <AlertCircle className="size-8" />
      <p>此 HTML 分享链接已失效。请从文档内「在浏览器打开」获取新地址。</p>
    </div>
  )
}
