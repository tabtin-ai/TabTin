import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { getAllPresets } from '../composer-presets/registry/composerPresetRegistry'

export function useChatInputComposerUiState(
  spaceName: string | null | undefined,
  queueCount: number,
  onExecutionSpaceChange?: ((spaceId: string) => void) | undefined,
  enableAgentPicker = false,
) {
  const { t } = useTranslation('chat')
  const toolbarRef = useRef<HTMLDivElement>(null)
  const presetBtnRef = useRef<HTMLButtonElement>(null)
  const [toolbarWidth, setToolbarWidth] = useState(0)
  const [presetPickerOpen, setPresetPickerOpen] = useState(false)
  const [queueBarDismissed, setQueueBarDismissed] = useState(false)
  const hasAvailablePresets = false && getAllPresets().length > 0
  const showExecutionSpaceIndicator = Boolean(spaceName)
  const canSwitchExecutionSpace = Boolean(
    spaceName && onExecutionSpaceChange && enableAgentPicker,
  )
  const executionSpaceTooltip = spaceName
    ? canSwitchExecutionSpace
      ? `${t('input.executionTarget', { defaultValue: '执行于' })} · ${spaceName} — ${t('input.switchExecutionTarget', { defaultValue: '点击切换执行 Agent' })}`
      : `${t('input.executionTarget', { defaultValue: '执行于' })} · ${spaceName}`
    : ''

  const prevQueueCountRef = useRef(0)
  useEffect(() => {
    if (queueCount > 0 && prevQueueCountRef.current === 0) {
      setQueueBarDismissed(false)
    }
    prevQueueCountRef.current = queueCount
  }, [queueCount])

  useEffect(() => {
    const target = toolbarRef.current
    if (!target || typeof ResizeObserver === 'undefined') return

    const syncWidth = () => setToolbarWidth(target.getBoundingClientRect().width)
    syncWidth()

    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      setToolbarWidth(entry.contentRect.width)
    })

    observer.observe(target)
    return () => observer.disconnect()
  }, [])

  const compactModelSelector = toolbarWidth > 0 && toolbarWidth < 440

  return {
    toolbarRef,
    presetBtnRef,
    presetPickerOpen,
    setPresetPickerOpen,
    queueBarDismissed,
    setQueueBarDismissed,
    hasAvailablePresets,
    showExecutionSpaceIndicator,
    canSwitchExecutionSpace,
    executionSpaceTooltip,
    compactModelSelector,
  }
}
