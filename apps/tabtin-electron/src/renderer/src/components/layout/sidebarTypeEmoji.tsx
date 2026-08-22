import React from 'react'
import { cn } from '@utils/cn'
import { contextRegistry } from '@components/context-space/registry'
import type { ContextItemType } from '@components/context-space/registry/types'
import {
  SIDEBAR_EMOJI,
  SIDEBAR_EMOJI_ACTIVE,
  SIDEBAR_EMOJI_INACTIVE,
} from './sidebarUi'
import { resolveAppIconUrl } from './appIconAssets'

export {
  resolveAppIconPresentation,
  resolveAppIconUrl,
} from './appIconAssets'

/**
 * 侧栏 app 入口 emoji，与各 handler displayEmoji 对齐。
 * 静态表优先，避免测试 mock 不全时 resolve 失败；未知 app 再查 registry。
 */
const SIDEBAR_TYPE_EMOJI_MAP: Record<string, string> = {
  'cloud-resources': '☁️',
  tabfolder: '📁',
  folder: '📁',
  tabdata: '📊',
  table: '📊',
  tabdoc: '📄',
  tabtracker: '🎯',
  skill: '🔧',
  tabweb: '🌐',
  browser: '🌐',
  terminal: '💻',
  tabslide: '📽️',
  slide: '📽️',
  tabvideo: '🎬',
  tabmail: '📧',
  tabcode: '💻',
  tabphone: '📱',
  tabfiles: '📁',
  bookmarks: '⭐',
  marketplace: '✨',
  tabwhiteboard: '💡',
  agentdiary: '🧠',
  tabsettings: '⚙️',
  history: '🕐',
  downloads: '⬇️',
  tins: '🧩',
  tabinbox: '🧭',
  tabsite: '🌐',
  'subagent-session': '🤖',
  apphome: '🏠',
  desktop_home: '🧰',
  'desktop-apps': '🗂️',
  orchestration: '🏠',
  'market-app': '✨',
  cowart: '🐮',
}

export function resolveSidebarTypeEmoji(appIdOrType: string): string {
  const mapped = SIDEBAR_TYPE_EMOJI_MAP[appIdOrType]
  if (mapped) return mapped

  const getByAppId = contextRegistry.getHandlerByAppId
  if (typeof getByAppId === 'function') {
    const byAppId = getByAppId.call(contextRegistry, appIdOrType)
    if (byAppId?.displayEmoji) return byAppId.displayEmoji
  }

  const getHandler = contextRegistry.getHandler
  if (typeof getHandler === 'function') {
    const byType = getHandler.call(contextRegistry, appIdOrType as ContextItemType)
    if (byType?.displayEmoji) return byType.displayEmoji
  }

  return '📦'
}

export interface SidebarTypeEmojiProps {
  appIdOrType: string
  /** true=彩色；false=灰度；undefined=不做内置 mute（卡片等场景） */
  active?: boolean
  className?: string
}

/** 侧栏工作台等场景的 app 入口 emoji（与 handler displayEmoji 同源）。 */
export function SidebarTypeEmoji({
  appIdOrType,
  active,
  className,
}: SidebarTypeEmojiProps) {
  const iconUrl = resolveAppIconUrl(appIdOrType, 'entry')
  return (
    <span
      className={cn(
        SIDEBAR_EMOJI,
        'inline-flex h-4 w-4 shrink-0 items-center justify-center',
        active === true && SIDEBAR_EMOJI_ACTIVE,
        active === false && SIDEBAR_EMOJI_INACTIVE,
        className,
      )}
      aria-hidden
    >
      {iconUrl
        ? <img src={iconUrl} alt="" className="h-full w-full" draggable={false} />
        : resolveSidebarTypeEmoji(appIdOrType)}
    </span>
  )
}

/** 顶部标签栏用 emoji：不内置灰度，由 NormalTab 外层按选中态控制彩色/静音。 */
export const TAB_TYPE_EMOJI_CLASS =
  'inline-flex h-4 w-4 shrink-0 items-center justify-center text-body leading-none'

export interface TabTypeEmojiProps {
  appIdOrType: string
  className?: string
}

export function TabTypeEmoji({ appIdOrType, className }: TabTypeEmojiProps) {
  const iconUrl = resolveAppIconUrl(appIdOrType, 'tab')
  return (
    <span className={cn(TAB_TYPE_EMOJI_CLASS, className)} aria-hidden>
      {iconUrl
        ? <img src={iconUrl} alt="" className="h-full w-full" draggable={false} />
        : resolveSidebarTypeEmoji(appIdOrType)}
    </span>
  )
}
