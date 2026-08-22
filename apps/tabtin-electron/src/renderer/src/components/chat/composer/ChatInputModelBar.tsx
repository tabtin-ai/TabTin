import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Folder } from 'lucide-react'
import { cn } from '@utils/cn'
import { COMPOSER_TEXT_META } from '../registry/chatDesignTokens'
import { CompactModelSelector } from '../model/CompactModelSelector'
import { SpaceSwitcherPopover } from '@components/sidebar/SpaceSwitcherPopover'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import type { ChatInputChromeProps } from './chatInputTypes'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import type {
  Model,
  ModelParamOverrides,
  ModelParamValue,
  ModelRuntimeControl,
  ModelRuntimeControlOption,
} from '@tabtin/chat-client'
import { isThinkingRelatedRuntimeControl } from './thinkingModeCapability'

type ModelBarProps = Pick<
  ChatInputChromeProps,
  | 'models'
  | 'currentModel'
  | 'onModelChange'
  | 'canChangeModel'
  | 'readOnlyModelName'
  | 'currentContextTier'
  | 'currentModelParamOverrides'
  | 'disabled'
  | 'isStreaming'
  | 'isLoadingModels'
  | 'modelLoadError'
  | 'onRetryLoadModels'
  | 'compactModelSelector'
  | 'showExecutionSpaceIndicator'
  | 'canSwitchExecutionSpace'
  | 'executionSpaceTooltip'
  | 'spaceId'
  | 'spaceName'
  | 'onExecutionSpaceChange'
>

function getVisibleRuntimeControls(model: Model | null | undefined): ModelRuntimeControl[] {
  return (model?.runtime_controls ?? []).filter(control => (
    control
    && control.visibility !== 'hidden'
    && control.visibility !== 'advanced'
    && control.kind === 'select'
    // 思考强度已迁入 CompactModelSelector 右栏，底栏不再挂芯片
    && !isThinkingRelatedRuntimeControl(control)
  ))
}

function getControlOptions(control: ModelRuntimeControl): ModelRuntimeControlOption[] {
  return control.options ?? []
}

function getControlParamPath(control: ModelRuntimeControl): string {
  return control.param_path?.trim() || control.key
}

function getActiveControlValue(
  control: ModelRuntimeControl,
  overrides: ModelParamOverrides | null | undefined,
): ModelParamValue {
  const paramPath = getControlParamPath(control)
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, paramPath)) {
    return overrides[paramPath]
  }
  return control.default_value ?? null
}

function getActiveOption(
  control: ModelRuntimeControl,
  overrides: ModelParamOverrides | null | undefined,
): ModelRuntimeControlOption | null {
  const activeValue = getActiveControlValue(control, overrides)
  return getControlOptions(control).find(option => Object.is(option.value, activeValue)) ?? null
}

function ModelRuntimeControlChip({
  model,
  control,
  currentModelParamOverrides,
  disabled,
  onModelChange,
}: {
  model: Model
  control: ModelRuntimeControl
  currentModelParamOverrides?: ModelParamOverrides | null
  disabled?: boolean
  onModelChange?: ChatInputChromeProps['onModelChange']
}) {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const options = getControlOptions(control)
  const activeOption = getActiveOption(control, currentModelParamOverrides)
  const activeLabel = activeOption?.label ?? '默认'
  const controlTitle = control.description || control.label

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

  if (!options.length) return null

  return (
    <div ref={rootRef} className="relative shrink-0">
      <ChatIconTooltip
        content={controlTitle}
        side="top"
        align="center"
        sideOffset={8}
        delayDuration={250}
        className="max-w-[280px] whitespace-normal text-caption leading-relaxed"
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(prev => !prev)}
          className={cn(
            'flex h-7 items-center gap-1 rounded-md px-2 text-body transition-colors',
            'text-muted-foreground/85 hover:bg-muted/40 hover:text-foreground',
            open && 'bg-muted/60 text-foreground',
            disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
          )}
        >
          <span className="whitespace-nowrap">{control.label}</span>
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
        >
          <div className="flex flex-col p-1">
            {options.map(option => {
              const isActive = Object.is(
                getActiveControlValue(control, currentModelParamOverrides),
                option.value,
              )
              return (
                <ChatIconTooltip
                  key={`${control.key}:${String(option.value)}`}
                  content={option.description || controlTitle}
                  side="right"
                  align="center"
                  sideOffset={8}
                  delayDuration={200}
                  triggerClassName="w-full"
                  className="max-w-[280px] whitespace-normal text-caption leading-relaxed"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onModelChange?.(model.id, undefined, {
                        key: getControlParamPath(control),
                        value: option.value,
                      })
                      setOpen(false)
                    }}
                    className={cn(
                      'flex h-7 w-full items-center rounded-md px-2 text-left text-body transition-colors',
                      isActive
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <span className="whitespace-nowrap">{option.label}</span>
                  </button>
                </ChatIconTooltip>
              )
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

/**
 * Composer 底栏：工作空间 → 模型（左对齐），对齐 release/0.0.3。
 */
export function ChatInputModelBar({
  models,
  currentModel,
  onModelChange,
  canChangeModel = true,
  readOnlyModelName,
  currentContextTier,
  currentModelParamOverrides,
  disabled,
  isStreaming,
  isLoadingModels,
  modelLoadError,
  onRetryLoadModels,
  compactModelSelector,
  showExecutionSpaceIndicator,
  canSwitchExecutionSpace,
  executionSpaceTooltip,
  spaceId,
  spaceName,
  onExecutionSpaceChange,
}: ModelBarProps) {
  const [isExecutionSpacePickerOpen, setIsExecutionSpacePickerOpen] = useState(false)
  const runtimeControls = useMemo(
    () => getVisibleRuntimeControls(currentModel),
    [currentModel],
  )

  // 不用 max-w-[40%]：窄栏会把名称挤成「默…」；草稿可切 / 已有会话只读。
  const workspaceTriggerClassName = cn(
    'flex max-w-[12rem] shrink-0 items-center gap-1.5 rounded-md px-2 py-1',
    COMPOSER_TEXT_META,
    canSwitchExecutionSpace
      ? 'text-muted-foreground/80 hover:bg-muted/40 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
      : 'select-none text-muted-foreground/80',
  )

  const readOnlyWorkspaceClassName = cn(
    'flex min-w-0 max-w-[12rem] items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground/80',
    COMPOSER_TEXT_META,
  )

  return (
    <div
      data-testid="chat-input-model-bar"
      className="flex min-w-0 shrink-0 items-center gap-1.5 overflow-x-auto scrollbar-none px-1"
    >
      {showExecutionSpaceIndicator ? (
        canSwitchExecutionSpace ? (
          <ChatIconTooltip content={isExecutionSpacePickerOpen ? null : executionSpaceTooltip} side="top" align="start">
            <SpaceSwitcherPopover
              currentSpaceId={spaceId ?? null}
              side="top"
              align="start"
              onOpenChange={setIsExecutionSpacePickerOpen}
              onSelectSpace={onExecutionSpaceChange
                ? (space) => onExecutionSpaceChange(space.source_id)
                : undefined}
            >
              <button
                type="button"
                aria-label={executionSpaceTooltip}
                className={workspaceTriggerClassName}
              >
                <Folder className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">{spaceName}</span>
              </button>
            </SpaceSwitcherPopover>
          </ChatIconTooltip>
        ) : spaceName ? (
          <ChatIconTooltip content={executionSpaceTooltip} side="top" align="start">
            <div
              aria-label={executionSpaceTooltip}
              title={executionSpaceTooltip}
              className={readOnlyWorkspaceClassName}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">{spaceName}</span>
            </div>
          </ChatIconTooltip>
        ) : null
      ) : readOnlyModelName ? (
        <div className={readOnlyWorkspaceClassName} title={readOnlyModelName}>
          <span className="min-w-0 truncate">{readOnlyModelName}</span>
        </div>
      ) : null}

      {canChangeModel ? (
        <div className="shrink-0">
          <CompactModelSelector
            models={models ?? []}
            currentModel={currentModel ?? null}
            onModelChange={onModelChange || (() => {})}
            currentTier={currentContextTier}
            currentModelParamOverrides={currentModelParamOverrides ?? null}
            disabled={disabled || isStreaming}
            loading={isLoadingModels}
            error={modelLoadError}
            onRetry={onRetryLoadModels}
            compact={compactModelSelector}
          />
        </div>
      ) : null}

      {canChangeModel && currentModel && runtimeControls.map(control => (
        <ModelRuntimeControlChip
          key={control.key}
          model={currentModel}
          control={control}
          currentModelParamOverrides={currentModelParamOverrides ?? null}
          disabled={!canChangeModel || disabled || isStreaming}
          onModelChange={onModelChange}
        />
      ))}
    </div>
  )
}
