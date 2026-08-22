/**
 * CompactModelSelector - 紧凑版模型选择器
 *
 * 双栏：左搜索+列表 / 右当前模型运行设置（非 Modal）。
 */

import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, AlertCircle, Loader2, Search, Zap } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type {
  Model,
  ContextTier,
  ModelParamOverrides,
  ModelParamValue,
} from '@tabtin/chat-client'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { COMPOSER_TEXT_META } from '../registry/chatDesignTokens'
import { useTranslation } from 'react-i18next'
import { getProviderShortLabel } from '@/utils/provider-registry'
import {
  isFastEnabledForModel,
  resolveModelFastToggle,
} from '@/utils/modelFastToggle'
import { resolveFloatingMenuLayout, type FloatingMenuLayout } from '../panel/floatingMenuLayout'
import { ProviderLogo } from './ProviderLogo'
import { ModelPromotionCreditInline } from './ModelPromotionCreditInline'
import { ModelRuntimeOptionsPanel } from './ModelRuntimeOptionsPanel'
import { useCloseOnOrganizationContextReset } from '@/hooks/useCloseOnOrganizationContextReset'
import {
  groupModelsBySourceAndProvider,
  MODEL_SOURCE_BADGE_CLASSNAMES,
  MODEL_SOURCE_DEFAULT_LABELS,
  resolveModelSource,
} from './modelSourceGrouping'

const MENU_MAX_WIDTH = 640
const MENU_LEFT_WIDTH = 320
const MENU_STACK_BREAKPOINT = 520
const MENU_MIN_HEIGHT = 200
/** 左栏列表区最大高度 */
const MENU_LIST_MAX_HEIGHT = 320

interface CompactModelSelectorProps {
  models: Model[]
  currentModel: Model | null
  /**
   * 切换模型 / 档位 / 运行参数。
   * - tierId：切档或切模型带档
   * - controlChange：写 Session 模型参数（如 thinking_mode）
   * 点选模型：立即 switchModel，**不关闭**菜单。
   */
  onModelChange: (modelId: string, tierId?: string, controlChange?: { key: string; value: ModelParamValue }) => void
  currentTier?: ContextTier | null
  /** 当前会话模型参数（Fast / thinking / performance 等） */
  currentModelParamOverrides?: ModelParamOverrides | null
  /** 是否禁用 */
  disabled?: boolean
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  compact?: boolean
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

function modelMatchesQuery(model: Model, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    model.display_name.toLowerCase().includes(q)
    || model.name.toLowerCase().includes(q)
    || (model.model_name?.toLowerCase().includes(q) ?? false)
    || model.provider.toLowerCase().includes(q)
    || (model.provider_display_name?.toLowerCase().includes(q) ?? false)
  )
}

export const CompactModelSelector: React.FC<CompactModelSelectorProps> = ({
  models,
  currentModel,
  onModelChange,
  currentTier = null,
  currentModelParamOverrides = null,
  disabled = false,
  loading = false,
  error = null,
  onRetry,
  compact = false,
}) => {
  const { t } = useTranslation('chat')
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [openFilter, setOpenFilter] = useState<ModelSelectorFilter | null>(null)
  const [menuLayout, setMenuLayout] = useState<FloatingMenuLayout>({
    width: MENU_MAX_WIDTH,
    height: 360,
    left: 16,
    placement: 'up',
    bottom: 16,
  })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuContentRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handler = (event: Event) => {
      if (disabled) return
      setOpenFilter(readOpenSelectorFilter(event))
      setSearch('')
      setIsOpen(true)
    }
    window.addEventListener('chat:open-model-selector', handler)
    return () => window.removeEventListener('chat:open-model-selector', handler)
  }, [disabled])

  const openMenuFromTrigger = useCallback(() => {
    if (disabled) return
    setOpenFilter(null)
    if (!isOpen) setSearch('')
    setIsOpen(!isOpen)
  }, [disabled, isOpen])

  const closeMenu = useCallback(() => {
    setIsOpen(false)
    setOpenFilter(null)
    setSearch('')
  }, [])
  useCloseOnOrganizationContextReset(closeMenu)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current
        && !menuRef.current.contains(event.target as Node)
        && triggerRef.current
        && !triggerRef.current.contains(event.target as Node)
      ) {
        closeMenu()
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [closeMenu, isOpen])

  useEffect(() => {
    if (!isOpen) return
    const id = window.requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [isOpen])

  const visibleModels = useMemo(() => {
    const base = openFilter?.excludeByok ? models.filter(model => !isByokModel(model)) : models
    const query = search.trim()
    if (!query) return base
    return base.filter(model => modelMatchesQuery(model, query))
  }, [models, openFilter, search])

  useEffect(() => {
    if (!isOpen) return

    const updateMenuLayout = () => {
      const trigger = triggerRef.current
      const contentHeight = menuContentRef.current?.offsetHeight ?? 0
      setMenuLayout(resolveFloatingMenuLayout({
        trigger,
        maxWidth: MENU_MAX_WIDTH,
        minHeight: MENU_MIN_HEIGHT,
        contentHeight,
      }))
    }

    const rafId = window.requestAnimationFrame(updateMenuLayout)
    window.addEventListener('resize', updateMenuLayout)

    return () => {
      window.cancelAnimationFrame(rafId)
      window.removeEventListener('resize', updateMenuLayout)
    }
  }, [isOpen, visibleModels, search, currentModel, currentTier, currentModelParamOverrides])

  const groupedModels = useMemo(
    () => groupModelsBySourceAndProvider(visibleModels),
    [visibleModels],
  )

  /** 点选即切模型；菜单保持打开，右侧随 currentModel 更新。 */
  const handleSelect = (modelId: string) => {
    onModelChange(modelId)
  }

  const handleSettingsTier = useCallback((tierId: string) => {
    if (!currentModel) return
    onModelChange(currentModel.id, tierId)
  }, [currentModel, onModelChange])

  const handleSettingsThinking = useCallback((
    change: { key: string; value: ModelParamValue },
  ) => {
    if (!currentModel) return
    onModelChange(currentModel.id, undefined, change)
  }, [currentModel, onModelChange])

  const handleSettingsPerformance = useCallback((
    change: { key: string; value: ModelParamValue },
  ) => {
    if (!currentModel) return
    onModelChange(currentModel.id, undefined, change)
  }, [currentModel, onModelChange])

  /** 右栏 Fast / 思考强度：写参后不关闭下拉。 */
  const handleSettingsFast = useCallback((
    change: { key: string; value: ModelParamValue },
  ) => {
    if (!currentModel) return
    onModelChange(currentModel.id, undefined, change)
  }, [currentModel, onModelChange])

  const handleSettingsReasoningEffort = useCallback((
    change: { key: string; value: ModelParamValue },
  ) => {
    if (!currentModel) return
    onModelChange(currentModel.id, undefined, change)
  }, [currentModel, onModelChange])

  const stackColumns = menuLayout.width < MENU_STACK_BREAKPOINT

  if (loading) {
    return (
      <div
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 text-body text-muted-foreground',
          compact && 'h-7 px-1.5'
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {!compact && <span>{t('model.loadingCompact')}</span>}
      </div>
    )
  }

  if (models.length === 0) {
    return (
      <button
        onClick={onRetry}
        disabled={disabled || !onRetry}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded text-body transition-colors',
          compact && 'h-7 px-1.5',
          'text-muted-foreground hover:text-foreground hover:bg-muted/40',
          (disabled || !onRetry) && 'opacity-50 cursor-not-allowed'
        )}
        title={error ? t('model.compactLoadFailed') : t('model.compactEmpty')}
      >
        <AlertCircle className="h-3 w-3" />
        {!compact && <span>{error ? t('model.compactLoadFailed') : t('model.compactEmpty')}</span>}
      </button>
    )
  }

  if (!currentModel && models.length > 0) {
    return (
      <button
        onClick={() => onModelChange(models[0].id)}
        disabled={disabled}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded text-body transition-colors',
          compact && 'h-7 px-1.5',
          'text-muted-foreground hover:text-foreground hover:bg-muted/40',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
        title={t('model.select')}
      >
        <ProviderLogo provider={models[0].provider} className="h-3.5 w-3.5" />
        {!compact && <span>{t('model.select')}</span>}
        <ChevronDown className="h-3 w-3" />
      </button>
    )
  }

  if (!currentModel) {
    return null
  }

  const currentFastToggle = resolveModelFastToggle(currentModel)
  const currentFastActive = Boolean(
    currentFastToggle
    && isFastEnabledForModel(
      currentModelParamOverrides,
      currentModel.id,
      currentModel.id,
      currentFastToggle,
    ),
  )

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={openMenuFromTrigger}
        disabled={disabled}
        className={cn(
          'flex items-center gap-1 px-1.5 py-0.5 rounded-lg transition-colors',
          COMPOSER_TEXT_META,
          'hover:text-foreground',
          isOpen && 'text-foreground',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
        title={currentModel.display_name}
      >
        {currentFastActive && (
          <Zap
            data-testid="model-fast-trigger-icon"
            className="h-3 w-3 shrink-0 text-primary"
            fill="currentColor"
            strokeWidth={0}
            aria-hidden
          />
        )}
        <ProviderLogo provider={currentModel.provider} className="h-3 w-3" />
        <span className="font-normal max-w-[12rem] truncate">
          {currentModel.display_name}
        </span>
        <ChevronDown
          strokeWidth={2.5}
          className={cn(
            'h-2.5 w-2.5 transition-transform',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {createPortal(
        <AnimatePresence>
          {isOpen && (
            <motion.div
              ref={menuRef}
              data-testid="compact-model-selector-menu"
              initial={{ opacity: 0, y: menuLayout.placement === 'down' ? -4 : 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: menuLayout.placement === 'down' ? -4 : 4 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className={cn(
                'fixed z-dropdown flex flex-col overflow-hidden rounded-interactive',
                OVERLAY_SURFACE_CLASS,
              )}
              style={{
                top: menuLayout.top,
                bottom: menuLayout.bottom,
                left: menuLayout.left,
                width: menuLayout.width,
                height: menuLayout.height,
              }}
            >
              <div
                ref={menuContentRef}
                className={cn(
                  'flex min-h-0 flex-1',
                  stackColumns ? 'flex-col' : 'flex-row',
                )}
              >
                <div
                  className={cn(
                    'flex min-h-0 flex-col',
                    stackColumns
                      ? 'min-h-0 flex-1 border-b border-border/60'
                      : 'shrink-0 border-r border-border/60',
                  )}
                  style={stackColumns ? undefined : { width: MENU_LEFT_WIDTH }}
                >
                  <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
                    <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Escape') {
                          e.stopPropagation()
                          if (search) setSearch('')
                          else closeMenu()
                        }
                      }}
                      placeholder={t('model.searchPlaceholder', { defaultValue: 'Search models' })}
                      className="w-full bg-transparent text-body outline-none placeholder:text-muted-foreground/40"
                    />
                  </div>

                  <div
                    className="min-h-0 flex-1 overflow-y-auto py-1"
                    style={{ maxHeight: stackColumns ? MENU_LIST_MAX_HEIGHT : undefined }}
                  >
                    {visibleModels.length === 0 ? (
                      <div className="px-3 py-4 text-center text-body text-muted-foreground">
                        {search.trim()
                          ? t('model.searchEmpty', { defaultValue: '无匹配模型' })
                          : t('model.noPlatformModels', { defaultValue: '暂无可用平台模型' })}
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
                            {group.models.map(model => {
                              const isSelected = currentModel.id === model.id
                              const rowTitle = [
                                model.display_name,
                                model.description?.trim() && model.description.trim() !== model.display_name.trim()
                                  ? model.description.trim()
                                  : null,
                                model.supports_function_calling === false
                                  ? t('model.noTools', { defaultValue: '不支持工具调用，无法使用搜索、表格操作等功能' })
                                  : null,
                              ].filter(Boolean).join(' — ')

                              return (
                                <button
                                  key={model.id}
                                  type="button"
                                  onClick={() => handleSelect(model.id)}
                                  title={rowTitle}
                                  className={cn(
                                    'w-full rounded-lg px-2 py-1.5 text-left transition-colors',
                                    'hover:bg-muted/35',
                                    isSelected && 'bg-muted/80',
                                  )}
                                >
                                  <div className="flex items-center gap-2">
                                    <ProviderLogo provider={model.provider} className="h-4 w-4" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="truncate text-body text-foreground">
                                          {model.display_name}
                                        </span>
                                        {model.promotion_credit && (
                                          <ModelPromotionCreditInline promotion={model.promotion_credit} />
                                        )}
                                        {model.is_default && (
                                          <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-caption font-medium text-accent">
                                            {t('model.default')}
                                          </span>
                                        )}
                                        {model.supports_function_calling === false && (
                                          <span
                                            className="shrink-0 rounded border border-warning/30 px-1 py-0.5 text-caption text-warning"
                                            title={t('model.noTools', { defaultValue: '不支持工具调用，无法使用搜索、表格操作等功能' })}
                                          >
                                            {t('model.chatOnly', { defaultValue: '纯对话' })}
                                          </span>
                                        )}
                                      </div>
                                    </div>

                                    {isSelected && (
                                      <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                                    )}
                                  </div>
                                </button>
                              )
                            })}
                          </div>
                        </section>
                      )
                    })}
                  </div>
                </div>

                <div
                  className={cn(
                    'min-h-0 min-w-0',
                    stackColumns ? 'shrink-0' : 'flex-1',
                  )}
                >
                  <ModelRuntimeOptionsPanel
                    model={currentModel}
                    currentTier={currentTier}
                    currentModelParamOverrides={currentModelParamOverrides}
                    disabled={disabled}
                    onSelectTier={handleSettingsTier}
                    onFastChange={handleSettingsFast}
                    onReasoningEffortChange={handleSettingsReasoningEffort}
                    onThinkingModeChange={handleSettingsThinking}
                    onPerformanceProfileChange={handleSettingsPerformance}
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}
