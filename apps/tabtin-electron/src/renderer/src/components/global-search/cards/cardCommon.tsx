/**
 * 6 类结果卡片共享：容器、徽章、时间、创建者徽章
 *
 * 字号严格遵守设计系统：
 * - 标题：text-body
 * - 摘要片段：text-caption text-muted-foreground/80
 * - 元信息：text-caption text-muted-foreground/60
 * - 徽章：text-caption
 *
 * 透明度：次要 /60，较重要次要 /80。
 */

import React from 'react'

export interface CardShellProps {
  /** 1 字符 / emoji / lucide icon 节点 */
  icon: React.ReactNode
  /** 卡片右上：类型徽章 */
  badge?: React.ReactNode
  /** 卡片右上：时间（已 i18n） */
  trailing?: React.ReactNode
  /** 卡片是否选中（键盘导航高亮） */
  selected?: boolean
  /** 整卡点击 */
  onClick?: () => void
  /** Hover 时同步 selectedIndex */
  onMouseEnter?: () => void
  /** 用于键盘导航定位的 data-idx */
  dataIdx?: number
  /** 用于无障碍的 id */
  id?: string
  ariaSelected?: boolean
  children: React.ReactNode
}

export function CardShell({
  icon,
  badge,
  trailing,
  selected,
  onClick,
  onMouseEnter,
  dataIdx,
  id,
  ariaSelected,
  children,
}: CardShellProps) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={ariaSelected ?? selected ?? false}
      data-idx={dataIdx}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={
        'flex items-start gap-3 mx-1.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ' +
        (selected ? 'bg-muted/40' : 'hover:bg-muted/20')
      }
    >
      <span className="text-subtitle shrink-0 w-5 text-center leading-none mt-0.5" aria-hidden="true">
        {icon}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
      <div className="flex flex-col items-end gap-0.5 shrink-0 max-w-[180px]">
        {trailing && <span className="text-caption text-muted-foreground/60">{trailing}</span>}
        {badge && <span className="text-caption text-muted-foreground/60 truncate">{badge}</span>}
      </div>
    </div>
  )
}

/** 创建者标识徽章（PRD 3.4 "你 → / CodeBot →"） */
interface CreatorBadgeProps {
  creatorType?: 'user' | 'agent' | null
  creatorName?: string | null
  /** 当 creator_type='user' 且 creator_id 等于当前 user 时显示"你"；否则显示 name */
  isSelf?: boolean
  selfLabel: string
  /** 紧跟在创建者后的目标对象（如会话标题）。可选 */
  target?: string
}

export function CreatorBadge({ creatorType, creatorName, isSelf, selfLabel, target }: CreatorBadgeProps) {
  if (!creatorType && !creatorName) return null
  const icon = creatorType === 'agent' ? '🤖' : '👤'
  const name = isSelf ? selfLabel : (creatorName || '')
  if (!name && !target) return null
  return (
    <span className="inline-flex items-center gap-1 text-caption text-muted-foreground/60">
      <span aria-hidden="true">{icon}</span>
      {name && <span className="truncate max-w-[120px]">{name}</span>}
      {target && (
        <>
          <span className="opacity-60">→</span>
          <span className="truncate max-w-[160px]">{target}</span>
        </>
      )}
    </span>
  )
}

/** Space 路径显示组件，点击触发"在此 Space 中搜索" */
interface SpacePathProps {
  spaceName?: string | null
  onScopeToSpace?: () => void
}

export function SpacePath({ spaceName, onScopeToSpace }: SpacePathProps) {
  if (!spaceName) return null
  if (!onScopeToSpace) {
    return <span className="text-caption text-muted-foreground/60 truncate">{spaceName}</span>
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onScopeToSpace()
      }}
      className="text-caption text-muted-foreground/60 hover:text-foreground/80 transition-colors truncate text-left"
      title={`在「${spaceName}」中搜索`}
    >
      {spaceName}
    </button>
  )
}

/** 时间格式化：相对时间（"3 分钟前" / "1 小时前" / "2 天前" / 否则 yyyy-MM-dd） */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 0) return d.toLocaleDateString()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return d.toLocaleDateString()
}
