/**
 * IMResourceCard — 私信里的 TabData 表格 / TabDoc 文档资源卡片（TC-5）。
 *
 * 视觉参照飞书：卡片主体直接渲染文档/表格开头内容，类型与操作提示收在底部。
 * 颜色固定：文档蓝，表格绿。
 * 权限：读取后端按资源 ACL 计算的真实角色，显示「你可编辑」或「你可阅读」；
 * forbidden 显示「申请访问」，不展示可读文案。
 */

import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Ban, ExternalLink, FileText, Loader2, Table2 } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { openSharedResourceTab } from '@/services/openSharedResource'
import {
  openResourceTabGuarded,
  openTableTabGuarded,
} from '@/components/context-space/restore/openResourceMembershipGuard'
import { expandCanvasForScope } from '@/services/openResourceLink'
import { buildDesktopScopeKey } from '@components/layout/workspaceContextState'
import { ensureSpaceSelectedWithFeedback } from '@/services/spaceNavigation'
import { useAuthStore } from '@stores/useAuthStore'
import { createResourceAccessRequest } from '@/services/tabchatApi'
import { useImConversationCanvas, type ImConversationCanvasTarget } from './ImConversationCanvasContext'
import type { IMResourceCardTablePreview } from '@/lib/imResourceCardPreview'
import { useResourceCardPreviewContext } from '@/lib/useResourceCardPreview'
import { DocumentPreviewBody, TablePreviewBody } from './IMResourceCardPreviewBody'

// ─── 固定颜色 ─────────────────────────────────────────────────────────────────
// 文档（tabdoc）: 蓝色  表格（tabdata）: 绿色

const TYPE_ACCENT = {
  document: {
    card: 'bg-blue-500/[0.08] border-blue-500/20',
    color: 'text-blue-600 dark:text-blue-400',
  },
  table: {
    card: 'bg-emerald-500/[0.08] border-emerald-500/20',
    color: 'text-emerald-600 dark:text-emerald-400',
  },
} as const

// ─── 组件 ───────────────────────────────────────────────────────────────────

interface Props {
  resourceType: 'table' | 'document'
  resourceId: string
  name: string
  spaceId?: string
  /** TC-23：资源所属 organization，用于跨 organization 分享时切到正确团队再打开 */
  organizationId?: string
  description?: string
  previewTable?: IMResourceCardTablePreview
  /** 申请访问所需：来源会话 / 消息（由 IMMessageBubble 传入） */
  sourceConversationId?: string
  sourceMessageId?: number
  sourceMessageRef?: string
}

export interface IMResourceOpenTarget {
  resourceType: 'table' | 'document'
  resourceId: string
  name: string
  spaceId?: string
  organizationId?: string
}

function resolveDesktopResourceTabScopeKey(spaceId: string, organizationId?: string): string {
  const resolvedOrganizationId = organizationId
    ?? useSpaceStore.getState().spaces.find(space => space.id === spaceId)?.organization_id
    ?? null
  const userId = useAuthStore.getState().user?.id ?? null
  return buildDesktopScopeKey({ organizationId: resolvedOrganizationId, userId })
}

export async function openIMResourceFromChat(target: IMResourceOpenTarget, t: TFunction) {
  const { resourceType, resourceId, name, spaceId, organizationId } = target
  const resourceSpaceId = spaceId === 'None' ? undefined : spaceId
  if (!resourceId || (!resourceSpaceId && !organizationId)) return

  useSettingsSpaceStore.getState().closeSettings()
  useMainNavStore.getState().setCurrentTab('agent')

  const spaceStore = useSpaceStore.getState()
  const spaceVisibleToUser = spaceStore.spaces.some((space) => space.id === resourceSpaceId)
  if (!spaceVisibleToUser) {
    const selectedSpace = spaceStore.selectedSpace
    const visibleSelectedSpace = selectedSpace
      ? spaceStore.spaces.find((space) => space.id === selectedSpace.id) ?? null
      : null
    const hostSpace = visibleSelectedSpace
      ?? spaceStore.spaces.find((space) => space.organization_id === organizationId)
      ?? spaceStore.spaces[0]
      ?? null
    const hostSpaceId = hostSpace?.id ?? null
    const hostOrganizationId = hostSpace?.organization_id ?? null

    if (!hostSpaceId || !hostOrganizationId) {
      toast({
        title: t('resourceOpenFailed', { defaultValue: '无法打开该资源' }),
        description: t('resourceOpenFailedDesc', {
          defaultValue: '资源可能已删除，或你没有访问权限',
        }),
        variant: 'destructive',
      })
      return
    }

    const ok = await ensureSpaceSelectedWithFeedback(hostSpaceId, {
      organizationId: hostOrganizationId,
      failureToast: {
        title: t('resourceOpenFailed', { defaultValue: '无法打开该资源' }),
        description: t('resourceOpenFailedDesc', {
          defaultValue: '资源可能已删除，或你没有访问权限',
        }),
        variant: 'destructive',
      },
    })
    if (!ok) return

    openSharedResourceTab({
      hostSpaceId,
      resourceType: resourceType === 'table' ? 'table' : 'doc',
      resourceId,
      resourceSpaceId,
      // 组织级资源没有 legacy space_id；以当前承载工作台的组织作为归属回退。
      organizationId: organizationId ?? hostOrganizationId,
      title: name || '',
    })
    return
  }

  // 没有 legacy space_id 的组织级资源已在上面的外部资源路径打开。
  if (!resourceSpaceId) return

  const ok = await ensureSpaceSelectedWithFeedback(resourceSpaceId, {
    organizationId,
    failureToast: {
      title: t('resourceOpenFailed', { defaultValue: '无法打开该资源' }),
      description: t('resourceOpenFailedDesc', {
        defaultValue: '资源可能已删除，或你没有访问权限',
      }),
      variant: 'destructive',
    },
  })
  if (!ok) return

  // 同 Space 打开：标签写入前台 scope 桶（desktop/conversation），资源归属仍用 spaceId。
  // 跨 Space 分支走上面的 openSharedResourceTab，不经过这里。
  const foregroundScopeKey = resolveDesktopResourceTabScopeKey(resourceSpaceId, organizationId)
  if (resourceType === 'table') {
    openTableTabGuarded(foregroundScopeKey, resourceId, { refreshSpaceId: resourceSpaceId })
  } else {
    openResourceTabGuarded(foregroundScopeKey, {
      type: 'tabdoc',
      id: resourceId,
      title: name || '',
      meta: { spaceId: resourceSpaceId },
    }, resourceSpaceId)
  }
}

export function openImResourceInCanvas(
  target: IMResourceOpenTarget,
  canvas: ImConversationCanvasTarget,
): void {
  const { resourceType, resourceId, name, spaceId, organizationId } = target
  const resourceSpaceId = spaceId === 'None' ? undefined : spaceId
  if (!resourceId || (!resourceSpaceId && !organizationId)) return
  openSharedResourceTab({
    hostSpaceId: canvas.executionSpaceId,
    resourceType: resourceType === 'table' ? 'table' : 'doc',
    resourceId,
    resourceSpaceId,
    organizationId: organizationId ?? '',
    title: name,
    tabScopeKey: canvas.scopeKey,
  })
  // 对齐收起栏点「打开的标签」：开资源后必须展开画布，否则只出现在侧栏标签列表里。
  expandCanvasForScope(canvas.scopeKey)
}

export const IMResourceCard: React.FC<Props> = ({
  resourceType,
  resourceId,
  name,
  spaceId,
  organizationId,
  description,
  previewTable,
  sourceConversationId,
  sourceMessageId,
  sourceMessageRef,
}) => {
  const { t } = useTranslation('tabchat')
  const {
    previewText,
    previewTable: resolvedPreviewTable,
    liveTitle,
    availability,
    currentUserRole,
  } = useResourceCardPreviewContext(
    resourceId,
    spaceId,
    description,
    previewTable,
    resourceType,
  )
  const [accessRequested, setAccessRequested] = useState(false)
  const [requestingAccess, setRequestingAccess] = useState(false)

  // liveTitle 随文件重命名实时更新，name 是发送时快照作为回退
  const displayName = (liveTitle || name)?.trim() || t(
    resourceType === 'table' ? 'resourceCardTable' : 'resourceCardDocument',
    { defaultValue: resourceType === 'table' ? '多维表格' : '云文档' },
  )

  // 权限标签只认资源 ACL；组织 editor 并不等于能编辑任意文档/表格。
  const canEdit = currentUserRole === 'owner'
    || currentUserRole === 'admin'
    || currentUserRole === 'editor'
  const permissionLabel = canEdit
    ? t('resourceCardCanEdit', { defaultValue: '你可编辑' })
    : t('resourceCardCanRead', { defaultValue: '你可阅读' })

  const conversationCanvas = useImConversationCanvas()
  const handleOpen = useCallback(async () => {
    const target = { resourceType, resourceId, name: displayName, spaceId, organizationId }
    if (conversationCanvas) {
      openImResourceInCanvas(target, conversationCanvas)
      return
    }
    await openIMResourceFromChat(target, t)
  }, [conversationCanvas, displayName, resourceId, spaceId, organizationId, resourceType, t])

  const canRequestAccess = Boolean(
    sourceConversationId
    && ((typeof sourceMessageRef === 'string' && sourceMessageRef.trim())
      || (typeof sourceMessageId === 'number' && Number.isFinite(sourceMessageId)))
    && resourceId,
  )

  const handleRequestAccess = useCallback(async (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!canRequestAccess || accessRequested || requestingAccess) return
    if (!sourceConversationId) return
    setRequestingAccess(true)
    try {
      await createResourceAccessRequest({
        sourceConversationId,
        ...(typeof sourceMessageId === 'number' ? { sourceMessageId } : {}),
        ...(sourceMessageRef?.trim() ? { sourceMessageRef: sourceMessageRef.trim() } : {}),
        resourceType,
        resourceId,
      })
      setAccessRequested(true)
      toast({
        title: t('resourceCardAccessRequestedToast', { defaultValue: '已提交访问申请' }),
        description: t('resourceCardAccessRequestedToastDesc', {
          defaultValue: '已通知资源所有者，通过后即可查看',
        }),
      })
    } catch (err) {
      toast({
        title: t('resourceCardAccessRequestFailed', { defaultValue: '申请失败' }),
        description: err instanceof Error
          ? err.message
          : t('resourceCardAccessRequestFailedDesc', { defaultValue: '请稍后重试' }),
        variant: 'destructive',
      })
    } finally {
      setRequestingAccess(false)
    }
  }, [
    accessRequested,
    canRequestAccess,
    requestingAccess,
    resourceId,
    resourceType,
    sourceConversationId,
    sourceMessageId,
    sourceMessageRef,
    t,
  ])

  const isTable = resourceType === 'table'
  const Icon = isTable ? Table2 : FileText
  const typeLabel = isTable
    ? t('resourceCardTable', { defaultValue: '多维表格' })
    : t('resourceCardDocument', { defaultValue: '云文档' })
  const emptyPreviewLabel = t('resourceCardPreviewFallback', { defaultValue: '暂无内容预览' })
  const accent = TYPE_ACCENT[resourceType]
  const isDeleted = availability === 'deleted'
  const isForbidden = availability === 'forbidden'
  const cardClass = isDeleted ? 'bg-muted/30 border-border/40' : accent.card
  const typeColorClass = isDeleted ? 'text-muted-foreground/80' : accent.color
  const canOpen = Boolean(
    resourceId
    && ((spaceId && spaceId !== 'None') || organizationId)
    && !isDeleted
    && !isForbidden,
  )
  const cardShellClass = `group relative w-[300px] max-w-full overflow-hidden rounded-2xl border ${cardClass} text-left shadow-sm transition-all ${isDeleted || isForbidden ? 'opacity-70' : 'hover:-translate-y-0.5 hover:shadow-md'} disabled:cursor-default`

  const body = (
    <>
      <div className="p-3.5">
        {/* 类型胶囊徽标（icon 不变：文档=FileText，表格=Table2） */}
        <span className={`inline-flex items-center gap-1.5 rounded-full bg-background/80 px-2.5 py-1 text-caption font-medium ${typeColorClass}`}>
          <Icon className="h-3.5 w-3.5" />
          {typeLabel}
        </span>

        {/* 标题（类型色，海报式主视觉） */}
        <h3
          className={`mt-3 line-clamp-2 text-subtitle font-semibold leading-snug ${
            isDeleted ? 'text-muted-foreground line-through decoration-muted-foreground/40' : typeColorClass
          }`}
        >
          {displayName}
        </h3>

        {/* 内容预览（次要，底部柔化淡出；mask 与背景色无关） */}
        {isDeleted ? (
          <div className="mt-3 flex flex-col items-center justify-center gap-2 py-3 text-center">
            <Ban className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-caption text-muted-foreground/60">
              {t('resourceCardDeleted', { defaultValue: '该资源已被删除或移入回收站' })}
            </p>
          </div>
        ) : (
          <div
            className="relative mt-2 max-h-[108px] overflow-hidden text-muted-foreground"
            style={{
              maskImage: 'linear-gradient(to bottom, black 62%, transparent)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 62%, transparent)',
            }}
          >
            {isTable ? (
              <TablePreviewBody snapshot={resolvedPreviewTable} emptyLabel={emptyPreviewLabel} />
            ) : (
              <DocumentPreviewBody text={previewText} title={displayName} emptyLabel={emptyPreviewLabel} />
            )}
          </div>
        )}
      </div>

      {/* 页脚：权限 + 打开 / 申请访问 / 已失效 */}
      <div className="flex items-center justify-between border-t border-border/30 px-3.5 py-2">
        {isDeleted ? (
          <span className="flex-shrink-0 text-caption text-muted-foreground/60">
            {t('resourceCardDeletedBadge', { defaultValue: '已失效' })}
          </span>
        ) : isForbidden ? (
          <>
            <span className="min-w-0 truncate text-caption text-muted-foreground/80">
              {accessRequested
                ? t('resourceCardAccessRequested', { defaultValue: '已申请访问' })
                : t('resourceCardNoAccess', { defaultValue: '暂无访问权限' })}
            </span>
            {accessRequested ? (
              <span className="flex-shrink-0 text-caption text-muted-foreground/60">
                {t('resourceCardAccessPending', { defaultValue: '等待确认' })}
              </span>
            ) : (
              <button
                type="button"
                onClick={handleRequestAccess}
                disabled={!canRequestAccess || requestingAccess}
                className={`flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-caption font-medium transition-colors ${typeColorClass} hover:bg-background/70 disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {requestingAccess ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : null}
                {requestingAccess
                  ? t('resourceCardAccessRequesting', { defaultValue: '申请中…' })
                  : t('resourceCardRequestAccess', { defaultValue: '申请访问' })}
              </button>
            )}
          </>
        ) : (
          <>
            <span className="min-w-0 truncate text-caption text-muted-foreground/80">{permissionLabel}</span>
            <div className={`flex flex-shrink-0 items-center gap-1 text-caption ${typeColorClass}`}>
              <span>{t('resourceCardOpenHint', { defaultValue: '在工作台打开' })}</span>
              <ExternalLink className="h-3 w-3 opacity-70 transition-opacity group-hover:opacity-100" />
            </div>
          </>
        )}
      </div>
    </>
  )

  // forbidden 用 div，避免外层 button 包裹「申请访问」内层 button
  if (isForbidden) {
    return (
      <div className={cardShellClass} title={displayName}>
        {body}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      disabled={!canOpen}
      className={cardShellClass}
      title={displayName}
    >
      {body}
    </button>
  )
}
