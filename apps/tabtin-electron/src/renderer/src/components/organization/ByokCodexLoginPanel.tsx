import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@components/ui'

export type OpenAICodexStatus = {
  connected: boolean
  expiresAt?: number
  models: Array<{ id: string; displayName: string }>
}

interface ByokCodexLoginPanelProps {
  disabled?: boolean
  hideIntro?: boolean
  onConnected: (status: OpenAICodexStatus) => void | Promise<void>
}

const STATUS_POLL_INTERVAL_MS = 2_000

/** 设备码登录入口暂关；主进程 IPC 仍保留，改 true 即可恢复按钮。 */
const DEVICE_CODE_LOGIN_UI_ENABLED = false

export function ByokCodexLoginPanel({
  disabled = false,
  hideIntro = false,
  onConnected,
}: ByokCodexLoginPanelProps) {
  const { t } = useTranslation('organization')
  const [status, setStatus] = useState<OpenAICodexStatus | null>(null)
  const [deviceCode, setDeviceCode] = useState<{ userCode: string; verificationUri: string } | null>(null)
  const [pending, setPending] = useState<'browser' | 'device' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollTimerRef = useRef<number | null>(null)
  const loginPendingRef = useRef(false)

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    const nextStatus = await window.tabtin.openaiCodex.getStatus()
    setStatus(nextStatus)
    if (nextStatus.connected && loginPendingRef.current) {
      stopPolling()
      loginPendingRef.current = false
      setPending(null)
      setDeviceCode(null)
      await onConnected(nextStatus)
    }
    return nextStatus
  }, [onConnected, stopPolling])

  const startPolling = useCallback(() => {
    stopPolling()
    pollTimerRef.current = window.setInterval(() => {
      void refreshStatus().catch(() => {
        // 主进程仅暴露无密状态；轮询失败不应清空既有 UI。
      })
    }, STATUS_POLL_INTERVAL_MS)
  }, [refreshStatus, stopPolling])

  useEffect(() => {
    void refreshStatus().catch(() => {
      setError(t('llm.codex.statusLoadFailed'))
    })
    const unsubscribe = window.tabtin.openaiCodex.onStatusChanged(() => {
      void refreshStatus().catch(() => {
        // 状态推送失败时保留现有 UI，避免清空已连接态。
      })
    })
    return () => {
      stopPolling()
      unsubscribe()
    }
  }, [refreshStatus, stopPolling, t])

  const handleBrowserLogin = async () => {
    setError(null)
    setDeviceCode(null)
    setPending('browser')
    try {
      if (status?.connected) {
        await window.tabtin.openaiCodex.logout()
        setStatus({ connected: false, models: [] })
      }
      loginPendingRef.current = true
      await window.tabtin.openaiCodex.loginBrowser()
      // 浏览器授权在回调里落凭据；此处开始轮询 get-status。
      startPolling()
      // 立即再拉一次，避免只等 interval 造成「已登录但 UI 未变」。
      await refreshStatus()
    } catch (error) {
      loginPendingRef.current = false
      setPending(null)
      setError(error instanceof Error ? error.message : t('llm.codex.loginStartFailed'))
    }
  }

  const handleDeviceCodeLogin = async () => {
    setError(null)
    setPending('device')
    try {
      loginPendingRef.current = true
      const result = await window.tabtin.openaiCodex.loginDeviceCode()
      setDeviceCode(result)
      startPolling()
    } catch {
      loginPendingRef.current = false
      setPending(null)
      setError(t('llm.codex.deviceCodeStartFailed'))
    }
  }

  const handleLogout = async () => {
    setError(null)
    stopPolling()
    loginPendingRef.current = false
    setPending(null)
    setDeviceCode(null)
    try {
      await window.tabtin.openaiCodex.logout()
      await refreshStatus()
    } catch {
      setError(t('llm.codex.logoutFailed'))
    }
  }

  const handleCancel = async () => {
    stopPolling()
    loginPendingRef.current = false
    setPending(null)
    setDeviceCode(null)
    await window.tabtin.openaiCodex.cancelLogin()
  }

  const isPending = pending !== null
  const models = status?.models ?? []

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-body text-destructive">{error}</p>}

      {status?.connected ? (
        <>
          <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2.5">
            <p className="text-body font-medium text-foreground">{t('llm.codex.connected')}</p>
            <p className="mt-1 text-caption text-muted-foreground">{t('llm.codex.connectedHint')}</p>
          </div>
          <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2.5">
            <p className="text-caption font-medium text-foreground">{t('llm.codex.modelsLabel')}</p>
            <p className="mt-1 overflow-x-auto whitespace-nowrap text-caption text-muted-foreground">
              {models.map((model) => model.displayName).join(' · ')}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => void handleBrowserLogin()} disabled={disabled || isPending}>
              {t('llm.codex.reconnect')}
            </Button>
            <Button variant="outline" onClick={() => void handleLogout()} disabled={disabled || isPending}>
              {t('llm.codex.disconnect')}
            </Button>
          </div>
        </>
      ) : (
        <>
          {!hideIntro && (
            <p className="text-caption text-muted-foreground leading-relaxed">{t('llm.codex.description')}</p>
          )}
          {DEVICE_CODE_LOGIN_UI_ENABLED && deviceCode && (
            <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2.5">
              <p className="text-caption text-muted-foreground">{t('llm.codex.deviceCodeHint')}</p>
              <p className="mt-1 font-mono text-body font-semibold tracking-[0.12em] text-foreground">{deviceCode.userCode}</p>
              <a
                className="mt-2 inline-flex items-center gap-1 text-caption text-accent hover:underline"
                href={deviceCode.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                {deviceCode.verificationUri}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {isPending && (
              <Button variant="outline" onClick={() => void handleCancel()} disabled={disabled}>
                {t('llm.codex.cancelLogin')}
              </Button>
            )}
            {DEVICE_CODE_LOGIN_UI_ENABLED && (
              <Button variant="outline" onClick={() => void handleDeviceCodeLogin()} disabled={disabled || isPending}>
                {pending === 'device' && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                {t('llm.codex.deviceCodeLogin')}
              </Button>
            )}
            <Button onClick={() => void handleBrowserLogin()} disabled={disabled || isPending}>
              {pending === 'browser' && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              {t('llm.codex.browserLogin')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
