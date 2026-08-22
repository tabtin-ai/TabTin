import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, ClipboardCopy, Download, Info, RefreshCw, Smartphone, Upload } from 'lucide-react'
import { Button, Progress, StatusNotice, toast } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SettingsInfoTooltip } from '../SettingsInfoTooltip'
import { exportDiagnostics, copyDiagnosticsToClipboard, openDiagnosticsLogDir, uploadDiagnosticsToSupport } from '@/services/diagnostics/exportDiagnostics'
import { useRuntimeVersionInfo } from '@/hooks/useRuntimeVersionInfo'
import { RUNTIME_VERSION_DETAILS_ENABLED } from '@/utils/featureFlags'
import { DesktopCleanupSection } from './DesktopCleanupSection'
import { SETTINGS_HINT, SETTINGS_SECTION_TITLE, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE } from '../settingsUi'
import { cn } from '@utils/cn'
import { API_BASE_URL, PUBLIC_WEB_BASE_URL } from '@/config/api'
import {
  deriveMobileCentrifugoUrl,
  deriveMobileWebsocketUrl,
  deriveMobileWebUrl,
} from '@/utils/mobileEnvironmentQr'
import { MobileEnvironmentQrDialog } from './MobileEnvironmentQrDialog'

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'

type UpdateRuntimeState = {
  currentVersion?: string
  platform?: 'mac' | 'win' | 'linux'
  arch?: 'x64' | 'arm64'
  channel?: 'stable' | 'beta' | 'alpha'
  status?: UpdateStatus
  downloadProgress?: number
  updateInfo?: any
  errorMessage?: string | null
  lastCheckedAt?: string | null
}

export type ReleaseHistoryItem = {
  version: string
  platform?: string
  arch?: string
  channel?: string
  releaseNotes: string
  releaseNotesEn?: string
  publishedAt?: string | null
  isMandatory?: boolean
  priority?: string
}

type HistoryLoadState = 'idle' | 'loading' | 'error' | 'loaded'

export const UpdatePanel: React.FC = () => {
  const { t, i18n } = useTranslation('settings')
  const runtimeVersion = useRuntimeVersionInfo(RUNTIME_VERSION_DETAILS_ENABLED)
  const [currentVersion, setCurrentVersion] = useState('')
  const [platform, setPlatform] = useState<'mac' | 'win' | 'linux'>('mac')
  const [arch, setArch] = useState<'x64' | 'arm64'>('x64')
  const [channel, setChannel] = useState<'stable' | 'beta' | 'alpha'>('stable')
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [updateInfo, setUpdateInfo] = useState<any>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null)
  const [releaseHistory, setReleaseHistory] = useState<ReleaseHistoryItem[]>([])
  const [historyState, setHistoryState] = useState<HistoryLoadState>('idle')
  const [historyError, setHistoryError] = useState('')
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false)
  const [runtimeStateLoaded, setRuntimeStateLoaded] = useState(false)
  const [showMobileEnvironmentQr, setShowMobileEnvironmentQr] = useState(false)
  const mobileEnvironmentConfig = useMemo(() => ({
    apiUrl: API_BASE_URL,
    websocketUrl: deriveMobileWebsocketUrl(API_BASE_URL),
    webUrl: PUBLIC_WEB_BASE_URL || deriveMobileWebUrl(API_BASE_URL),
    centrifugoUrl: import.meta.env.VITE_CENTRIFUGO_WS_URL?.trim()
      || deriveMobileCentrifugoUrl(API_BASE_URL),
  }), [])

  const applyRuntimeState = useCallback((snapshot: UpdateRuntimeState | null | undefined) => {
    if (!snapshot) return
    if (snapshot.currentVersion) setCurrentVersion(snapshot.currentVersion)
    if (snapshot.platform) setPlatform(snapshot.platform)
    if (snapshot.arch) setArch(snapshot.arch)
    if (snapshot.channel) setChannel(snapshot.channel)
    if (snapshot.status) setStatus(snapshot.status)
    if (typeof snapshot.downloadProgress === 'number') {
      setDownloadProgress(snapshot.downloadProgress)
    }
    if (snapshot.updateInfo !== undefined) setUpdateInfo(snapshot.updateInfo ?? null)
    if (typeof snapshot.errorMessage === 'string') {
      setErrorMessage(snapshot.errorMessage)
    } else if (snapshot.errorMessage === null) {
      setErrorMessage('')
    }
    if (snapshot.lastCheckedAt !== undefined) {
      setLastCheckedAt(snapshot.lastCheckedAt ?? null)
    }
  }, [])

  const loadReleaseHistory = useCallback(async () => {
    if (!window.tabtin.updater.getReleaseHistory) return
    setHistoryState('loading')
    setHistoryError('')
    try {
      const items = await window.tabtin.updater.getReleaseHistory({
        platform,
        arch,
        channel,
        limit: 10,
        locale: i18n.language,
      })
      setReleaseHistory(normalizeReleaseHistory(Array.isArray(items) ? items : []))
      setHistoryState('loaded')
    } catch (error) {
      setHistoryState('error')
      setHistoryError(error instanceof Error ? error.message : t('update.historyLoadFailed', { defaultValue: '更新日志暂时无法加载' }))
    }
  }, [arch, channel, i18n.language, platform, t])

  useEffect(() => {
    window.tabtin.updater.getAppVersion().then(setCurrentVersion)
    window.tabtin.updater.getState?.()
      .then(applyRuntimeState)
      .catch(() => {})
      .finally(() => setRuntimeStateLoaded(true))

    const cleanup = window.tabtin.updater.onUpdateEvent((payload) => {
      const { event, data } = payload

      switch (event) {
        case 'update-state':
          applyRuntimeState(data)
          break

        case 'update-checking':
          setStatus('checking')
          setErrorMessage('')
          break

        case 'update-available':
          setUpdateInfo(data)
          setStatus('available')
          toast({ title: t('update.newVersionFound', { version: data?.version }) })
          break

        case 'update-not-available':
          setStatus('idle')
          setUpdateInfo(null)
          toast({ title: t('update.alreadyLatest') })
          break

        case 'download-progress':
          setStatus('downloading')
          setDownloadProgress(Math.round(data?.percent ?? 0))
          break

        case 'update-downloaded':
          setStatus('downloaded')
          setDownloadProgress(100)
          setUpdateInfo(data)
          toast({ title: t('update.downloadComplete') })
          break

        case 'update-installing':
          setStatus('installing')
          break

        case 'update-error':
          setStatus('error')
          setErrorMessage(typeof data === 'string' ? data : t('update.unknownError'))
          // 检查更新失败多为网络抖动，用普通提示避免「严重故障」观感
          toast({ title: t('update.updateFailed') })
          break
      }
    })

    return cleanup
  }, [applyRuntimeState, t])

  useEffect(() => {
    if (!runtimeStateLoaded) return
    void loadReleaseHistory()
  }, [loadReleaseHistory, runtimeStateLoaded])

  const handleCheckUpdate = useCallback(async () => {
    setStatus('checking')
    setUpdateInfo(null)
    setErrorMessage('')
    try {
      await window.tabtin.updater.checkForUpdates()
    } catch {
      // errors handled via event
    }
  }, [])

  const handleDownload = useCallback(async () => {
    try {
      await window.tabtin.updater.downloadUpdate()
    } catch {
      // errors handled via event
    }
  }, [])

  const handleInstall = useCallback(() => {
    window.tabtin.updater.quitAndInstall()
  }, [])

  // 自动更新失败时的兜底：直接在浏览器里下载安装包手动安装
  const manualDownloadUrl: string | null =
    updateInfo?.fileUrl || updateInfo?.file_url || null

  const handleManualDownload = useCallback(() => {
    if (manualDownloadUrl) {
      void window.tabtin.openExternal(manualDownloadUrl)
    }
  }, [manualDownloadUrl])

  const [isExportingLogs, setIsExportingLogs] = useState(false)
  const [isCopyingLogs, setIsCopyingLogs] = useState(false)
  const [isUploadingLogs, setIsUploadingLogs] = useState(false)
  const handleExportLogs = useCallback(async () => {
    setIsExportingLogs(true)
    try {
      await exportDiagnostics({ reason: 'settings' })
    } finally {
      setIsExportingLogs(false)
    }
  }, [])
  const handleUploadLogs = useCallback(async () => {
    setIsUploadingLogs(true)
    try {
      await uploadDiagnosticsToSupport()
    } finally {
      setIsUploadingLogs(false)
    }
  }, [])
  const handleCopyLogs = useCallback(async () => {
    setIsCopyingLogs(true)
    try {
      await copyDiagnosticsToClipboard({ reason: 'settings' })
    } finally {
      setIsCopyingLogs(false)
    }
  }, [])
  const handleOpenLogDir = useCallback(() => {
    void openDiagnosticsLogDir()
  }, [])

  const statusCopy = useMemo(
    () => buildStatusCopy({ status, updateInfo, errorMessage, t }),
    [errorMessage, status, t, updateInfo],
  )
  const primaryAction = useMemo(
    () => buildPrimaryAction({ status, updateInfo, t }),
    [status, t, updateInfo],
  )

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Info className="h-4 w-4" />}
        title={t('sections.tabtinVersion')}
        subtitle={t('update.description')}
      />

      <SettingsSectionCard>
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <StatusIcon status={status} />
                <div className="flex min-w-0 items-center gap-1">
                  <p className="text-body font-semibold text-foreground">{statusCopy.title}</p>
                  <SettingsInfoTooltip
                    content={(
                      <>
                        <p>{statusCopy.description}</p>
                        <p className="mt-1.5">
                          {t('update.lastCheckedWithValue', {
                            defaultValue: '上次检查：{{time}}',
                            time: formatLastChecked(lastCheckedAt, t),
                          })}
                        </p>
                        <p className="mt-1.5">• {t('update.hint1')}</p>
                        <p className="mt-1.5">• {t('update.hint2')}</p>
                        <p className="mt-1.5">• {t('update.hint3')}</p>
                      </>
                    )}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground', 'rounded-full bg-muted/60 px-2.5 py-1')}>
                  {t('update.currentVersionWithValue', { defaultValue: '当前版本 v{{version}}', version: currentVersion || '...' })}
                </span>
                <span className={cn(SETTINGS_TEXT_META, 'rounded-full bg-muted/40 px-2.5 py-1')}>
                  {formatChannelLabel(channel, t)}
                </span>
                <span className={cn(SETTINGS_TEXT_META, 'rounded-full bg-muted/40 px-2.5 py-1')}>
                  {formatPlatformLabel(platform, t)}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => setShowMobileEnvironmentQr(true)}
                variant="outline"
                size="sm"
              >
                <Smartphone className="mr-2 h-3.5 w-3.5" />
                {t('update.configureMobileEnvironment')}
              </Button>
              <Button
                onClick={
                  primaryAction.kind === 'download'
                    ? handleDownload
                    : primaryAction.kind === 'install'
                      ? handleInstall
                      : handleCheckUpdate
                }
                disabled={primaryAction.disabled}
                variant={primaryAction.kind === 'check' && status !== 'error' ? 'outline' : 'default'}
                size="sm"
              >
                {primaryAction.kind === 'download' ? (
                  <Download className="mr-2 h-3.5 w-3.5" />
                ) : primaryAction.kind === 'install' ? null : (
                  <RefreshCw className={`mr-2 h-3.5 w-3.5 ${status === 'checking' ? 'animate-spin' : ''}`} />
                )}
                {primaryAction.label}
              </Button>
              {status === 'error' && manualDownloadUrl ? (
                <Button variant="outline" size="sm" onClick={handleManualDownload}>
                  <Download className="mr-2 h-3.5 w-3.5" />
                  {t('update.manualDownload')}
                </Button>
              ) : null}
            </div>
          </div>

          {status === 'downloading' ? (
            <div className="space-y-2">
              <Progress value={downloadProgress} />
              <p className={cn(SETTINGS_HINT, 'text-center', 'text-muted-foreground')}>{downloadProgress}%</p>
            </div>
          ) : null}

          {RUNTIME_VERSION_DETAILS_ENABLED ? (
            <dl className="grid gap-3 border-t border-border/40 pt-4 sm:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <dt className={SETTINGS_HINT}>{t('update.clientVersion', { defaultValue: '客户端版本' })}</dt>
                <dd className="flex min-w-0 items-baseline gap-2 font-mono text-body text-foreground/80">
                  <span>{runtimeVersion.clientVersion || currentVersion || '—'}</span>
                  <span className="text-muted-foreground/60">{runtimeVersion.clientSourceSha.slice(0, 8) || '—'}</span>
                </dd>
              </div>
              <div className="min-w-0 space-y-1">
                <dt className={SETTINGS_HINT}>{t('update.serverVersion', { defaultValue: '服务端版本' })}</dt>
                <dd className="flex min-w-0 items-baseline gap-2 font-mono text-body text-foreground/80">
                  <span>{runtimeVersion.serverLoading && !runtimeVersion.serverVersion ? '…' : runtimeVersion.serverVersion || '—'}</span>
                  <span className="text-muted-foreground/60">{runtimeVersion.serverSourceSha.slice(0, 8) || '—'}</span>
                </dd>
              </div>
              <div className="min-w-0 space-y-1 sm:col-span-2">
                <dt className={SETTINGS_HINT}>{t('update.serverAddress', { defaultValue: '服务端地址' })}</dt>
                <dd className="break-all font-mono text-body text-foreground/80">{runtimeVersion.serverAddress || '—'}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </SettingsSectionCard>

      {status === 'available' && updateInfo && (
        <SettingsSectionCard>
          <StatusNotice
            tone="info"
            title={updateInfo.mandatory
              ? t('update.mandatoryUpdateTitle', { defaultValue: '这是必须安装的安全更新' })
              : t('update.newVersion', { version: updateInfo.version })}
            description={(
              <div className="space-y-2">
                {getUpdateReleaseNotes(updateInfo) ? (
                  <p className={cn(SETTINGS_TEXT_META, 'whitespace-pre-wrap')}>
                    {getUpdateReleaseNotes(updateInfo)}
                  </p>
                ) : null}
                {updateInfo.releaseDate ? (
                  <p className={SETTINGS_TEXT_META}>
                    {t('update.releaseDateWithValue', {
                      defaultValue: '发布时间：{{date}}',
                      date: formatDate(updateInfo.releaseDate),
                    })}
                  </p>
                ) : null}
              </div>
            )}
          />
        </SettingsSectionCard>
      )}

      {status === 'downloaded' && (
        <SettingsSectionCard>
          <StatusNotice
            tone="success"
            title={t('update.readyToInstall')}
            description={t('update.readyToInstallHint')}
            actions={(
              <Button onClick={handleInstall} size="sm">
                {t('update.restartAndInstall')}
              </Button>
            )}
          />
        </SettingsSectionCard>
      )}

      {status === 'error' && (
        <SettingsSectionCard>
          <StatusNotice
            tone="warning"
            title={t('update.updateFailed')}
            description={(
              <div className="space-y-1">
                <p>{resolveUpdateErrorDescription(errorMessage, t)}</p>
                {manualDownloadUrl ? <p className={SETTINGS_TEXT_META}>{t('update.manualDownloadHint')}</p> : null}
              </div>
            )}
          />
        </SettingsSectionCard>
      )}

      <SettingsSectionCard
        title={t('diagnostics.title', { defaultValue: '诊断日志' })}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={handleExportLogs} disabled={isExportingLogs || isCopyingLogs || isUploadingLogs}>
            <Download className="mr-2 h-3.5 w-3.5" />
            {isExportingLogs
              ? t('diagnostics.exporting', { defaultValue: '正在导出…' })
              : t('diagnostics.export', { defaultValue: '导出诊断日志' })}
          </Button>
          <Button variant="outline" size="sm" onClick={handleUploadLogs} disabled={isExportingLogs || isCopyingLogs || isUploadingLogs}>
            <Upload className="mr-2 h-3.5 w-3.5" />
            {isUploadingLogs ? '正在上传…' : '上传给技术支持'}
          </Button>
          <Button variant="outline" size="sm" onClick={handleCopyLogs} disabled={isExportingLogs || isCopyingLogs || isUploadingLogs}>
            <ClipboardCopy className="mr-2 h-3.5 w-3.5" />
            {isCopyingLogs
              ? t('diagnostics.copying', { defaultValue: '正在复制…' })
              : t('diagnostics.copy', { defaultValue: '复制到剪贴板' })}
          </Button>
          <Button variant="outline" size="sm" onClick={handleOpenLogDir}>
            {t('diagnostics.openFolder', { defaultValue: '打开日志文件夹' })}
          </Button>
        </div>
        <p className="mt-2 text-body text-muted-foreground">上传仅在你主动点击后发生；完整诊断包会先脱敏，供技术支持在 24 小时内排障。</p>
      </SettingsSectionCard>

      <DesktopCleanupSection />

      <ReleaseHistorySection
        currentVersion={currentVersion}
        items={releaseHistory}
        loading={historyState === 'loading'}
        error={historyState === 'error' ? historyError : ''}
        onRetry={loadReleaseHistory}
      />

      <TechnicalDetails
        expanded={showTechnicalDetails}
        onToggle={() => setShowTechnicalDetails(value => !value)}
        currentVersion={currentVersion}
        platform={platform}
        arch={arch}
        channel={channel}
        updateInfo={updateInfo}
      />

      <MobileEnvironmentQrDialog
        open={showMobileEnvironmentQr}
        onOpenChange={setShowMobileEnvironmentQr}
        config={mobileEnvironmentConfig}
      />
    </SettingsPanelLayout>
  )
}

function StatusIcon({ status }: { status: UpdateStatus }) {
  if (status === 'error') return <Info className="h-4 w-4 text-amber-500" />
  if (status === 'available') return <Download className="h-4 w-4 text-blue-500" />
  if (status === 'checking' || status === 'downloading') return <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />
  return <CheckCircle2 className="h-4 w-4 text-emerald-500" />
}

function ReleaseHistoryItemRow({
  item,
  defaultExpanded,
}: {
  item: ReleaseHistoryItem
  defaultExpanded: boolean
}) {
  const { t } = useTranslation('settings')
  const [expanded, setExpanded] = useState(defaultExpanded)
  const Icon = expanded ? ChevronDown : ChevronRight

  return (
    <div className="rounded-lg bg-muted/20 overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <span className="text-body font-medium flex-1">v{item.version}</span>
        {item.isMandatory ? (
          <span className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive', 'rounded bg-destructive/10 px-1.5 py-0.5')}>
            {t('update.mandatory', { defaultValue: '强制更新' })}
          </span>
        ) : null}
        <span className={SETTINGS_HINT}>{formatDate(item.publishedAt)}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-3 pl-9">
          <p className={cn(SETTINGS_TEXT_META_BASE, 'text-foreground/80', 'whitespace-pre-wrap')}>
            {item.releaseNotes || t('update.noReleaseNotes', { defaultValue: '暂无该版本更新说明' })}
          </p>
        </div>
      )}
    </div>
  )
}

function ReleaseHistorySection({
  currentVersion,
  items,
  loading,
  error,
  onRetry,
}: {
  currentVersion: string
  items: ReleaseHistoryItem[]
  loading: boolean
  error: string
  onRetry: () => void
}) {
  const { t } = useTranslation('settings')

  return (
    <SettingsSectionCard
      title={t('update.recentUpdates', { defaultValue: '最近更新' })}
      subtitle={t('update.recentUpdatesSubtitle', { defaultValue: '当前渠道的版本记录来自发布后台' })}
    >
      <div className="flex flex-col gap-2">
        {loading ? (
          <p className={SETTINGS_TEXT_META}>{t('update.historyLoading', { defaultValue: '正在加载更新日志...' })}</p>
        ) : error ? (
          <StatusNotice
            tone="info"
            title={t('update.historyLoadFailed', { defaultValue: '更新日志暂时无法加载' })}
            description={error}
            actions={(
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                {t('update.retry', { defaultValue: '重试' })}
              </Button>
            )}
          />
        ) : items.length ? (
          items.map((item, index) => (
            <ReleaseHistoryItemRow
              key={`${item.version}-${item.platform}-${item.arch}-${item.channel}`}
              item={item}
              defaultExpanded={normalizeVersion(item.version) === normalizeVersion(currentVersion) || index === 0}
            />
          ))
        ) : (
          <p className={SETTINGS_TEXT_META}>{t('update.noReleaseHistory', { defaultValue: '暂无当前渠道的版本记录' })}</p>
        )}
      </div>
    </SettingsSectionCard>
  )
}

function TechnicalDetails({
  expanded,
  onToggle,
  currentVersion,
  platform,
  arch,
  channel,
  updateInfo,
}: {
  expanded: boolean
  onToggle: () => void
  currentVersion: string
  platform: string
  arch: string
  channel: string
  updateInfo: any
}) {
  const { t } = useTranslation('settings')
  const Icon = expanded ? ChevronDown : ChevronRight
  const details = [
    ['version', currentVersion || ''],
    ['platform', platform],
    ['arch', arch],
    ['channel', channel],
    ['manifestFile', updateInfo?.manifestFile || updateInfo?.manifest_file || ''],
    ['manifestUrl', updateInfo?.manifestUrl || updateInfo?.manifest_url || ''],
    ['feedUrl', updateInfo?.feedUrl || updateInfo?.feed_url || ''],
  ].filter(([, value]) => Boolean(value))

  return (
    <SettingsSectionCard>
      <button
        type="button"
        className={cn(SETTINGS_SECTION_TITLE, 'flex w-full items-center gap-2 text-left hover:text-foreground')}
        onClick={onToggle}
      >
        <Icon className="h-3.5 w-3.5" />
        {t('update.technicalDetails', { defaultValue: '查看技术详情' })}
      </button>
      {expanded ? (
        <div className={cn(SETTINGS_TEXT_META, 'mt-3 space-y-1 rounded-lg bg-muted/20 p-3')}>
          {details.map(([label, value]) => (
            <div key={label} className="grid gap-1 sm:grid-cols-[120px_1fr]">
              <span>{label}</span>
              <span className="break-all text-foreground/80">{value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </SettingsSectionCard>
  )
}

function buildStatusCopy({
  status,
  updateInfo,
  errorMessage,
  t,
}: {
  status: UpdateStatus
  updateInfo: any
  errorMessage: string
  t: TFunction
}) {
  if (status === 'checking') {
    return {
      title: t('update.checking', { defaultValue: '正在检查更新' }),
      description: t('update.checkingDescription', { defaultValue: '正在确认是否有可用版本' }),
    }
  }
  if (status === 'available') {
    return {
      title: t('update.availableTitle', { defaultValue: '有新版本 v{{version}} 可用', version: updateInfo?.version || '' }),
      description: updateInfo?.mandatory
        ? t('update.availableMandatoryDescription', { defaultValue: '这是必须安装的安全更新，请尽快完成安装' })
        : t('update.availableDescription', { defaultValue: '建议更新到最新版本以获得更好的体验' }),
    }
  }
  if (status === 'downloading') {
    return {
      title: t('update.downloading', { defaultValue: '正在下载更新' }),
      description: t('update.downloadingDescription', { defaultValue: '下载完成后即可重启安装' }),
    }
  }
  if (status === 'downloaded') {
    return {
      title: t('update.readyToInstall', { defaultValue: '重启后完成安装' }),
      description: t('update.readyToInstallHint', { defaultValue: '新版本已经准备好，重启应用后生效' }),
    }
  }
  if (status === 'installing') {
    return {
      title: t('update.installing', { defaultValue: '正在安装更新' }),
      description: t('update.installingDescription', { defaultValue: '请稍候，应用会自动重启' }),
    }
  }
  if (status === 'error') {
    return {
      title: t('update.updateFailed', { defaultValue: '更新失败' }),
      description: resolveUpdateErrorDescription(errorMessage, t),
    }
  }
  return {
    title: t('update.alreadyLatest', { defaultValue: '当前已是最新版本' }),
    description: t('update.alreadyLatestDescription', { defaultValue: 'TabTin 会在启动时自动检查可用更新' }),
  }
}

/** 面向用户的失败说明：网络/技术错误转成中文，避免直接展示 fetch failed 等原文 */
function resolveUpdateErrorDescription(errorMessage: string, t: TFunction): string {
  const friendly = t('update.unknownError', {
    defaultValue: '网络不稳定或服务暂时不可用，请稍后重试。',
  })
  const raw = errorMessage.trim()
  if (!raw) return friendly
  // 已是中文产品文案则保留
  if (/[\u4e00-\u9fff]/.test(raw) && !/TypeError|fetch failed|Failed to fetch/i.test(raw)) {
    return raw
  }
  return friendly
}

function buildPrimaryAction({
  status,
  updateInfo,
  t,
}: {
  status: UpdateStatus
  updateInfo: any
  t: TFunction
}) {
  if (status === 'available' && updateInfo) {
    return { kind: 'download' as const, label: t('update.downloadUpdate'), disabled: false }
  }
  if (status === 'downloaded') {
    return { kind: 'install' as const, label: t('update.restartAndInstall'), disabled: false }
  }
  if (status === 'checking') {
    return { kind: 'check' as const, label: t('update.checking'), disabled: true }
  }
  if (status === 'downloading' || status === 'installing') {
    return { kind: 'check' as const, label: t('update.checkUpdate'), disabled: true }
  }
  return { kind: 'check' as const, label: status === 'error' ? t('update.retry', { defaultValue: '重新检查' }) : t('update.checkUpdate'), disabled: false }
}

export function normalizeReleaseHistory(items: any[]): ReleaseHistoryItem[] {
  if (!Array.isArray(items)) return []
  return items
    .filter(item => item && typeof item.version === 'string')
    .map(item => ({
      version: item.version,
      platform: item.platform,
      arch: item.arch,
      channel: item.channel,
      releaseNotes: item.releaseNotes ?? item.release_notes ?? '',
      releaseNotesEn: item.releaseNotesEn ?? item.release_notes_en ?? '',
      publishedAt: item.publishedAt ?? item.published_at ?? null,
      isMandatory: Boolean(item.isMandatory ?? item.is_mandatory),
      priority: item.priority ?? 'normal',
    }))
}

function getUpdateReleaseNotes(updateInfo: any): string {
  return updateInfo?.releaseNotes || updateInfo?.release_notes || ''
}

function normalizeVersion(version: string): string {
  return version.replace(/^v/i, '')
}

function formatChannelLabel(channel: string, t: TFunction): string {
  if (channel === 'stable') return t('update.channelStable', { defaultValue: '正式版' })
  if (channel === 'beta') return t('update.channelBeta', { defaultValue: '测试版' })
  return t('update.channelAlpha', { defaultValue: '预发版' })
}

function formatPlatformLabel(platform: string, t: TFunction): string {
  if (platform === 'win') return t('update.platformWindows', { defaultValue: 'Windows' })
  if (platform === 'mac') return t('update.platformMac', { defaultValue: 'macOS' })
  return t('update.platformLinux', { defaultValue: 'Linux' })
}

function formatLastChecked(value: string | null, t: TFunction): string {
  if (!value) return t('update.notCheckedYet', { defaultValue: '尚未检查' })
  return formatDate(value)
}

function formatDate(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString()
}
