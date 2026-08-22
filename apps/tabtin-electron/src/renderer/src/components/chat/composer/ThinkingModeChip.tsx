/**
 * ThinkingModeChip — Runtime Profile 产品三档思考控件（W2f PR1）。
 *
 * 数据源：Catalog `runtime_profile.thinking` + Session `thinking_mode` 意图。
 * 写入：`controlChange { key: 'thinking_mode', value }` → 既有 model param transport（v2）。
 */

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import type { ChatInputChromeProps } from './chatInputTypes'
import type {
  Model,
  ModelParamOverrides,
  RuntimeProfileThinkingMode,
} from '@tabtin/chat-client'
import {
  getCatalogThinkingCapability,
  resolveActiveThinkingMode,
  thinkingModeControlChange,
  type CatalogThinkingCapability,
} from './thinkingModeCapability'

const MODE_I18N: Record<RuntimeProfileThinkingMode, { labelKey: string; defaultLabel: string }> = {
  off: { labelKey: 'model.thinkingMode.off', defaultLabel: '关闭' },
  standard: { labelKey: 'model.thinkingMode.standard', defaultLabel: '标准' },
  deep: { labelKey: 'model.thinkingMode.deep', defaultLabel: '深度' },
}

export function ThinkingModeChip({
  model,
  currentModelParamOverrides,
  disabled,
  onModelChange,
}: {
  model: Model
  currentModelParamOverrides?: ModelParamOverrides | null
  disabled?: boolean
  onModelChange?: ChatInputChromeProps['onModelChange']
}) {
  const { t } = useTranslation('chat')
  const capability = getCatalogThinkingCapability(model)
  if (!capability) return null

  return (
    <ThinkingModeChipView
      model={model}
      capability={capability}
      currentModelParamOverrides={currentModelParamOverrides}
      disabled={disabled}
      onModelChange={onModelChange}
      t={t}
    />
  )
}

function ThinkingModeChipView({
  model,
  capability,
  currentModelParamOverrides,
  disabled,
  onModelChange,
  t,
}: {
  model: Model
  capability: CatalogThinkingCapability
  currentModelParamOverrides?: ModelParamOverrides | null
  disabled?: boolean
  onModelChange?: ChatInputChromeProps['onModelChange']
  t: (key: string, opts?: { defaultValue?: string }) => string
}) {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const activeMode = resolveActiveThinkingMode(
    currentModelParamOverrides,
    capability.defaultMode,
  )
  const activeInModes = capability.modes.includes(activeMode)
  const activeLabel = modeLabel(t, activeMode)
  const chipTitle = activeInModes
    ? t('model.thinkingMode.tooltip', { defaultValue: '思考强度' })
    : t('model.thinkingMode.intentOutsideModes', {
      defaultValue: '当前模型不提供该档；发送时按模型能力调整。你的选择仍会保留。',
    })

  useEffect(() => {
    if (!open) return

    const updateMenuStyle = () => {
      const trigger = rootRef.current?.getBoundingClientRect()
      if (!trigger) return
      setMenuStyle({
        position: 'fixed',
        left: Math.max(8, Math.min(trigger.left, window.innerWidth - 180)),
        top: Math.max(8, trigger.top - 8),
        minWidth: trigger.width,
        transform: 'translateY(-100%)',
      })
    }

    updateMenuStyle()
    window.addEventListener('resize', updateMenuStyle)
    window.addEventListener('scroll', updateMenuStyle, true)
    return () => {
      window.removeEventListener('resize', updateMenuStyle)
      window.removeEventListener('scroll', updateMenuStyle, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  return (
    <div ref={rootRef} className="relative shrink-0" data-testid="thinking-mode-chip">
      <ChatIconTooltip
        content={chipTitle}
        side="top"
        align="center"
        sideOffset={8}
        delayDuration={250}
        className="max-w-[280px] whitespace-normal text-caption leading-relaxed"
      >
        <button
          type="button"
          disabled={disabled}
          aria-label={t('model.thinkingMode.label', { defaultValue: '思考' })}
          onClick={() => setOpen(prev => !prev)}
          className={cn(
            'flex h-7 items-center gap-1 rounded-md px-2 text-body transition-colors',
            'text-muted-foreground/85 hover:bg-muted/40 hover:text-foreground',
            open && 'bg-muted/60 text-foreground',
            disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
          )}
        >
          <span className="whitespace-nowrap">
            {t('model.thinkingMode.label', { defaultValue: '思考' })}
          </span>
          <span className="max-w-[4.5rem] truncate text-foreground/85">{activeLabel}</span>
          <ChevronDown
            strokeWidth={2.5}
            className={cn('h-2.5 w-2.5 transition-transform', open && 'rotate-180')}
          />
        </button>
      </ChatIconTooltip>

      {open && menuStyle && createPortal(
        <div
          ref={menuRef}
          className={cn(
            'z-dropdown overflow-hidden rounded-interactive',
            OVERLAY_SURFACE_CLASS,
          )}
          style={menuStyle}
          data-testid="thinking-mode-menu"
        >
          <div className="flex flex-col p-1">
            {capability.modes.map(mode => {
              const isActive = mode === activeMode
              return (
                <button
                  key={mode}
                  type="button"
                  data-thinking-mode={mode}
                  onClick={() => {
                    onModelChange?.(model.id, undefined, thinkingModeControlChange(mode))
                    setOpen(false)
                  }}
                  className={cn(
                    'flex h-7 w-full items-center rounded-md px-2 text-left text-body transition-colors',
                    isActive
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  <span className="whitespace-nowrap">{modeLabel(t, mode)}</span>
                </button>
              )
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function modeLabel(
  t: (key: string, opts?: { defaultValue?: string }) => string,
  mode: RuntimeProfileThinkingMode,
): string {
  const meta = MODE_I18N[mode]
  return t(meta.labelKey, { defaultValue: meta.defaultLabel })
}
