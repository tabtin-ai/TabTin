import { joinApiPath } from '@tabtin/config'
import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Trash2, Power, PowerOff, FolderKanban, Pencil, Copy, Check, AlertCircle, QrCode, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ChannelStatusBadge } from './ChannelStatusBadge'
import { useSpaceStore } from '@/stores/useSpaceStore'
import type { ChannelAccountResponse, ChannelRuntimeStatusResponse } from '@/services/channelApi'
import { channelApi } from '@/services/channelApi'
import { API_CONFIG } from '@/config/api'

const CHANNEL_ICONS: Record<string, string> = {
  telegram: '🤖',
  feishu: '🐦',
  slack: '💬',
  discord: '🎮',
  whatsapp: '📱',
  line: '🟢',
  dingtalk: '🔔',
  wechat_work: '💼',
  googlechat: '💬',
  msteams: '🟦',
  mattermost: '🔵',
  email: '📧',
  weixin_personal: '💚',
}

const WEIXIN_QR_STATUSES = new Set(['waiting_scan', 'scanned', 'auth_expired'])

interface ChannelAccountCardProps {
  account: ChannelAccountResponse
  runtimeStatus?: ChannelRuntimeStatusResponse | null
  onToggleEnabled: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
  onEdit?: (id: string) => void
  loading?: boolean
  canManage?: boolean
}

export const ChannelAccountCard: React.FC<ChannelAccountCardProps> = ({
  account,
  runtimeStatus,
  onToggleEnabled,
  onDelete,
  onEdit,
  loading,
  canManage = true,
}) => {
  const { t } = useTranslation('channel')
  const spaces = useSpaceStore((s) => s.spaces)
  const [copied, setCopied] = useState(false)
  const [qrLoading, setQrLoading] = useState(false)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [qrExpanded, setQrExpanded] = useState(false)
  const [qrError, setQrError] = useState<string | null>(null)
  const pollAbortRef = useRef(false)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isWeixinPersonal = account.channel === 'weixin_personal'
  const runtimeStatusKey = runtimeStatus?.status ?? ''
  const needsQrScan = isWeixinPersonal && WEIXIN_QR_STATUSES.has(runtimeStatusKey)

  useEffect(() => {
    if (runtimeStatus?.qr) setQrUrl(runtimeStatus.qr)
  }, [runtimeStatus?.qr])

  const stopPolling = useCallback(() => {
    pollAbortRef.current = true
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!needsQrScan && !qrExpanded) stopPolling()
  }, [needsQrScan, qrExpanded, stopPolling])

  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  const startPolling = useCallback((acctId: string, wId: string) => {
    stopPolling()
    pollAbortRef.current = false
    const QR_POLL_TIMEOUT = 5 * 60 * 1000
    const startTime = Date.now()
    let failCount = 0

    const tick = async () => {
      if (pollAbortRef.current) return
      if (Date.now() - startTime > QR_POLL_TIMEOUT) {
        setQrError(t('weixinQrExpired'))
        setQrExpanded(false)
        return
      }
      try {
        const status = await channelApi.pollWeixinQrStatus(acctId, wId)
        if (pollAbortRef.current) return
        if (status.qr) setQrUrl(status.qr)
        failCount = 0
        if (status.status === 'running' || status.status === 'error') {
          setQrExpanded(false)
          return
        }
      } catch {
        failCount++
        if (failCount >= 5) {
          setQrError(t('weixinQrExpired'))
          return
        }
      }
      if (!pollAbortRef.current) {
        pollTimerRef.current = setTimeout(tick, 3000)
      }
    }
    pollTimerRef.current = setTimeout(tick, 3000)
  }, [stopPolling, t])

  const handleStartQrLogin = useCallback(async () => {
    setQrLoading(true)
    setQrExpanded(true)
    setQrError(null)
    try {
      const res = await channelApi.startWeixinQrLogin(account.id, account.organization_id)
      if (res.qr) setQrUrl(res.qr)
      startPolling(account.id, account.organization_id)
    } catch {
      setQrError(t('addChannelFailed'))
    } finally {
      setQrLoading(false)
    }
  }, [account.id, account.organization_id, startPolling, t])

  const handleRefreshQr = useCallback(async () => {
    setQrLoading(true)
    setQrError(null)
    try {
      const res = await channelApi.refreshWeixinQrCode(account.id, account.organization_id)
      if (res.qr) setQrUrl(res.qr)
      startPolling(account.id, account.organization_id)
    } catch {
      setQrError(t('addChannelFailed'))
    } finally {
      setQrLoading(false)
    }
  }, [account.id, account.organization_id, startPolling, t])

  const icon = CHANNEL_ICONS[account.channel] ?? '📡'
  const channelLabel = t(`channelMeta.${account.channel}`, { defaultValue: account.channel })
  const displayName = account.name || channelLabel
  const cfg = account.config as Record<string, unknown> | undefined
  const botUsername = cfg?.bot_username as string | undefined
  const channelMode = (cfg?.mode as string) || 'polling'
  const linkedSpaceId = (cfg?.default_space_id ?? cfg?.default_project_id) as string | undefined
  const linkedSpace = linkedSpaceId ? spaces.find((p) => p.id === linkedSpaceId) : null
  const webhookToken = cfg?.webhook_token as string | undefined
  const webhookUrl = webhookToken ? joinApiPath(API_CONFIG.baseURL, `/channel-gateway/webhook/${account.channel}/${webhookToken}/`) : null
  const lastError = runtimeStatus?.last_error

  const handleCopyWebhookUrl = useCallback(() => {
    if (!webhookUrl) return
    navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [webhookUrl])

  return (
    <div className="group relative rounded-md px-2 py-2 transition-colors hover:bg-muted/20">
      <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/30 text-subtitle">
        {icon}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-body font-medium text-foreground truncate">{displayName}</span>
          {botUsername && (
            <span className="text-caption text-muted-foreground/60">@{botUsername}</span>
          )}
          {!account.enabled && (
            <span className="text-caption text-muted-foreground/40">{t('disabled')}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-caption text-muted-foreground/60">{channelLabel}</span>
          <span className="text-caption text-muted-foreground/40 capitalize">
            {t(`modeLabel.${channelMode}`, { defaultValue: channelMode })}
          </span>
          {linkedSpace && (
            <span className="flex items-center gap-0.5 text-caption text-muted-foreground/40" title={t('linkedTo', { name: linkedSpace.name })}>
              <FolderKanban className="h-2.5 w-2.5" />
              {linkedSpace.icon || ''}{linkedSpace.name}
            </span>
          )}
          {!linkedSpace && linkedSpaceId && (
            <span className="text-caption text-destructive/60">{t('noSpaceLinked')}</span>
          )}
          <ChannelStatusBadge status={runtimeStatus?.status} />
        </div>
      </div>

      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {onEdit && (
          <button
            type="button"
            className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground/40 hover:text-foreground transition-colors"
            title={t('edit')}
            disabled={loading || !canManage}
            onClick={() => onEdit(account.id)}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground/40 hover:text-foreground transition-colors"
          title={account.enabled ? t('disable') : t('enable')}
          disabled={loading || !canManage}
          onClick={() => onToggleEnabled(account.id, !account.enabled)}
        >
          {account.enabled ? (
            <PowerOff className="h-3 w-3" />
          ) : (
            <Power className="h-3 w-3" />
          )}
        </button>
        <button
          type="button"
          className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground/40 hover:text-destructive transition-colors"
          title={t('delete')}
          disabled={loading || !canManage}
          onClick={() => onDelete(account.id)}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      </div>

      {webhookUrl && channelMode === 'webhook' && (
        <div className="mt-1 ml-[42px] flex items-center gap-1">
          <span className="text-caption text-muted-foreground/40">{t('webhookUrl')}:</span>
          <code className="text-caption text-muted-foreground/60 truncate max-w-[260px]" title={webhookUrl}>{webhookUrl}</code>
          <button
            type="button"
            className="h-4 w-4 shrink-0 flex items-center justify-center text-muted-foreground/40 hover:text-foreground transition-colors"
            onClick={handleCopyWebhookUrl}
            title={copied ? t('webhookUrlCopied') : t('webhookUrl')}
          >
            {copied ? <Check className="h-2.5 w-2.5 text-success" /> : <Copy className="h-2.5 w-2.5" />}
          </button>
        </div>
      )}

      {lastError && (
        <div className="mt-1 ml-[42px] flex items-center gap-1">
          <AlertCircle className="h-3 w-3 shrink-0 text-destructive/60" />
          <span className="text-caption text-destructive/80 truncate" title={lastError}>
            {lastError}
          </span>
        </div>
      )}

      {isWeixinPersonal && (needsQrScan || qrExpanded) && (
        <div className="mt-2 ml-[42px] space-y-2">
          {runtimeStatusKey === 'auth_expired' && (
            <div className="flex items-center gap-1">
              <AlertCircle className="h-3 w-3 shrink-0 text-destructive/60" />
              <span className="text-caption text-destructive/80">{t('weixinAuthExpiredWarning')}</span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-caption font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
              disabled={qrLoading || loading}
              onClick={runtimeStatusKey === 'auth_expired' ? handleStartQrLogin : qrUrl ? handleRefreshQr : handleStartQrLogin}
            >
              {runtimeStatusKey === 'auth_expired' ? (
                <>
                  <RefreshCw className={`h-3 w-3 ${qrLoading ? 'animate-spin' : ''}`} />
                  {t('weixinRescan')}
                </>
              ) : qrUrl ? (
                <>
                  <RefreshCw className={`h-3 w-3 ${qrLoading ? 'animate-spin' : ''}`} />
                  {t('weixinRefreshQr')}
                </>
              ) : (
                <>
                  <QrCode className={`h-3 w-3 ${qrLoading ? 'animate-pulse' : ''}`} />
                  {t('weixinScanLogin')}
                </>
              )}
            </button>
            {runtimeStatusKey === 'scanned' && (
              <span className="text-caption text-warning">{t('weixinScannedConfirm')}</span>
            )}
          </div>

          {qrError && (
            <div className="flex items-center gap-1">
              <AlertCircle className="h-3 w-3 shrink-0 text-destructive/60" />
              <span className="text-caption text-destructive/80">{qrError}</span>
            </div>
          )}

          {qrUrl && (
            <div className="inline-flex flex-col items-center gap-1.5 rounded-lg border border-border/60 bg-white p-3">
              <img
                src={qrUrl}
                alt={t('weixinQrAlt')}
                className="h-40 w-40 object-contain"
                onError={() => setQrError(t('weixinQrExpired'))}
              />
              <span className="text-caption text-muted-foreground">
                {runtimeStatusKey === 'waiting_scan' ? t('weixinWaitingScan') : t('weixinScanLogin')}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
