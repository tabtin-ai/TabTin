import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, ScrollArea, Switch } from '@components/ui'
import { useShallow } from 'zustand/react/shallow'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useTranslation } from 'react-i18next'
import { SETTINGS_CONTROL, SETTINGS_HINT, SETTINGS_SECTION_TITLE } from '@components/settings/settingsUi'
import { SpaceSettingsSectionHeader } from '@components/space-settings/SpaceSettingsSectionHeader'
import { cn } from '@utils/cn'
import {
  PRODUCT_DEFAULT_MAX_CREDITS,
  PRODUCT_DEFAULT_MAX_ITERATIONS,
  isExecutionLimitsEnabled,
  normalizeExecutionLimitsForPersist,
  resolveExecutionLimitsDisplay,
  type ExecLimitsShape,
} from './executionLimitsHelpers'

export {
  PRODUCT_DEFAULT_MAX_CREDITS,
  PRODUCT_DEFAULT_MAX_ITERATIONS,
  hasCustomExecutionLimits,
  isExecutionLimitsEnabled,
  normalizeExecutionLimitsForPersist,
  resolveExecutionLimitsDisplay,
} from './executionLimitsHelpers'

interface ExecutionLimitsPanelProps {
  spaceId: string
  canManage?: boolean
}

export const ExecutionLimitsPanel: React.FC<ExecutionLimitsPanelProps> = ({
  spaceId,
  canManage = true,
}) => {
  const { t } = useTranslation('space')
  const space = useSpaceStore((state) => state.spaces.find((s) => s.id === spaceId) ?? null)
  const { updateSpace, isLoading } = useSpaceStore(
    useShallow((state) => ({
      updateSpace: state.updateSpace,
      isLoading: state.isLoading,
    })),
  )
  const saving = isLoading

  // ：现场执行限制读工作空间.execution_limits
  const savedLimits = (space?.execution_limits ?? null) as ExecLimitsShape | null
  const savedEnabled = isExecutionLimitsEnabled(savedLimits)

  const [enabled, setEnabled] = useState(savedEnabled)
  const [maxIterations, setMaxIterations] = useState(
    String(PRODUCT_DEFAULT_MAX_ITERATIONS),
  )
  const [maxCredits, setMaxCredits] = useState(PRODUCT_DEFAULT_MAX_CREDITS)
  const [saveError, setSaveError] = useState('')
  const [saveSuccess, setSaveSuccess] = useState(false)

  useEffect(() => {
    const display = resolveExecutionLimitsDisplay(savedLimits)
    setEnabled(isExecutionLimitsEnabled(savedLimits))
    setMaxIterations(display.maxIterations)
    setMaxCredits(display.maxCredits)
    setSaveError('')
    setSaveSuccess(false)
  }, [space?.id, savedLimits])

  const hasChanges = useMemo(() => {
    const baseline = resolveExecutionLimitsDisplay(savedLimits)
    return (
      enabled !== savedEnabled
      || maxIterations.trim() !== baseline.maxIterations
      || maxCredits.trim() !== baseline.maxCredits
    )
  }, [enabled, savedEnabled, maxIterations, maxCredits, savedLimits])

  const persistLimits = useCallback(async (payload: ExecLimitsShape) => {
    if (!space) {
      setSaveError(t('profileSheet.noExecutionContext', {
        defaultValue: '暂无法保存此工作空间的执行设置，请刷新后重试',
      }))
      return false
    }

    const ok = await updateSpace(space.id, {
      execution_limits: {
        enabled: payload.enabled ?? null,
        max_iterations_per_run: payload.max_iterations_per_run ?? null,
        max_credits_per_run:
          payload.max_credits_per_run == null
            ? null
            : String(payload.max_credits_per_run),
      },
    })
    return ok
  }, [space, updateSpace, t])

  const handleEnabledChange = useCallback((next: boolean) => {
    setEnabled(next)
    setSaveSuccess(false)
    if (next) {
      setMaxIterations((prev) => prev.trim() || String(PRODUCT_DEFAULT_MAX_ITERATIONS))
      setMaxCredits((prev) => prev.trim() || PRODUCT_DEFAULT_MAX_CREDITS)
    }
  }, [])

  const handleSave = useCallback(async () => {
    setSaveError('')
    setSaveSuccess(false)

    if (!enabled) {
      const draft = normalizeExecutionLimitsForPersist(maxIterations, maxCredits)
      try {
        const ok = await persistLimits({
          enabled: false,
          max_iterations_per_run: 'error' in draft ? null : draft.iterValue,
          max_credits_per_run: 'error' in draft ? null : draft.credValue,
        })
        if (!ok) return
        setSaveSuccess(true)
        setTimeout(() => setSaveSuccess(false), 3000)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : t('errors.updateFailed'))
      }
      return
    }

    const normalized = normalizeExecutionLimitsForPersist(maxIterations, maxCredits)
    if ('error' in normalized) {
      setSaveError(t('errors.updateFailed'))
      return
    }

    try {
      const ok = await persistLimits({
        enabled: true,
        max_iterations_per_run: normalized.iterValue,
        max_credits_per_run: normalized.credValue,
      })
      if (!ok) return
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('errors.updateFailed'))
    }
  }, [enabled, maxIterations, maxCredits, persistLimits, t])

  const handleFillRecommended = useCallback(() => {
    setMaxIterations(String(PRODUCT_DEFAULT_MAX_ITERATIONS))
    setMaxCredits(PRODUCT_DEFAULT_MAX_CREDITS)
    setSaveSuccess(false)
  }, [])

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="space-y-5 pb-2">
          <SpaceSettingsSectionHeader
            marginBottomClassName="mb-1"
            title={t('executionLimits.title')}
            description={t('executionLimits.desc')}
          />

          <div className="flex items-center justify-between gap-4 py-1">
            <div className="min-w-0">
              <div className={SETTINGS_SECTION_TITLE}>
                {t('executionLimits.enabled')}
              </div>
              <p className={cn(SETTINGS_HINT, 'mt-1')}>
                {t('executionLimits.enabledDesc')}
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={handleEnabledChange}
              disabled={saving || !canManage}
            />
          </div>

          {enabled && (
            <>
              <div className="border-t border-border/20 pt-4">
                <div className={SETTINGS_SECTION_TITLE}>
                  {t('executionLimits.maxIterationsPerRun')}
                </div>
                <p className={cn(SETTINGS_HINT, 'mt-1 mb-2')}>
                  {t('executionLimits.maxIterationsPerRunDesc')}
                </p>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={maxIterations}
                  onChange={e => {
                    setMaxIterations(e.target.value)
                    setSaveSuccess(false)
                  }}
                  disabled={saving || !canManage}
                  className={cn('w-full', SETTINGS_CONTROL)}
                />
              </div>

              <div className="border-t border-border/20 pt-4">
                <div className={SETTINGS_SECTION_TITLE}>
                  {t('executionLimits.maxCreditsPerRun')}
                </div>
                <p className={cn(SETTINGS_HINT, 'mt-1 mb-2')}>
                  {t('executionLimits.maxCreditsPerRunDesc')}
                </p>
                <Input
                  type="number"
                  min={0.01}
                  step="any"
                  value={maxCredits}
                  onChange={e => {
                    setMaxCredits(e.target.value)
                    setSaveSuccess(false)
                  }}
                  disabled={saving || !canManage}
                  className={cn('w-full', SETTINGS_CONTROL)}
                />
              </div>

              <p className={cn(SETTINGS_HINT, 'pt-1')}>
                {t('executionLimits.recommendedHint', {
                  iterations: PRODUCT_DEFAULT_MAX_ITERATIONS,
                  credits: PRODUCT_DEFAULT_MAX_CREDITS,
                })}
              </p>
              {canManage && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleFillRecommended}
                  disabled={saving}
                  className={SETTINGS_CONTROL}
                >
                  {t('executionLimits.fillRecommended')}
                </Button>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t border-border/20 pt-3 mt-1">
        {saveError && (
          <p className="mb-2 text-caption text-destructive">{saveError}</p>
        )}
        {saveSuccess && (
          <p className="mb-2 text-caption text-success">
            {t('executionLimits.saveSuccess')}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          {hasChanges && (
            <span className="text-caption text-muted-foreground/60">
              {t('executionLimits.unsavedChanges')}
            </span>
          )}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !hasChanges || !canManage}
            className={cn(
              SETTINGS_CONTROL,
              'transition-opacity',
              !hasChanges && 'opacity-40',
            )}
          >
            {saving ? t('actions.saving') : t('actions.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
