import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Share2,
  Copy,
  Check,
  ExternalLink,
  Link2,
  RefreshCw,
  XCircle,
  Loader2,
} from 'lucide-react'
import {
  Button,
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  TabsRoot,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  toast,
} from '@tabtin/smartsheet-ui'
import { ViewApiService, buildTableApiUrl } from '@tabtin/table-core'
import { electronFetch } from '@/services/electronFetch'

function FormTooltip({
  content,
  children,
}: {
  content: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{children}</span>
        </TooltipTrigger>
        <TooltipContent>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export type FormMode = 'edit' | 'fill'

export interface FormToolBarProps {
  mode: FormMode
  onModeChange: (mode: FormMode) => void
  viewId?: string | null
  className?: string
  /** 隐藏编辑模式 Tab（权限不足或移动端场景） */
  hideEditTab?: boolean
}

export const FormToolBar: React.FC<FormToolBarProps> = ({
  mode,
  onModeChange,
  viewId,
  className,
  hideEditTab,
}) => {
  const { t } = useTranslation('view')

  const [shareLoading, setShareLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [isShared, setIsShared] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [disabling, setDisabling] = useState(false)

  const handleCreateShare = useCallback(async () => {
    if (!viewId || shareLoading) return
    setShareLoading(true)
    try {
      const result = await ViewApiService.createFormShare(viewId)
      const shareId = result?.share?.share_id
      if (shareId) {
        const url = `${window.location.origin}/forms/${shareId}`
        setShareUrl(url)
        setIsShared(true)
      }
    } catch (err) {
      toast.error(t('form.shareCreateFailed'))
      console.error('[FormToolBar] createFormShare failed:', err)
    } finally {
      setShareLoading(false)
    }
  }, [viewId, shareLoading, t])

  const handleCopyUrl = useCallback(() => {
    if (!shareUrl) return
    navigator.clipboard.writeText(shareUrl)
    setCopied(true)
    toast.success(t('form.linkCopied'))
    setTimeout(() => setCopied(false), 2000)
  }, [shareUrl, t])

  const handleDisableShare = useCallback(async () => {
    if (!viewId || disabling) return
    setDisabling(true)
    try {
      const url = buildTableApiUrl(`/tabdata/views/${viewId}/form-share`)
      const token = await import('@tabtin/table-core').then(m => m.getRequiredAccessToken())
      const res = await electronFetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message || body?.data?.message || 'failed')
      }
      setIsShared(false)
      setShareUrl(null)
      toast.success(t('form.shareDisabled'))
    } catch (err) {
      toast.error(t('form.shareDisableFailed'))
      console.error('[FormToolBar] disableShare failed:', err)
    } finally {
      setDisabling(false)
    }
  }, [viewId, disabling, t])

  const handleRefreshShare = useCallback(async () => {
    if (!viewId || refreshing) return
    setRefreshing(true)
    try {
      const url = buildTableApiUrl(`/tabdata/views/${viewId}/form-share/refresh`)
      const token = await import('@tabtin/table-core').then(m => m.getRequiredAccessToken())
      const res = await electronFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      })
      const envelope = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(envelope?.message || envelope?.data?.message || 'failed')
      }
      const newShareId = envelope?.data?.share?.share_id
      if (newShareId) {
        const newUrl = `${window.location.origin}/forms/${newShareId}`
        setShareUrl(newUrl)
        toast.success(t('form.shareRefreshed'))
      } else {
        throw new Error('No share_id in response')
      }
    } catch (err) {
      toast.error(t('form.shareRefreshFailed'))
      console.error('[FormToolBar] refreshShare failed:', err)
    } finally {
      setRefreshing(false)
    }
  }, [viewId, refreshing, t])

  return (
    <div className={cn('border-b border-border/60 bg-background', className)}>
      <div className="flex h-8 items-center gap-1.5 px-2 sm:px-3 md:px-3">
        <div className="min-w-0 flex-1">
          {hideEditTab ? (
            <div className="flex h-6 items-center rounded-md bg-muted px-2.5">
              <span className="text-caption font-medium text-foreground">
                {t('form.fillMode')}
              </span>
            </div>
          ) : (
            <TabsRoot
              value={mode}
              onValueChange={v => onModeChange(v as FormMode)}
            >
              <TabsList className="h-6 rounded-md bg-muted p-0.5">
                <TabsTrigger
                  value="edit"
                  className="h-5 rounded px-2.5 text-caption data-[state=active]:shadow-sm"
                >
                  {t('form.editMode')}
                </TabsTrigger>
                <TabsTrigger
                  value="fill"
                  className="h-5 rounded px-2.5 text-caption data-[state=active]:shadow-sm"
                >
                  {t('form.fillMode')}
                </TabsTrigger>
              </TabsList>
            </TabsRoot>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isShared && shareUrl ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-caption"
                >
                  <Link2 className="h-3.5 w-3.5 text-primary" />
                  {t('form.shareLinkReady')}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-3">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5">
                    <Input
                      readOnly
                      value={shareUrl}
                      className="h-auto border-0 bg-transparent p-0 text-caption focus-visible:ring-0"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 gap-1.5 text-caption"
                      onClick={handleCopyUrl}
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      {copied ? t('form.copied') : t('form.copyLink')}
                    </Button>
                    <FormTooltip content={t('form.goToLink')}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => window.open(shareUrl, '_blank')}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </FormTooltip>
                  </div>
                  <div className="border-t border-border/60 pt-2">
                    <div className="flex gap-2">
                      <FormTooltip content={t('form.refreshShareTooltip')}>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 gap-1.5 text-caption"
                          onClick={() => void handleRefreshShare()}
                          disabled={refreshing}
                        >
                          {refreshing ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                          )}
                          {t('form.refreshShareLink')}
                        </Button>
                      </FormTooltip>
                      <FormTooltip content={t('form.disableShareTooltip')}>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 text-caption text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => void handleDisableShare()}
                          disabled={disabling}
                        >
                          {disabling ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <XCircle className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </FormTooltip>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          ) : viewId ? (
            <FormTooltip content={t('form.shareTooltip')}>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2"
                onClick={() => void handleCreateShare()}
                disabled={shareLoading}
              >
                <Share2 className="h-3.5 w-3.5" />
                <span className="text-caption">
                  {shareLoading
                    ? t('form.creatingShare')
                    : t('form.createShareLink')}
                </span>
              </Button>
            </FormTooltip>
          ) : null}
        </div>
      </div>
    </div>
  )
}
