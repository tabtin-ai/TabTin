/**
 * ProfileRulesForm — Workspace 现场规则表单
 *
 * 读写 Workspace.custom_rules；与 Agent 人设（Agent.custom_rules）分离。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Textarea } from '@components/ui'
import { Button } from '@tabtin/smartsheet-ui'
import { useSpaceStore } from '@stores/useSpaceStore'
import {
  SETTINGS_HINT,
  SETTINGS_LABEL,
  SETTINGS_TEXTAREA_FULL,
} from '@components/settings/settingsUi'
import { ProfileFormShell } from './ProfileFormShell'

interface ProfileRulesFormProps {
  spaceId: string
  canManage: boolean
}

export const ProfileRulesForm: React.FC<ProfileRulesFormProps> = ({
  spaceId,
  canManage,
}) => {
  const { t } = useTranslation('space')
  const space = useSpaceStore((state) => state.spaces.find((p) => p.id === spaceId) ?? null)
  const { updateSpace, isLoading } = useSpaceStore(
    useShallow((s) => ({
      updateSpace: s.updateSpace,
      isLoading: s.isLoading,
    })),
  )

  const savedRules = space?.custom_rules ?? ''
  const [rules, setRules] = useState(savedRules)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    setRules(savedRules)
    setError(null)
    setSuccess(null)
  }, [space?.id, savedRules])

  const dirty = useMemo(() => rules !== savedRules, [rules, savedRules])

  const handleSubmit = async () => {
    if (!space) {
      setError(t('profileSheet.noExecutionContext', {
        defaultValue: '暂无法保存此工作空间的执行规则，请刷新后重试',
      }))
      return
    }
    setError(null)
    setSuccess(null)
    try {
      const ok = await updateSpace(space.id, { custom_rules: rules.trim() })
      if (!ok) {
        setError(t('errors.updateFailed', { defaultValue: '更新失败' }))
        return
      }
      setSuccess(t('profileRules.saved', { defaultValue: '规则已保存' }))
      setTimeout(() => setSuccess(null), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.updateFailed', { defaultValue: '更新失败' }))
    }
  }

  const handleResetToDefault = async () => {
    if (!space) return
    setRules('')
    setError(null)
    setSuccess(null)
    try {
      const ok = await updateSpace(space.id, { custom_rules: '' })
      if (!ok) {
        setError(t('errors.updateFailed', { defaultValue: '更新失败' }))
        return
      }
      setSuccess(t('profileRules.cleared', { defaultValue: '规则已清除' }))
      setTimeout(() => setSuccess(null), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.updateFailed', { defaultValue: '更新失败' }))
    }
  }

  if (!space && !canManage) {
    return (
      <p className="text-body text-muted-foreground/60 py-8 text-center">
        {t('profileSheet.noExecutionContext', {
          defaultValue: '暂无法编辑此工作空间的执行规则',
        })}
      </p>
    )
  }

  return (
    <ProfileFormShell
      dirty={dirty}
      saving={isLoading}
      saveDisabled={!canManage}
      error={error}
      success={success}
      onSubmit={handleSubmit}
    >
      <div className="space-y-1.5">
        <label className={SETTINGS_LABEL}>
          {t('profileRules.label', { defaultValue: '现场规则' })}
        </label>
        <Textarea
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          placeholder={t('profileRules.placeholder', {
            defaultValue: '在这个工作空间里干活时要遵守的约定，例如代码风格、回复语言、目录约定等',
          })}
          maxLength={5000}
          rows={12}
          disabled={!canManage}
          className={SETTINGS_TEXTAREA_FULL}
        />
        <p className={SETTINGS_HINT}>
          {t('profileRules.hint', {
            defaultValue: '仅在本工作空间生效；与 Agent 人设冲突时，以现场规则为准。下轮对话起生效。',
          })}
        </p>
        {savedRules.trim().length > 0 && canManage && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleResetToDefault()}
            disabled={isLoading}
          >
            {t('profileRules.resetToDefault', { defaultValue: '清除规则' })}
          </Button>
        )}
      </div>
    </ProfileFormShell>
  )
}
