import { AlertTriangle, CheckCircle2, Download, RefreshCw, X } from 'lucide-react'
import { Button, OVERLAY_SURFACE_CLASS, Progress } from '@tabtin/smartsheet-ui'

import type {
  OverlayUpdatePromptActionPayload,
  OverlayUpdatePromptInfo,
  OverlayUpdatePromptState,
} from '@shared/overlay/types'

const FALLBACK_ERROR_MESSAGE = '更新失败，请稍后重试'

function formatBytes(bytes?: number | null): string | null {
  if (!bytes || bytes <= 0) return null
  const mb = bytes / 1024 / 1024
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

function resolveFileSize(info: OverlayUpdatePromptInfo | null | undefined): number | null {
  if (!info) return null
  const direct = info.fileSize ?? info.file_size
  if (typeof direct === 'number' && direct > 0) return direct
  const fileEntry = Array.isArray(info.files) ? info.files[0] : null
  return typeof fileEntry?.size === 'number' ? fileEntry.size : null
}

function sendAction(action: OverlayUpdatePromptActionPayload['action']): void {
  window.tabtin?.overlay?.sendUpdatePromptAction?.({
    type: 'update-prompt-action',
    action,
  })
}

function resolveTitle(state: OverlayUpdatePromptState, targetVersion: string): string {
  if (state.status === 'downloaded') return '更新已下载完成'
  if (state.status === 'downloading') return '正在下载更新'
  if (state.status === 'installing') return '正在准备安装'
  if (state.status === 'error') return '更新失败'
  return `发现新版本 v${targetVersion}`
}

export function UpdatePromptOverlay({ state }: { state: OverlayUpdatePromptState }) {
  const targetVersion = String(state.updateInfo?.version ?? '')
  const fileSizeLabel = formatBytes(resolveFileSize(state.updateInfo))
  const releaseNotes = String(state.updateInfo?.releaseNotes ?? state.updateInfo?.release_notes ?? '').trim()
  const mandatory = Boolean(state.updateInfo?.mandatory)
  const isError = state.status === 'error'
  const downloadProgress = Math.round(state.downloadProgress ?? 0)

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-global flex items-end justify-center p-5 sm:items-center"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="overlay-update-prompt-title"
    >
      <div
        className="absolute inset-0 bg-modal-scrim"
        aria-hidden="true"
        onClick={() => sendAction('dismiss')}
      />
      <div className={`relative z-10 w-full max-w-[440px] rounded-2xl p-5 ${OVERLAY_SURFACE_CLASS}`}>
        <div className="flex items-start gap-3">
          <div
            className={
              `mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ` +
              (isError ? 'bg-destructive/10 text-destructive' : 'bg-accent/10 text-accent')
            }
          >
            {isError ? <AlertTriangle className="h-5 w-5" /> : <Download className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="overlay-update-prompt-title" className="text-subtitle font-semibold text-foreground">
                  {resolveTitle(state, targetVersion)}
                </h2>
                <p className="mt-1 text-caption text-muted-foreground">
                  当前版本 v{state.currentVersion || '...'}
                  {targetVersion ? ` · 目标版本 v${targetVersion}` : ''}
                </p>
              </div>
              {(state.status === 'available' && !mandatory) || isError ? (
                <button
                  type="button"
                  className="rounded-md p-1 text-muted-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground"
                  onClick={() => sendAction('dismiss')}
                  aria-label={isError ? '关闭错误提示' : '关闭更新提示'}
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>

            {mandatory ? (
              <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-caption text-destructive">
                这是强制更新，下载完成后需要重启安装才能继续使用。
              </div>
            ) : null}

            {state.status === 'downloading' || state.status === 'installing' ? (
              <div className="mt-4 space-y-2">
                <Progress value={downloadProgress} />
                <div className="flex justify-between text-caption text-muted-foreground">
                  <span>{state.status === 'installing' ? '准备安装中' : '下载进度'}</span>
                  <span>{downloadProgress}%</span>
                </div>
              </div>
            ) : null}

            {state.status === 'downloaded' ? (
              <div className="mt-4 flex items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-caption text-accent">
                <CheckCircle2 className="h-4 w-4" />
                <span>更新包已准备好，重启应用即可完成安装。</span>
              </div>
            ) : null}

            {isError ? (
              <p className="mt-3 text-caption text-destructive">{state.errorMessage || FALLBACK_ERROR_MESSAGE}</p>
            ) : null}

            {state.status === 'available' && releaseNotes ? (
              <p className="mt-3 max-h-24 overflow-auto whitespace-pre-wrap text-caption text-muted-foreground">
                {releaseNotes}
              </p>
            ) : null}

            {state.status === 'available' && fileSizeLabel ? (
              <p className="mt-2 text-caption text-muted-foreground">安装包大小：{fileSizeLabel}</p>
            ) : null}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => sendAction('open-settings')}>
                查看版本详情
              </Button>
              {state.status === 'available' ? (
                <Button size="sm" onClick={() => sendAction('download')}>
                  <Download className="mr-2 h-3.5 w-3.5" />
                  下载更新
                </Button>
              ) : null}
              {state.status === 'downloaded' ? (
                <Button size="sm" onClick={() => sendAction('install')}>
                  重启并安装
                </Button>
              ) : null}
              {isError ? (
                <Button variant="outline" size="sm" onClick={() => sendAction('open-settings')}>
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  手动检查
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
