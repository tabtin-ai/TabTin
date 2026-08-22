import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import {
  COMPOSER_COMPACT_TRIGGER_CLASS,
  COMPOSER_TOOLBAR_ICON_CLASS,
  COMPOSER_TOOLBAR_ICON_STROKE,
} from '../registry/chatDesignTokens'
import { useTranslation } from 'react-i18next'
import type { Agent, Space } from '@tabtin/app-shell'
import { SELECTABLE_AGENT_MODES, type AgentModeName } from '@/stores/chat/shared/types'
import { useChatModelStore } from '@/stores/useChatModelStore'
import { AGENT_MODE_THEME } from './agentModeTheme'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { useSpaceStore } from '@stores/useSpaceStore'
import { NewAgentDialog } from '@components/sidebar/NewAgentButton'
import { AgentAvatar } from '../message'
import { extractAgentAvatarUrl } from '@/utils/resolveAgentAvatar'
import { useAgentIdentitySelection } from './useAgentIdentitySelection'
import { resolveFloatingMenuLayout, type FloatingMenuLayout } from '../panel/floatingMenuLayout'
import { useCloseOnOrganizationContextReset } from '@/hooks/useCloseOnOrganizationContextReset'

const MENU_MAX_WIDTH = 320
const MENU_MIN_HEIGHT = 180
const EMPTY_MENU_LAYOUT: FloatingMenuLayout = {
  width: MENU_MAX_WIDTH,
  height: MENU_MIN_HEIGHT,
  left: 16,
  placement: 'up',
  bottom: 16,
}

const TRIGGER_BASE_CLASS =
  'flex min-w-0 items-center rounded-lg text-body text-muted-foreground transition-colors hover:bg-muted/25 hover:text-foreground'

/** Agent 身份触发器整颗按钮上限，避免长名称挤占底栏其它控件。 */
const AGENT_TRIGGER_MAX_WIDTH_CLASS = 'max-w-[10rem]'
const AGENT_TRIGGER_MAX_WIDTH_COMPACT_CLASS = 'max-w-[7.5rem]'

/** 人设与规则首行预览：取首行前 maxChars 字；空则 null。 */
export function personaFirstLinePreview(rules?: string | null, maxChars = 40): string | null {
  const trimmed = rules?.trim()
  if (!trimmed) return null
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine) return null
  return Array.from(firstLine).slice(0, maxChars).join('')
}

/** 默认执行身份归属：只认当前组织的 is_default Space 绑定，不按可改的展示名猜测。 */
export function resolveDefaultAffiliation(
  agentId: string,
  spaces: Array<Pick<
    Space,
    'organization_id' | 'type' | 'is_default' | 'agent_id' | 'execution_agent_id'
  >>,
  organizationId: string | null,
): string | null {
  if (!organizationId) return null
  const defaultSpace = spaces.find((space) => (
    space.organization_id === organizationId
    && space.is_default
    && (space.execution_agent_id ?? space.agent_id) === agentId
  ))
  if (defaultSpace?.type === 'workspace') return '个人 Space'
  if (defaultSpace?.type === 'team_space') return '团队'
  return null
}

function resolvePreferredModelLabel(
  preferredModelId: string | null | undefined,
  availableModels: Array<{ id: string; display_name?: string; name?: string }>,
): string | null {
  const id = preferredModelId?.trim()
  if (!id) return null
  const model = availableModels.find(item => item.id === id)
  const label = (model?.display_name || model?.name || '').trim()
  return label || null
}

/** 副行文案：默认项=归属；真实 Agent=人设首行/未设定人设。模型单独渲染 badge。 */
export function buildAgentPickerSubtitle(
  agent: Pick<Agent, 'name' | 'display_name' | 'custom_rules'>,
  affiliation: string | null = null,
): string {
  return affiliation ?? personaFirstLinePreview(agent.custom_rules) ?? '未设定人设'
}

/** composer 触发器与下拉行共用同一 20px 身份头像。 */
const AgentPickerIdentityAvatar: React.FC<{ agent: Agent }> = ({ agent }) => {
  const name = agent.display_name || agent.name
  return (
    <AgentAvatar
      agentId={agent.id}
      name={name}
      avatarUrl={extractAgentAvatarUrl(agent.settings)}
    />
  )
}

const AgentPickerRow: React.FC<{
  agent: Agent
  active: boolean
  disabled: boolean
  affiliation: string | null
  modelLabel: string | null
  onSelect: (agentId: string) => void
}> = ({ agent, active, disabled, affiliation, modelLabel, onSelect }) => {
  const name = agent.display_name || agent.name
  const subtitle = buildAgentPickerSubtitle(agent, affiliation)
  const emptyPersona = !affiliation && !personaFirstLinePreview(agent.custom_rules)

  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={name}
      onClick={() => onSelect(agent.id)}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
        'hover:bg-muted/40',
        active && 'bg-muted/80',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <AgentPickerIdentityAvatar agent={agent} />
      <span className="min-w-0 flex-1">
        <span className={cn(
          'block truncate text-body',
          active ? 'font-medium text-foreground' : 'text-foreground/80',
        )}>
          {name}
        </span>
        <span className="mt-px flex min-w-0 items-center gap-1.5">
          <span className={cn(
            'min-w-0 truncate text-caption',
            emptyPersona ? 'text-muted-foreground/45' : 'text-muted-foreground/60',
          )}>
            {subtitle}
          </span>
          {modelLabel ? (
            <span
              data-testid="agent-picker-model-badge"
              className="shrink-0 rounded-full bg-foreground/[0.05] px-1.5 py-px text-micro leading-none text-muted-foreground/80"
            >
              {modelLabel}
            </span>
          ) : null}
        </span>
      </span>
      {active ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
    </button>
  )
}

type OpenMenu = 'agent' | 'mode' | null

interface AgentModeSelectorProps {
  currentMode: AgentModeName
  onModeChange: (mode: AgentModeName) => void
  sessionId?: string | null
  /**
   * @deprecated 工作空间底栏切换仍读此 prop；Agent 身份请用 canChangeAgent。
   * 草稿态可开工作空间切换；正式会话保持 false。
   */
  enableAgentPicker?: boolean
  /** 是否允许切换 Agent（：个人工作空间正式会话也可 true；团队 Space 为 false） */
  canChangeAgent?: boolean
  /** opaque draft scope；草稿 episode 按此查找，不按全局选中宿主猜 */
  draftScopeKey?: string | null
  /** 是否展示 Agent 身份（与 Mode 正交，）；默认 false 以免编辑气泡误显 */
  showAgentIdentity?: boolean
  disabled?: boolean
  compact?: boolean
  /** 仅折叠 Agent 身份；用于工具栏按真实内容宽度分级收缩。 */
  compactIdentity?: boolean
  /** 仅折叠执行模式；用于工具栏优先收缩模式与权限。 */
  compactMode?: boolean
  showModeLabel?: boolean
  triggerClassName?: string
  showModes?: boolean
}

/**
 * Agent 身份与任务模式选择器。
 *
 *  三档审批策略：yolo 已从任务模式下拉移除——「多大程度放手」由
 * 授权策略里的「审批权限授权」承接，本组件只管「做什么类型的事」。
 *
 * ：Agent 身份与 Mode 拆成两个独立触发器 / 菜单，始终同时可感知，不得 XOR。
 * 宽布局展示 Agent / Mode 名称；compact 小窗只保留身份头像与模式图标。
 * 草稿/可换身份时可点；锁死态只读可见。
 */
export const AgentModeSelector: React.FC<AgentModeSelectorProps> = ({
  currentMode,
  onModeChange,
  sessionId = null,
  enableAgentPicker = false,
  canChangeAgent: canChangeAgentProp,
  draftScopeKey = null,
  showAgentIdentity = false,
  disabled = false,
  compact = false,
  compactIdentity = false,
  compactMode = false,
  showModeLabel = true,
  triggerClassName,
  showModes = true,
}) => {
  const { t } = useTranslation('chat')
  const canChangeAgent = canChangeAgentProp ?? enableAgentPicker
  const identityCompact = compact || compactIdentity
  const modeCompact = compact || compactMode
  const showIdentity = showAgentIdentity || canChangeAgent
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [newAgentOpen, setNewAgentOpen] = useState(false)
  const [menuLayout, setMenuLayout] = useState<FloatingMenuLayout>(EMPTY_MENU_LAYOUT)
  const agentTriggerRef = useRef<HTMLButtonElement>(null)
  const modeTriggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuContentRef = useRef<HTMLDivElement>(null)

  const loadAgent = useSpaceStore(s => s.loadAgent)
  const spaces = useSpaceStore(s => s.spaces)
  const availableModels = useChatModelStore(s => s.availableModels)
  const loadedModelsOrganizationId = useChatModelStore(s => s.loadedOrganizationId)
  const loadModels = useChatModelStore(s => s.loadModels)
  const {
    agents,
    currentAgent,
    currentAgentId,
    identityPlaceholder,
    organizationId,
    isLoading,
    isUpdating,
    selectIdentity,
    reloadAgents,
  } = useAgentIdentitySelection(sessionId, {
    showIdentity,
    canChangeAgent,
    draftScopeKey,
  })

  // study / yolo 的隐藏口径已收进 SELECTABLE_AGENT_MODES 单源（见 agent-modes types.ts）；
  // 选择器与 switch_mode 可提议目标共用它，避免两处漂移。
  const visibleModes = SELECTABLE_AGENT_MODES
  const isBusy = disabled || isLoading || isUpdating
  const activeTriggerRef = openMenu === 'agent' ? agentTriggerRef : modeTriggerRef

  useEffect(() => {
    if (!openMenu) return

    const updateMenuLayout = () => {
      setMenuLayout(resolveFloatingMenuLayout({
        trigger: activeTriggerRef.current,
        maxWidth: MENU_MAX_WIDTH,
        minHeight: MENU_MIN_HEIGHT,
        contentHeight: menuContentRef.current?.scrollHeight ?? 0,
      }))
    }

    const rafId = window.requestAnimationFrame(updateMenuLayout)
    window.addEventListener('resize', updateMenuLayout)
    window.addEventListener('scroll', updateMenuLayout, true)

    return () => {
      window.cancelAnimationFrame(rafId)
      window.removeEventListener('resize', updateMenuLayout)
      window.removeEventListener('scroll', updateMenuLayout, true)
    }
  }, [activeTriggerRef, agents, openMenu, visibleModes])

  useEffect(() => {
    if (!openMenu) return

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target)) return
      if (agentTriggerRef.current?.contains(target)) return
      if (modeTriggerRef.current?.contains(target)) return
      setOpenMenu(null)
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [openMenu])

  const closeMenus = useCallback(() => {
    setOpenMenu(null)
    // 「开新分身」挂在本组件树外的 Dialog；只关菜单不够，否则会在 B 组织里创建 Agent。
    setNewAgentOpen(false)
  }, [])
  useCloseOnOrganizationContextReset(closeMenus)

  // PRD v3 §5.4.3 单次握手：打开 Agent 菜单时刷新 agent_config / 身份列表。
  const handleToggleAgentMenu = useCallback(() => {
    if (isBusy || !canChangeAgent) return
    if (openMenu !== 'agent') {
      void reloadAgents()
      if (organizationId && loadedModelsOrganizationId !== organizationId) {
        void loadModels(organizationId)
      }
      if (currentAgentId) {
        loadAgent(currentAgentId, { force: true }).catch(() => {})
      }
      setOpenMenu('agent')
      return
    }
    setOpenMenu(null)
  }, [
    canChangeAgent,
    currentAgentId,
    isBusy,
    loadAgent,
    loadModels,
    loadedModelsOrganizationId,
    openMenu,
    organizationId,
    reloadAgents,
  ])

  const handleToggleModeMenu = useCallback(() => {
    if (isBusy || !showModes) return
    if (openMenu !== 'mode') {
      // Mode 菜单不拉 Agent 列表；仍握手当前身份 config（审批档等下游可读）。
      if (currentAgentId) {
        loadAgent(currentAgentId, { force: true }).catch(() => {})
      }
      setOpenMenu('mode')
      return
    }
    setOpenMenu(null)
  }, [currentAgentId, isBusy, loadAgent, openMenu, showModes])

  const handleSelectMode = (mode: AgentModeName) => {
    onModeChange(mode)
    setOpenMenu(null)
  }

  const handleSelectAgent = (agentId: string) => {
    if (!canChangeAgent) return
    void selectIdentity(agentId)
    setOpenMenu(null)
  }

  const handleOpenNewAgent = () => {
    setOpenMenu(null)
    setNewAgentOpen(true)
  }

  const current = AGENT_MODE_THEME[currentMode]
  const CurrentIcon = current.icon
  const accentClass = currentMode !== 'agent' ? current.colorClass : undefined
  const iconAccentClass = current.colorClass
  const modeDescription = currentMode !== 'agent'
    ? t(`agentMode.${currentMode}.description`)
    : null
  const modeName = t(`agentMode.${currentMode}.name`)
  const agentName = currentAgent
    ? (currentAgent.display_name || currentAgent.name)
    : (identityPlaceholder?.label ?? null)
  const identityLockedHint = !canChangeAgent && agentName
    ? t('agentMode.identityLocked', {
      defaultValue: '本会话由 {{name}} 执行，创建后不可更换',
      name: agentName,
    })
    : null
  // 只读身份 accessible name 必须含真实 Agent 名 +「不可更换」（不依赖 i18n 插值）
  const agentAriaLabel = !canChangeAgent && agentName
    ? `${agentName}（不可更换）`
    : (agentName ?? t('newTask.agentPickerLabel', { defaultValue: '选择 Agent' }))
  const agentTooltip = openMenu === 'agent'
    ? null
    : (identityLockedHint || agentName)
  const modeTooltip = openMenu === 'mode'
    ? null
    : [modeName, modeDescription].filter(Boolean).join('\n')

  const agentMenuOpen = openMenu === 'agent'
  const modeMenuOpen = openMenu === 'mode'

  return (
    <>
      {showIdentity ? (
        <ChatIconTooltip
          side="top"
          content={agentTooltip}
          className="max-w-[280px] whitespace-pre-line leading-relaxed"
          triggerClassName={cn(
            'min-w-0',
            identityCompact ? AGENT_TRIGGER_MAX_WIDTH_COMPACT_CLASS : AGENT_TRIGGER_MAX_WIDTH_CLASS,
          )}
        >
          <button
            ref={agentTriggerRef}
            type="button"
            data-testid="agent-identity-trigger"
            onClick={handleToggleAgentMenu}
            disabled={isBusy}
            aria-label={agentAriaLabel}
            aria-expanded={canChangeAgent ? agentMenuOpen : undefined}
            aria-haspopup={canChangeAgent ? 'menu' : undefined}
            aria-disabled={!canChangeAgent || undefined}
            className={cn(
              TRIGGER_BASE_CLASS,
              'overflow-hidden',
              identityCompact ? COMPOSER_COMPACT_TRIGGER_CLASS : 'h-7 w-full gap-1 px-1.5',
              identityCompact ? AGENT_TRIGGER_MAX_WIDTH_COMPACT_CLASS : AGENT_TRIGGER_MAX_WIDTH_CLASS,
              agentMenuOpen && 'bg-muted/25',
              isBusy && 'cursor-not-allowed opacity-50',
              !canChangeAgent && 'cursor-default hover:bg-transparent hover:text-muted-foreground',
              triggerClassName,
            )}
          >
            {currentAgent ? (
              <AgentAvatar
                agentId={currentAgent.id}
                name={currentAgent.display_name || currentAgent.name}
                avatarUrl={extractAgentAvatarUrl(currentAgent.settings)}
                className={identityCompact ? 'h-4 w-4' : undefined}
              />
            ) : identityPlaceholder ? (
              <span data-testid="agent-identity-placeholder" className="inline-flex">
                <AgentAvatar
                  name={identityPlaceholder.label}
                  className={identityCompact ? 'h-4 w-4' : undefined}
                />
              </span>
            ) : null}
            {agentName && !identityCompact ? (
              <span
                data-testid="agent-identity-name"
                className={cn(
                  'min-w-0 flex-1 truncate font-normal',
                )}
              >
                {agentName}
              </span>
            ) : null}
            {canChangeAgent && !identityCompact ? (
              <ChevronDown
                strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE}
                  className={cn(
                    COMPOSER_TOOLBAR_ICON_CLASS,
                    'shrink-0 transition-transform',
                    agentMenuOpen && 'rotate-180',
                )}
              />
            ) : null}
          </button>
        </ChatIconTooltip>
      ) : null}

      {showModes ? (
        <ChatIconTooltip
          side="top"
          content={modeTooltip}
          className="max-w-[280px] whitespace-pre-line leading-relaxed"
        >
          <button
            ref={modeTriggerRef}
            type="button"
            data-testid="agent-mode-trigger"
            onClick={handleToggleModeMenu}
            disabled={isBusy}
            aria-label={modeName}
            aria-expanded={modeMenuOpen}
            aria-haspopup="menu"
            className={cn(
              TRIGGER_BASE_CLASS,
              modeCompact ? COMPOSER_COMPACT_TRIGGER_CLASS : 'h-7 gap-1 px-1.5',
              modeMenuOpen && 'bg-muted/25',
              isBusy && 'cursor-not-allowed opacity-50',
              triggerClassName,
            )}
          >
            <CurrentIcon
              data-testid="agent-mode-icon"
              data-mode-icon={currentMode}
              className={cn(COMPOSER_TOOLBAR_ICON_CLASS, iconAccentClass)}
              strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE}
              aria-hidden
            />
            {showModeLabel && !modeCompact ? (
              <span
                data-testid="agent-mode-name"
                className={cn(
                  'min-w-0 max-w-[96px] truncate font-normal',
                  accentClass,
                )}
              >
                {modeName}
              </span>
            ) : null}
            {!modeCompact ? (
              <ChevronDown
                strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE}
                className={cn(
                  COMPOSER_TOOLBAR_ICON_CLASS,
                  'shrink-0 transition-transform',
                  modeMenuOpen && 'rotate-180',
                )}
              />
            ) : null}
          </button>
        </ChatIconTooltip>
      ) : null}

      {/* Portal 到 body：避免浮动输入区的 backdrop-filter 成为 fixed 包含块导致菜单错位 */}
      {createPortal(
        <AnimatePresence>
          {openMenu ? (
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: menuLayout.placement === 'down' ? -4 : 4, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: menuLayout.placement === 'down' ? -4 : 4, scale: 0.96 }}
              transition={{ duration: 0.12 }}
              className={cn(
                'fixed z-dropdown rounded-interactive overflow-hidden',
                OVERLAY_SURFACE_CLASS,
              )}
              style={{
                top: menuLayout.top,
                bottom: menuLayout.bottom,
                left: menuLayout.left,
                width: menuLayout.width,
                maxHeight: menuLayout.height,
              }}
            >
              <div
                ref={menuContentRef}
                className="overflow-y-auto p-1.5"
                style={{ maxHeight: menuLayout.height }}
              >
                {agentMenuOpen && canChangeAgent ? (
                  <div role="radiogroup" aria-label={t('newTask.agentPickerLabel', { defaultValue: '选择 Agent' })}>
                    {agents.map((agent) => (
                      <AgentPickerRow
                        key={agent.id}
                        agent={agent}
                        active={agent.id === currentAgentId}
                        disabled={isUpdating}
                        affiliation={resolveDefaultAffiliation(agent.id, spaces, organizationId)}
                        modelLabel={resolvePreferredModelLabel(
                          agent.preferred_model_id,
                          loadedModelsOrganizationId === organizationId ? availableModels : [],
                        )}
                        onSelect={handleSelectAgent}
                      />
                    ))}
                    <div
                      data-testid="agent-picker-actions-hairline"
                      className="mx-1 my-1.5 h-px bg-foreground/[0.07]"
                      aria-hidden
                    />
                    <button
                      type="button"
                      onClick={handleOpenNewAgent}
                      disabled={isUpdating}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                    >
                      <Plus className="h-4 w-4 shrink-0" />
                      <span className="text-body">
                        {t('newTask.newAgentChip', { defaultValue: '开新分身' })}
                      </span>
                    </button>
                  </div>
                ) : null}

                {modeMenuOpen ? visibleModes.map((mode) => {
                  const config = AGENT_MODE_THEME[mode]
                  const Icon = config.icon
                  const isSelected = mode === currentMode
                  return (
                    <ChatIconTooltip
                      key={mode}
                      side="right"
                      align="start"
                      delayDuration={280}
                      content={t(`agentMode.${mode}.description`)}
                      className="max-w-[260px] whitespace-normal leading-relaxed"
                      triggerClassName="flex w-full"
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectMode(mode)}
                        data-mode={mode}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                          'hover:bg-muted/40',
                          isSelected && 'bg-muted/80',
                        )}
                      >
                        <Icon className={cn('h-4 w-4 shrink-0', config.colorClass)} />
                        <span className={cn(
                          'min-w-0 flex-1 truncate text-body font-medium',
                          isSelected ? 'text-foreground' : 'text-foreground/80',
                        )}>
                          {t(`agentMode.${mode}.name`)}
                        </span>
                        {isSelected ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
                      </button>
                    </ChatIconTooltip>
                  )
                }) : null}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}

      {canChangeAgent ? (
        <NewAgentDialog
          open={newAgentOpen}
          organizationId={organizationId}
          onOpenChange={(open) => {
            setNewAgentOpen(open)
            // 对齐 MyAgentsPanel：关弹窗后重拉列表（含创建成功与取消）。
            if (!open) void reloadAgents()
          }}
          onAgentCreated={async (agent) => {
            useSpaceStore.setState((state) => ({
              agentCache: {
                ...state.agentCache,
                [agent.id]: {
                  ...state.agentCache[agent.id],
                  ...agent,
                },
              },
            }))
            await selectIdentity(agent.id, agent)
          }}
        />
      ) : null}
    </>
  )
}
