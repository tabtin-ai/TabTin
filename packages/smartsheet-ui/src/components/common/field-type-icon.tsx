/**
 * FieldTypeIcon — 统一字段类型图标组件
 *
 * 从 record-history-dialog / history-timeline 中提炼。
 * 各模块（Table、Docs、Design 等）凡涉及字段类型展示时，统一使用此组件。
 *
 * @example
 * <FieldTypeIcon type="text" size={14} />
 * <FieldTypeIcon type="select" size={12} className="text-primary" />
 */

import * as React from 'react'
import {
  Type,
  Hash,
  Star,
  List,
  ListChecks,
  Calendar,
  Clock,
  CheckSquare,
  Link as LinkIcon,
  Mail,
  Phone,
  Paperclip,
  AlignLeft,
  User,
  UserCheck,
  UserPen,
  Users,
} from 'lucide-react'
import { cn } from '../../utils/cn'

export type FieldIconType =
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'select'
  | 'single_select'
  | 'multi_select'
  | 'url'
  | 'email'
  | 'phone'
  | 'attachment'
  | 'link'
  | 'rating'
  | 'long_text'
  | 'created_time'
  | 'last_modified_time'
  | 'created_by'
  | 'last_modified_by'
  | 'user'

export interface FieldTypeIconProps {
  /** 字段类型 */
  type?: string
  /** 图标尺寸（px），默认 14 */
  size?: number
  /** 额外 className */
  className?: string
}

// ── SVG path 定义（统一维护，不再各文件复制） ──

interface IconDef {
  /** SVG 子元素 */
  paths: React.ReactNode
}

const makeIcon = (paths: React.ReactNode): IconDef => ({ paths })

const ICON_DEFS: Record<string, IconDef> = {
  text: makeIcon(
    <>
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </>
  ),
  long_text: makeIcon(
    <>
      <line x1="17" y1="10" x2="3" y2="10" />
      <line x1="21" y1="6" x2="3" y2="6" />
      <line x1="21" y1="14" x2="3" y2="14" />
      <line x1="17" y1="18" x2="3" y2="18" />
    </>
  ),
  number: makeIcon(
    <>
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </>
  ),
  date: makeIcon(
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </>
  ),
  checkbox: makeIcon(
    <>
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </>
  ),
  select: makeIcon(
    <>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </>
  ),
  single_select: makeIcon(
    <>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </>
  ),
  multi_select: makeIcon(
    <>
      <line x1="10" y1="6" x2="21" y2="6" />
      <line x1="10" y1="12" x2="21" y2="12" />
      <line x1="10" y1="18" x2="21" y2="18" />
      <polyline points="3 6 4 7 6 5" />
      <polyline points="3 12 4 13 6 11" />
      <polyline points="3 18 4 19 6 17" />
    </>
  ),
  url: makeIcon(
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  email: makeIcon(
    <>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </>
  ),
  phone: makeIcon(
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
  ),
  attachment: makeIcon(
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  ),
  link: makeIcon(
    <>
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </>
  ),
  rating: makeIcon(
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  ),
}

// 使用 lucide-react 的字段类型（与 Electron 端保持一致）
const LUCIDE_ICON_MAP: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  created_time: Clock,
  last_modified_time: Clock,
  created_by: UserCheck,
  last_modified_by: UserPen,
  user: Users,
}

/**
 * 统一字段类型图标。
 *
 * 所有涉及字段类型展示的场景（历史面板、字段选择器、数据网格等）
 * 都应使用此组件，而不是各自内联 SVG。
 */
export const FieldTypeIcon: React.FC<FieldTypeIconProps> = ({
  type,
  size = 14,
  className,
}) => {
  // 优先使用 lucide-react 图标（如 created_time）。
  const LucideIcon = type ? LUCIDE_ICON_MAP[type] : null
  if (LucideIcon) {
    return (
      <LucideIcon
        size={size}
        className={cn('inline-flex shrink-0 opacity-60', className)}
      />
    )
  }

  const def = type ? ICON_DEFS[type] : null

  const svgProps: React.SVGProps<SVGSVGElement> = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }

  if (!def) {
    // 默认：文本图标
    return (
      <svg {...svgProps} className={cn('inline-flex shrink-0 opacity-60', className)}>
        <polyline points="4 7 4 4 20 4 20 7" />
        <line x1="9" y1="20" x2="15" y2="20" />
        <line x1="12" y1="4" x2="12" y2="20" />
      </svg>
    )
  }

  return (
    <svg {...svgProps} className={cn('inline-flex shrink-0 opacity-60', className)}>
      {def.paths}
    </svg>
  )
}

FieldTypeIcon.displayName = 'FieldTypeIcon'

/**
 * 获取字段类型对应的 lucide-react 图标组件。
 * 用于需要直接使用图标组件（而非 FieldTypeIcon 包装）的场景，
 * 如 FieldTypeSelector 中的下拉选项。
 */
export const getFieldTypeIcon = (
  type: string,
): React.ComponentType<{ className?: string; size?: number }> => {
  switch (type) {
    case 'text': return Type
    case 'long_text': return AlignLeft
    case 'number': return Hash
    case 'rating': return Star
    case 'select':
    case 'single_select': return List
    case 'multi_select': return ListChecks
    case 'date': return Calendar
    case 'created_time':
    case 'last_modified_time': return Clock
    case 'checkbox': return CheckSquare
    case 'url': return LinkIcon
    case 'email': return Mail
    case 'phone': return Phone
    case 'attachment': return Paperclip
    case 'user': return Users
    case 'created_by': return UserCheck
    case 'last_modified_by': return UserPen
    case 'link': return LinkIcon
    default: return Type
  }
}
