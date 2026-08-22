/**
 * 创建组织对话框容器组件
 * 连接 store 和 UI 组件；支持创建时裁剪上传组织头像。
 */

import React, { useEffect, useMemo, useState } from 'react'
import {
  CreateOrganizationDialog as CreateOrganizationDialogUI,
  CreateOrganizationData
} from '@tabtin/smartsheet-ui'
import { useShallow } from 'zustand/react/shallow'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useTranslation } from 'react-i18next'
import { OrganizationApiService } from '@tabtin/app-shell'
import type { CreateOrganizationRequest, Organization } from '@tabtin/app-shell'
import { OrganizationAvatarUploader } from '@components/settings/panels/OrganizationAvatarUploader'

/** 合并创建表单 settings 与可选 logo_url（纯函数，便于单测）。 */
export function buildCreateOrganizationSettings(
  base: CreateOrganizationData['settings'] | undefined,
  logoUrl: string | null | undefined,
): CreateOrganizationRequest['settings'] | undefined {
  const nextSettings: Record<string, unknown> = {
    ...(base ?? {}),
  }
  if (logoUrl?.trim()) {
    nextSettings.logo_url = logoUrl.trim()
  }
  if (
    nextSettings.theme !== 'light' &&
    nextSettings.theme !== 'dark' &&
    nextSettings.theme !== 'auto'
  ) {
    delete nextSettings.theme
  }
  return Object.keys(nextSettings).length > 0
    ? (nextSettings as CreateOrganizationRequest['settings'])
    : undefined
}

interface CreateOrganizationDialogProps {
  isOpen: boolean
  onClose: () => void
  onCreated?: (organization: Organization) => void
}

export const CreateOrganizationDialog: React.FC<CreateOrganizationDialogProps> = ({
  isOpen,
  onClose,
  onCreated,
}) => {
  const { createOrganization, isLoading } = useOrganizationStore(
    useShallow((s) => ({ createOrganization: s.createOrganization, isLoading: s.isLoading }))
  )
  const userId = useAuthStore((s) => s.user?.id)
  const { t } = useTranslation('organization')
  const [error, setError] = useState<string | null>(null)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)

  const pendingUploadKey = useMemo(
    () => (userId ? `pending-${userId}` : 'pending-anonymous'),
    [userId],
  )

  useEffect(() => {
    if (!isOpen) return

    let cancelled = false
    setError(null)
    setLogoUrl(null)
    OrganizationApiService.getOrganizationCreatePolicy()
      .then((policy) => {
        if (!cancelled && !policy.allowed) {
          setError(t('create.errors.limitExceeded', {
            max: policy.max_allowed,
            defaultValue: '每个用户最多可创建 {{max}} 个组织，当前已达到上限',
          }))
        }
      })
      .catch(() => {
        // 策略接口异常时不在 UI 侧阻断，后端创建接口仍会做最终校验。
      })

    return () => {
      cancelled = true
    }
  }, [isOpen, t])

  const handleSubmit = async (data: CreateOrganizationData) => {
    setError(null)

    try {
      const policy = await OrganizationApiService.getOrganizationCreatePolicy()
      if (!policy.allowed) {
        setError(t('create.errors.limitExceeded', {
          max: policy.max_allowed,
          defaultValue: '每个用户最多可创建 {{max}} 个组织，当前已达到上限',
        }))
        return
      }
      const fingerprint = useDeviceStore.getState().getCurrentFingerprint()
      if (!fingerprint) {
        setError(t('create.errors.deviceRequired', { defaultValue: '正在识别本机执行设备，请稍后再试' }))
        return
      }
      // 默认目录名固定中文，不跟 UI 语言走英文（避免 ~/TabTin/.../Default Space）。
      const defaultDir = await window.tabtin?.fileSystem?.ensureDefaultAgentDir({
        organizationName: data.name,
        spaceName: '默认工作空间',
      })
      if (!defaultDir?.success || !defaultDir.path) {
        setError(defaultDir?.error || t('create.errors.workingDirRequired', { defaultValue: '默认工作空间目录准备失败，请稍后再试' }))
        return
      }

      const payload: CreateOrganizationRequest = {
        name: data.name,
        description: data.description,
        default_agent_device_fingerprint: fingerprint,
        default_agent_working_dir: defaultDir.path,
        default_agent_working_dir_type: 'mixed',
        settings: buildCreateOrganizationSettings(data.settings, logoUrl),
      }

      const result = await createOrganization(payload)

      if (result) {
        onCreated?.(result)
        onClose()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (
        message.includes('ORGANIZATION_NAME_CONFLICT') ||
        message.includes('已存在同名组织') ||
        /organization with this name already exists/i.test(message)
      ) {
        setError(t('create.errors.nameConflict'))
      } else {
        setError(message || t('create.errors.failed'))
      }
    }
  }

  const handleClose = () => {
    setError(null)
    setLogoUrl(null)
    onClose()
  }

  return (
    <CreateOrganizationDialogUI
      isOpen={isOpen}
      isLoading={isLoading}
      error={error}
      onClose={handleClose}
      onSubmit={handleSubmit}
      avatarSlot={(
        <OrganizationAvatarUploader
          organizationId={pendingUploadKey}
          organizationName={t('create.defaultAvatarName', { defaultValue: '组织' })}
          canManage
          currentLogo={logoUrl ?? undefined}
          disabled={isLoading || !userId}
          persistMode="create"
          onLogoUploaded={(url) => setLogoUrl(url)}
          onLogoRemoved={() => setLogoUrl(null)}
        />
      )}
    />
  )
}
