/**
 * AskFormPanel — `ask_form` 工具的 UI 渲染（路径权限治理 W7 / A5 D6 真分立）。
 *
 * 包括两种 form 形态：
 *   - `formMode: 'fields'`         → SchemaFormRenderer 渲染（默认）
 *   - `formMode: 'text_fallback'` → 退化为单 textarea（mobile / 老版桌面端走此路径）
 *
 * 字段owner：fields[] / addons[] / formMode（必有）；其他 base 字段
 * （title / submit 文案 / 错误反显）由顶层 AskUserPanel 透传。
 */

import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HelpCircle, Loader2 } from 'lucide-react'
import { Button, toast } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import type { PresetFieldDef, AddonParamDef } from '@tabtin/chat-client'
import { useAskUserFormState } from '../composer-presets/useAskUserFormState'
import { SchemaFormRenderer } from '../composer-presets/SchemaFormRenderer'
import {
  CARD_RADIUS,
  CARD_MAX_HEIGHT,
  BORDER,
  TEXT,
  TEXT_COLOR,
  ICON_SIZE,
} from '../registry/chatDesignTokens'

export interface AskFormPanelProps {
  fields: PresetFieldDef[]
  addons?: AddonParamDef[]
  formMode: 'fields' | 'text_fallback'
  title?: string
  onFieldsSubmit?: (fieldValues: Record<string, unknown>) => void
  onTextSubmit?: (text: string) => void
  onSkip?: () => void
  isSubmitting?: boolean
  disabled?: boolean
  submitError?: string
}

const FieldsForm: React.FC<{
  fieldDefs: PresetFieldDef[]
  addonDefs?: AddonParamDef[]
  title?: string
  onFieldsSubmit: (fieldValues: Record<string, unknown>) => void
  onSkip?: () => void
  isSubmitting: boolean
  disabled?: boolean
}> = ({ fieldDefs, addonDefs, title, onFieldsSubmit, onSkip, isSubmitting, disabled = false }) => {
  const { t } = useTranslation('chat')
  const formApi = useAskUserFormState(fieldDefs, addonDefs)
  const {
    presetFields, presetAddons, formState, formErrors, activeAddonKeys, slotAttachments,
    isUploading, hasErrors,
    handleStateChange, handleFieldError, handleToggleAddon,
    handleAddSlotAttachment, handleRemoveSlotAttachment,
    resolveUploadsAndBuildFinalState,
  } = formApi

  const canSubmit = useMemo(() => {
    if (hasErrors) return false

    const isFieldFilled = (f: import('../composer-presets/registry/types').PresetField, state: Record<string, unknown>): boolean => {
      if (f.type === 'group' && Array.isArray(f.config?.fields)) {
        const groupState = (typeof state[f.key] === 'object' && state[f.key] !== null
          ? state[f.key] : {}) as Record<string, unknown>
        for (const child of f.config.fields as import('../composer-presets/registry/types').PresetField[]) {
          if (child.required && !isFieldFilled(child, groupState)) return false
        }
        return true
      }
      if (f.type === 'upload') {
        return Boolean(slotAttachments[f.key]?.length)
      }
      const v = state[f.key]
      return v !== undefined && v !== null && v !== ''
    }

    for (const f of presetFields) {
      if (!f.required && f.type !== 'group') continue
      if (f.type === 'group') {
        if (!isFieldFilled(f, formState)) return false
      } else if (f.required && !isFieldFilled(f, formState)) {
        return false
      }
    }
    return true
  }, [hasErrors, presetFields, formState, slotAttachments])

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || isSubmitting || isUploading) return
    try {
      const finalState = await resolveUploadsAndBuildFinalState()
      onFieldsSubmit(finalState)
    } catch (err) {
      console.error('[AskFormPanel] Upload failed:', err)
      toast({
        title: t('chat:messages.uploadFailed', { defaultValue: '文件上传失败，请重试' }),
        variant: 'destructive',
      })
    }
  }, [canSubmit, isSubmitting, isUploading, resolveUploadsAndBuildFinalState, onFieldsSubmit, t])

  const submitting = isSubmitting || isUploading

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 flex-shrink-0 items-center gap-2 px-3 pt-3">
        <HelpCircle className={cn(ICON_SIZE.lg, 'text-accent flex-shrink-0')} />
        <span className={cn(TEXT.header, TEXT_COLOR.secondary, 'min-w-0 flex-1 break-words [overflow-wrap:anywhere]')}>
          {title || t('askUser.fieldsTitle', '请填写以下信息')}
        </span>
      </div>

      <div className={cn('min-h-0 flex-1 overflow-y-auto px-3 py-3')}>
        <SchemaFormRenderer
          fields={presetFields}
          addons={presetAddons}
          state={formState}
          activeAddonKeys={activeAddonKeys}
          errors={formErrors}
          onStateChange={handleStateChange}
          onToggleAddon={handleToggleAddon}
          onFieldError={handleFieldError}
          disabled={submitting}
          slotAttachments={slotAttachments}
          onAddSlotAttachment={handleAddSlotAttachment}
          onRemoveSlotAttachment={handleRemoveSlotAttachment}
        />
      </div>

      <div className={cn('flex flex-shrink-0 items-center justify-between border-t px-3 pb-3 pt-2', BORDER.subtle)}>
        {onSkip ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-7 px-3', TEXT.body, 'text-muted-foreground')}
            onClick={onSkip}
            disabled={submitting || disabled}
          >
            {t('askUser.skip', '跳过')}
          </Button>
        ) : <div />}
        <Button
          variant="default"
          size="sm"
          className={cn('h-7 px-4', TEXT.body)}
          onClick={handleSubmit}
          disabled={submitting || !canSubmit || disabled}
        >
          {submitting ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              {isUploading
                ? t('askUser.uploading', '上传中...')
                : t('askUser.submitting', '提交中...')}
            </span>
          ) : disabled ? (
            t('input.wsDisconnected', { defaultValue: '连接已断开' })
          ) : (
            t('askUser.submit', '提交回答')
          )}
        </Button>
      </div>
    </div>
  )
}

const TextFallbackForm: React.FC<{
  title?: string
  fields?: PresetFieldDef[]
  addons?: AddonParamDef[]
  onTextSubmit: (text: string) => void
  onSkip?: () => void
  isSubmitting: boolean
  disabled?: boolean
}> = ({ title, fields, addons, onTextSubmit, onSkip, isSubmitting, disabled = false }) => {
  const { t } = useTranslation('chat')
  const [text, setText] = useState('')

  const helperLines = useMemo(() => {
    const lines: string[] = []
    const requiredFields = (fields ?? [])
      .filter(field => field.required)
      .map(field => field.label)
      .filter(Boolean)
    const optionalFields = (fields ?? [])
      .filter(field => !field.required)
      .map(field => field.label)
      .filter(Boolean)
    const enabledAddons = (addons ?? [])
      .map(addon => addon.label)
      .filter(Boolean)

    if (requiredFields.length > 0) {
      lines.push(
        t('askUser.textFallbackRequiredFields', {
          defaultValue: '请尽量在文本里补充这些关键信息：{{fields}}',
          fields: requiredFields.join('、'),
        }),
      )
    }

    if (optionalFields.length > 0) {
      lines.push(
        t('askUser.textFallbackOptionalFields', {
          defaultValue: '如果方便，也可以一并说明：{{fields}}',
          fields: optionalFields.join('、'),
        }),
      )
    }

    if (enabledAddons.length > 0) {
      lines.push(
        t('askUser.textFallbackAddons', {
          defaultValue: '可选扩展项包括：{{addons}}',
          addons: enabledAddons.join('、'),
        }),
      )
    }

    return lines
  }, [addons, fields, t])

  const canSubmit = text.trim().length > 0

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onTextSubmit(trimmed)
  }, [onTextSubmit, text])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 flex-shrink-0 items-center gap-2 px-3 pt-3">
        <HelpCircle className={cn(ICON_SIZE.lg, 'text-accent flex-shrink-0')} />
        <span className={cn(TEXT.header, TEXT_COLOR.secondary, 'min-w-0 flex-1 break-words [overflow-wrap:anywhere]')}>
          {title || t('askUser.textFallbackTitle', '请用文本补充信息')}
        </span>
      </div>

      <div className={cn('min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3')}>
        {helperLines.length > 0 && (
          <div className={cn('space-y-1 rounded-md border px-2.5 py-2', BORDER.subtle, 'bg-muted/10')}>
            {helperLines.map(line => (
              <p key={line} className={cn(TEXT.meta, TEXT_COLOR.muted, 'break-words [overflow-wrap:anywhere]')}>
                {line}
              </p>
            ))}
          </div>
        )}

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={isSubmitting || disabled}
          rows={5}
          placeholder={t('askUser.textFallbackPlaceholder', '直接输入补充信息，Agent 会继续往下执行')}
          className={cn(
            'w-full resize-none rounded-md border bg-background px-2.5 py-2', TEXT.body, BORDER.default,
            'placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-accent/40',
            'min-h-[120px]',
            (isSubmitting || disabled) && 'opacity-60 cursor-not-allowed',
          )}
        />
      </div>

      <div className={cn('flex flex-shrink-0 items-center justify-between border-t px-3 pb-3 pt-2', BORDER.subtle)}>
        {onSkip ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-7 px-3', TEXT.body, 'text-muted-foreground')}
            onClick={onSkip}
            disabled={isSubmitting || disabled}
          >
            {t('askUser.skip', '跳过')}
          </Button>
        ) : <div />}
        <Button
          variant="default"
          size="sm"
          className={cn('h-7 px-4', TEXT.body)}
          onClick={handleSubmit}
          disabled={isSubmitting || !canSubmit || disabled}
        >
          {isSubmitting
            ? t('askUser.submitting', '提交中...')
            : disabled
              ? t('input.wsDisconnected', { defaultValue: '连接已断开' })
              : t('askUser.submit', '提交回答')}
        </Button>
      </div>
    </div>
  )
}

export const AskFormPanel: React.FC<AskFormPanelProps> = ({
  fields,
  addons,
  formMode,
  title,
  onFieldsSubmit,
  onTextSubmit,
  onSkip,
  isSubmitting = false,
  disabled = false,
  submitError,
}) => {
  return (
    <div
      data-testid="ask-form-panel"
      className={cn(
        CARD_RADIUS,
        // 与 ApprovalPanel / AskUser choice 同用实底，避免叠在
        // chat-composer-backplate 灰托盘上透出蒙层感。
        'flex min-h-0 min-w-0 flex-col overflow-hidden border bg-background',
        CARD_MAX_HEIGHT.lg,
        BORDER.active,
      )}
    >
      {submitError ? (
        <div
          className={cn(
            'mx-3 mt-3 flex-shrink-0 rounded-md border px-2.5 py-2',
            'border-destructive/30 text-destructive',
            TEXT.meta,
          )}
        >
          {submitError}
        </div>
      ) : null}

      {formMode === 'text_fallback' && typeof onTextSubmit === 'function' ? (
        <TextFallbackForm
          title={title}
          fields={fields}
          addons={addons}
          onTextSubmit={onTextSubmit}
          onSkip={onSkip}
          isSubmitting={isSubmitting}
          disabled={disabled}
        />
      ) : typeof onFieldsSubmit === 'function' ? (
        <FieldsForm
          fieldDefs={fields}
          addonDefs={addons}
          title={title}
          onFieldsSubmit={onFieldsSubmit}
          onSkip={onSkip}
          isSubmitting={isSubmitting}
          disabled={disabled}
        />
      ) : null}
    </div>
  )
}
