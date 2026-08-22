/**
 * FeishuConnectPage — Electron 打开的授权桥接页
 *
 * 路由：/integrations/feishu/connect?organization_id=
 * 1. 消费 handoff JWT → localStorage
 * 2. 带 Bearer 请求 Django GET /api/integrations/feishu/oauth/start
 * 3. 跳转飞书 authorize_url
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { API_BASE_URL } from '@/config/api'
import { LanguageToggle, ThemeToggle } from '@/components/layout/ToolbarWidgets'
import { getAccessToken } from './shareAuth'
import { consumeTabtinWebAuthHandoff } from './feishuAuthHandoff'

const FEISHU_RETURN_DEEP_LINK = 'tabtin://integrations/feishu/connected'

type PageState =
  | { type: 'loading' }
  | { type: 'error'; message: string }
  | { type: 'missing_org' }
  | { type: 'need_login' }

async function startFeishuOAuth(organizationId: string): Promise<string> {
  const token = getAccessToken()
  if (!token) {
    throw new Error('NEED_LOGIN')
  }
  const base = (API_BASE_URL || '/api').replace(/\/$/, '')
  const params = new URLSearchParams({
    organization_id: organizationId,
    return_deep_link: FEISHU_RETURN_DEEP_LINK,
  })
  const response = await fetch(
    `${base}/integrations/feishu/oauth/start?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      redirect: 'manual',
    },
  )

  // 后端若直接 302 到飞书
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location')
    if (location) return location
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      throw new Error(`OAuth start failed (${response.status})`)
    }
    throw new Error('OAuth start returned unexpected response')
  }

  const json = (await response.json()) as {
    success?: boolean
    message?: string
    data?: { authorize_url?: string; url?: string }
    authorize_url?: string
  }

  if (!response.ok || json.success === false) {
    if (response.status === 401) throw new Error('NEED_LOGIN')
    throw new Error(json.message || `OAuth start failed (${response.status})`)
  }

  const authorizeUrl =
    json.data?.authorize_url
    || json.data?.url
    || json.authorize_url
  if (!authorizeUrl) {
    throw new Error('OAuth start missing authorize_url')
  }
  return authorizeUrl
}

export function FeishuConnectPage() {
  const [searchParams] = useSearchParams()
  const organizationId = (searchParams.get('organization_id') || '').trim()
  const [state, setState] = useState<PageState>({ type: 'loading' })

  useEffect(() => {
    let cancelled = false
    consumeTabtinWebAuthHandoff()

    if (!organizationId) {
      setState({ type: 'missing_org' })
      return
    }

    void (async () => {
      try {
        const authorizeUrl = await startFeishuOAuth(organizationId)
        if (cancelled) return
        window.location.href = authorizeUrl
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        if (message === 'NEED_LOGIN') {
          setState({ type: 'need_login' })
          return
        }
        setState({ type: 'error', message })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [organizationId])

  return (
    <BridgeShell>
      {state.type === 'loading' ? (
        <BridgeCard>
          <div className="flex items-start gap-3">
            <Loader2 className="mt-0.5 h-5 w-5 animate-spin text-primary" aria-hidden />
            <div className="space-y-1">
              <h1 className="text-title font-semibold text-foreground">正在跳转飞书授权</h1>
              <p className="text-body text-muted-foreground">
                请稍候，授权完成后会回到 TabTin 客户端。
              </p>
            </div>
          </div>
        </BridgeCard>
      ) : null}

      {state.type === 'missing_org' ? (
        <BridgeCard>
          <ErrorBlock
            title="缺少组织参数"
            description="链接中没有 organization_id。请从 TabTin 客户端「云盘 → 新建 → 飞书」重新打开。"
          />
        </BridgeCard>
      ) : null}

      {state.type === 'need_login' ? (
        <BridgeCard>
          <ErrorBlock
            title="需要登录"
            description="未能识别登录态。请回到 TabTin 客户端重新点击「去授权」。"
          />
        </BridgeCard>
      ) : null}

      {state.type === 'error' ? (
        <BridgeCard>
          <ErrorBlock
            title="无法开始飞书授权"
            description={state.message}
          />
        </BridgeCard>
      ) : null}
    </BridgeShell>
  )
}

function BridgeShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'hsl(var(--canvas))' }}>
      <div className="flex justify-end items-center gap-1 p-4">
        <LanguageToggle />
        <ThemeToggle />
      </div>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-lg">{children}</div>
      </main>
    </div>
  )
}

function BridgeCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-background p-6 shadow-sm">
      {children}
    </div>
  )
}

function ErrorBlock({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="rounded-full bg-destructive/10 p-2 text-destructive">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="space-y-2">
        <h1 className="text-title font-semibold text-foreground">{title}</h1>
        <p className="text-body text-muted-foreground">{description}</p>
        <Link
          to="/"
          className="inline-flex text-body text-primary underline underline-offset-4 hover:text-primary/80"
        >
          返回首页
        </Link>
      </div>
    </div>
  )
}
