import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, Download, ExternalLink, ShieldCheck } from 'lucide-react'
import {
  TABTIN_DOWNLOAD_URL,
  buildDesktopInviteDeepLink,
  isSupportedInviteToken,
} from '@tabtin/config'
import { LanguageToggle, ThemeToggle } from '@/components/layout/ToolbarWidgets'

const CLIENT_LAUNCH_FALLBACK_DELAY_MS = 1600

export function InviteBridgePage() {
  const { token = '' } = useParams()
  const normalizedToken = token.trim()
  const isValidToken = isSupportedInviteToken(normalizedToken)
  const deepLink = useMemo(
    () => (
      isValidToken
        ? buildDesktopInviteDeepLink(normalizedToken, window.location.origin)
        : undefined
    ),
    [isValidToken, normalizedToken],
  )
  const [showDownloadHint, setShowDownloadHint] = useState(false)

  useEffect(() => {
    if (!deepLink) return undefined

    window.location.href = deepLink
    const timer = window.setTimeout(() => {
      setShowDownloadHint(true)
    }, CLIENT_LAUNCH_FALLBACK_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [deepLink])

  const handleOpenClient = useCallback(() => {
    if (!deepLink) return

    setShowDownloadHint(false)
    window.location.href = deepLink
    window.setTimeout(() => {
      setShowDownloadHint(true)
    }, CLIENT_LAUNCH_FALLBACK_DELAY_MS)
  }, [deepLink])

  if (!isValidToken) {
    return (
      <InviteBridgeShell>
        <div className="rounded-2xl border border-destructive/20 bg-background p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-destructive/10 p-2 text-destructive">
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="space-y-2">
              <h1 className="text-title font-semibold text-foreground">邀请链接无效</h1>
              <p className="text-body text-muted-foreground">
                这个邀请链接格式不正确。请确认复制了完整链接，或让邀请人重新生成邀请链接。
              </p>
              <Link
                to="/"
                className="inline-flex text-body text-primary underline underline-offset-4 hover:text-primary/80"
              >
                返回首页
              </Link>
            </div>
          </div>
        </div>
      </InviteBridgeShell>
    )
  }

  return (
    <InviteBridgeShell>
      <div className="rounded-2xl border border-border bg-background p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-primary/10 p-2 text-primary">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="space-y-3">
            <div className="space-y-1">
              <h1 className="text-title font-semibold text-foreground">正在打开 TabTin 客户端</h1>
              <p className="text-body text-muted-foreground">
                浏览器会尝试唤起本机 TabTin 客户端来处理组织邀请。
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={handleOpenClient}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-body font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                再次打开客户端
              </button>
              <a
                href={TABTIN_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-body font-medium text-foreground transition-colors hover:bg-accent"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                下载 TabTin
              </a>
            </div>

            <p className="text-caption text-muted-foreground" aria-live="polite">
              {showDownloadHint
                ? '如果没有看到系统确认弹窗，可能是尚未安装客户端，或浏览器拦截了协议唤起。'
                : '如果系统询问是否打开 TabTin，请选择允许。'}
            </p>
          </div>
        </div>
      </div>
    </InviteBridgeShell>
  )
}

function InviteBridgeShell({ children }: { children: ReactNode }) {
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
