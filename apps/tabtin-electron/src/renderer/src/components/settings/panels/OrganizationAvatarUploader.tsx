/**
 * 组织头像上传器 — 基于 AvatarCropUploader。
 *
 * 裁剪确认 / 移除只回传草稿，最终经组织资料「保存」写入
 * `organization.settings.logo_url`（与个人资料 / Agent 头像一致，见 ）。
 * 无图时的默认预览复用 UserAvatar 色块/首字算法（与 ActivityRail 组织入口一致）。
 */
import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast, UserAvatar } from '@components/ui'
import { AvatarCropUploader } from '@components/shared/AvatarCropUploader'

/** 组织 Logo 未保存草稿 */
export type OrgLogoDraft =
  | { type: 'set'; url: string }
  | { type: 'clear' }

/** 根据草稿与已保存 logo 解析预览 URL */
export function resolveOrgLogoDraftPreview(
  draft: OrgLogoDraft | null,
  savedLogo?: string | null,
): string | undefined {
  if (draft?.type === 'set') return draft.url
  if (draft?.type === 'clear') return undefined
  return savedLogo?.trim() || undefined
}

/** 将草稿合并进 updateOrganization 的 settings；无草稿则不改 logo_url */
export function logoSettingsFromDraft(
  draft: OrgLogoDraft | null,
  currentSettings: Record<string, unknown> | undefined | null,
): { settings: Record<string, unknown> } | Record<string, never> {
  if (!draft) return {}
  const next = { ...(currentSettings ?? {}) }
  if (draft.type === 'set') {
    next.logo_url = draft.url
  } else {
    next.logo_url = ''
  }
  return { settings: next }
}

interface OrganizationAvatarUploaderProps {
  /**
   * 已有组织 ID；创建组织场景可传 `pending-<userId>` 作为 OSS 上下文占位，
   * 最终 logo_url 随 createOrganization.settings 一并写入。
   */
  organizationId: string
  /** 用于无图时的色块首字；创建态可传草稿名或占位。 */
  organizationName?: string
  canManage: boolean
  currentLogo?: string
  disabled?: boolean
  onLogoUploaded: (url: string) => void
  onLogoRemoved: () => void
  /** create：提示随创建生效；edit（默认）：提示保存资料后生效 */
  persistMode?: 'edit' | 'create'
}

/** 组织默认头像：与窄栏 OrganizationAvatarRailButton 同源算法。 */
export function OrganizationIdentityAvatar(props: {
  name: string
  seed?: string | null
  size?: number
  className?: string
}) {
  const { name, seed, size = 56, className } = props
  return (
    <UserAvatar
      name={name || '?'}
      seed={seed}
      size={size}
      className={className ?? 'border border-border/30 !rounded-[8px]'}
    />
  )
}

export const OrganizationAvatarUploader: React.FC<OrganizationAvatarUploaderProps> = ({
  organizationId,
  organizationName,
  canManage,
  currentLogo,
  disabled = false,
  onLogoUploaded,
  onLogoRemoved,
  persistMode = 'edit',
}) => {
  const { t } = useTranslation('settings')

  const handleUploadComplete = useCallback(async (url: string) => {
    onLogoUploaded(url)
    toast({
      title: persistMode === 'create'
        ? t('settings.avatar.pendingCreate', {
            defaultValue: '头像已裁剪，创建组织时一并生效',
          })
        : t('settings.avatar.pendingSave', {
            defaultValue: '头像已裁剪，保存组织资料后生效',
          }),
    })
  }, [onLogoUploaded, persistMode, t])

  const handleRemove = useCallback(async () => {
    onLogoRemoved()
    toast({
      title: persistMode === 'create'
        ? t('settings.avatar.pendingCreateRemove', {
            defaultValue: '已清除头像，创建时将不带组织头像',
          })
        : t('settings.avatar.pendingRemove', {
            defaultValue: '头像将在保存后移除',
          }),
    })
  }, [onLogoRemoved, persistMode, t])

  return (
    <AvatarCropUploader
      currentAvatar={currentLogo}
      disabled={disabled || !canManage}
      uploadOptions={{
        module: 'tabtinspace',
        folder: 'org-logos',
        contextType: 'organization',
        contextId: organizationId,
        fileNamePrefix: `org-${organizationId}`,
        isPublic: true,
      }}
      onUploadComplete={handleUploadComplete}
      onRemove={handleRemove}
      label={t('settings.fields.avatar', { defaultValue: '组织头像' })}
      hint={t('settings.avatar.hint', {
        defaultValue: '支持 JPG、PNG、GIF、WebP，最大 5MB。GIF 将转为静态图。',
      })}
      cropTitle={t('settings.avatar.cropTitle', { defaultValue: '裁剪组织头像' })}
      previewSize="h-14 w-14"
      previewRounded="rounded-interactive"
      emptyPreview={(
        <OrganizationIdentityAvatar
          name={organizationName || '?'}
          seed={organizationId}
          size={56}
          className="!rounded-[8px]"
        />
      )}
    />
  )
}
