/**
 * MemoryPanel — 对话上下文设置面板
 *
 * 决策1（记忆偏好统一到 per-(user,organization)）重构后本面板精简为「对话上下文」：
 * 只负责长对话的上下文窗口压缩（working_memory / 会话摘要）。
 * 记笔记的总开关、记录风格与「关于你」画像已搬到 TabMemo 的「记忆偏好」面板，
 * 这里不再呈现记忆数据卡 / 记忆行为开关。
 */
import React, { useCallback, useEffect, useMemo, useReducer } from 'react'
import { MessageCircle } from 'lucide-react'
import { Button, ScrollArea, Switch } from '@tabtin/smartsheet-ui'
import { useShallow } from 'zustand/react/shallow'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceExecutionAgent } from './hooks/useSpaceExecutionAgent'
import type {
  Space, Agent, MemoryConfig, SessionSummarizationStrategy,
} from '@tabtin/app-shell'
import { MEMORY_DEFAULTS_V2 } from '@tabtin/app-shell'
import { useTranslation } from 'react-i18next'
import { SETTINGS_CONTROL } from '@components/settings/settingsUi'
import { SpaceSettingsSectionHeader } from '@components/space-settings/SpaceSettingsSectionHeader'
import { cn } from '@utils/cn'

/* ================================================================
 * 类型与配置解析
 * ================================================================ */

interface ResolvedConfig {
  ssEnabled: boolean
  ssStrategy: SessionSummarizationStrategy
  ssPressureThreshold: number
  ssEmergencyKeep: number
  ssMaxTokens: number
}

const RESOLVED_CONFIG_KEYS: (keyof ResolvedConfig)[] = [
  'ssEnabled', 'ssStrategy', 'ssPressureThreshold', 'ssEmergencyKeep', 'ssMaxTokens',
]

const MD = MEMORY_DEFAULTS_V2

function resolveConfig(agent: Agent | null): ResolvedConfig {
  const mc = agent?.agent_config?.memory ?? {}
  const wm = mc.working_memory ?? {}

  return {
    ssEnabled: wm.strategy !== 'prune_only',
    ssStrategy: wm.strategy ?? MD.working_memory.strategy,
    ssPressureThreshold: wm.pressure_threshold ?? MD.working_memory.pressure_threshold,
    ssEmergencyKeep: wm.emergency_keep_messages ?? MD.working_memory.emergency_keep_messages,
    ssMaxTokens: wm.max_summary_tokens ?? MD.working_memory.max_summary_tokens,
  }
}

/* ================================================================
 * useReducer 状态管理
 * ================================================================ */

interface MemoryFormState extends ResolvedConfig {
  saveError: string
  saveSuccess: boolean
}

type MemoryFormAction =
  | { type: 'SYNC'; payload: ResolvedConfig }
  | { type: 'SET'; field: keyof ResolvedConfig; value: ResolvedConfig[keyof ResolvedConfig] }
  | { type: 'SAVE_ERROR'; error: string }
  | { type: 'SAVE_SUCCESS' }
  | { type: 'CLEAR_FEEDBACK' }

function memoryFormReducer(state: MemoryFormState, action: MemoryFormAction): MemoryFormState {
  switch (action.type) {
    case 'SYNC':
      return { ...state, ...action.payload, saveError: '', saveSuccess: false }
    case 'SET':
      return { ...state, [action.field]: action.value }
    case 'SAVE_ERROR':
      return { ...state, saveError: action.error, saveSuccess: false }
    case 'SAVE_SUCCESS':
      return { ...state, saveError: '', saveSuccess: true }
    case 'CLEAR_FEEDBACK':
      return { ...state, saveError: '', saveSuccess: false }
    default:
      return state
  }
}

function hasFormChanges(state: MemoryFormState, saved: ResolvedConfig): boolean {
  return RESOLVED_CONFIG_KEYS.some(k => state[k] !== saved[k])
}

function initFormState(config: ResolvedConfig): MemoryFormState {
  return { ...config, saveError: '', saveSuccess: false }
}

/* ================================================================
 * SectionHeader — 分区标题
 * ================================================================ */

const SectionHeader: React.FC<{
  icon: React.ReactNode
  title: string
  hint?: string
}> = ({ icon, title, hint }) => (
  <div className="mb-3">
    <div className="flex items-center gap-2">
      {icon}
      <span className="text-body font-medium text-foreground">{title}</span>
    </div>
    {hint && (
      <p className="text-caption text-muted-foreground/40 mt-1 ml-[26px]">{hint}</p>
    )}
  </div>
)

/* ================================================================
 * SessionMemorySection — 会话记忆（独立顶级分区）
 * ================================================================ */

const SessionMemorySection: React.FC<{
  state: MemoryFormState
  dispatch: React.Dispatch<MemoryFormAction>
  disabled: boolean
}> = ({ state, dispatch, disabled }) => {
  const { t } = useTranslation('space')

  const autoSummaryEnabled = state.ssEnabled && state.ssStrategy !== 'prune_only'

  const handleToggle = useCallback((v: boolean) => {
    dispatch({ type: 'SET', field: 'ssEnabled', value: true })
    dispatch({ type: 'SET', field: 'ssStrategy', value: v ? 'auto_condense' : 'prune_only' })
  }, [dispatch])

  return (
    <div>
      <SectionHeader
        icon={<MessageCircle className="h-4 w-4 text-info" />}
        title={t('memory.session.title')}
        hint={t('memory.session.hint')}
      />

      {/* 自动摘要开关 */}
      <div className="flex items-center justify-between px-3 py-2.5 rounded-md bg-muted/10">
        <div>
          <span className="text-body font-medium text-foreground">
            {t('memory.session.autoSummaryLabel')}
          </span>
          <p className="text-caption text-muted-foreground/40 mt-0.5">
            {autoSummaryEnabled
              ? t('memory.session.autoSummaryOnHint')
              : t('memory.session.autoSummaryOffHint')}
          </p>
        </div>
        <Switch
          checked={autoSummaryEnabled}
          onCheckedChange={handleToggle}
          disabled={disabled}
        />
      </div>
    </div>
  )
}

/* ================================================================
 * MemoryPanel — 主组件
 * ================================================================ */

interface MemoryPanelProps {
  /**
   * 当前 Space —— 决策1 精简后本面板不再直接读取（记忆偏好/画像已移至 TabMemo），
   * 仍保留在 props 上以匹配「Agent 设置子面板」统一调用契约（各 caller 一律传 space）。
   */
  space: Space
  canManage?: boolean
}

export const MemoryPanel: React.FC<MemoryPanelProps> = ({ space, canManage = true }) => {
  const { t } = useTranslation('space')
  const { agent, ensureAgent, isLoading: agentLoading } = useSpaceExecutionAgent(space.id)
  const { updateAgent, isLoading } = useSpaceStore(
    useShallow((state) => ({
      updateAgent: state.updateAgent,
      isLoading: state.isLoading,
    })),
  )
  const saving = isLoading || agentLoading

  const saved = useMemo(() => resolveConfig(agent), [agent])
  const [state, dispatch] = useReducer(memoryFormReducer, saved, initFormState)

  useEffect(() => {
    dispatch({ type: 'SYNC', payload: resolveConfig(agent) })
  }, [agent?.id, agent?.agent_config?.memory])

  const changes = useMemo(() => hasFormChanges(state, saved), [state, saved])

  const handleSave = useCallback(async () => {
    dispatch({ type: 'CLEAR_FEEDBACK' })
    const executionAgent = agent ?? await ensureAgent()
    if (!executionAgent) {
      dispatch({
        type: 'SAVE_ERROR',
        error: t('profileSheet.noExecutionContext', {
          defaultValue: '暂无法保存此工作空间的执行设置，请刷新后重试',
        }),
      })
      return
    }
    try {
      const mc = executionAgent.agent_config?.memory ?? {}

      const memoryConfig: MemoryConfig = {
        ...mc,
        version: 'v2.0',
        working_memory: {
          ...mc.working_memory,
          strategy: state.ssStrategy,
          pressure_threshold: state.ssPressureThreshold,
          emergency_keep_messages: state.ssEmergencyKeep,
          max_summary_tokens: state.ssMaxTokens,
        },
      }

      // 只发 memory 子树（后端 deep_merge 合并进现有 config），不再 spread 整包
      // agent.agent_config，避免把退役死数据回写触发 bleed-back
      // （Hilt W4 收尾 · 阶段2 源头收口）。
      await updateAgent(executionAgent.id, {
        agent_config: { memory: memoryConfig },
      })
      dispatch({ type: 'SAVE_SUCCESS' })
      setTimeout(() => dispatch({ type: 'CLEAR_FEEDBACK' }), 3000)
    } catch (err) {
      dispatch({ type: 'SAVE_ERROR', error: err instanceof Error ? err.message : t('errors.updateFailed') })
    }
  }, [state, agent, ensureAgent, updateAgent, t])

  const disabled = saving || !canManage

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="space-y-6 pb-2">

          <SpaceSettingsSectionHeader
            marginBottomClassName="mb-0"
            title={t('tabs.contextManagement', { defaultValue: '对话上下文' })}
            description={t('memory.contextMovedHint', {
              defaultValue: '管理长对话的上下文窗口压缩。记笔记的开关、风格与「关于你」画像已移至 TabMemo 的「记忆偏好」。',
            })}
          />

          {/* 长对话处理 (Context Management) */}
          <div>
            <SessionMemorySection state={state} dispatch={dispatch} disabled={disabled} />
          </div>

        </div>
      </ScrollArea>

      {/* ── 固定保存栏 ── */}
      <div className="shrink-0 border-t border-border/20 pt-3 mt-1">
        {state.saveError && (
          <p className="mb-2 text-caption text-destructive">{state.saveError}</p>
        )}
        {state.saveSuccess && (
          <p className="mb-2 text-caption text-success">
            {t('memory.saveSuccess')}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          {changes && (
            <span className="text-caption text-muted-foreground/60">
              {t('security.unsavedChanges', { defaultValue: '有未保存的更改' })}
            </span>
          )}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !changes || !canManage}
            className={cn(
              SETTINGS_CONTROL,
              'transition-opacity',
              !changes && 'opacity-40',
            )}
          >
            {saving ? t('actions.saving', { defaultValue: '保存中…' }) : t('actions.save', { defaultValue: '保存' })}
          </Button>
        </div>
      </div>
    </div>
  )
}
