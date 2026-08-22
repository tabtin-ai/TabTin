/**
 * VoiceSettingsPanel — 语音输入设置
 *
 * 遵守设置规范：页眉走 SettingsSectionHeader（与侧栏同源），分组一律用
 * SettingsSectionCard，开关项一律用 SettingsRow / SettingsRowGroup。
 * 词库标签输入、修正规则列表这类确有价值的自定义内容保留，但都放进标准卡片里，
 * 不再自造 Hero / 彩色状态横幅 / 自定义 section 外框。
 */

import React, { useState, useCallback, useRef, useEffect } from 'react'
import {
  Plus,
  X,
  ArrowRight,
  RotateCcw,
  Keyboard,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import { Input, Switch, toast } from '@components/ui'
import { cn } from '@utils/cn'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSectionHeader } from '../SettingsSectionHeader'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SettingsRow, SettingsRowGroup } from '../SettingsRow'
import { SETTINGS_CONTROL, SETTINGS_HINT, SETTINGS_TEXT_META, SETTINGS_TEXT_MICRO } from '../settingsUi'
import {
  useVoiceSettingsStore,
  type AddHotwordResult,
  type AddReplacementRuleResult,
  type ReplacementRule,
  formatShortcut,
  eventToShortcut,
  DEFAULT_VOICE_SHORTCUT,
} from '@/stores/useVoiceSettingsStore'

const MAX_HOTWORDS = 100
const MAX_REPLACEMENT_RULES = 50

const PLATFORM_HOTWORDS = [
  // 与 useVoiceSettingsStore.PLATFORM_HOTWORDS 保持一致（13 个）
  'TabTin', 'TabData', 'TabDoc', 'TabSlide',
  'Agentspace', 'Agent', 'Space',
  'RAG', 'Prompt', 'Skill', 'Memo', 'Composer', 'Crawler',
] as const
const PLATFORM_HOTWORD_COUNT = PLATFORM_HOTWORDS.length

export const VoiceSettingsPanel: React.FC = () => {
  const { t } = useTranslation('settings')

  const {
    enabled,
    enableAppContext,
    enableDialogContext,
    customHotwords,
    replacementRules,
    voiceShortcut,
    setEnabled,
    setEnableAppContext,
    setEnableDialogContext,
    addHotword,
    removeHotword,
    addReplacementRule,
    removeReplacementRule,
    toggleReplacementRule,
    setVoiceShortcut,
    resetVoiceShortcut,
  } = useVoiceSettingsStore(
    useShallow(s => ({
      enabled: s.enabled,
      enableAppContext: s.enableAppContext,
      enableDialogContext: s.enableDialogContext,
      customHotwords: s.customHotwords,
      replacementRules: s.replacementRules,
      voiceShortcut: s.voiceShortcut,
      setEnabled: s.setEnabled,
      setEnableAppContext: s.setEnableAppContext,
      setEnableDialogContext: s.setEnableDialogContext,
      addHotword: s.addHotword,
      removeHotword: s.removeHotword,
      addReplacementRule: s.addReplacementRule,
      removeReplacementRule: s.removeReplacementRule,
      toggleReplacementRule: s.toggleReplacementRule,
      setVoiceShortcut: s.setVoiceShortcut,
      resetVoiceShortcut: s.resetVoiceShortcut,
    })),
  )

  return (
    <SettingsPanelLayout>
      <SettingsSectionHeader section="voice" subtitle={t('voice.description')} />

      {/* ── 语音输入总控 ── */}
      <SettingsSectionCard>
        <SettingsRowGroup>
          <SettingsRow
            label={t('voice.enableLabel', { defaultValue: '启用语音输入' })}
            description={t('voice.enableDesc', {
              defaultValue: '开启后聊天框显示麦克风按钮，可用快捷键说话',
            })}
            control={(
              <Switch
                checked={enabled}
                onCheckedChange={setEnabled}
                aria-label={t('voice.enableLabel', { defaultValue: '启用语音输入' })}
              />
            )}
          />
          <SettingsRow
            label={t('voice.shortcutLabel')}
            description={t('voice.usageRules')}
            disabled={!enabled}
            control={(
              <div className="flex items-center gap-2">
                <ShortcutRecorder value={voiceShortcut} onChange={setVoiceShortcut} />
                {voiceShortcut !== DEFAULT_VOICE_SHORTCUT && (
                  <button
                    type="button"
                    onClick={resetVoiceShortcut}
                    className="flex items-center gap-1 text-muted-foreground/60 transition-colors hover:text-foreground"
                    title={t('voice.shortcutReset')}
                    aria-label={t('voice.shortcutReset')}
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}
          />
        </SettingsRowGroup>
      </SettingsSectionCard>

      {/* ── 资源区（总开关关闭时整体灰掉但仍可见） ── */}
      <div
        aria-hidden={!enabled}
        className={cn(
          'space-y-4 transition-opacity',
          !enabled && 'pointer-events-none select-none opacity-40',
        )}
      >
        <VocabSection
          customHotwords={customHotwords}
          onAdd={addHotword}
          onRemove={removeHotword}
        />

        <RealtimeContextSection
          enableAppContext={enableAppContext}
          onToggleAppContext={setEnableAppContext}
          enableDialogContext={enableDialogContext}
          onToggleDialogContext={setEnableDialogContext}
        />

        <RulesSection
          rules={replacementRules}
          onAdd={addReplacementRule}
          onRemove={removeReplacementRule}
          onToggle={toggleReplacementRule}
        />
      </div>
    </SettingsPanelLayout>
  )
}

/* ════════════════════════════════════════════════════
   VocabSection — 我的词库（资源型，标准卡片内的标签输入）
   ════════════════════════════════════════════════════ */

const VocabSection: React.FC<{
  customHotwords: string[]
  onAdd: (word: string) => AddHotwordResult
  onRemove: (index: number) => void
}> = ({ customHotwords, onAdd, onRemove }) => {
  const { t } = useTranslation('settings')
  const [input, setInput] = useState('')
  const [showPlatform, setShowPlatform] = useState(false)
  const full = customHotwords.length >= MAX_HOTWORDS

  const handleAdd = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed) return
    const result = onAdd(trimmed)
    if (result === 'duplicate') {
      toast.error(t('voice.vocabDuplicate', { word: trimmed }))
      return
    }
    if (result === 'full') {
      toast.error(t('voice.vocabFull', { max: MAX_HOTWORDS }))
      return
    }
    if (result === 'added') {
      setInput('')
    }
  }, [input, onAdd, t])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleAdd()
    }
  }, [handleAdd])

  return (
    <SettingsSectionCard
      title={t('voice.vocabSection')}
      subtitle={t('voice.vocabHint')}
      actions={(
        <span className={cn(SETTINGS_TEXT_MICRO, 'tabular-nums', 'text-muted-foreground/60')}>
          {customHotwords.length} / {MAX_HOTWORDS}
        </span>
      )}
    >
      <div className="mb-3 flex gap-2">
        <div className="min-w-0 flex-1">
          <Input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={full ? t('voice.vocabFull', { max: MAX_HOTWORDS }) : t('voice.vocabPlaceholder')}
            disabled={full}
            maxLength={50}
            className={SETTINGS_CONTROL}
          />
        </div>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!input.trim() || full}
          className={cn(
            'h-8 rounded-interactive px-3 text-body font-medium transition-colors',
            'bg-accent/10 text-accent hover:bg-accent/20',
            'disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {customHotwords.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {customHotwords.map((word, idx) => (
            <span
              key={`${word}-${idx}`}
              className="inline-flex items-center gap-1 rounded-interactive bg-muted/25 px-2 py-1 text-body text-foreground"
            >
              {word}
              <button
                type="button"
                onClick={() => onRemove(idx)}
                className="text-muted-foreground/60 transition-colors hover:text-destructive"
                aria-label={t('voice.vocabRemove', { word })}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className={cn(SETTINGS_HINT, 'mb-3')}>{t('voice.vocabEmpty')}</p>
      )}

      <button
        type="button"
        onClick={() => setShowPlatform(v => !v)}
        className={cn(SETTINGS_HINT, 'flex items-center gap-1.5 transition-colors hover:text-foreground')}
      >
        {showPlatform ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>{t('voice.vocabPlatformToggle', { count: PLATFORM_HOTWORD_COUNT })}</span>
      </button>

      {showPlatform && (
        <div className="mt-2.5 border-l-2 border-border/30 pl-4">
          <div className="flex flex-wrap gap-1.5">
            {PLATFORM_HOTWORDS.map(word => (
              <span
                key={word}
                className={cn(SETTINGS_TEXT_META, 'inline-flex items-center rounded-interactive bg-muted/15 px-2 py-0.5')}
              >
                {word}
              </span>
            ))}
          </div>
          <p className={cn(SETTINGS_HINT, 'mt-2')}>{t('voice.vocabPlatformFooter')}</p>
        </div>
      )}
    </SettingsSectionCard>
  )
}

/* ════════════════════════════════════════════════════
   RealtimeContextSection — 实时上下文（标准开关行）
   ════════════════════════════════════════════════════ */

const RealtimeContextSection: React.FC<{
  enableAppContext: boolean
  onToggleAppContext: (v: boolean) => void
  enableDialogContext: boolean
  onToggleDialogContext: (v: boolean) => void
}> = ({
  enableAppContext,
  onToggleAppContext,
  enableDialogContext,
  onToggleDialogContext,
}) => {
  const { t } = useTranslation('settings')

  return (
    <SettingsSectionCard
      title={t('voice.contextSection')}
      subtitle={(
        <>
          <p>{t('voice.contextHint')}</p>
          <p className="mt-1.5">
            {t('voice.contextAppTitle')}
            {'：'}
            {t('voice.contextAppOn')}
          </p>
          <p className="mt-1.5">
            {t('voice.contextDialogTitle')}
            {'：'}
            {t('voice.contextDialogOn')}
          </p>
        </>
      )}
      subtitleAsTooltip
    >
      <SettingsRowGroup>
        <SettingsRow
          label={t('voice.contextAppTitle')}
          control={(
            <Switch
              checked={enableAppContext}
              onCheckedChange={onToggleAppContext}
              aria-label={t('voice.contextAppTitle')}
            />
          )}
        />
        <SettingsRow
          label={t('voice.contextDialogTitle')}
          control={(
            <Switch
              checked={enableDialogContext}
              onCheckedChange={onToggleDialogContext}
              aria-label={t('voice.contextDialogTitle')}
            />
          )}
        />
      </SettingsRowGroup>
    </SettingsSectionCard>
  )
}

/* ════════════════════════════════════════════════════
   RulesSection — 修正规则（标准卡片内的键值列表）
   ════════════════════════════════════════════════════ */

const RulesSection: React.FC<{
  rules: ReplacementRule[]
  onAdd: (from: string, to: string) => AddReplacementRuleResult
  onRemove: (id: string) => void
  onToggle: (id: string) => void
}> = ({ rules, onAdd, onRemove, onToggle }) => {
  const { t } = useTranslation('settings')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const full = rules.length >= MAX_REPLACEMENT_RULES

  const handleAdd = useCallback(() => {
    const f = from.trim()
    const tVal = to.trim()
    if (!f) return
    if (f === tVal) {
      toast.error(t('voice.rulesSame'))
      return
    }
    const result = onAdd(f, tVal)
    if (result === 'same') {
      toast.error(t('voice.rulesSame'))
      return
    }
    if (result === 'duplicate') {
      toast.error(t('voice.rulesDuplicate', { from: f }))
      return
    }
    if (result === 'full') {
      toast.error(t('voice.rulesFull', { max: MAX_REPLACEMENT_RULES }))
      return
    }
    if (result === 'added') {
      setFrom('')
      setTo('')
    }
  }, [from, to, onAdd, t])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleAdd()
    }
  }, [handleAdd])

  return (
    <SettingsSectionCard
      title={t('voice.rulesSection')}
      subtitle={t('voice.rulesHint')}
      actions={(
        <span className={cn(SETTINGS_TEXT_MICRO, 'tabular-nums', 'text-muted-foreground/60')}>
          {rules.length} / {MAX_REPLACEMENT_RULES}
        </span>
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            type="text"
            value={from}
            onChange={e => setFrom(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={full ? t('voice.rulesFull', { max: MAX_REPLACEMENT_RULES }) : t('voice.rulesFromPlaceholder')}
            disabled={full}
            maxLength={100}
            className={SETTINGS_CONTROL}
          />
        </div>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
        <div className="min-w-0 flex-1">
          <Input
            type="text"
            value={to}
            onChange={e => setTo(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('voice.rulesToPlaceholder')}
            disabled={full}
            maxLength={100}
            className={SETTINGS_CONTROL}
          />
        </div>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!from.trim() || full || (!!to.trim() && from.trim() === to.trim())}
          className={cn(
            'h-8 rounded-interactive px-3 text-body font-medium transition-colors',
            'bg-accent/10 text-accent hover:bg-accent/20',
            'disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {rules.length > 0 ? (
        <div className="divide-y divide-border/20 overflow-hidden rounded-interactive bg-background/40">
          {rules.map(rule => (
            <RuleRow
              key={rule.id}
              rule={rule}
              onToggle={() => onToggle(rule.id)}
              onRemove={() => onRemove(rule.id)}
            />
          ))}
        </div>
      ) : (
        <p className={SETTINGS_HINT}>{t('voice.rulesEmpty')}</p>
      )}
    </SettingsSectionCard>
  )
}

const RuleRow: React.FC<{
  rule: ReplacementRule
  onToggle: () => void
  onRemove: () => void
}> = ({ rule, onToggle, onRemove }) => {
  const { t } = useTranslation('settings')
  const isPaused = !rule.isEnabled

  return (
    <div
      className={cn(
        'group flex items-center gap-3 px-3 py-2 transition-colors',
        'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
        isPaused && 'bg-muted/5',
      )}
    >
      <Switch
        checked={rule.isEnabled}
        onCheckedChange={onToggle}
        aria-label={t('voice.rulesRemove', { from: rule.from })}
      />
      <div className={cn('flex min-w-0 flex-1 items-center gap-2', isPaused && 'opacity-50')}>
        <span className="truncate text-body font-medium text-foreground">{rule.from}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
        <span className="truncate text-body text-muted-foreground">
          {rule.to || t('voice.rulesToEmpty')}
        </span>
      </div>
      {isPaused && (
        <span className={cn(SETTINGS_HINT, 'shrink-0')}>
          {t('voice.rulesPaused')}
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 text-muted-foreground/40 transition-colors hover:text-destructive"
        aria-label={t('voice.rulesRemove', { from: rule.from })}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/* ════════════════════════════════════════════════════
   ShortcutRecorder — 快捷键录制（行内控件）
   ════════════════════════════════════════════════════ */

const ShortcutRecorder: React.FC<{
  value: string
  onChange: (shortcut: string) => void
}> = ({ value, onChange }) => {
  const { t } = useTranslation('settings')
  const [recording, setRecording] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!recording) return

    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        setRecording(false)
        return
      }

      const shortcut = eventToShortcut(e)
      if (shortcut) {
        onChange(shortcut)
        setRecording(false)
      }
    }

    const handleBlur = () => setRecording(false)

    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 快捷键录制需在录制期间捕获全局按键，与 Space 活跃态无关。
    window.addEventListener('keydown', handleKeyDown, true)
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 录制期间窗口失焦即结束，属于录制交互本身。
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('blur', handleBlur)
    }
  }, [recording, onChange])

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => setRecording(prev => !prev)}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-interactive border px-2 transition-all', SETTINGS_TEXT_MICRO,
        recording
          ? 'animate-pulse border-accent bg-accent/5 text-accent ring-1 ring-accent/30'
          : 'border-border/40 bg-background text-foreground hover:bg-muted/15',
      )}
    >
      <Keyboard className="h-3 w-3" />
      <span className="font-mono">
        {recording ? t('voice.shortcutRecording') : formatShortcut(value)}
      </span>
    </button>
  )
}
