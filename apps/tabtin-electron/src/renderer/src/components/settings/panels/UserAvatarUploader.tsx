/**
 * 用户头像上传器 — 基于 AvatarCropUploader 的个人资料专用封装。
 *
 * 裁剪确认后只回传头像草稿，最终持久化由个人资料面板的保存按钮统一完成。
 */
import React, { useCallback } from 'react'
import { Camera } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { UserAvatar, toast } from '@components/ui'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@/stores/useAuthStore'
import { AvatarCropUploader } from '@components/shared/AvatarCropUploader'
import { cn } from '@utils/cn'

interface UserAvatarUploaderProps {
  disabled?: boolean
  compact?: boolean
  currentAvatar?: string
  saving?: boolean
  onAvatarUploaded: (draft: { url: string; fileId: string }) => void
}

export const UserAvatarUploader: React.FC<UserAvatarUploaderProps> = ({
  disabled = false,
  compact = false,
  currentAvatar,
  saving = false,
  onAvatarUploaded,
}) => {
  const { t } = useTranslation('profile')
  const { user, isLoading } = useAuthStore(
    useShallow((s) => ({ user: s.user, isLoading: s.isLoading })),
  )

  const handleUploadComplete = useCallback(async (url: string, fileId: string) => {
    onAvatarUploaded({ url, fileId })
    toast({ title: t('avatar.pendingSave', { defaultValue: '头像已裁剪，保存个人资料后生效' }) })
  }, [onAvatarUploaded, t])

  const handleRemove = useCallback(async () => {
    toast({
      variant: 'destructive',
      title: t('avatar.removeUnsupported', { defaultValue: '暂不支持移除头像' }),
    })
  }, [t])

  if (!user) return null

  const displayName = user.nickname || user.username || '?'

  return (
    <div className={cn('relative shrink-0', compact && 'group')}>
      <AvatarCropUploader
        currentAvatar={currentAvatar ?? user.avatar ?? undefined}
        disabled={disabled || isLoading}
        saving={saving}
        compact={compact}
        uploadOptions={{
          module: 'user',
          folder: 'user-avatars',
          contextType: 'avatar',
          contextId: user.id,
          fileNamePrefix: `user-${user.id}`,
          isPublic: true,
        }}
        onUploadComplete={handleUploadComplete}
        onRemove={handleRemove}
        cropTitle={t('avatar.cropTitle', { defaultValue: '裁剪头像' })}
        previewSize={compact ? 'h-[4.5rem] w-[4.5rem]' : 'h-20 w-20'}
        previewRounded={compact ? 'rounded-full' : 'rounded-full'}
        emptyPreview={<UserAvatar name={displayName} seed={user.id} size={compact ? 72 : 80} />}
      />
      {compact && !disabled && !isLoading && (
        <span className="pointer-events-none absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-background">
          <Camera className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      )}
    </div>
  )
}
