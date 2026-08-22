/**
 * ModelSelector - 模型选择器组件
 *
 * 用于在对话中选择和切换 LLM 模型
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Sparkles, Zap } from 'lucide-react'
import { Button, OVERLAY_SURFACE_CLASS, ScrollArea } from '@components/ui'
import { motion, AnimatePresence } from 'framer-motion'
import type { Model } from '@tabtin/chat-client'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { getProviderShortLabel } from '@/utils/provider-registry'
import { ProviderLogo } from './ProviderLogo'
import { ModelPromotionCreditInline } from './ModelPromotionCreditInline'
import {
  groupModelsBySourceAndProvider,
  MODEL_SOURCE_BADGE_CLASSNAMES,
  MODEL_SOURCE_DEFAULT_LABELS,
  resolveModelSource,
} from './modelSourceGrouping'

interface ModelSelectorProps {
  /** 可用模型列表 */
  models: Model[]
  /** 当前选中的模型 */
  currentModel: Model | null
  /** 切换模型的回调（传入模型ID） */
  onModelChange: (modelId: string) => void
  /** 是否禁用 */
  disabled?: boolean
  /** 是否正在加载 */
  loading?: boolean
  /** 是否为紧凑模式 */
  compact?: boolean
  /** 模型加载错误 */
  error?: string | null
  /** 重试加载模型 */
  onRetry?: () => void
}

type ModelSelectorFilter = {
  excludeByok: boolean
}

function isByokModel(model: Model): boolean {
  return resolveModelSource(model.provider_scope) !== 'platform'
}

function readOpenSelectorFilter(event: Event): ModelSelectorFilter | null {
  if (!(event instanceof CustomEvent)) return null
  const detail = event.detail
  if (!detail || typeof detail !== 'object') return null
  const filter = (detail as { filter?: unknown }).filter
  if (!filter || typeof filter !== 'object') return null
  const excludeByok = (filter as { exclude_byok?: unknown; excludeByok?: unknown }).exclude_byok
    ?? (filter as { exclude_byok?: unknown; excludeByok?: unknown }).excludeByok
  return excludeByok === true ? { excludeByok: true } : null
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  models,
  currentModel,
  onModelChange,
  disabled = false,
  loading = false,
  compact = false,
  error = null,
  onRetry,
}) => {
  const { t } = useTranslation('chat')
  const [isOpen, setIsOpen] = useState(false)
  const [openFilter, setOpenFilter] = useState<ModelSelectorFilter | null>(null)

  useEffect(() => {
    const handler = (event: Event) => {
      if (disabled) return
      setOpenFilter(readOpenSelectorFilter(event))
      setIsOpen(true)
    }
    window.addEventListener('chat:open-model-selector', handler)
    return () => window.removeEventListener('chat:open-model-selector', handler)
  }, [disabled])

  const openMenuFromTrigger = useCallback(() => {
    if (disabled) return
    setOpenFilter(null)
    setIsOpen(!isOpen)
  }, [disabled, isOpen])

  const closeMenu = useCallback(() => {
    setIsOpen(false)
    setOpenFilter(null)
  }, [])

  const visibleModels = useMemo(
    () => openFilter?.excludeByok ? models.filter(model => !isByokModel(model)) : models,
    [models, openFilter],
  )

  // 同一提供商可能同时存在平台与 BYOK 渠道，必须先按来源拆开。
  const groupedModels = useMemo(
    () => groupModelsBySourceAndProvider(visibleModels),
    [visibleModels],
  )

  const handleSelect = (modelId: string) => {
    onModelChange(modelId)
    closeMenu()
  }

  if (loading) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        className="h-8 gap-2 text-body"
      >
        <Sparkles className="h-3.5 w-3.5 animate-spin" />
        {t('model.loading')}
      </Button>
    )
  }

  // 如果模型列表为空，显示提示
  if (models.length === 0) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={!onRetry}
        onClick={onRetry}
        className={`h-8 gap-2 text-body ${onRetry ? '' : 'opacity-50'}`}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {error ? t('model.loadFailed') : t('model.empty')}
      </Button>
    )
  }

  // 如果没有当前模型但有模型列表，使用第一个模型
  if (!currentModel && models.length > 0) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => onModelChange(models[0].id)}
        disabled={disabled}
        className="h-8 gap-2 text-body"
      >
        <ProviderLogo provider={models[0].provider} className="h-3.5 w-3.5" />
        {!compact && <span className="font-medium">{t('model.select')}</span>}
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
    )
  }

  if (!currentModel) {
    return null
  }

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={openMenuFromTrigger}
        disabled={disabled}
        className={`h-8 gap-2 text-body hover:bg-muted/40 transition-colors ${
          compact ? 'px-2' : 'px-3'
        }`}
      >
        <ProviderLogo provider={currentModel.provider} className="h-3.5 w-3.5" />
        {!compact && (
          <>
            <span className="font-medium">{currentModel.display_name}</span>
            {currentModel.supports_vision && (
              <Zap className="h-3 w-3 text-warning" />
            )}
          </>
        )}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </Button>

      <AnimatePresence>
        {isOpen && (
          <>
            {/* 遮罩层 */}
            <div
              className="fixed inset-0 z-overlay"
              onClick={closeMenu}
            />

            {/* 下拉菜单 */}
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className={`absolute right-0 top-full mt-2 z-dropdown w-80 overflow-hidden rounded-interactive ${OVERLAY_SURFACE_CLASS}`}
            >
              <ScrollArea className="max-h-96">
                <div className="p-2">
                <div className="text-body font-medium text-muted-foreground px-3 py-2">
                  {t('model.select')}
                </div>

                {visibleModels.length === 0 ? (
                  <div className="px-3 py-4 text-body text-muted-foreground">
                    {t('model.noPlatformModels', { defaultValue: '暂无可用平台模型' })}
                  </div>
                ) : groupedModels.map((group, groupIndex) => {
                  const providerLabel = getProviderShortLabel(
                    group.provider,
                    group.providerDisplayName,
                  )
                  const sourceLabel = t(`model.source.${group.source}`, {
                    defaultValue: MODEL_SOURCE_DEFAULT_LABELS[group.source],
                  })
                  return (
                  <section
                    key={group.key}
                    className={cn(
                      'pb-1 last:pb-0',
                      groupIndex > 0 && 'mt-1 border-t border-border/60 pt-1',
                    )}
                    aria-label={`${sourceLabel} · ${providerLabel}`}
                  >
                    <div className="flex items-center gap-1.5 px-3 pb-1 pt-1.5">
                      <span className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-caption font-medium',
                        MODEL_SOURCE_BADGE_CLASSNAMES[group.source],
                      )}>
                        {sourceLabel}
                      </span>
                      <span className="truncate text-caption font-medium text-muted-foreground/70">
                        {providerLabel}
                      </span>
                    </div>

                    <div className="flex flex-col gap-0.5 px-1">
                    {group.models.map(model => (
                      <button
                        key={model.id}
                        onClick={() => handleSelect(model.id)}
                        title={model.description?.trim() || model.display_name}
                        className={`w-full text-left px-2 py-1.5 rounded-lg hover:bg-muted/40 transition-colors ${
                          currentModel.id === model.id ? 'bg-muted' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <ProviderLogo provider={model.provider} className="h-4 w-4" />
                            <span className="truncate text-body text-foreground">
                              {model.display_name}
                            </span>
                            {model.promotion_credit && (
                              <ModelPromotionCreditInline promotion={model.promotion_credit} />
                            )}
                            {model.is_default && (
                              <span className="shrink-0 px-1.5 py-0.5 text-caption font-medium rounded bg-accent/10 text-accent border border-accent/20">
                                {t('model.default')}
                              </span>
                            )}
                            {model.supports_function_calling === false && (
                              <span className="shrink-0 px-1 py-0.5 text-caption rounded border border-warning/30 text-warning" title={t('model.noTools', { defaultValue: '不支持工具调用，无法使用搜索、表格操作等功能' })}>
                                {t('model.chatOnly', { defaultValue: '纯对话' })}
                              </span>
                            )}
                          </div>

                          {currentModel.id === model.id && (
                            <Check className="h-4 w-4 text-primary flex-shrink-0" />
                          )}
                        </div>
                      </button>
                    ))}
                    </div>
                  </section>
                  )
                })}
                </div>
              </ScrollArea>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
