/**
 * AgentWorkbenchDetail — AI 分身域主画布详情：
 * 总览（12 列 grid：上下行 span 错开）或画布内整页 drill-in。
 */

import React, { useCallback, useEffect, useState } from 'react'
import {
  Ban,
  Brain,
  Check,
  ImagePlus,
  ListTodo,
  Loader2,
  MoreHorizontal,
  PenLine,
  Plug,
  RotateCcw,
  ScrollText,
  Sparkles,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  toast,
} from '@components/ui'
import { useSpaceStore } from '@stores/useSpaceStore'
import { resolveAgentSourceBadge } from '@utils/agentSourceBadge'
import { AgentSkillsPanel } from '@components/space-settings/AgentSkillsPanel'
import { AgentToolsPanel } from '@components/space-settings/AgentToolsPanel'
import { AgentMemoryGovernancePanel } from '@components/settings/panels/AgentMemoryGovernancePanel'
import {
  AgentListIdentityAvatar,
} from '@components/settings/panels/MyAgentsPanel'
import { personaFirstLinePreview } from '@components/chat/model/AgentModeSelector'
import type { OrganizationAgentSummary } from '@/services/organizationAgentsApi'
import { AGENT_NAME_OWNER_TOKEN } from '@utils/agentNameInterpolation'
import { extractAgentCustomAvatarUrl } from '@/utils/resolveAgentAvatar'
import {
  AGENT_AVATAR_PRESET_KEYS,
  DEFAULT_AGENT_AVATAR_PRESET_KEY,
  resolveAgentAvatarPresetUrl,
} from '@/constants/agentAvatarPresets'
import { SETTINGS_TEXT_META_BASE, SETTINGS_TEXT_MICRO, SETTINGS_TEXTAREA } from '@components/settings/settingsUi'
import { CANVAS_TEXT_META, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { createLogger } from '@/utils/logger'
import {
  AgentWorkbenchExpandCard,
  AgentWorkbenchPane,
} from './AgentWorkbenchExpandCard'
import { AgentRecentActivitiesPanel } from './AgentRecentActivitiesPanel'

const log = createLogger('AgentWorkbench')

/** 与标题同字号（设计系统：图标跟文字用 1em） */
const CARD_TITLE_ICON = 'h-[1em] w-[1em]'

/** 画布内整页 drill-in；null = 工作台总览 */
type WorkbenchPanel = 'rules' | 'skills' | 'tools' | null

/** rules / skills / tools 共用外壳，避免多份 early-return 重复 close 与布局 */
const WorkbenchDrillInShell: React.FC<{
  panel: Exclude<WorkbenchPanel, null>
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  onClose: () => void
  closeLabel: string
  bodyClassName?: string
  children: React.ReactNode
}> = ({
  panel,
  title,
  subtitle,
  actions,
  onClose,
  closeLabel,
  bodyClassName,
  children,
}) => (
  <div
    className="flex h-full min-h-0 w-full flex-col gap-4"
    data-testid="agent-workbench-detail"
    data-panel={panel}
  >
    <div className="flex shrink-0 items-start justify-between gap-3">
      <div className="min-w-0">
        {title}
        {subtitle}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-interactive text-muted-foreground/80 hover:bg-muted/30 hover:text-foreground"
          aria-label={closeLabel}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
    <div
      className={cn(
        'min-h-0 flex-1 rounded-[12px] border border-border/40 bg-muted/10 px-4 py-4',
        bodyClassName,
      )}
    >
      {children}
    </div>
  </div>
)

export interface AgentWorkbenchDetailProps {
  organizationId: string
  agent: OrganizationAgentSummary
  templateName?: string
  skillContextSpaceId: string | null
  updateAgent: (
    agentId: string,
    updates: { name?: string; custom_rules?: string; avatar_key?: string },
  ) => Promise<boolean>
  deleteAgent: (agentId: string) => Promise<boolean>
  onUpdated: () => void
  onDeactivated: () => void
  rulesDraft: string | null
  onRulesDraftChange: (draft: string | null) => void
  focusMemoryId?: string | null
}

export const AgentWorkbenchDetail: React.FC<AgentWorkbenchDetailProps> = ({
  organizationId,
  agent,
  templateName,
  skillContextSpaceId,
  updateAgent,
  deleteAgent,
  onUpdated,
  onDeactivated,
  rulesDraft,
  onRulesDraftChange,
  focusMemoryId,
}) => {
  const { t } = useTranslation('settings')
  const fullAgent = useSpaceStore(s => s.agentCache[agent.id] ?? null)
  const loadAgent = useSpaceStore(s => s.loadAgent)

  const [activePanel, setActivePanel] = useState<WorkbenchPanel>(null)
  const [editingName, setEditingName] = useState(false)
  /** 已提交展示名：保存成功后立刻本地更新，避免等 loadAgents 回写前只读态闪旧名 */
  const [displayName, setDisplayName] = useState(agent.name)
  const [nameValue, setNameValue] = useState(agent.name)
  const [nameError, setNameError] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [savingRules, setSavingRules] = useState(false)
  const [detailLoading, setDetailLoading] = useState(!fullAgent)
  const [detailLoadError, setDetailLoadError] = useState(false)
  const [deactivateConfirmOpen, setDeactivateConfirmOpen] = useState(false)
  const [deactivating, setDeactivating] = useState(false)
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false)
  const [savingAvatar, setSavingAvatar] = useState(false)
  const [localAvatarKey, setLocalAvatarKey] = useState<string | null>(
    () => agent.settings?.avatar_key?.trim() || null,
  )
  const [avatarDraftKey, setAvatarDraftKey] = useState<string | null>(
    () => agent.settings?.avatar_key?.trim() || DEFAULT_AGENT_AVATAR_PRESET_KEY,
  )
  const [localAvatarUrl, setLocalAvatarUrl] = useState<string | null>(
    () => extractAgentCustomAvatarUrl(agent.settings),
  )
  const isDefaultAgent = Boolean(agent.is_default)

  const loadAgentDetail = useCallback(async () => {
    const cached = useSpaceStore.getState().agentCache[agent.id]
    if (cached && typeof cached.custom_rules === 'string') {
      setDetailLoading(false)
      setDetailLoadError(false)
      return
    }
    setDetailLoading(true)
    setDetailLoadError(false)
    try {
      const loaded = await loadAgent(agent.id, { force: true })
      setDetailLoadError(!loaded)
      if (!loaded) {
        log.warn('Agent 详情加载失败', { agentId: agent.id })
      }
    } catch (error) {
      log.error('Agent 详情加载异常', { agentId: agent.id }, error)
      setDetailLoadError(true)
    } finally {
      setDetailLoading(false)
    }
  }, [agent.id, loadAgent])

  useEffect(() => {
    void loadAgentDetail()
  }, [loadAgentDetail])

  useEffect(() => {
    setDisplayName(agent.name)
    setNameValue(agent.name)
    setEditingName(false)
    setActivePanel(null)
    const nextAvatarKey = agent.settings?.avatar_key?.trim() || null
    setLocalAvatarKey(nextAvatarKey)
    setAvatarDraftKey(nextAvatarKey || DEFAULT_AGENT_AVATAR_PRESET_KEY)
    setLocalAvatarUrl(extractAgentCustomAvatarUrl(agent.settings))
  }, [agent.id, agent.name, agent.settings])

  const identityAgent: OrganizationAgentSummary = {
    ...agent,
    name: displayName,
    settings: {
      ...agent.settings,
      avatar_key: localAvatarKey,
      avatar_url: localAvatarUrl,
    },
  }
  const savedRules = fullAgent?.custom_rules ?? ''
  const effectiveRules = rulesDraft ?? savedRules
  const rulesDirty = rulesDraft !== null && rulesDraft !== savedRules
  const rulesPreview = personaFirstLinePreview(effectiveRules, 72)
    ?? t('myAgents.workbench.rulesEmptyPreview', { defaultValue: '还没设定人设 — 点击打开编辑' })

  const beginRename = () => {
    setNameValue(displayName)
    setNameError('')
    setEditingName(true)
  }

  const cancelRename = () => {
    setEditingName(false)
    setNameValue(displayName)
    setNameError('')
  }

  const handleSaveName = async () => {
    const trimmed = nameValue.trim()
    if (!trimmed) {
      setNameError(t('myAgents.nameEmptyError', { defaultValue: '名字不能为空' }))
      return
    }
    if (trimmed === displayName) {
      setEditingName(false)
      setNameError('')
      return
    }
    setSavingName(true)
    setNameError('')
    try {
      const ok = await updateAgent(agent.id, { name: trimmed })
      if (!ok) {
        const storeError = useSpaceStore.getState().error ?? ''
        setNameError(
          storeError.includes(AGENT_NAME_OWNER_TOKEN) || storeError.includes('AGENT_NAME_RESERVED_TOKEN')
            ? t('myAgents.nameReservedTokenError', {
                defaultValue: '名字不能包含保留占位符 {{token}}',
                token: AGENT_NAME_OWNER_TOKEN,
                interpolation: { escapeValue: false },
              })
            : (storeError || t('myAgents.renameFailed', { defaultValue: '改名失败，请重试' })),
        )
        return
      }
      toast({ title: t('myAgents.renameSuccess', { defaultValue: '名字已更新' }) })
      setDisplayName(trimmed)
      setNameValue(trimmed)
      setEditingName(false)
      onUpdated()
    } finally {
      setSavingName(false)
    }
  }

  const handleSaveRules = async () => {
    if (!rulesDirty) return
    setSavingRules(true)
    try {
      const ok = await updateAgent(agent.id, { custom_rules: effectiveRules.trim() })
      if (!ok) {
        toast({
          title: t('myAgents.rulesSaveFailed', { defaultValue: '人设保存失败，请重试' }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('myAgents.rulesSaveSuccess', { defaultValue: '人设已保存' }) })
      onRulesDraftChange(null)
      onUpdated()
    } finally {
      setSavingRules(false)
    }
  }

  const handleDeactivate = async () => {
    setDeactivating(true)
    try {
      const ok = await deleteAgent(agent.id)
      if (!ok) {
        const storeError = useSpaceStore.getState().error
        toast({
          title: storeError || t('myAgents.deactivateFailed', { defaultValue: '停用失败，请重试' }),
          variant: 'destructive',
        })
        return
      }
      setDeactivateConfirmOpen(false)
      toast({
        title: t('myAgents.deactivateSuccess', { name: agent.name, defaultValue: `「${agent.name}」已停用` }),
      })
      onDeactivated()
    } finally {
      setDeactivating(false)
    }
  }

  const beginEditAvatar = () => {
    setAvatarDraftKey(localAvatarKey || DEFAULT_AGENT_AVATAR_PRESET_KEY)
    setAvatarEditorOpen(true)
  }

  const handleAvatarSave = async () => {
    if (!avatarDraftKey) return
    setSavingAvatar(true)
    try {
      const ok = await updateAgent(agent.id, { avatar_key: avatarDraftKey })
      if (!ok) {
        toast({
          title: t('myAgents.avatarSaveFailed', { defaultValue: '头像保存失败，请重试' }),
          variant: 'destructive',
        })
        return
      }
      setLocalAvatarKey(avatarDraftKey)
      setLocalAvatarUrl(null)
      setAvatarEditorOpen(false)
      toast({ title: t('myAgents.avatarSaveSuccess', { defaultValue: '头像已更新' }) })
      onUpdated()
    } finally {
      setSavingAvatar(false)
    }
  }

  const sourceLabel = resolveAgentSourceBadge(
    agent,
    {
      defaultBadge: t('myAgents.defaultBadge', { defaultValue: '默认' }),
      customBadge: t('myAgents.customBadge', { defaultValue: '自建' }),
      templateBadgeFallback: t('myAgents.templateBadgeFallback', { defaultValue: '模板' }),
    },
    templateName,
    'detail',
    agent.name,
  )

  const rulesEditor = detailLoading && !fullAgent && rulesDraft === null ? (
    <div className="flex items-center gap-2 rounded-interactive bg-muted/30 px-3 py-6 text-body text-foreground-secondary">
      <Loader2 className="h-4 w-4 animate-spin" />
      {t('myAgents.detailLoading', { defaultValue: '正在加载人设…' })}
    </div>
  ) : detailLoadError && !fullAgent && rulesDraft === null ? (
    <div className="flex items-center justify-between gap-3 rounded-interactive bg-muted/30 px-3 py-3">
      <p className="text-body text-foreground-secondary">
        {t('myAgents.detailLoadFailed', { defaultValue: '人设加载失败，请重试。' })}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={() => { void loadAgentDetail() }}>
        <RotateCcw className="h-[1em] w-[1em]" />
        {t('myAgents.retry', { defaultValue: '重试' })}
      </Button>
    </div>
  ) : (
    <Textarea
      value={effectiveRules}
      onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const nextRules = event.target.value
        onRulesDraftChange(nextRules === savedRules ? null : nextRules)
      }}
      rows={14}
      maxLength={5000}
      disabled={savingRules}
      aria-label={t('myAgents.rulesTitle', { defaultValue: '人设与规则' })}
      placeholder={t('myAgents.rulesPlaceholder', {
        defaultValue: '这个 AI 分身是干什么的、怎么干活、有什么边界……',
      })}
      className={cn(SETTINGS_TEXTAREA, 'min-h-[280px] resize-y border-transparent bg-muted/30 focus:ring-1 focus:ring-inset focus:ring-ring')}
    />
  )

  const closePanelLabel = t('myAgents.workbench.closePanel', { defaultValue: '关闭' })

  if (activePanel === 'rules') {
    return (
      <WorkbenchDrillInShell
        panel="rules"
        onClose={() => setActivePanel(null)}
        closeLabel={closePanelLabel}
        title={(
          <h2 className="flex min-w-0 items-center gap-1.5 text-subtitle font-semibold text-foreground">
            <ScrollText className={cn(CARD_TITLE_ICON, 'shrink-0 text-accent')} aria-hidden />
            <span className="truncate">{t('myAgents.rulesTitle', { defaultValue: '人设与规则' })}</span>
          </h2>
        )}
        subtitle={(
          <p className={cn('mt-1', CANVAS_TEXT_META)}>
            {t('myAgents.rulesHint', {
              defaultValue: '描述它怎么思考、怎么表达，以及做事时要遵守的边界。',
            })}
          </p>
        )}
        actions={rulesDirty ? (
          <Button size="sm" onClick={() => { void handleSaveRules() }} disabled={savingRules}>
            {savingRules ? <Loader2 className="h-[1em] w-[1em] animate-spin" /> : <Check className="h-[1em] w-[1em]" />}
            {t('myAgents.rulesSave', { defaultValue: '保存' })}
          </Button>
        ) : null}
        bodyClassName="overflow-y-auto scrollbar-hover"
      >
        {rulesEditor}
      </WorkbenchDrillInShell>
    )
  }

  if (activePanel === 'skills') {
    return (
      <WorkbenchDrillInShell
        panel="skills"
        onClose={() => setActivePanel(null)}
        closeLabel={closePanelLabel}
        title={(
          <h2 className="flex min-w-0 items-center gap-1.5 text-subtitle font-semibold text-foreground">
            <Sparkles className={cn(CARD_TITLE_ICON, 'shrink-0 text-accent')} aria-hidden />
            <span className="truncate">{t('myAgents.skillsTitle', { defaultValue: '技能携带集' })}</span>
          </h2>
        )}
        bodyClassName="flex flex-col overflow-hidden"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {skillContextSpaceId ? (
            <AgentSkillsPanel
              spaceId={skillContextSpaceId}
              agentId={agent.id}
              canManage
              isDefaultAgent={isDefaultAgent}
            />
          ) : (
            <p className={CANVAS_TEXT_SECONDARY}>
              {t('myAgents.skillsUnavailable', {
                defaultValue: '当前组织还没有可用的工作空间，暂时无法读取技能库。',
              })}
            </p>
          )}
        </div>
      </WorkbenchDrillInShell>
    )
  }

  if (activePanel === 'tools') {
    return (
      <WorkbenchDrillInShell
        panel="tools"
        onClose={() => setActivePanel(null)}
        closeLabel={closePanelLabel}
        title={(
          <h2 className="flex min-w-0 items-center gap-1.5 text-subtitle font-semibold text-foreground">
            <Plug className={cn(CARD_TITLE_ICON, 'shrink-0 text-accent')} aria-hidden />
            <span className="truncate">{t('myAgents.toolsTitle', { defaultValue: '工具携带集' })}</span>
          </h2>
        )}
        bodyClassName="flex min-h-0 flex-col overflow-hidden p-0"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <AgentToolsPanel organizationId={organizationId} agentId={agent.id} canManage hideHeader />
        </div>
      </WorkbenchDrillInShell>
    )
  }

  return (
    <div
      className={cn(
        'grid h-full min-h-0 w-full gap-4',
        'grid-cols-1',
        // 上排 3+3+3+3；下排 7+5，与上排列线错开
        'md:grid-cols-12 md:grid-rows-[auto_minmax(0,1fr)]',
      )}
      data-testid="agent-workbench-detail"
      data-panel="overview"
    >
      {/* 身份卡 — 3/12 */}
      <section className="flex min-w-0 flex-col rounded-[12px] border border-border/40 bg-muted/10 px-4 py-3 md:col-span-3">
        <div className="flex items-stretch gap-3">
          <button
            type="button"
            className="group relative shrink-0 self-stretch rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('myAgents.editAvatarAction', { defaultValue: '编辑头像' })}
            onClick={beginEditAvatar}
          >
            <AgentListIdentityAvatar agent={identityAgent} size="stretch" />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-foreground/40 opacity-0 transition-opacity group-hover:opacity-100">
              <ImagePlus className="h-4 w-4 text-background" />
            </span>
          </button>
          <div className="min-w-0 flex-1">
            {/* 名称行：编辑/只读同高（h-7），确认取消与铅笔同排，避免编辑时卡片被撑高 */}
            <div className="flex h-7 min-w-0 items-center gap-1.5">
              {editingName ? (
                <>
                  <Input
                    value={nameValue}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                      setNameValue(event.target.value)
                      setNameError('')
                    }}
                    maxLength={100}
                    disabled={savingName}
                    autoFocus
                    aria-label={t('myAgents.nameInputLabel', { defaultValue: 'AI 分身名字' })}
                    className="h-7 min-w-0 flex-1 border-transparent bg-muted/30 px-2 py-0 text-body focus:ring-1 focus:ring-inset focus:ring-ring"
                    onKeyDown={(event: React.KeyboardEvent) => {
                      if (event.key === 'Enter') { event.preventDefault(); void handleSaveName() }
                      if (event.key === 'Escape') {
                        cancelRename()
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive text-accent hover:bg-accent/10 disabled:opacity-50"
                    aria-label={t('myAgents.confirmRename', { defaultValue: '保存名字' })}
                    disabled={savingName}
                    onClick={() => { void handleSaveName() }}
                  >
                    {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive text-muted-foreground/80 hover:bg-muted/30 hover:text-foreground disabled:opacity-50"
                    aria-label={t('myAgents.cancelRename', { defaultValue: '取消改名' })}
                    disabled={savingName}
                    onClick={cancelRename}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <>
                  <h2 className="min-w-0 flex-1 truncate text-subtitle font-semibold leading-7 text-foreground">
                    {displayName}
                  </h2>
                  {!isDefaultAgent ? (
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive text-muted-foreground/80 hover:bg-muted/30 hover:text-foreground"
                          aria-label={t('myAgents.workbench.moreActions', { defaultValue: '更多操作' })}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[168px]">
                        <DropdownMenuItem onSelect={beginRename}>
                          <PenLine className="h-3.5 w-3.5" />
                          {t('myAgents.renameAction', { defaultValue: '改名' })}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={beginEditAvatar}>
                          <ImagePlus className="h-3.5 w-3.5" />
                          {t('myAgents.editAvatarAction', { defaultValue: '编辑头像' })}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => setDeactivateConfirmOpen(true)}
                        >
                          <Ban className="h-3.5 w-3.5" />
                          {t('myAgents.deactivateAction', { defaultValue: '停用 AI 分身' })}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive text-muted-foreground/80 hover:bg-muted/30 hover:text-foreground"
                      aria-label={t('myAgents.renameAction', { defaultValue: '改名' })}
                      onClick={beginRename}
                    >
                      <PenLine className="h-4 w-4" />
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {sourceLabel ? (
                <span className={cn(SETTINGS_TEXT_MICRO, 'rounded bg-foreground/[0.045] px-1.5 py-0.5 text-muted-foreground')}>
                  {sourceLabel}
                </span>
              ) : null}
              {isDefaultAgent ? (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          SETTINGS_TEXT_MICRO,
                          'cursor-default rounded bg-accent/10 px-1.5 py-0.5 text-accent',
                        )}
                      >
                        {t('myAgents.defaultBadge', { defaultValue: '默认' })}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {t('myAgents.deactivateDefaultProtected', {
                        defaultValue: '这是你的默认身份，无法停用。',
                      })}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
            </div>
            {editingName && nameError ? (
              <p className={cn(SETTINGS_TEXT_META_BASE, 'mt-1 text-destructive')}>{nameError}</p>
            ) : null}
          </div>
        </div>
      </section>

      <AgentWorkbenchExpandCard
        title={t('myAgents.rulesTitle', { defaultValue: '人设与规则' })}
        icon={<ScrollText className={CARD_TITLE_ICON} />}
        preview={rulesPreview}
        onOpen={() => setActivePanel('rules')}
        className="md:col-span-3"
      />

      <AgentWorkbenchExpandCard
        title={t('myAgents.skillsTitle', { defaultValue: '技能携带集' })}
        icon={<Sparkles className={CARD_TITLE_ICON} />}
        preview={
          skillContextSpaceId
            ? t('myAgents.workbench.skillsPreview', { defaultValue: '管理这个 AI 分身会携带的技能' })
            : t('myAgents.skillsUnavailableHint', {
                defaultValue: '创建或进入一个工作空间后，即可为这个 AI 分身添加技能。',
              })
        }
        onOpen={() => setActivePanel('skills')}
        className="md:col-span-3"
      />

      <AgentWorkbenchExpandCard
        title={t('myAgents.toolsTitle', { defaultValue: '工具携带集' })}
        icon={<Plug className={CARD_TITLE_ICON} />}
        preview={t('myAgents.workbench.toolsPreview', {
          defaultValue: '管理这个 AI 分身会用的外部连接',
        })}
        onOpen={() => setActivePanel('tools')}
        className="md:col-span-3"
      />

      <AgentWorkbenchPane
        title={t('myAgents.memoryTitle', { defaultValue: '记忆' })}
        icon={<Brain className={CARD_TITLE_ICON} />}
        subtitle={t('myAgents.memoryHint', {
          defaultValue: 'TA 对你的综合理解，以及协作中记下的全部记忆记录——可纠正、忘记或导出。',
        })}
        className="min-h-[320px] md:col-span-7 md:min-h-0"
      >
        <div className="px-4 py-3">
          <AgentMemoryGovernancePanel
            organizationId={organizationId}
            agentId={agent.id}
            agentName={displayName}
            focusMemoryId={focusMemoryId ?? undefined}
          />
        </div>
      </AgentWorkbenchPane>

      <AgentWorkbenchPane
        title={t('myAgents.workbench.recentTasksTitle', { defaultValue: '最近任务' })}
        icon={<ListTodo className={CARD_TITLE_ICON} />}
        subtitle={t('myAgents.workbench.recentTasksHint', {
          defaultValue: '这个 AI 分身参与的 Chat 对话与 Project 任务',
        })}
        className="min-h-[240px] md:col-span-5 md:min-h-0"
      >
        <AgentRecentActivitiesPanel
          organizationId={organizationId}
          agentId={agent.id}
        />
      </AgentWorkbenchPane>

      {!isDefaultAgent ? (
        <ConfirmDialog
          open={deactivateConfirmOpen}
          onOpenChange={setDeactivateConfirmOpen}
          title={t('myAgents.deactivateConfirmTitle', { defaultValue: '确认停用这个 AI 分身？' })}
          description={t('myAgents.deactivateConfirmDesc', {
            name: agent.name,
            defaultValue: `停用「${agent.name}」后不会出现在 AI 分身列表和会话切换里，可以随时在「已停用」里恢复。`,
          })}
          variant="destructive"
          isLoading={deactivating}
          onConfirm={() => { void handleDeactivate() }}
        />
      ) : null}

      <Dialog open={avatarEditorOpen} onOpenChange={setAvatarEditorOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t('myAgents.editAvatarTitle', { defaultValue: '编辑头像' })}
            </DialogTitle>
            <DialogDescription>
              {t('myAgents.avatarPresetHint', {
                defaultValue: '暂不支持上传，请从 TabTin 品牌头像中选择。',
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <span id="edit-agent-avatar-label" className="text-body font-medium">
              {t('myAgents.avatarLabel', { defaultValue: '头像' })}
            </span>
            <div
              role="radiogroup"
              aria-labelledby="edit-agent-avatar-label"
              className="flex flex-wrap gap-2"
            >
              {AGENT_AVATAR_PRESET_KEYS.map((avatarKey) => {
                const avatarUrl = resolveAgentAvatarPresetUrl(avatarKey)
                const active = avatarDraftKey === avatarKey
                const avatarLabel = t(`common:agentAvatarPresets.${avatarKey}`, {
                  defaultValue: avatarKey,
                })
                return (
                  <label
                    key={avatarKey}
                    title={avatarLabel}
                    className={cn(
                      'relative h-14 w-14 shrink-0 cursor-pointer rounded-full border p-0.5 transition-colors',
                      active
                        ? 'border-accent bg-accent/10'
                        : 'border-border/60 hover:border-accent/60',
                      savingAvatar && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <input
                      type="radio"
                      name="edit-agent-avatar"
                      value={avatarKey}
                      checked={active}
                      aria-label={avatarLabel}
                      disabled={savingAvatar}
                      onChange={() => setAvatarDraftKey(avatarKey)}
                      className="peer sr-only"
                    />
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt=""
                        className="h-full w-full rounded-full object-cover peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background"
                      />
                    ) : null}
                    {active ? (
                      <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-foreground">
                        <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />
                      </span>
                    ) : null}
                  </label>
                )
              })}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={savingAvatar}
              onClick={() => setAvatarEditorOpen(false)}
            >
              {t('common:cancel', { defaultValue: '取消' })}
            </Button>
            <Button
              type="button"
              disabled={savingAvatar || !avatarDraftKey}
              onClick={() => { void handleAvatarSave() }}
            >
              {savingAvatar ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('myAgents.avatarSaveAction', { defaultValue: '保存' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
