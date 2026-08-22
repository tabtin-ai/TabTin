/**
 * ProfileIdentityForm — Agent 档案：身份编辑表单
 *
 * 包含 Workspace 名字 / 描述。
 * 「角色设定」persona 已下线——Agent 身份固定用系统默认，用户的行为/语气
 * 偏好统一写到「自定义规则」。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Input, Textarea } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useSpaceStore } from '@stores/useSpaceStore'
import {
  SETTINGS_CONTROL,
  SETTINGS_HINT,
  SETTINGS_LABEL,
  SETTINGS_TEXTAREA_FULL,
} from '@components/settings/settingsUi'
import { cn } from '@utils/cn'
import { ProfileFormShell } from './ProfileFormShell'

interface ProfileIdentityFormProps {
  spaceId: string
  canManage: boolean
  /** 保存成功后由宿主关闭当前编辑 Sheet。 */
  onSaved?: () => void
}

export const ProfileIdentityForm: React.FC<ProfileIdentityFormProps> = ({
  spaceId,
  canManage,
  onSaved,
}) => {
  const { t } = useTranslation('space')
  const space = useSpaceStore((state) => state.spaces.find((p) => p.id === spaceId) ?? null)
  const { updateSpace, isLoading } = useSpaceStore(
    useShallow((s) => ({
      updateSpace: s.updateSpace,
      isLoading: s.isLoading,
    })),
  )

  const loadedSpaceId = space?.id
  const loadedName = space?.name ?? ''
  const loadedDescription = space?.description ?? ''
  const [name, setName] = useState(loadedName)
  const [description, setDescription] = useState(loadedDescription)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!loadedSpaceId) return
    setName(loadedName)
    setDescription(loadedDescription)
    setError(null)
  }, [loadedSpaceId, loadedName, loadedDescription])

  const dirty = useMemo(() => {
    if (!space) return false
    return name !== space.name || description !== (space.description ?? '')
  }, [name, description, space])

  const trimmedName = name.trim()
  const saveDisabled = !canManage || trimmedName.length === 0
  const handleSubmit = async () => {
    if (!space) return
    setError(null)
    if (!trimmedName) {
      setError(t('validation.nameRequired', { defaultValue: 'Agent 名称不能为空' }))
      return
    }
    try {
      const ok = await updateSpace(space.id, {
        name: trimmedName,
        // 空串是明确的清空指令，不能转成 undefined 后被 API 客户端省略。
        description: description.trim(),
      })
      if (!ok) {
        setError(useSpaceStore.getState().error ?? t('errors.updateFailed', { defaultValue: '更新失败' }))
        return
      }
      onSaved?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.updateFailed', { defaultValue: '更新失败' }))
    }
  }

  if (!space) return null

  return (
    <ProfileFormShell
      dirty={dirty}
      saving={isLoading}
      saveDisabled={saveDisabled}
      error={error}
      onSubmit={handleSubmit}
    >
      <div className="space-y-1.5">
        <label className={SETTINGS_LABEL}>
          {t('fields.name', { defaultValue: '名称' })}
          <span className="ml-0.5 text-destructive/60">*</span>
        </label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('fields.namePlaceholder', { defaultValue: 'Agent 名称' })}
          maxLength={100}
          disabled={isLoading || !canManage}
          className={cn('w-full', SETTINGS_CONTROL)}
        />
        <p className={SETTINGS_HINT}>{t('fields.nameHint', { count: name.length })}</p>
      </div>

      <div className="space-y-1.5">
        <label className={SETTINGS_LABEL}>{t('fields.description', { defaultValue: '描述' })}</label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('fields.descriptionPlaceholder', { defaultValue: '一句话介绍这个 Agent…' })}
          maxLength={500}
          rows={3}
          disabled={isLoading || !canManage}
          className={SETTINGS_TEXTAREA_FULL}
        />
      </div>
    </ProfileFormShell>
  )
}
