import React, { useCallback, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, FileText, LayoutTemplate, Table2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { isLocalFileArtifactHref } from '@/services/localFileResourceResolver'
import type { TurnArtifact, TurnArtifactKind } from './turnArtifacts'
import { filterHistoryArtifactsNotInTurn } from './turnArtifacts'
import { useResourcePreviewStore } from '../preview/useResourcePreviewStore'
import { useArtifactOpenActions } from './useArtifactOpenActions'
import { ArtifactOpenInMenu } from './ArtifactOpenInMenu'

interface TurnArtifactsCardProps {
  artifacts: TurnArtifact[]
  /** 当前轮之前各轮产物；折叠区再去掉与本轮重复的项 */
  historyArtifacts?: TurnArtifact[]
  sessionId: string
  tabScopeKey?: string | null
}

const KIND_ICON: Record<TurnArtifactKind, typeof FileText> = {
  file: FileText,
  doc: FileText,
  table: Table2,
  resource: FileText,
  widget: LayoutTemplate,
}

const MAX_COLLAPSED_ARTIFACTS = 5

export function useArtifactSubtitle(): (artifact: TurnArtifact) => string {
  const { t } = useTranslation('chat')
  return useCallback((artifact: TurnArtifact): string => {
    switch (artifact.subtitleKey) {
      case 'previewDoc':
        return t('turnArtifacts.previewDoc', { defaultValue: '预览文档' })
      case 'previewTable':
        return t('turnArtifacts.previewTable', { defaultValue: '预览表格' })
      case 'previewResource':
        return t('turnArtifacts.previewResource', { defaultValue: '预览资源' })
      case 'previewOrDownload':
        return t('turnArtifacts.previewOrDownload', { defaultValue: '预览或者下载文件' })
      case 'previewWidget':
        return t('turnArtifacts.previewWidget', { defaultValue: '查看图示' })
      default:
        return t('turnArtifacts.previewFile', { defaultValue: '预览文件' })
    }
  }, [t])
}

function ArtifactRow({
  artifact,
  tabKey,
  subtitle,
  sessionId,
  onPreviewOpened,
}: {
  artifact: TurnArtifact
  tabKey: string | null
  subtitle: string
  sessionId: string
  onPreviewOpened?: () => void
}) {
  const { t } = useTranslation('chat')
  const Icon = KIND_ICON[artifact.kind]
  // 文件类产物走与 create_file 卡完全相同的打开语义（useArtifactOpenActions）
  // + 同款「Open in」下拉；doc / table / resource 是云端资源、widget 是图示，
  // 各自保留「预览」单动作。
  const isFile = artifact.kind === 'file'
  const isOssFile = isFile && !isLocalFileArtifactHref(artifact.href)
  const openIntentHints = useMemo(
    () => isFile ? { filename: artifact.title } : undefined,
    [artifact.title, isFile],
  )
  const openActions = useArtifactOpenActions({
    href: artifact.href,
    tabScopeKey: tabKey,
    isOssFile,
    resourceSpaceId: artifact.resourceSpaceId,
    openIntentHints,
    fileSize: artifact.fileSize,
  })

  const openWidgetLightbox = useCallback((): boolean => {
    if (artifact.kind !== 'widget' || !artifact.widgetId) return false
    const store = useResourcePreviewStore.getState()
    const messageId = artifact.sourceMessageId
    const resourceId = messageId ? `${messageId}:widget:${artifact.widgetId}` : undefined
    if (sessionId && messageId && store.openFromMessage(sessionId, messageId, { resourceId })) {
      return true
    }
    toast({
      title: t('turnArtifacts.previewFailed', { defaultValue: '无法预览' }),
      description: t('turnArtifacts.widgetPreviewUnavailable', {
        defaultValue: '找不到对应图示，请在对话中点击图示卡放大查看',
      }),
      variant: 'destructive',
    })
    return false
  }, [artifact.kind, artifact.widgetId, artifact.sourceMessageId, sessionId, t])

  const handlePrimary = useCallback(async () => {
    onPreviewOpened?.()
    if (artifact.kind === 'widget') {
      openWidgetLightbox()
      return
    }
    await openActions.openPrimary()
  }, [artifact.kind, openWidgetLightbox, openActions, onPreviewOpened])

  const handleVersionHistory = useCallback(async () => {
    onPreviewOpened?.()
    if (artifact.kind !== 'doc') {
      toast({
        title: t('turnArtifacts.versionHistoryUnsupported', {
          defaultValue: '该产物暂不支持版本历史',
        }),
      })
      return
    }
    await openActions.openVersionHistory()
  }, [artifact.kind, onPreviewOpened, openActions, t])

  const rowInner = (
    <>
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border',
          'border-border/60 bg-muted/30 text-muted-foreground',
        )}
        aria-hidden
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="min-w-0 flex-1 truncate text-caption font-medium text-foreground">{artifact.title}</p>
          {artifact.sourceSubagentName ? (
            <span
              data-testid="artifact-subagent-source-badge"
              className={cn(
                'min-w-0 max-w-[min(40%,12rem)] shrink-0 truncate rounded px-1.5 py-px text-caption font-medium',
                'bg-muted/60 text-muted-foreground/80',
              )}
              title={t('turnArtifacts.fromSubagent', {
                name: artifact.sourceSubagentName,
                defaultValue: `来自 ${artifact.sourceSubagentName}`,
              })}
            >
              {artifact.sourceSubagentName}
            </span>
          ) : null}
        </div>
        <p className="text-caption text-muted-foreground/60 truncate">
          {openActions.isSharedSessionLocalFile
            ? `${subtitle} · ${t('card.openFile.sharedPreviewChip', { defaultValue: '共享预览' })}`
            : openActions.isRemoteLocalFile
              ? `${subtitle} · ${t('card.openFile.remoteChip', { defaultValue: '远程设备文件' })}`
              : subtitle}
        </p>
      </div>
    </>
  )

  // 文件类：与 create_file 卡同构——整行可点触发主动作 + 「Open in」下拉。
  if (isFile) {
    return (
      <div
        role="button"
        tabIndex={0}
        data-testid="artifact-file-row"
        title={
          openActions.isSharedPreviewTooLarge
            ? (openActions.sharedPreviewDisabledHint ?? undefined)
            : undefined
        }
        aria-label={
          openActions.isSharedPreviewTooLarge
            ? (openActions.sharedPreviewDisabledHint ?? undefined)
            : undefined
        }
        className={cn(
          'group flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20 cursor-pointer',
          openActions.isSharedPreviewTooLarge && 'cursor-not-allowed opacity-80',
        )}
        onClick={() => {
          if (openActions.isSharedPreviewTooLarge) return
          void handlePrimary()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (openActions.isSharedPreviewTooLarge) return
            void handlePrimary()
          }
        }}
      >
        {rowInner}
        <ArtifactOpenInMenu
          actions={openActions}
          fileIcon={Icon}
          isOssFile={isOssFile}
          title={artifact.title}
          stopPropagation
          onAction={onPreviewOpened}
          triggerClassName="hover:border-accent/30 hover:text-accent"
        />
      </div>
    )
  }

  // 云端资源 / 图示：「预览」主动作；文档另挂「版本历史」次级入口。
  return (
    <div className="group flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20">
      {rowInner}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {artifact.kind === 'doc' ? (
          <button
            type="button"
            data-testid="artifact-version-history"
            className={cn(
              'inline-flex h-7 items-center rounded-md border border-border/60 px-2',
              'text-caption font-medium text-muted-foreground transition-colors',
              'hover:border-accent/30 hover:bg-muted/40 hover:text-accent',
            )}
            onClick={() => { void handleVersionHistory() }}
          >
            {t('turnArtifacts.versionHistory', { defaultValue: '版本历史' })}
          </button>
        ) : null}
        <button
          type="button"
          className={cn(
            'inline-flex h-7 items-center rounded-md border border-border/60 px-2',
            'text-caption font-medium text-muted-foreground transition-colors',
            'hover:border-accent/30 hover:bg-muted/40 hover:text-accent',
          )}
          onClick={() => { void handlePrimary() }}
        >
          {t('turnArtifacts.preview', { defaultValue: '预览' })}
        </button>
      </div>
    </div>
  )
}

export const TurnArtifactsCard: React.FC<TurnArtifactsCardProps> = React.memo(({
  artifacts,
  historyArtifacts = [],
  sessionId,
  tabScopeKey = null,
}) => {
  const { t } = useTranslation('chat')
  const tabKey = tabScopeKey ?? (sessionId ? `conversation:${sessionId}` : null)
  const subtitleFor = useArtifactSubtitle()
  const [artifactsExpanded, setArtifactsExpanded] = useState(false)
  const [otherExpanded, setOtherExpanded] = useState(false)

  const hasHiddenArtifacts = artifacts.length > MAX_COLLAPSED_ARTIFACTS
  const hiddenArtifactsCount = artifacts.length - MAX_COLLAPSED_ARTIFACTS
  const visibleArtifacts = hasHiddenArtifacts && !artifactsExpanded
    ? artifacts.slice(0, MAX_COLLAPSED_ARTIFACTS)
    : artifacts

  const priorArtifacts = useMemo(
    () => filterHistoryArtifactsNotInTurn(historyArtifacts, artifacts),
    [historyArtifacts, artifacts],
  )

  // 实时聚合可能短暂挂载卡片后再把无效条目过滤为空；此时整张卡片都不展示，
  // 避免用户看到只有「产物」标题的空壳。
  if (artifacts.length === 0) return null

  return (
    <div
      className="mt-2 w-full max-w-[min(28rem,100%)] rounded-lg border border-border/60 bg-background/80 shadow-sm"
      data-testid="turn-artifacts-card"
    >
      <div className="border-b border-border/40 px-3 py-2">
        <p className="text-caption font-medium text-foreground">
          {t('turnArtifacts.title', { defaultValue: '产物' })}
        </p>
      </div>
      <ul className="divide-y divide-border/40">
        {visibleArtifacts.map((artifact) => (
          <li key={artifact.id}>
            <ArtifactRow
              artifact={artifact}
              tabKey={tabKey}
              subtitle={subtitleFor(artifact)}
              sessionId={sessionId}
            />
          </li>
        ))}
        {hasHiddenArtifacts ? (
          <li>
            <button
              type="button"
              data-testid="turn-artifacts-toggle"
              aria-expanded={artifactsExpanded}
              className={cn(
                'flex w-full items-center gap-1.5 px-3 py-2 text-left transition-colors',
                'text-caption font-medium text-muted-foreground hover:bg-muted/15 hover:text-foreground',
              )}
              onClick={() => setArtifactsExpanded((expanded) => !expanded)}
            >
              {artifactsExpanded ? (
                <ChevronUp className="h-3.5 w-3.5 shrink-0" aria-hidden />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              <span>
                {artifactsExpanded
                  ? t('turnArtifacts.collapse', { defaultValue: '收起' })
                  : t('turnArtifacts.showMoreFiles', {
                    count: hiddenArtifactsCount,
                    defaultValue: '还有 {{count}} 个文件',
                  })}
              </span>
            </button>
          </li>
        ) : null}
        {priorArtifacts.length > 0 ? (
          <li data-testid="other-artifacts-accordion" className="bg-muted/5">
            <button
              type="button"
              data-testid="other-artifacts-toggle"
              aria-expanded={otherExpanded}
              className={cn(
                'flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors',
                'hover:bg-muted/15',
              )}
              onClick={() => setOtherExpanded((open) => !open)}
            >
              <ChevronDown
                className={cn(
                  'h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform duration-200',
                  otherExpanded && 'rotate-180',
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground/70">
                {t('turnArtifacts.otherArtifacts', { defaultValue: '历史产物' })}
                <span className="ml-1 text-muted-foreground/45">
                  {t('turnArtifacts.otherArtifactsCount', {
                    count: priorArtifacts.length,
                    defaultValue: '{{count}} 项',
                  })}
                </span>
              </span>
            </button>
            {otherExpanded ? (
              <ul
                data-testid="other-artifacts-list"
                className={cn(
                  'border-t border-border/30 divide-y divide-border/30',
                  'opacity-80',
                )}
              >
                {priorArtifacts.map((artifact) => (
                  <li key={artifact.id}>
                    <ArtifactRow
                      artifact={artifact}
                      tabKey={tabKey}
                      subtitle={subtitleFor(artifact)}
                      sessionId={sessionId}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ) : null}
      </ul>
    </div>
  )
})

TurnArtifactsCard.displayName = 'TurnArtifactsCard'
