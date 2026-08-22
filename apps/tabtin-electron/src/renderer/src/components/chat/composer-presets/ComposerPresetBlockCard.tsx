/**
 * ComposerPresetBlockCard — 消息历史中的 Preset 参数回显卡片
 *
 * 只读、紧凑布局。在用户消息气泡中展示提交的结构化参数。
 * 支持 source='preset'（用户主动）和 source='ask_user'（Agent 提问后回答，v2.3 预留）。
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { getComposerPreset } from './registry/composerPresetRegistry'
import type { PresetField } from './registry/types'
import {
  COMPOSER_TEXT_META_BASE,
  TEXT,
  TEXT_COLOR,
  BORDER,
  BG,
  CARD_RADIUS,
} from '../registry/chatDesignTokens'

interface ComposerPresetBlockCardProps {
  presetId: string
  params: Record<string, unknown>
  source?: 'preset' | 'ask_user'
}

const MAX_VALUE_LENGTH = 120

function truncateValue(value: unknown): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value)
  if (str.length > MAX_VALUE_LENGTH) return str.slice(0, MAX_VALUE_LENGTH) + '...'
  return str
}

function isImageUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(value) || value.includes('/image')
}

const ParamRow: React.FC<{ label: string; value: unknown }> = ({ label, value }) => {
  if (value === undefined || value === null || value === '') return null

  if (isImageUrl(value)) {
    return (
      <div className="flex items-start gap-2">
        <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted} shrink-0 w-16`}>{label}</span>
        <img
          src={value as string}
          alt={label}
          className="h-10 w-10 rounded object-cover"
          onError={e => {
            const target = e.target as HTMLImageElement
            target.style.display = 'none'
            const fallback = target.nextElementSibling as HTMLElement | null
            if (fallback) fallback.style.display = 'inline'
          }}
        />
        <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted} hidden truncate`}>
          {typeof value === 'string' ? value.split('/').pop() : ''}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-baseline gap-2">
      <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted} shrink-0 w-16`}>{label}</span>
      <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.secondary} truncate`}>
        {truncateValue(value)}
      </span>
    </div>
  )
}

export const ComposerPresetBlockCard: React.FC<ComposerPresetBlockCardProps> = ({
  presetId,
  params,
  source = 'preset',
}) => {
  const { t } = useTranslation('composerPreset')
  const descriptor = getComposerPreset(presetId)

  const rows = useMemo(() => {
    if (!descriptor?.fields) {
      return Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([key, value]) => ({ key, label: key, value }))
    }

    const allFields: PresetField[] = [
      ...descriptor.fields,
      ...(descriptor.addons ?? []).flatMap(a => a.fields),
    ]

    return allFields
      .filter(f => params[f.key] !== undefined && params[f.key] !== null && params[f.key] !== '')
      .map(f => ({
        key: f.key,
        label: f.label ?? f.labelKey?.split('.').pop() ?? f.key,
        value: params[f.key],
      }))
  }, [descriptor, params])

  const heading = useMemo(() => {
    if (source === 'ask_user') {
      return t('blockCard.askUserTitle')
    }
    if (descriptor) {
      return resolveLabel(descriptor.labelKey, t)
    }
    return presetId
  }, [source, descriptor, presetId, t])

  if (rows.length === 0) return null

  return (
    <div className={`${CARD_RADIUS} ${BORDER.subtle} ${BG.card} border px-2.5 py-2 space-y-1`}>
      <div className="flex items-center gap-1.5">
        {descriptor?.icon && <span className={COMPOSER_TEXT_META_BASE}>{descriptor.icon}</span>}
        <span className={`${TEXT.label} ${TEXT_COLOR.primary}`}>{heading}</span>
      </div>
      <div className="space-y-0.5">
        {rows.map(row => (
          <ParamRow key={row.key} label={row.label} value={row.value} />
        ))}
      </div>
    </div>
  )
}

function resolveLabel(key: string, t: TFunction): string {
  if (key.includes(':') || key.includes('.')) {
    const translated = String(t(key, key))
    return translated === key ? key.split('.').pop() ?? key : translated
  }
  return key
}
