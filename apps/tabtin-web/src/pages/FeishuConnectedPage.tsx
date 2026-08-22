/**
 * FeishuConnectedPage — 飞书 OAuth 回调后的桥接页
 *
 * 路由：/integrations/feishu/connected
 * 尝试唤起 tabtin://integrations/feishu/connected，提示可关闭浏览器。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Download, ExternalLink, ShieldCheck } from 'lucide-react'
import { TABTIN_DOWNLOAD_URL } from '@tabtin/config'
import { LanguageToggle, ThemeToggle } from '@/components/layout/ToolbarWidgets'

const CLIENT_LAUNCH_FALLBACK_DELAY_MS = 1600
const FEISHU_CONNECTED_DEEP_LINK = 'tabtin://integrations/feishu/connected'

export function FeishuConnectedPage() {
  const [showDownloadHint, setShowDownloadHint] = useState(false)

  useEffect(() => {
    window.location.href = FEISHU_CONNECTED_DEEP_LINK
    const timer = window.setTimeout(() => {
      setShowDownloadHint(true)
    }, CLIENT_LAUNCH_FALLBACK_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])

  const handleOpenClient = useCallback(() => {
    setShowDownloadHint(false)
    window.location.href = FEISHU_CONNECTED_DEEP_LINK
    window.setTimeout(() => {
      setShowDownloadHint(true)
    }, CLIENT_LAUNCH_FALLBACK_DELAY_MS)
  }, [])

  return (
    <BridgeShell>
      <div className="rounded-2xl border border-border bg-background p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-primary/10 p-2 text-primary">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="space-y-3">
            <div className="space-y-1">
              <h1 className="text-title font-semibold text-foreground">飞书授权完成</h1>
              <p className="text-body text-muted-foreground">
                正在回到 TabTin 客户端。若已自动打开，可直接关闭本页。
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
