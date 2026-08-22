/**
 * Agent 头像上传器 — 基于通用 AvatarCropUploader 的 Space 专用封装。
 *
 * 裁剪确认 / 移除只回传草稿，最终持久化由宿主表单的保存按钮统一完成
 *（与个人资料 UserAvatarUploader 一致；避免不点保存就落库，见 ）。
 */
import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { useSpaceStore } from '@stores/useSpaceStore'
import { AvatarCropUploader } from '@components/shared/AvatarCropUploader'

/** 非工作空间 Space 头像未保存草稿 */
export type SpaceAvatarDraft =
  | { type: 'set'; url: string }
  | { type: 'clear' }

/** 根据草稿与已保存头像解析预览 URL */
export function resolveSpaceAvatarDraftPreview(
  draft: SpaceAvatarDraft | null,
  savedAvatar?: string | null,
): string | undefined {
  if (draft?.type === 'set') return draft.url
  if (draft?.type === 'clear') return undefined
  return savedAvatar?.trim() || undefined
}

/** 将草稿合并进 updateSpace 的 avatar 字段；无草稿则不带该字段 */
export function avatarUpdateFromDraft(
  draft: SpaceAvatarDraft | null,
): { avatar: string } | Record<string, never> {
  if (draft?.type === 'set') return { avatar: draft.url }
  if (draft?.type === 'clear') return { avatar: '' }
  return {}
}

interface AgentAvatarUploaderProps {
  spaceId: string
  canManage: boolean
  /** 预览用头像（草稿优先，由宿主传入） */
  currentAvatar?: string
  onAvatarUploaded: (url: string) => void
  onAvatarRemoved: () => void
}

export const AgentAvatarUploader: React.FC<AgentAvatarUploaderProps> = ({
  spaceId,
  canManage,
  currentAvatar,
  onAvatarUploaded,
  onAvatarRemoved,
}) => {
  const { t } = useTranslation('space')
  const isLoading = useSpaceStore(state => state.isLoading)

  const handleUploadComplete = useCallback(async (url: string, _fileId: string) => {
    onAvatarUploaded(url)
    toast.success(t('avatar.pendingSave', {
      defaultValue: '头像已裁剪，保存后生效',
    }))
  }, [onAvatarUploaded, t])

  const handleRemove = useCallback(async () => {
    onAvatarRemoved()
    toast.success(t('avatar.pendingRemove', {
      defaultValue: '头像将在保存后移除',
    }))
  }, [onAvatarRemoved, t])

  return (
    <AvatarCropUploader
      currentAvatar={currentAvatar}
      disabled={isLoading || !canManage}
      uploadOptions={{
        module: 'tabtinspace',
        folder: 'agent-avatars',
        contextType: 'space',
        contextId: spaceId,
        fileNamePrefix: `agent-${spaceId}`,
        isPublic: true,
      }}
      onUploadComplete={handleUploadComplete}
      onRemove={handleRemove}
      label={t('fields.avatar', { defaultValue: '头像' })}
      hint={t('avatar.hint', { defaultValue: '支持 JPG、PNG、GIF、WebP，最大 5MB。GIF 将转为静态图。' })}
      cropTitle={t('avatar.cropTitle', { defaultValue: '裁剪头像' })}
    />
  )
}
