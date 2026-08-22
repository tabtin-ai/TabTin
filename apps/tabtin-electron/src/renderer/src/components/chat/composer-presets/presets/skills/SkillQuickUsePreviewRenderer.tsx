import React, { useMemo } from 'react'
import { CheckCircle2, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { registerComposerRenderer } from '../../registry/composerRenderers'
import type { ComposerPresetProps, PromptVariable } from '../../registry/types'
import {
  BORDER,
  CARD_RADIUS,
  COMPOSER_TEXT_META_BASE,
  COMPOSER_TEXT_MICRO,
  TEXT,
  TEXT_COLOR,
} from '../../../registry/chatDesignTokens'

export const SKILL_QUICK_USE_PREVIEW_RENDERER = 'skillQuickUsePreview'

function valueAsString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(valueAsString).filter(Boolean).join('、')
  return ''
}

function resolveVariableLabel(variable: PromptVariable): string {
  return variable.label || variable.labelKey || variable.key
}

function editableValue(value: unknown, fallback: unknown): string {
  if (typeof value === 'string') return value
  if (value !== undefined && value !== null) return valueAsString(value)
  if (typeof fallback === 'string') return fallback
  return valueAsString(fallback)
}

function buildPreviewPrompt(
  template: string | undefined,
  variables: PromptVariable[] | undefined,
  state: Record<string, unknown>,
): string {
  if (!template) return ''
  const variableMap = new Map((variables ?? []).map(variable => [variable.key, variable]))
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = valueAsString(state[key])
    if (value) return value
    const fallback = valueAsString(variableMap.get(key)?.defaultValue)
    return fallback || key
  })
}

const SkillQuickUseField: React.FC<{
  variable: PromptVariable
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
}> = ({ variable, value, disabled, onChange }) => {
  const { t } = useTranslation('context')
  const label = resolveVariableLabel(variable)
  const stringValue = editableValue(value, variable.defaultValue)

  if (variable.type === 'select' && variable.options?.length) {
    const currentValue = stringValue || variable.options[0]?.value || ''
    return (
      <div className="space-y-1.5">
        <div className={`${TEXT.label} ${TEXT_COLOR.muted}`}>{label}</div>
        <div className="flex flex-wrap gap-1.5">
          {variable.options.map(option => {
            const active = option.value === currentValue
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onClick={() => onChange(option.value)}
                className={cn(
                  'rounded-full px-2.5 py-1 font-medium transition-colors',
                  COMPOSER_TEXT_MICRO,
                  active
                    ? 'bg-accent/10 text-accent'
                    : 'bg-muted/20 text-muted-foreground/80 hover:bg-muted/30 hover:text-foreground',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  if (variable.type === 'multiselect' && variable.options?.length) {
    const selected = Array.isArray(value) ? value.map(String) : []
    return (
      <div className="space-y-1.5">
        <div className={`${TEXT.label} ${TEXT_COLOR.muted}`}>{label}</div>
        <div className="flex flex-wrap gap-1.5">
          {variable.options.map(option => {
            const active = selected.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onClick={() => {
                  onChange(active
                    ? selected.filter(item => item !== option.value)
                    : [...selected, option.value])
                }}
                className={cn(
                  'rounded-full px-2.5 py-1 font-medium transition-colors',
                  COMPOSER_TEXT_MICRO,
                  active
                    ? 'bg-accent/10 text-accent'
                    : 'bg-muted/20 text-muted-foreground/80 hover:bg-muted/30 hover:text-foreground',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  if (variable.type === 'toggle') {
    const active = Boolean(value)
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/10 px-2.5 py-2">
        <div className={`${TEXT.body} ${TEXT_COLOR.secondary}`}>{label}</div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(!active)}
          className={cn(
            'rounded-full px-2.5 py-1 font-medium transition-colors',
            COMPOSER_TEXT_MICRO,
            active ? 'bg-accent/10 text-accent' : 'bg-muted/30 text-muted-foreground/80',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          {active ? t('skills.quickUse.toggleOn', '开启') : t('skills.quickUse.toggleOff', '关闭')}
        </button>
      </div>
    )
  }

  if (variable.type === 'number' || variable.type === 'slider') {
    return (
      <label className="block space-y-1.5">
        <span className={`${TEXT.label} ${TEXT_COLOR.muted}`}>{label}</span>
        <input
          type="number"
          disabled={disabled}
          value={stringValue}
          onChange={event => onChange(event.target.value ? Number(event.target.value) : undefined)}
          className="h-8 w-full rounded-lg border border-border/30 bg-background/80 px-2.5 text-body text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-accent/30"
        />
      </label>
    )
  }

  return (
    <label className="block space-y-1.5">
      <span className={`${TEXT.label} ${TEXT_COLOR.muted}`}>{label}</span>
      <textarea
        disabled={disabled}
        value={stringValue}
        rows={variable.type === 'textarea' ? ((variable.config?.rows as number | undefined) ?? 2) : 1}
        placeholder={variable.placeholder}
        onChange={event => onChange(event.target.value)}
        className="min-h-8 w-full resize-none rounded-lg border border-border/30 bg-background/80 px-2.5 py-1.5 text-body leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
      />
    </label>
  )
}

export const SkillQuickUsePreviewRenderer: React.FC<ComposerPresetProps> = ({
  preset,
  state,
  onChange,
  disabled,
}) => {
  const { t } = useTranslation('context')
  const previewPrompt = useMemo(
    () => buildPreviewPrompt(preset.promptTemplate, preset.variables, state),
    [preset.promptTemplate, preset.variables, state],
  )
  const variables = preset.variables ?? []

  return (
    <div className="space-y-2.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className={`${TEXT.header} ${TEXT_COLOR.primary}`}>
            {t('skills.quickUse.generatedTitle', '已生成任务草稿')}
          </div>
          <div className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted}`}>
            {t('skills.quickUse.generatedHint', '已按模板先填好内容，你可以微调后再发送。')}
          </div>
        </div>
        <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 font-medium text-accent', COMPOSER_TEXT_MICRO)}>
          <CheckCircle2 className="h-3 w-3" />
          {t('skills.quickUse.readyBadge', '可发送')}
        </span>
      </div>

      {variables.length > 0 && (
        <div className="grid gap-2">
          {variables.map(variable => (
            <SkillQuickUseField
              key={variable.key}
              variable={variable}
              value={state[variable.key]}
              disabled={disabled}
              onChange={value => onChange({ [variable.key]: value })}
            />
          ))}
        </div>
      )}

      {previewPrompt && (
        <div className={`${CARD_RADIUS} ${BORDER.subtle} border bg-background/80 px-3 py-2`}>
          <div className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted} mb-1`}>
            {t('skills.quickUse.previewLabel', '将发送给 Agent')}
          </div>
          <pre className="max-h-40 whitespace-pre-wrap font-sans text-body leading-relaxed text-foreground/80">
            {previewPrompt}
          </pre>
        </div>
      )}
    </div>
  )
}

registerComposerRenderer(SKILL_QUICK_USE_PREVIEW_RENDERER, SkillQuickUsePreviewRenderer)
