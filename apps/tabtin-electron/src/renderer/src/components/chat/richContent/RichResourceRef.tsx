/**
 * resource_ref kind 渲染 —— 跳转按钮 + onNavigate 回调桥接。
 *
 * 「Agent 产物在 Space 内的打开」机制 B：
 *   - Agent 通过 present_to_user 工具发 resource_ref kind → 卡片持久化到 chat 历史
 *   - 用户点击卡片 → ResourceRouter.open（D2 五层优先级）
 *   - present_to_user 带 auto_open 时：新鲜 token 窗口内同步在旁边 Space 工作区打开
 *   - 用户右键卡片 → ResourceLinkContextMenu（与 markdown 链接同款菜单切换载体）
 *   - ⌘ / Ctrl + 点击 → D2 第 5 层"用户主动逃生通道"走系统应用
 */

import React, { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { RichContentBlock } from '@tabtin/chat-client'
import { cn } from '@utils/cn'
import { ANIMATION, CARD_PADDING, CARD_RADIUS, RESULT_BAR, TEXT, TEXT_COLOR } from '../registry/chatDesignTokens'
import { RESOURCE_TYPE_ICONS } from './kindIcons'
import { resolveResourceRefDisplayName } from './resolveResourceRefDisplayName'
import { registerAgentArtifactTab } from '@/services/registerAgentArtifactTab'
import { SidebarTypeEmoji } from '@components/layout/sidebarTypeEmoji'

export interface RichResourceRefNavigateOpts {
  /** ⌘+点击 / Ctrl+点击 时为 true —— 走 D2 第 5 层系统应用 */
  modifierExternal?: boolean
  /** 资源真实归属的工作空间，Project Task 验收前与协作 Project 不同。 */
  resourceSpaceId?: string
}

const autoOpenedResourceKeys = new Set<string>()

/** present_to_user token：`present-<base36-ms>-<rand>`；超过窗口视为历史卡，避免 streaming 中虚拟列表重挂载抢焦点。 */
const PRESENT_AUTO_OPEN_FRESH_MS = 5 * 60_000

function isFreshPresentAutoOpenToken(token: string | undefined): boolean {
  if (!token) return false
  const match = /^present-([0-9a-z]+)-/i.exec(token)
  if (!match) return false
  const createdAt = Number.parseInt(match[1], 36)
  if (!Number.isFinite(createdAt)) return false
  return Date.now() - createdAt < PRESENT_AUTO_OPEN_FRESH_MS
}

export const RichResourceRef: React.FC<{
  block: RichContentBlock
  tabScopeKey?: string | null
  /**
   * 卡片点击回调。
   * - 第 3 参 `hint`：D2 第 3 层 Agent hint（来自 `block.hint_carrier_app_id`）
   * - 第 4 参 `opts.modifierExternal`：⌘/Ctrl 修饰键透传
   */
  onNavigate?: (
    resourceType: string,
    resourceId: string,
    hint?: string,
    opts?: RichResourceRefNavigateOpts,
  ) => void
  /**
   * 卡片右键菜单请求回调。不传则无右键菜单。
   */
  onContextMenuRequest?: (
    e: React.MouseEvent<HTMLElement>,
    resourceType: string,
    resourceId: string,
    hint?: string,
  ) => void
}> = React.memo(({ block, tabScopeKey, onNavigate, onContextMenuRequest }) => {
  const { t } = useTranslation('chat')

  const hasActionableData = Boolean(block.resource_id && block.resource_type)
  const hint = block.hint_carrier_app_id || undefined
  const resourceSpaceId = (block as RichContentBlock & { space_id?: string }).space_id || undefined

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!hasActionableData) return
      const modifierExternal = e.metaKey || e.ctrlKey
      onNavigate?.(
        block.resource_type as string,
        block.resource_id as string,
        hint,
        modifierExternal || resourceSpaceId
          ? {
              ...(modifierExternal ? { modifierExternal: true } : {}),
              ...(resourceSpaceId ? { resourceSpaceId } : {}),
            }
          : undefined,
      )
    },
    [hasActionableData, block.resource_type, block.resource_id, hint, resourceSpaceId, onNavigate],
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!hasActionableData || !onContextMenuRequest) return
      e.preventDefault()
      onContextMenuRequest(
        e,
        block.resource_type as string,
        block.resource_id as string,
        hint,
      )
    },
    [hasActionableData, block.resource_type, block.resource_id, hint, onContextMenuRequest],
  )

  useEffect(() => {
    if (!block.auto_register || !hasActionableData) return
    void registerAgentArtifactTab({
      tabScopeKey,
      resourceType: block.resource_type as string,
      resourceId: block.resource_id as string,
      title: block.resource_name || block.title || block.summary,
      hintCarrierAppId: hint,
      token: block.auto_register_token,
    })
  }, [
    block.auto_register,
    block.auto_register_token,
    block.resource_id,
    block.resource_name,
    block.resource_type,
    block.summary,
    block.title,
    hasActionableData,
    hint,
    tabScopeKey,
  ])

  // present_to_user resource_ref：出卡后同步打开 Space 工作区（对齐 RichFile auto_open）。
  // 门控：auto_open + 新鲜 present token（5 分钟）+ session 去重；不依赖 isStreaming，
  // 避免 turn 结束与 mini-message 挂载竞态导致漏开。
  useEffect(() => {
    if (!block.auto_open || !hasActionableData || !onNavigate) return
    if (!isFreshPresentAutoOpenToken(block.auto_open_token)) return
    const key = `tabtin:auto-open-resource:${block.auto_open_token}`
    if (autoOpenedResourceKeys.has(key)) return
    if (typeof window !== 'undefined' && window.sessionStorage?.getItem(key)) return
    autoOpenedResourceKeys.add(key)
    try {
      window.sessionStorage?.setItem(key, '1')
    } catch {
      // best-effort de-dupe only
    }
    const resourceType = block.resource_type as string
    const resourceId = block.resource_id as string
    window.setTimeout(() => {
      onNavigate(
        resourceType,
        resourceId,
        hint,
        resourceSpaceId ? { resourceSpaceId } : undefined,
      )
    }, 0)
  }, [
    block.auto_open,
    block.auto_open_token,
    block.resource_id,
    block.resource_type,
    hasActionableData,
    hint,
    resourceSpaceId,
    onNavigate,
  ])

  const icon = RESOURCE_TYPE_ICONS[block.resource_type ?? ''] ?? '📁'
  const normalizedResourceType = block.resource_type?.toLowerCase() ?? ''
  const appIconType = ['table', 'tabdata'].includes(normalizedResourceType)
    ? 'tabdata'
    : ['doc', 'document', 'tabdoc'].includes(normalizedResourceType)
      ? 'tabdoc'
      : null
  const displayName = resolveResourceRefDisplayName(block)
  const isClickable = hasActionableData && Boolean(onNavigate)
  const openLabel = block.open_label ?? t('richContent.open')
  const ariaLabel = block.open_label ?? t('richContent.openAriaLabel', { defaultValue: '打开资源' })

  const cardClassName = cn(
    'flex w-full items-center gap-2',
    CARD_RADIUS,
    CARD_PADDING.x,
    CARD_PADDING.y,
    RESULT_BAR.surface,
    ANIMATION.fadeIn,
    RESULT_BAR.surfaceHover,
    isClickable && 'cursor-pointer text-left',
  )

  const cardBody = (
    <>
      {appIconType
        ? <SidebarTypeEmoji appIdOrType={appIconType} className="h-5 w-5" />
        : <span className="text-subtitle" aria-hidden>{icon}</span>}
      <div className="flex-1 min-w-0">
        <p className={cn(TEXT.label, TEXT_COLOR.primary, 'truncate')}>
          {displayName}
        </p>
        {block.space_name && (
          <p className={cn(TEXT.meta, TEXT_COLOR.muted, 'truncate')}>{block.space_name}</p>
        )}
      </div>
      {isClickable && (
        <span
          className={cn('shrink-0', TEXT.meta, TEXT_COLOR.accent)}
          aria-hidden
        >
          {openLabel}
        </span>
      )}
    </>
  )

  if (isClickable) {
    return (
      <button
        type="button"
        className={cardClassName}
        onClick={handleClick}
        onContextMenu={onContextMenuRequest ? handleContextMenu : undefined}
        aria-label={ariaLabel}
        data-testid="rich-resource-ref"
      >
        {cardBody}
      </button>
    )
  }

  return (
    <div className={cardClassName} data-testid="rich-resource-ref">
      {cardBody}
    </div>
  )
})

RichResourceRef.displayName = 'RichResourceRef'

/** 测试用：清空 auto_open 去重表 */
export function _clearRichResourceAutoOpenKeys(): void {
  autoOpenedResourceKeys.clear()
}
