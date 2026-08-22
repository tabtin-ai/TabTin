/**
 * ComposerPresetCard — Preset 卡片容器
 *
 * 纯壳组件：提供 header（标签 + 折叠/移除）+ 内容区。
 * 内容渲染完全由注册的 renderer 或 SchemaFormRenderer 决定。
 */

import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown, X } from 'lucide-react'
import type { PresetInstance } from './registry/types'
import { createAttachment, revokeAttachmentPreview } from '../types'
import { getComposerPreset } from './registry/composerPresetRegistry'
import { getComposerRenderer } from './registry/composerRenderers'
import { SchemaFormRenderer } from './SchemaFormRenderer'
import { PromptTemplateRenderer } from './PromptTemplateRenderer'
import { useComposerPresetStore } from '@/stores/useComposerPresetStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { cn } from '@utils/cn'
import {
  COMPOSER_TEXT_META_BASE,
  TEXT,
  TEXT_COLOR,
  BORDER,
  BG,
  CARD_RADIUS,
  ANIMATION,
} from '../registry/chatDesignTokens'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

const EMPTY_PRESETS: never[] = []

interface ComposerPresetCardProps {
  sessionId: string
  instance: PresetInstance
  disabled?: boolean
}

export const ComposerPresetCard: React.FC<ComposerPresetCardProps> = ({
  sessionId,
  instance,
  disabled,
}) => {
  const descriptor = getComposerPreset(instance.presetId)
  const updatePresetState = useComposerPresetStore(s => s.updatePresetState)
  const setFieldError = useComposerPresetStore(s => s.setFieldError)
  const toggleAddon = useComposerPresetStore(s => s.toggleAddon)
  const toggleCollapsed = useComposerPresetStore(s => s.toggleCollapsed)
  const removePreset = useComposerPresetStore(s => s.removePreset)
  const addSlotAttachment = useComposerPresetStore(s => s.addSlotAttachment)
  const removeSlotAttachment = useComposerPresetStore(s => s.removeSlotAttachment)

  const slotAttachments = instance.slotAttachments

  const handleStateChange = useCallback(
    (patch: Record<string, unknown>) => {
      updatePresetState(sessionId, instance.instanceId, patch)
    },
    [sessionId, instance.instanceId, updatePresetState],
  )

  const handleFieldError = useCallback(
    (fieldKey: string, error: string | null) => {
      setFieldError(sessionId, instance.instanceId, fieldKey, error)
    },
    [sessionId, instance.instanceId, setFieldError],
  )

  const handleToggleAddon = useCallback(
    (addonKey: string) => {
      toggleAddon(sessionId, instance.instanceId, addonKey)
    },
    [sessionId, instance.instanceId, toggleAddon],
  )

  const handleAddSlotAttachment = useCallback(
    (slotKey: string, file: File) => {
      const attachment = createAttachment(file)
      addSlotAttachment(sessionId, instance.instanceId, slotKey, attachment)
    },
    [sessionId, instance.instanceId, addSlotAttachment],
  )

  const handleRemoveSlotAttachment = useCallback(
    (slotKey: string, attachmentId: string) => {
      const atts = slotAttachments[slotKey] ?? []
      const target = atts.find(a => a.id === attachmentId)
      if (target) revokeAttachmentPreview(target)
      removeSlotAttachment(sessionId, instance.instanceId, slotKey, attachmentId)
    },
    [sessionId, instance.instanceId, slotAttachments, removeSlotAttachment],
  )

  const { t } = useTranslation()
  const { t: tPreset } = useTranslation('composerPreset')
  const { t: tContext } = useTranslation('context')

  if (!descriptor) {
    return (
      <div className={`${CARD_RADIUS} ${BORDER.error} border p-2 ${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.error}`}>
        Unknown preset: {instance.presetId}
      </div>
    )
  }

  const CustomRenderer = descriptor.renderer
    ? getComposerRenderer(descriptor.renderer)
    : null

  const summaryText = descriptor.labelKey.includes('.') ? t(descriptor.labelKey) : descriptor.labelKey
  const isReadOnly = descriptor.readOnly === true

  return (
    <div
      className={`${CARD_RADIUS} ${BORDER.default} ${BG.card} ${ANIMATION.collapse} overflow-hidden border`}
    >
      {/* Header */}
      <div
        className={`${BG.header} flex items-center justify-between px-2.5 py-1.5`}
      >
        <div className="flex items-center gap-1.5">
          {descriptor.icon && (
            <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted}`}>{descriptor.icon}</span>
          )}
          <span className={`${TEXT.label} ${TEXT_COLOR.primary}`}>{summaryText}</span>
        </div>
        <div className="flex items-center gap-1">
          {!isReadOnly && (
            <ChatIconTooltip content={instance.collapsed ? tPreset('card.expand') : tPreset('card.collapse')}>
              <button
                type="button"
                className={`${COMPOSER_TEXT_META_BASE} text-muted-foreground/60 hover:text-foreground/80 px-1 transition-colors`}
                onClick={() => toggleCollapsed(sessionId, instance.instanceId)}
                aria-label={instance.collapsed ? tPreset('card.expand') : tPreset('card.collapse')}
              >
                {instance.collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
            </ChatIconTooltip>
          )}
          <ChatIconTooltip content={isReadOnly ? tContext('skills.quickUse.cancelAction', '取消使用') : tPreset('card.remove')}>
            <button
              type="button"
              className={cn(
                `${COMPOSER_TEXT_META_BASE} text-muted-foreground/60 transition-colors`,
                isReadOnly
                  ? 'rounded-full px-2 py-0.5 hover:bg-muted/30 hover:text-foreground/80'
                  : 'px-1 hover:text-destructive',
              )}
              onClick={() => {
                removePreset(sessionId, instance.instanceId)
                // Phase 1 Review #6 修复：sessionId 是 draft scope 时清完 preset
                // 应该回退 draft session 状态——否则 chat 侧栏会停在一个空 draft，
                // session 列表里也看不见，用户体感"什么都没发生但页面变了"。
                const DRAFT_PREFIX = '__draft__:'
                if (sessionId.startsWith(DRAFT_PREFIX)) {
                  const remaining = useComposerPresetStore.getState().getPresets(sessionId)
                  if (remaining.length === 0) {
                    const spaceId = sessionId.slice(DRAFT_PREFIX.length)
                    useChatStore.getState().clearDraftSessionForSpace(spaceId)
                  }
                }
              }}
              aria-label={isReadOnly ? tContext('skills.quickUse.cancelAction', '取消使用') : tPreset('card.remove')}
            >
              {isReadOnly ? tContext('skills.quickUse.cancelAction', '取消使用') : <X className="h-3 w-3" />}
            </button>
          </ChatIconTooltip>
        </div>
      </div>

      {/* Content — grid-rows 过渡实现展开/折叠高度动画 */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          instance.collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="max-h-[360px] overflow-y-auto px-2.5 py-2">
            {CustomRenderer ? (
              <CustomRenderer
                preset={descriptor}
                state={instance.state}
                onChange={handleStateChange}
                disabled={disabled}
                triggerContext={instance.triggerContext}
                addSlotAttachment={handleAddSlotAttachment}
                removeSlotAttachment={handleRemoveSlotAttachment}
                slotAttachments={slotAttachments}
              />
            ) : (descriptor.promptTemplate || descriptor.fields) ? (
              <div className="flex flex-col gap-2.5">
                {descriptor.promptTemplate && descriptor.variables && (
                  <PromptTemplateRenderer
                    template={descriptor.promptTemplate}
                    variables={descriptor.variables}
                    state={instance.state}
                    onChange={handleStateChange}
                    disabled={disabled}
                    slotAttachments={slotAttachments}
                    onAddSlotAttachment={handleAddSlotAttachment}
                    onRemoveSlotAttachment={handleRemoveSlotAttachment}
                  />
                )}
                {descriptor.fields && (
                  <SchemaFormRenderer
                    fields={descriptor.fields}
                    addons={descriptor.addons}
                    state={instance.state}
                    activeAddonKeys={instance.activeAddonKeys}
                    errors={instance.errors}
                    onStateChange={handleStateChange}
                    onToggleAddon={handleToggleAddon}
                    onFieldError={handleFieldError}
                    disabled={disabled}
                    slotAttachments={slotAttachments}
                    onAddSlotAttachment={handleAddSlotAttachment}
                    onRemoveSlotAttachment={handleRemoveSlotAttachment}
                  />
                )}
              </div>
            ) : (
              <div className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted}`}>
                No fields or renderer defined
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * ComposerPresetCardList — 渲染当前会话的所有 Preset 卡片
 * 嵌入 ChatInput 的 ContextChipList 上方
 */
export const ComposerPresetCardList: React.FC<{
  sessionId: string
  disabled?: boolean
  hidden?: boolean
}> = ({ sessionId, disabled, hidden }) => {
  const presets = useComposerPresetStore(s => s.presetsBySessionId[sessionId] ?? EMPTY_PRESETS)

  if (presets.length === 0 || hidden) return null

  return (
    <div className="flex flex-col gap-2 px-1 pb-1">
      {presets.map(instance => (
        <ComposerPresetCard
          key={instance.instanceId}
          sessionId={sessionId}
          instance={instance}
          disabled={disabled}
        />
      ))}
    </div>
  )
}
