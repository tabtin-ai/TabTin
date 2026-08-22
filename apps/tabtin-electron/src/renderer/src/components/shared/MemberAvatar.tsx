/**
 * MemberAvatar — 群聊成员单个头像
 *
 * 优先展示 avatar_url（图片），fallback 到 name 首字母。
 */

import React, { useState } from 'react'
import { cn } from '@utils/cn'

interface MemberAvatarProps {
  name: string
  avatarUrl?: string
  /** emoji fallback（旧数据兼容） */
  avatarIcon?: string
  size?: 'xs' | 'sm' | 'md'
  className?: string
}

const SIZE_CLASSES = {
  xs: 'h-5 w-5 text-caption',
  sm: 'h-7 w-7 text-caption',
  md: 'h-8 w-8 text-body',
} as const

export const MemberAvatar: React.FC<MemberAvatarProps> = ({
  name,
  avatarUrl,
  avatarIcon,
  size = 'sm',
  className,
}) => {
  const [imgError, setImgError] = useState(false)
  const showImg = !!avatarUrl && !imgError

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-muted overflow-hidden shrink-0',
        SIZE_CLASSES[size],
        className,
      )}
    >
      {showImg ? (
        <img
          src={avatarUrl}
          alt=""
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : avatarIcon ? (
        <span className="leading-none select-none">{avatarIcon}</span>
      ) : (
        <span className="font-semibold text-accent leading-none select-none">
          {name?.charAt(0) || '?'}
        </span>
      )}
    </span>
  )
}
