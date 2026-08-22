/**
 * 字段类型图标组件
 * 为不同类型的字段显示对应的图标
 */

import React from 'react'
import {
  Type,
  Hash,
  Calendar,
  Clock,
  CheckSquare,
  Link as LinkIcon,
  Mail,
  Phone,
  Paperclip,
  List,
  ListChecks,
  Star,
  AlignLeft,
  User,
  UserCheck,
  UserPen,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FieldType } from '@tabtin/table-core'

export type { FieldType }

interface FieldTypeIconProps {
  type: string
  className?: string
  size?: number
}

/**
 * 获取字段类型对应的图标组件
 */
export const getFieldTypeIcon = (type: string) => {
  switch (type) {
    case 'text':
      return Type
    case 'long_text':
      return AlignLeft
    case 'number':
      return Hash
    case 'rating':
      return Star
    case 'select':
    case 'single_select':
      return List
    case 'multi_select':
      return ListChecks
    case 'date':
      return Calendar
    case 'created_time':
    case 'last_modified_time':
      return Clock
    case 'checkbox':
      return CheckSquare
    case 'url':
      return LinkIcon
    case 'email':
      return Mail
    case 'phone':
      return Phone
    case 'attachment':
      return Paperclip
    case 'user':
      return User
    case 'created_by':
      return UserCheck
    case 'last_modified_by':
      return UserPen
    case 'link':
      return LinkIcon
    default:
      return Type
  }
}

/**
 * 字段类型图标组件 - 继承文本颜色
 */
export const FieldTypeIcon: React.FC<FieldTypeIconProps> = ({
  type,
  className = '',
  size = 14
}) => {
  const IconComponent = getFieldTypeIcon(type)

  return (
    <IconComponent
      className={`opacity-70 ${className}`}
      size={size}
    />
  )
}

/**
 * 字段类型标签（带文字）
 */
export const FieldTypeLabel: React.FC<{ type: string; showText?: boolean }> = ({
  type,
  showText = true
}) => {
  const { t } = useTranslation('field')
  const label = t(`types.${type}`, { defaultValue: type })

  return (
    <div className="inline-flex items-center gap-1">
      <FieldTypeIcon type={type} size={12} />
      {showText && (
        <span className="text-body text-muted-foreground">
          {label}
        </span>
      )}
    </div>
  )
}

// 导出getFieldTypeColor用于向后兼容，但不再推荐使用
export const getFieldTypeColor = (type: string): string => {
  return 'currentColor'
}
