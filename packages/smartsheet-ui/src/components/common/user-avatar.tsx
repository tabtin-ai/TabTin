/**
 * UserAvatar — 通用用户头像组件
 *
 * 从 history-timeline.tsx 提炼。
 * 根据用户名生成稳定的初始字母 + HSL 颜色。
 * 各模块（历史面板、协作、评论等）统一使用。
 *
 * @example
 * <UserAvatar name="张三" size={24} />
 * <UserAvatar name="System" size={20} className="ring-2 ring-background" />
 * <UserAvatar name="Alice" avatarUrl="https://..." size={32} />
 */

import * as React from 'react'
import { identityAvatarColor, identityAvatarInitial } from '@tabtin/shared/identity-avatar'
import { resolvePublicAvatarUrl } from '../../share-dialog/resolvePublicAvatarUrl'
import { cn } from '../../utils/cn'

export interface UserAvatarProps {
  /** 用户名 */
  name: string
  /** 头像 URL（优先使用） */
  avatarUrl?: string | null
  /** 稳定身份 ID。未传时兼容使用 name；用户场景应传 userId。 */
  seed?: string | null
  /** 尺寸（px），默认 24 */
  size?: number
  /** 额外 className */
  className?: string
}

export const UserAvatar: React.FC<UserAvatarProps> = ({
  name,
  avatarUrl,
  seed,
  size = 24,
  className,
}) => {
  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(null)
  const resolvedAvatarUrl = resolvePublicAvatarUrl(avatarUrl)
  const backgroundColor = identityAvatarColor(seed || name)
  const displayInitial = identityAvatarInitial(name)
  const showImage = Boolean(resolvedAvatarUrl && resolvedAvatarUrl !== failedAvatarUrl)
  const textSizeClass = size <= 28
    ? 'text-caption'
    : size <= 40
      ? 'text-body'
      : size <= 56
        ? 'text-subtitle'
        : size <= 72
          ? 'text-title'
          : 'text-heading'

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-white font-medium select-none',
        textSizeClass,
        className,
      )}
      style={{
        width: size,
        height: size,
        backgroundColor,
      }}
      title={name}
    >
      {showImage ? (
        <img
          src={resolvedAvatarUrl ?? undefined}
          alt={name}
          className="h-full w-full object-cover"
          onError={() => {
            if (resolvedAvatarUrl) setFailedAvatarUrl(resolvedAvatarUrl)
          }}
        />
      ) : (
        displayInitial
      )}
    </span>
  )
}

UserAvatar.displayName = 'UserAvatar'
