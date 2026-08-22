/**
 * MyAgentsPanel — 「设置 → 我的 AI → 我的 Agent」管理面板（ W2）。
 *
 * live 走查缺口：此前没有独立的 Agent 管理入口（只能经由 Workspace 设置进
 * Agent 档案——旧动线残留）。本面板与「Skill 库」并列挂在「我的 AI」页：
 *
 * - 列表：当前 organization 的全部 Agent（头像/icon + 展开名 +
 *   来源角标（模板名 / 自建）+ 最近更新时间）；行尾「＋开新分身」复用
 *   NewAgentDialog。
 * - 详情（面板内切换）：精简档案——改名（后端 {owner} 保留占位符防呆的
 *   错误透传）；人设 / 技能携带集 / 记忆 / 管理拆成四个 tab。
 *   管理 tab「停用 Agent」（/#6313：身份生命周期在此，恢复走本页「已停用」，
 *   不依赖 Workspace 回收站）。产品不再使用独立 goal。
 *   完整执行现场配置仍在 Workspace 设置的 AgentProfilePane——那套按 spaceId
 *   组织，本批不搬。
 *
 * TODO: 「最近使用」暂以 updated_at 近似（Agent 无 last_used 投影）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Ban, Bot, Check, Loader2, PenLine, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { Button, ConfirmDialog, Input, Textarea, toast } from '@components/ui'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useAuthStore } from '@stores/useAuthStore'
import { NewAgentDialog } from '@components/sidebar/NewAgentButton'
import { AgentSkillsPanel } from '@components/space-settings/AgentSkillsPanel'
import { AgentToolsPanel } from '@components/space-settings/AgentToolsPanel'
import { AgentMemoryGovernancePanel } from './AgentMemoryGovernancePanel'
import { TABTIN_APP_ICON_URL } from '@/constants/appIcon'
import { extractAgentAvatarUrl, resolveAgentAvatarUrl } from '@/utils/resolveAgentAvatar'
import { useAgentMemoryFocusStore } from '@/services/agentMemoryNavigation'
import { useSkillLibraryContextSpaceId } from './SkillLibraryPanel'
import { expandAgentName, AGENT_NAME_OWNER_TOKEN } from '@utils/agentNameInterpolation'
import { resolveAgentSourceBadge } from '@utils/agentSourceBadge'
import {
  getCachedOrganizationAgents,
  listOrganizationAgents,
  organizationAgentSummaryFromAgent,
  type OrganizationAgentSummary,
} from '@/services/organizationAgentsApi'
import { listAgentTemplates } from '@/services/agentTemplatesApi'
import { AgentApiService, SpaceApiService, type DeactivatedAgent } from '@tabtin/app-shell'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SettingsSectionHeader } from '../SettingsSectionHeader'
import { SettingsTabs } from '../SettingsTabs'
import { SETTINGS_HINT, SETTINGS_TEXTAREA, SETTINGS_TEXT_META_BASE, SETTINGS_TEXT_MICRO } from '../settingsUi'
import { createLogger } from '@/utils/logger'
import { useScopedResizeObserver } from '@/hooks/spaceActivity'
import { ContextPageHeader } from '@components/context-space/ContextPageHeader'
import {
  CONTEXT_PAGE_HEADER_GAP,
  CONTEXT_PAGE_SHELL_FILL,
} from '@components/context-space/constants'

type AgentDetailTab = 'rules' | 'skills' | 'tools' | 'memory' | 'danger'

const log = createLogger('MyAgents')

export function formatAgentRelativeTime(
  iso: string | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!iso) return ''
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return ''
  const diffMin = Math.floor(Math.max(0, Date.now() - ts) / 60000)
  if (diffMin < 1) return t('myAgents.justNow', { defaultValue: '刚刚' })
  if (diffMin < 60) return t('myAgents.minutesAgo', { defaultValue: '{{n}} 分钟前', n: diffMin })
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return t('myAgents.hoursAgo', { defaultValue: '{{n}} 小时前', n: diffHour })
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 30) return t('myAgents.daysAgo', { defaultValue: '{{n}} 天前', n: diffDay })
  return new Date(ts).toLocaleDateString()
}

/** 列表行与详情头共用圆形身份头像：自定义图或 TabTin logo。 */
export const AgentListIdentityAvatar: React.FC<{
  agent: OrganizationAgentSummary
  /**
   * sm（36px）设置列表；md（48px）侧栏；
   * stretch：工作台身份卡主头像（56px 固定圆；img 不能用 h-auto+self-stretch，会吃到原图像素尺寸）。
   */
  size?: 'sm' | 'md' | 'stretch'
  className?: string
}> = ({ agent, size = 'sm', className }) => {
  const label = agent.name?.trim() || agent.id
  const resolved = resolveAgentAvatarUrl(extractAgentAvatarUrl(agent.settings))
  const [src, setSrc] = React.useState(resolved)

  React.useEffect(() => {
    setSrc(resolveAgentAvatarUrl(extractAgentAvatarUrl(agent.settings)))
  }, [agent.settings])

  return (
    <img
      src={src}
      alt={label}
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full object-cover',
        size === 'stretch'
          ? 'h-14 w-14'
          : size === 'md'
            ? 'h-12 w-12'
            : 'h-9 w-9',
        className,
      )}
      onError={() => {
        if (src !== TABTIN_APP_ICON_URL) setSrc(TABTIN_APP_ICON_URL)
      }}
    />
  )
}

interface MyAgentsPanelProps {
  /** 一级 Agent 工作台使用独立页壳；个人设置入口复用 Settings 统一页眉与外边距。 */
  standalone?: boolean
  /**
   * app-page 嵌入：页眉由 AppFullPageHost 承接，
   * 不再渲染面板内同款标题。
   * 若同时传入 onHeaderActions，则把「开新分身 / 已停用」上交页眉；
   * 否则退回列表区双行工具条（避免窄侧栏标题折行）。
   */
  hidePageHeader?: boolean
  /** 把页眉动作上交给外层 StandaloneModulePage.actions。 */
  onHeaderActions?: (actions: React.ReactNode) => void
}

export const MyAgentsPanel: React.FC<MyAgentsPanelProps> = ({
  standalone = false,
  hidePageHeader = false,
  onHeaderActions,
}) => {
  const { t } = useTranslation('settings')
  const selectedOrganizationId = useOrganizationStore(
    state => state.selectedOrganization?.id ?? null,
  )
  const [focusedOrganizationId, setFocusedOrganizationId] = useState<string | null>(
    () => useAgentMemoryFocusStore.getState().organizationId,
  )
  const organizationId = focusedOrganizationId ?? selectedOrganizationId
  const ownerName = useAuthStore(
    state => state.user?.nickname?.trim() || state.user?.username?.trim() || '',
  )
  const updateAgent = useSpaceStore(s => s.updateAgent)
  const deleteAgent = useSpaceStore(s => s.deleteAgent)
  const skillContextSpaceId = useSkillLibraryContextSpaceId(organizationId)

  const [agents, setAgents] = useState<OrganizationAgentSummary[]>([])
  const [loadedOrganizationId, setLoadedOrganizationId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [templateNameById, setTemplateNameById] = useState<Record<string, string>>({})
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [newAgentOpen, setNewAgentOpen] = useState(false)
  // 「已停用」是独立入口（不依赖工作空间回收站 flag，）：切到这个视图时
  // 主从布局让位给 DeactivatedAgentsView。
  const [showDeactivated, setShowDeactivated] = useState(false)
  // 每个 Agent 的人设草稿留在列表页层级；切换 Agent 时不丢输入。
  const [rulesDraftByAgentId, setRulesDraftByAgentId] = useState<Record<string, string | null>>({})
  // 深链聚焦：openAgentMemory(...) 设置的一次性意图（选中某 Agent + 高亮某条记忆）。
  const [focusMemoryId, setFocusMemoryId] = useState<string | null>(null)
  // 深链打开「我的 Agent」时强制切到记忆 tab（有无具体 memoryId 都切）。
  const [memoryTabFocusToken, setMemoryTabFocusToken] = useState(0)
  const memoryFocus = useAgentMemoryFocusStore()
  const appliedFocusNonceRef = useRef(0)
  const loadRequestIdRef = useRef(0)
  const loadedOrganizationIdRef = useRef<string | null>(null)
  const selectedAgentIdRef = useRef<string | null>(null)
  const agentsRef = useRef<OrganizationAgentSummary[]>([])
  const agentListRef = useRef<HTMLDivElement>(null)
  const focusBaseOrganizationIdRef = useRef<string | null | undefined>(undefined)
  const [layoutElement, setLayoutElement] = useState<HTMLDivElement | null>(null)
  const [compactLayout, setCompactLayout] = useState(false)

  selectedAgentIdRef.current = selectedAgentId
  agentsRef.current = agents

  const loadAgents = useCallback(async () => {
    const requestId = loadRequestIdRef.current + 1
    loadRequestIdRef.current = requestId
    if (!organizationId) {
      setAgents([])
      setLoadedOrganizationId(null)
      loadedOrganizationIdRef.current = null
      setSelectedAgentId(null)
      setLoading(false)
      setLoadError(false)
      return
    }
    // 仅在切换组织时重置详情，避免跨组织误操作；同组织刷新
    // （改名 / 保存人设后）保留当前选中，防止右侧档案被卸掉。
    const switchingOrganization = loadedOrganizationIdRef.current !== organizationId
    setLoadError(false)
    // stale-while-revalidate：命中上次已知列表快照时先展示它（不弹骨架、
    // 不清空），再静默刷新；缓存缺失（全新组织/本次会话首次进入）才走阻塞骨架的
    // 老路径。这样「切走设置页再切回来」不用每次空转一次全屏加载。
    const staleAgents = switchingOrganization ? getCachedOrganizationAgents(organizationId) : null
    if (switchingOrganization) {
      if (staleAgents) {
        setAgents(staleAgents)
        setLoadedOrganizationId(organizationId)
        loadedOrganizationIdRef.current = organizationId
        setSelectedAgentId(prev => (
          prev && staleAgents.some(agent => agent.id === prev)
            ? prev
            : (staleAgents[0]?.id ?? null)
        ))
        setLoading(false)
      } else {
        setAgents([])
        setLoadedOrganizationId(null)
        loadedOrganizationIdRef.current = null
        setSelectedAgentId(null)
        setLoading(true)
      }
    } else {
      setLoading(true)
    }
    try {
      const nextAgents = await listOrganizationAgents(organizationId)
      if (requestId !== loadRequestIdRef.current) return
      // 开号后可能先乐观选中再关窗刷新；列表瞬时未含新 id 时保留乐观项，避免回落到默认分身。
      const selectedId = selectedAgentIdRef.current
      let mergedAgents = nextAgents
      if (selectedId && !nextAgents.some(agent => agent.id === selectedId)) {
        const optimistic = agentsRef.current.find(agent => agent.id === selectedId)
        if (optimistic) {
          mergedAgents = [...nextAgents, optimistic]
        }
      }
      setAgents(mergedAgents)
      setLoadedOrganizationId(organizationId)
      loadedOrganizationIdRef.current = organizationId
      setSelectedAgentId(prev => (
        prev && mergedAgents.some(agent => agent.id === prev)
          ? prev
          : (mergedAgents[0]?.id ?? null)
      ))
    } catch (error) {
      if (requestId !== loadRequestIdRef.current) return
      log.warn('Agent 列表加载失败', { organizationId }, error)
      // 已经展示着缓存的旧列表时，后台静默刷新失败不应把界面砸成错误态——
      // 保留可见的旧数据；只有完全没有数据可展示时才切到可重试的错误态。
      if (!staleAgents) {
        setLoadError(true)
      }
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false)
      }
    }
  }, [organizationId])

  useEffect(() => {
    void loadAgents()
  }, [loadAgents])

  useEffect(() => {
    if (
      memoryFocus.nonce !== 0
      && memoryFocus.nonce !== appliedFocusNonceRef.current
      && memoryFocus.organizationId
      && memoryFocus.organizationId !== organizationId
    ) {
      focusBaseOrganizationIdRef.current = selectedOrganizationId
      setFocusedOrganizationId(memoryFocus.organizationId)
    }
  }, [memoryFocus.nonce, memoryFocus.organizationId, organizationId, selectedOrganizationId])

  // 深链跨组织只做一次性聚焦；用户随后从工作空间侧栏切换组织时，恢复跟随全局组织。
  useEffect(() => {
    if (focusedOrganizationId && focusBaseOrganizationIdRef.current === undefined) {
      focusBaseOrganizationIdRef.current = selectedOrganizationId
    }
    if (
      focusedOrganizationId
      && focusBaseOrganizationIdRef.current !== undefined
      && selectedOrganizationId !== focusBaseOrganizationIdRef.current
    ) {
      appliedFocusNonceRef.current = memoryFocus.nonce
      useAgentMemoryFocusStore.getState().clear()
      focusBaseOrganizationIdRef.current = undefined
      setFocusedOrganizationId(null)
    }
  }, [focusedOrganizationId, memoryFocus.nonce, selectedOrganizationId])

  // 依据 Agent 配置区的真实可用宽度切换布局，不依赖整个 Electron viewport。
  useScopedResizeObserver(layoutElement, ([entry]) => {
    if (entry) setCompactLayout(entry.contentRect.width < 720)
  })

  // 来源角标：模板实例显示模板名（插值串按当前昵称展开）。加载失败静默——
  // 角标降级为通用「模板」字样，不阻塞列表。
  useEffect(() => {
    let cancelled = false
    listAgentTemplates()
      .then((templates) => {
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const template of templates) {
          map[template.id] = expandAgentName(template.name, ownerName)
        }
        setTemplateNameById(map)
      })
      .catch((error) => {
        log.warn('Agent 模板加载失败，来源角标降级', { organizationId }, error)
      })
    return () => { cancelled = true }
  }, [organizationId, ownerName])

  const selectedAgent = useMemo(
    () => loadedOrganizationId === organizationId
      ? agents.find(agent => agent.id === selectedAgentId) ?? null
      : null,
    [agents, loadedOrganizationId, organizationId, selectedAgentId],
  )

  // 深链聚焦（ W3）：openAgentMemory 触发时选中目标 Agent + 记住待高亮记忆。
  // 用 nonce 判定「有新意图」，避免重复应用；agentId 尚未在列表里（列表还在加载）
  // 时保留意图，等 agents 更新后再应用（本 effect 依赖 agents）。
  useEffect(() => {
    if (memoryFocus.nonce === 0 || memoryFocus.nonce === appliedFocusNonceRef.current) return
    if (memoryFocus.agentId) {
      if (!agents.some(a => a.id === memoryFocus.agentId)) return // 等列表加载后再应用
      // 已知目标 Agent：选中它、切到记忆 tab，并高亮该条记忆（memoryId 可空）。
      setSelectedAgentId(memoryFocus.agentId)
      setFocusMemoryId(memoryFocus.memoryId)
      setMemoryTabFocusToken(token => token + 1)
    } else {
      // 不知道记忆属于哪个 Agent（如深链未带 agent_id）：只打开「我的 Agent」，
      // 不设高亮——否则会在自动选中的首个 Agent 事实页里对一条不属于它的记忆做无效高亮，
      // 反而误导用户看错 Agent（reviewer B/C 发现）。
      setFocusMemoryId(null)
    }
    appliedFocusNonceRef.current = memoryFocus.nonce
    useAgentMemoryFocusStore.getState().clear()
  }, [
    memoryFocus.nonce,
    memoryFocus.organizationId,
    memoryFocus.agentId,
    memoryFocus.memoryId,
    agents,
  ])

  // 主从布局：列表加载后自动选中首个分身，保证右侧档案不空；选中项失效时回落首个。
  useEffect(() => {
    if (agents.length === 0) return
    setSelectedAgentId(prev => (prev && agents.some(a => a.id === prev) ? prev : agents[0].id))
  }, [agents])

  // 详情内保存成功后刷新列表（改名归位场景要求列表即时可见）。
  const handleAgentUpdated = useCallback(() => {
    void loadAgents()
  }, [loadAgents])

  const handleAgentListKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const lastIndex = agents.length - 1
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? lastIndex
        : event.key === 'ArrowDown'
          ? Math.min(currentIndex + 1, lastIndex)
          : Math.max(currentIndex - 1, 0)
    const nextAgent = agents[nextIndex]
    if (!nextAgent) return
    setSelectedAgentId(nextAgent.id)
    setFocusMemoryId(null)
    setMemoryTabFocusToken(0)
    const buttons = agentListRef.current?.querySelectorAll<HTMLButtonElement>('[data-agent-option]')
    buttons?.[nextIndex]?.focus()
  }

  const newAgentLabel = t('myAgents.newAgent', { defaultValue: '开新分身' })
  const deactivatedEntryLabel = t('myAgents.deactivated.entry', { defaultValue: '已停用' })
  const openNewAgent = useCallback(() => setNewAgentOpen(true), [])
  const openDeactivated = useCallback(() => setShowDeactivated(true), [])

  const newAgentButton = (
    <Button type="button" size="sm" onClick={openNewAgent}>
      <Plus className="h-[1em] w-[1em]" />
      {newAgentLabel}
    </Button>
  )
  // 次要入口用 ghost，避免与主 CTA「开新分身」并列为两颗实心 pill。
  const deactivatedEntryButton = (
    <Button type="button" variant="ghost" size="sm" onClick={openDeactivated}>
      <Ban className="h-[1em] w-[1em]" />
      {deactivatedEntryLabel}
    </Button>
  )
  const headerActions = (
    <div className="flex items-center gap-2">
      {deactivatedEntryButton}
      {newAgentButton}
    </div>
  )
  // 外层页眉已承接动作时，列表区不再重复；单测 / 无宿主场景退回双行工具条。
  const hostHeaderActions = Boolean(onHeaderActions)
  const listToolbarActions = hidePageHeader && !hostHeaderActions ? (
    <div className="flex items-center gap-1.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="min-w-0 flex-1 justify-center"
        onClick={openDeactivated}
      >
        <Ban className="h-[1em] w-[1em]" />
        {deactivatedEntryLabel}
      </Button>
      <Button
        type="button"
        size="sm"
        className="min-w-0 flex-1 justify-center"
        onClick={openNewAgent}
      >
        <Plus className="h-[1em] w-[1em]" />
        {newAgentLabel}
      </Button>
    </div>
  ) : null

  // 只在宿主回调 / 文案变化时上交，避免每次 render 新 React 节点触发父级 setState 打环。
  useEffect(() => {
    if (!onHeaderActions) return
    onHeaderActions(
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={openDeactivated}>
          <Ban className="h-[1em] w-[1em]" />
          {deactivatedEntryLabel}
        </Button>
        <Button type="button" size="sm" onClick={openNewAgent}>
          <Plus className="h-[1em] w-[1em]" />
          {newAgentLabel}
        </Button>
      </div>,
    )
    return () => onHeaderActions(null)
  }, [
    deactivatedEntryLabel,
    newAgentLabel,
    onHeaderActions,
    openDeactivated,
    openNewAgent,
  ])

  return (
    <div className={cn(
      'flex h-full min-h-0 w-full flex-col',
      standalone && CONTEXT_PAGE_SHELL_FILL,
    )}>
      {hidePageHeader ? null : standalone ? (
        <ContextPageHeader
          icon={<Bot className="h-6 w-6" />}
          title={t('myAgents.pageTitle', { defaultValue: 'AI 分身' })}
          titleAs="h1"
          description={t('myAgents.pageSubtitle', { defaultValue: '管理每个 AI 分身的人设、技能和记忆。' })}
          actions={headerActions}
        />
      ) : (
        <SettingsSectionHeader
          section="myAgents"
          subtitle={t('myAgents.pageSubtitle', { defaultValue: '管理每个 AI 分身的人设、技能和记忆。' })}
          meta={headerActions}
        />
      )}

      {showDeactivated && organizationId ? (
        <DeactivatedAgentsPanel
          organizationId={organizationId}
          onBack={() => setShowDeactivated(false)}
          onRestored={() => { void loadAgents() }}
        />
      ) : (
      <div
        ref={setLayoutElement}
        className={cn(
          'flex min-h-0 flex-1 gap-4',
          hidePageHeader ? 'pb-0' : standalone ? CONTEXT_PAGE_HEADER_GAP : 'pb-4',
          compactLayout && 'flex-col',
        )}
      >
        <aside className={cn(
          'flex shrink-0 flex-col rounded-[12px] bg-muted/10',
          compactLayout ? 'max-h-56 w-full' : 'w-64',
        )}>
          <div className={cn(
            'flex shrink-0 flex-col gap-2 px-3',
            listToolbarActions ? 'py-2.5' : 'py-2',
          )}>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <h2 className="min-w-0 truncate text-body font-medium text-foreground">
                {t('myAgents.listTitle', { defaultValue: '我的 AI 分身' })}
              </h2>
              {!loading && !loadError ? (
                <span className={cn(SETTINGS_HINT, 'shrink-0 tabular-nums')}>
                  {agents.length}
                </span>
              ) : null}
            </div>
            {listToolbarActions}
          </div>
          <div
            ref={agentListRef}
            className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5 scrollbar-hover"
            aria-label={t('myAgents.listTitle', { defaultValue: '我的 AI 分身' })}
          >
            {loading ? (
              <div className="flex items-center gap-2 px-2 py-6 text-body text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('myAgents.loading', { defaultValue: '正在加载 AI 分身…' })}
              </div>
            ) : loadError ? (
              <div className="flex flex-col items-start gap-3 px-2 py-6">
                <span className="text-body text-foreground-secondary">
                  {t('myAgents.loadFailed', { defaultValue: 'AI 分身列表加载失败' })}
                </span>
                <Button type="button" variant="outline" size="sm" onClick={() => { void loadAgents() }}>
                  <RotateCcw className="h-[1em] w-[1em]" />
                  {t('myAgents.retry', { defaultValue: '重试' })}
                </Button>
              </div>
            ) : agents.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
                <Bot className="h-5 w-5 text-muted-foreground/60" />
                <p className="text-body text-foreground-secondary">
                  {t('myAgents.empty', { defaultValue: '还没有 AI 分身，先开一个新分身。' })}
                </p>
              </div>
            ) : agents.map((agent, index) => {
              const templateName = agent.template_id ? templateNameById[agent.template_id] : undefined
              const relativeTime = formatAgentRelativeTime(agent.updated_at, t)
              const sourceLabel = resolveAgentSourceBadge(
                agent,
                {
                  defaultBadge: t('myAgents.defaultBadge', { defaultValue: '默认' }),
                  customBadge: t('myAgents.customBadge', { defaultValue: '自建' }),
                  templateBadgeFallback: t('myAgents.templateBadgeFallback', { defaultValue: '模板' }),
                },
                templateName,
                'list',
                agent.name,
              )
              const isSelected = agent.id === selectedAgentId
              const hasDraft = rulesDraftByAgentId[agent.id] != null
              return (
                <Button
                  key={agent.id}
                  type="button"
                  variant="ghost"
                  data-agent-option
                  onClick={() => {
                    setSelectedAgentId(agent.id)
                    setFocusMemoryId(null)
                    setMemoryTabFocusToken(0)
                  }}
                  onKeyDown={(event) => handleAgentListKeyDown(event, index)}
                  aria-pressed={isSelected}
                  className={cn(
                    'group h-auto w-full justify-start gap-2 rounded-interactive px-2 py-2 text-left',
                    isSelected
                      ? 'bg-foreground/[0.06] hover:bg-foreground/[0.06] dark:bg-foreground/[0.08] dark:hover:bg-foreground/[0.08]'
                      : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                  )}
                >
                  <AgentListIdentityAvatar agent={agent} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
                        {agent.name}
                      </span>
                      {hasDraft ? (
                        <span className={cn(SETTINGS_TEXT_META_BASE, 'text-warning', 'shrink-0 rounded bg-warning/10 px-1 py-0.5')}>
                          {t('myAgents.unsaved', { defaultValue: '未保存' })}
                        </span>
                      ) : null}
                    </span>
                    <span className={cn(SETTINGS_HINT, 'mt-0.5 flex min-w-0 items-center gap-1')}>
                      <span className="shrink-0">{sourceLabel}</span>
                      {relativeTime ? <span aria-hidden>·</span> : null}
                      {relativeTime ? (
                        <span className="truncate">
                          {t('myAgents.updatedAt', { defaultValue: '更新于 {{time}}', time: relativeTime })}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </Button>
              )
            })}
          </div>
        </aside>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1 scrollbar-hover">
          {selectedAgent && organizationId ? (
            <AgentDetailPanel
              key={selectedAgent.id}
              organizationId={organizationId}
              agent={selectedAgent}
              templateName={selectedAgent.template_id ? templateNameById[selectedAgent.template_id] : undefined}
              skillContextSpaceId={skillContextSpaceId}
              updateAgent={updateAgent}
              deleteAgent={deleteAgent}
              onUpdated={handleAgentUpdated}
              onDeactivated={handleAgentUpdated}
              rulesDraft={rulesDraftByAgentId[selectedAgent.id] ?? null}
              onRulesDraftChange={(draft) => {
                setRulesDraftByAgentId(prev => ({ ...prev, [selectedAgent.id]: draft }))
              }}
              focusMemoryId={focusMemoryId}
              memoryTabFocusToken={memoryTabFocusToken}
              embedded
            />
          ) : !loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 rounded-[12px] bg-muted/10 text-center">
              <Bot className="h-7 w-7 text-muted-foreground/60" />
              <p className="text-body text-foreground-secondary">
                {agents.length === 0
                  ? t('myAgents.emptyDetail', { defaultValue: '开一个新分身后，在这里配置它。' })
                  : t('myAgents.detailEmpty', { defaultValue: '选择左侧的 AI 分身查看档案' })}
              </p>
            </div>
          ) : null}
        </main>
      </div>
      )}

      <NewAgentDialog
        open={newAgentOpen}
        organizationId={organizationId}
        onOpenChange={(open) => {
          setNewAgentOpen(open)
          if (!open) void loadAgents()
        }}
        onAgentCreated={(agent) => {
          const summary = organizationAgentSummaryFromAgent(agent)
          // 先入列表再选中：否则 agents effect 会把未知 id 回落到默认/首个分身
          setAgents(prev => (
            prev.some(item => item.id === summary.id)
              ? prev.map(item => (item.id === summary.id ? { ...item, ...summary } : item))
              : [...prev, summary]
          ))
          setSelectedAgentId(summary.id)
          setFocusMemoryId(null)
          setMemoryTabFocusToken(0)
        }}
      />
    </div>
  )
}

// ── 精简详情 ─────────────────────────────────────────────────────────────────

interface AgentDetailProps {
  organizationId: string
  agent: OrganizationAgentSummary
  templateName?: string
  skillContextSpaceId: string | null
  updateAgent: (agentId: string, updates: { name?: string; custom_rules?: string }) => Promise<boolean>
  /** Agent 生命周期：停用（软删除，）；权限按 Agent owner 契约，后端 403 时报错透传。 */
  deleteAgent: (agentId: string) => Promise<boolean>
  onUpdated: () => void
  /** 停用成功后的回调：驱动列表刷新（停用的 Agent 会从列表消失，自动落到下一个）。 */
  onDeactivated: () => void
  rulesDraft: string | null
  onRulesDraftChange: (draft: string | null) => void
  /** drill-in 模式的返回入口；主从（embedded）布局下不传、不渲染。 */
  onBack?: () => void
  /** 内嵌在右栏（主从布局）：隐藏「返回列表」按钮。 */
  embedded?: boolean
  /** 深链聚焦的记忆 id（openAgentMemory 传入）：记忆治理面切到事实 tab 并高亮该条。 */
  focusMemoryId?: string | null
  /** 深链打开记忆时递增；AgentDetail 收到后切到记忆 tab。 */
  memoryTabFocusToken?: number
}

export const AgentDetailPanel: React.FC<AgentDetailProps> = ({
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
  onBack,
  embedded = false,
  focusMemoryId,
  memoryTabFocusToken = 0,
}) => {
  const { t } = useTranslation('settings')
  const fullAgent = useSpaceStore(s => s.agentCache[agent.id] ?? null)
  const loadAgent = useSpaceStore(s => s.loadAgent)

  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(agent.name)
  const [nameError, setNameError] = useState('')
  const [savingName, setSavingName] = useState(false)

  const [savingRules, setSavingRules] = useState(false)
  const [detailLoading, setDetailLoading] = useState(!fullAgent)
  const [detailLoadError, setDetailLoadError] = useState(false)
  const [deactivateConfirmOpen, setDeactivateConfirmOpen] = useState(false)
  const [deactivating, setDeactivating] = useState(false)
  // key=agent.id 重挂时默认人设；深链带 token 则直接落记忆，避免先闪人设。
  const [detailTab, setDetailTab] = useState<AgentDetailTab>(
    () => (memoryTabFocusToken > 0 ? 'memory' : 'rules'),
  )
  const isDefaultAgent = Boolean(agent.is_default)

  // 同 Agent 再次深链打开记忆时，token 递增，切到记忆 tab。
  useEffect(() => {
    if (memoryTabFocusToken > 0) {
      setDetailTab('memory')
    }
  }, [memoryTabFocusToken])

  // 列表半量可能缺 custom_rules；仅当缓存已带该字段（含空串）才秒开，否则 force 拉详情。
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

  const savedRules = fullAgent?.custom_rules ?? ''
  const effectiveRules = rulesDraft ?? savedRules
  const rulesDirty = rulesDraft !== null && rulesDraft !== savedRules

  const handleSaveName = async () => {
    const trimmed = nameValue.trim()
    if (!trimmed) {
      setNameError(t('myAgents.nameEmptyError', { defaultValue: '名字不能为空' }))
      return
    }
    if (trimmed === agent.name) {
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
        // 后端 v2 §2.7 防呆：名字不能包含保留占位符 {owner}
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

  return (
    <div className="space-y-4">
      {/* 顶部：身份行（改名场景的主入口：铅笔进入行内编辑）；drill-in 模式额外给返回入口 */}
      <div className="space-y-3 rounded-[12px] bg-muted/10 px-4 py-3">
        {!embedded && onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="px-0 text-foreground-secondary"
          >
            <ArrowLeft className="h-[1em] w-[1em]" />
            {t('myAgents.backToList', { defaultValue: '返回 AI 分身列表' })}
          </Button>
        ) : null}
        <div className="flex items-center gap-3">
          <AgentListIdentityAvatar agent={agent} />
          <div className="min-w-0 flex-1">
            {editingName ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
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
                    className="border-transparent bg-muted/30 text-body focus:ring-1 focus:ring-inset focus:ring-ring"
                    onKeyDown={(event: React.KeyboardEvent) => {
                      if (event.key === 'Enter') { event.preventDefault(); void handleSaveName() }
                      if (event.key === 'Escape') { setEditingName(false); setNameValue(agent.name); setNameError('') }
                    }}
                  />
                  <Button
                    size="sm"
                    onClick={() => { void handleSaveName() }}
                    disabled={savingName}
                    aria-label={t('myAgents.confirmRename', { defaultValue: '保存名字' })}
                  >
                    {savingName
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Check className="h-4 w-4" />}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={savingName}
                    aria-label={t('myAgents.cancelRename', { defaultValue: '取消改名' })}
                    onClick={() => { setEditingName(false); setNameValue(agent.name); setNameError('') }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                {nameError ? <p className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>{nameError}</p> : null}
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <h2 className="truncate text-subtitle font-semibold text-foreground">{agent.name}</h2>
                    {(() => {
                      const detailSource = resolveAgentSourceBadge(
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
                      return detailSource ? (
                        <span className={cn(SETTINGS_TEXT_MICRO, 'leading-none', 'shrink-0 rounded bg-foreground/[0.045] px-1.5 py-0.5 text-muted-foreground')}>
                          {detailSource}
                        </span>
                      ) : null
                    })()}
                    {isDefaultAgent ? (
                      <span className={cn(SETTINGS_TEXT_MICRO, 'leading-none', 'shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-accent')}>
                        {t('myAgents.defaultBadge', { defaultValue: '默认' })}
                      </span>
                    ) : null}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => { setNameValue(agent.name); setEditingName(true) }}
                  aria-label={t('myAgents.renameAction', { defaultValue: '改名' })}
                >
                  <PenLine className="h-[1em] w-[1em]" />
                  {t('myAgents.renameAction', { defaultValue: '改名' })}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <SettingsTabs
        tabs={[
          {
            key: 'rules',
            label: t('myAgents.rulesTitle', { defaultValue: '人设与规则' }),
          },
          {
            key: 'skills',
            label: t('myAgents.skillsTitle', { defaultValue: '技能携带集' }),
          },
          {
            key: 'tools',
            label: t('myAgents.toolsTitle', { defaultValue: '工具携带集' }),
          },
          {
            key: 'memory',
            label: t('myAgents.memoryTitle', { defaultValue: '记忆' }),
          },
          {
            key: 'danger',
            label: t('myAgents.dangerZoneTitle', { defaultValue: '管理' }),
          },
        ]}
        activeKey={detailTab}
        onSelect={(key) => setDetailTab(key as AgentDetailTab)}
        className="pb-0"
      />

      {detailTab === 'rules' ? (
        <SettingsSectionCard
          title={t('myAgents.rulesTitle', { defaultValue: '人设与规则' })}
          subtitle={t('myAgents.rulesHint', {
            defaultValue: '描述它怎么思考、怎么表达，以及做事时要遵守的边界。',
          })}
          actions={rulesDirty ? (
              <Button size="sm" onClick={() => { void handleSaveRules() }} disabled={savingRules}>
                {savingRules
                  ? <Loader2 className="h-[1em] w-[1em] animate-spin" />
                  : <Check className="h-[1em] w-[1em]" />}
                {t('myAgents.rulesSave', { defaultValue: '保存' })}
              </Button>
            ) : undefined}
        >
          {detailLoading && !fullAgent && rulesDraft === null ? (
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
              rows={6}
              maxLength={5000}
              disabled={savingRules}
              aria-label={t('myAgents.rulesTitle', { defaultValue: '人设与规则' })}
              placeholder={t('myAgents.rulesPlaceholder', {
                defaultValue: '这个 AI 分身是干什么的、怎么干活、有什么边界……',
              })}
              className={cn(SETTINGS_TEXTAREA, 'resize-none border-transparent bg-muted/30 focus:ring-1 focus:ring-inset focus:ring-ring')}
            />
          )}
        </SettingsSectionCard>
      ) : null}

      {detailTab === 'skills' ? (
        skillContextSpaceId ? (
          <SettingsSectionCard title={t('myAgents.skillsTitle', { defaultValue: '技能携带集' })}>
            <AgentSkillsPanel
              spaceId={skillContextSpaceId}
              agentId={agent.id}
              canManage
              isDefaultAgent={isDefaultAgent}
            />
          </SettingsSectionCard>
        ) : (
          <SettingsSectionCard
            title={t('myAgents.skillsTitle', { defaultValue: '技能携带集' })}
            subtitle={t('myAgents.skillsUnavailable', {
              defaultValue: '当前组织还没有可用的工作空间，暂时无法读取技能库。',
            })}
          >
            <p className={SETTINGS_HINT}>
              {t('myAgents.skillsUnavailableHint', {
                defaultValue: '创建或进入一个工作空间后，即可为这个 AI 分身添加技能。',
              })}
            </p>
          </SettingsSectionCard>
        )
      ) : null}

      {detailTab === 'tools' ? (
        <div className="min-h-[480px] h-[min(70vh,720px)]">
          <AgentToolsPanel organizationId={organizationId} agentId={agent.id} canManage hideHeader={false} />
        </div>
      ) : null}

      {/* 记忆治理（ W3）：查看 / 纠正 / 忘记 / 导出该 Agent 记住的用户事实、
          经验与画像 + 成长记录时间线。严格 per-Agent，不跨 Agent 混排。 */}
      {detailTab === 'memory' ? (
        <SettingsSectionCard
          title={t('myAgents.memoryTitle', { defaultValue: '记忆' })}
          subtitle={t('myAgents.memoryHint', {
            defaultValue: 'TA 对你的综合理解，以及协作中记下的全部记忆记录——可纠正、忘记或导出。',
          })}
        >
          <AgentMemoryGovernancePanel
            organizationId={organizationId}
            agentId={agent.id}
            agentName={agent.name}
            focusMemoryId={focusMemoryId ?? undefined}
          />
        </SettingsSectionCard>
      ) : null}

      {/* 管理：停用是软删除，随时能从「已停用」恢复。
          ：默认身份不可停用（后端 DEFAULT_AGENT_PROTECTED）。 */}
      {detailTab === 'danger' ? (
        <SettingsSectionCard
          title={t('myAgents.dangerZoneTitle', { defaultValue: '管理' })}
          tone="danger"
        >
          {isDefaultAgent ? (
            <p className={SETTINGS_HINT}>
              {t('myAgents.deactivateDefaultProtected', {
                defaultValue: '这是你的默认身份，无法停用。',
              })}
            </p>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className={SETTINGS_HINT}>
                {t('myAgents.deactivateHint', {
                  defaultValue: '停用后该 AI 分身从活跃列表消失；工作空间与对话历史保留，可在「已停用」里恢复。',
                })}
              </p>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="shrink-0"
                onClick={() => setDeactivateConfirmOpen(true)}
              >
                <Ban className="h-[1em] w-[1em]" />
                {t('myAgents.deactivateAction', { defaultValue: '停用 AI 分身' })}
              </Button>
            </div>
          )}
        </SettingsSectionCard>
      ) : null}

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
    </div>
  )
}

// ── 已停用 Agent─────────────────────────────────────────────────────
// 独立入口，不依赖工作空间回收站的 SPACE_TRASH_UI_ENABLED flag：停用即软删除，
// 恢复动线收在「我的 Agent」页自己的「已停用」视图里。

interface DeactivatedAgentsViewProps {
  organizationId: string
  onBack: () => void
  /** 恢复成功后通知父级刷新活跃列表（被恢复的 Agent 会重新出现）。 */
  onRestored: () => void
}

export const DeactivatedAgentsPanel: React.FC<DeactivatedAgentsViewProps> = ({
  organizationId,
  onBack,
  onRestored,
}) => {
  const { t } = useTranslation('settings')
  const reactivateAgent = useSpaceStore(s => s.reactivateAgent)
  const [items, setItems] = useState<DeactivatedAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [restoringIds, setRestoringIds] = useState<Record<string, boolean>>({})
  const [deleteConfirmItem, setDeleteConfirmItem] = useState<DeactivatedAgent | null>(null)

  const loadDeactivated = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const response = await SpaceApiService.listDeactivatedAgents(organizationId)
      setItems(response.items ?? [])
    } catch (error) {
      // 不吞错：加载失败要展示可重试的错误态，不能悄悄降级成空列表。
      log.warn('已停用 Agent 列表加载失败', { organizationId }, error)
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [organizationId])

  useEffect(() => {
    void loadDeactivated()
  }, [loadDeactivated])

  const handleRestore = async (item: DeactivatedAgent) => {
    setRestoringIds(prev => ({ ...prev, [item.id]: true }))
    try {
      const ok = await reactivateAgent(item.id)
      if (!ok) {
        const storeError = useSpaceStore.getState().error
        toast({
          title: storeError || t('myAgents.deactivated.restoreFailed', { defaultValue: '恢复失败，请重试' }),
          variant: 'destructive',
        })
        return
      }
      setItems(prev => prev.filter(a => a.id !== item.id))
      toast({
        title: t('myAgents.deactivated.restoreSuccess', {
          name: item.name,
          defaultValue: `「${item.name}」已恢复`,
        }),
      })
      onRestored()
    } finally {
      setRestoringIds(prev => {
        const next = { ...prev }
        delete next[item.id]
        return next
      })
    }
  }

  const handlePermanentDelete = async () => {
    const item = deleteConfirmItem
    if (!item) return

    try {
      log.info('开始彻底删除已停用 Agent', { agentId: item.id, organizationId })
      await AgentApiService.permanentDeleteAgent(item.id)
      setItems(prev => prev.filter(agent => agent.id !== item.id))
      setDeleteConfirmItem(null)
      log.info('已彻底删除 Agent', { agentId: item.id, organizationId })
      toast({
        title: t('myAgents.deactivated.deleteSuccess', {
          name: item.name,
          defaultValue: `「${item.name}」已彻底删除`,
        }),
      })
    } catch (error) {
      log.error('彻底删除 Agent 失败', { agentId: item.id, organizationId }, error)
      toast({
        title: error instanceof Error
          ? error.message
          : t('myAgents.deactivated.deleteFailed', { defaultValue: '彻底删除失败，请重试' }),
        variant: 'destructive',
      })
      throw error
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="w-fit px-0 text-foreground-secondary"
        >
          <ArrowLeft className="h-[1em] w-[1em]" />
          {t('myAgents.backToList', { defaultValue: '返回 AI 分身列表' })}
        </Button>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-[12px] bg-muted/10 p-2">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-6 text-body text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('myAgents.deactivated.loading', { defaultValue: '正在加载已停用的 AI 分身…' })}
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-start gap-3 px-2 py-6">
            <span className="text-body text-foreground-secondary">
              {t('myAgents.deactivated.loadFailed', { defaultValue: '已停用列表加载失败' })}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => { void loadDeactivated() }}>
              <RotateCcw className="h-[1em] w-[1em]" />
              {t('myAgents.retry', { defaultValue: '重试' })}
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
            <Ban className="h-5 w-5 text-muted-foreground/60" />
            <p className="text-body text-foreground-secondary">
              {t('myAgents.deactivated.empty', { defaultValue: '还没有已停用的 AI 分身。' })}
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {items.map((item) => {
              const isRestoring = Boolean(restoringIds[item.id])
              const relativeTime = formatAgentRelativeTime(item.deactivated_at ?? undefined, t)
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-interactive px-3 py-2 hover:bg-foreground/[0.03]"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-interactive bg-foreground/[0.04] text-muted-foreground">
                      <Bot className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-body font-medium text-foreground">{item.name}</div>
                      {relativeTime ? (
                        <div className={SETTINGS_HINT}>
                          {t('myAgents.deactivated.deactivatedAt', {
                            time: relativeTime,
                            defaultValue: '停用于 {{time}}',
                          })}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isRestoring}
                      onClick={() => { void handleRestore(item) }}
                    >
                      {isRestoring
                        ? <Loader2 className="h-[1em] w-[1em] animate-spin" />
                        : <RotateCcw className="h-[1em] w-[1em]" />}
                      {t('myAgents.deactivated.restore', { defaultValue: '恢复' })}
                    </Button>
                    {!item.is_default ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isRestoring}
                        onClick={() => setDeleteConfirmItem(item)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-[1em] w-[1em]" />
                        {t('myAgents.deactivated.delete', { defaultValue: '彻底删除' })}
                      </Button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        </div>
      </div>
      <ConfirmDialog
        open={deleteConfirmItem !== null}
        onOpenChange={(open) => {
          if (!open && deleteConfirmItem) setDeleteConfirmItem(null)
        }}
        title={t('myAgents.deactivated.deleteConfirmTitle', { defaultValue: '彻底删除 AI 分身？' })}
        description={t('myAgents.deactivated.deleteConfirmDescription', {
          name: deleteConfirmItem?.name ?? '',
          defaultValue: '「{{name}}」的身份配置、技能携带集和记忆将被删除，且无法恢复。历史对话仍会保留。',
        })}
        confirmText={t('myAgents.deactivated.deleteConfirm', { defaultValue: '彻底删除' })}
        variant="destructive"
        onConfirm={handlePermanentDelete}
      />
    </>
  )
}

export default MyAgentsPanel
