/**
 * 上下文档位选择：Catalog context_tiers → Session context_tier_id。
 *
 * 无多档可切换时，回退展示模型 context_window_tokens（只读），
 * 避免右栏「上下文能力」整块消失。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import type { ContextTier, Model } from '@tabtin/chat-client'

/** 多档且运营标记为可切换 → 渲染可点芯片 */
export function canSelectContextTier(model: Model | null | undefined): boolean {
  const tiers = model?.context_tiers ?? []
  return tiers.length > 1 && tiers.some(tier => tier.is_user_selectable)
}

/** 有可切换档，或有单值 context_window → 显示上下文区块 */
export function shouldShowContextSelector(model: Model | null | undefined): boolean {
  if (canSelectContextTier(model)) return true
  const windowTokens = model?.context_window_tokens
  return typeof windowTokens === 'number' && windowTokens > 0
}

/** 将 token 数格式化为产品文案：128K / 256K / 1M */
export function formatContextWindowLabel(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return ''
  if (tokens >= 1_000_000) {
    const m = Math.round((tokens / 1_000_000) * 10) / 10
    return `${Number.isInteger(m) ? m.toFixed(0) : String(m)}M`
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`
  }
  return String(Math.round(tokens))
}

export function ContextSelector({
  model,
  currentTier,
  disabled,
  onSelectTier,
}: {
  model: Model
  currentTier?: ContextTier | null
  disabled?: boolean
  onSelectTier: (tierId: string) => void
}) {
  const { t } = useTranslation('chat')
  if (!shouldShowContextSelector(model)) return null

  const selectable = canSelectContextTier(model)
  const tiers = model.context_tiers ?? []
  const activeTierId = currentTier?.id
    ?? tiers.find(tier => tier.is_default)?.id
    ?? tiers[0]?.id

  const readOnlyLabel = !selectable && typeof model.context_window_tokens === 'number'
    ? formatContextWindowLabel(model.context_window_tokens)
    : ''

  return (
    <div data-testid="context-selector">
      <div className="mb-1.5 text-caption font-medium tracking-wide text-muted-foreground/70">
        {t('model.contextTier.section', { defaultValue: '上下文能力' })}
      </div>
      {selectable ? (
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label={t('model.contextTier.section', { defaultValue: '上下文能力' })}
        >
          {tiers.map(tier => {
            const isActive = tier.id === activeTierId
            const isBeta = (tier.tags ?? []).includes('beta')
            return (
              <button
                key={tier.id}
                type="button"
                disabled={disabled}
                onClick={() => onSelectTier(tier.id)}
                className={cn(
                  'inline-flex select-none items-center gap-0.5 rounded-md px-2 py-1 text-caption transition-colors',
                  isActive
                    ? 'border border-primary/30 bg-primary/15 text-primary'
                    : 'border border-transparent bg-muted/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <span>{tier.label}</span>
                {isBeta ? (
                  <span
                    className={cn(
                      'rounded px-1 text-caption font-medium uppercase tracking-wider',
                      isActive ? 'bg-primary/20' : 'border border-warning/30 text-warning',
                    )}
                  >
                    {t('model.contextTier.beta', { defaultValue: 'Beta' })}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : (
        <div
          data-testid="context-window-readonly"
          className="inline-flex select-none items-center rounded-md border border-primary/30 bg-primary/15 px-2 py-1 text-caption text-primary"
          aria-label={t('model.contextTier.window', {
            defaultValue: '上下文窗口 {{size}}',
            size: readOnlyLabel,
          })}
        >
          {readOnlyLabel}
        </div>
      )}
    </div>
  )
}
