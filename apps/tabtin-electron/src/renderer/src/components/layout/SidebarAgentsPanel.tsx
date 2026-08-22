/**
 * SidebarAgentsPanel — AI 分身域侧栏：顶栏动作 + 分身列表。
 *
 * 列表行复用 SIDEBAR_ROW / ConversationItem 同款 token，不走设置页 MyAgentsPanel 样式。
 */

import React, { useCallback, useEffect, useRef } from 'react'
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { Button } from '@components/ui'
import { NavigationListSkeleton } from '@components/common/ListSkeletons'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useAgentsWorkbenchStore } from '@stores/useAgentsWorkbenchStore'
import { NewAgentDialog } from '@components/sidebar/NewAgentButton'
import { listAgentTemplates } from '@/services/agentTemplatesApi'
import { organizationAgentSummaryFromAgent } from '@/services/organizationAgentsApi'
import { expandAgentName } from '@utils/agentNameInterpolation'
import { resolveAgentSourceBadge } from '@utils/agentSourceBadge'
import { createLogger } from '@/utils/logger'
import { formatAgentRelativeTime } from '@components/settings/panels/MyAgentsPanel'
import { AgentSidebarListItem } from './AgentSidebarListItem'
import { SidebarAgentsPrimaryNav } from './SidebarAgentsPrimaryNav'
import {
  SIDEBAR_EMPTY_TEXT,
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_SECTION_LABEL,
  SIDEBAR_ROW_LIST,
} from './sidebarUi'

const log = createLogger('SidebarAgentsPanel')

export const SidebarAgentsPanel: React.FC = React.memo(() => {
  const { t } = useTranslation('settings')
  const selectedOrganizationId = useOrganizationStore(
    state => state.selectedOrganization?.id ?? null,
  )
  const ownerName = useAuthStore(
    state => state.user?.nickname?.trim() || state.user?.username?.trim() || '',
  )

  const agents = useAgentsWorkbenchStore(state => state.agents)
  const loading = useAgentsWorkbenchStore(state => state.loading)
  const loadError = useAgentsWorkbenchStore(state => state.loadError)
  const selectedAgentId = useAgentsWorkbenchStore(state => state.selectedAgentId)
  const showDeactivated = useAgentsWorkbenchStore(state => state.showDeactivated)
  const newAgentOpen = useAgentsWorkbenchStore(state => state.newAgentOpen)
  const rulesDraftByAgentId = useAgentsWorkbenchStore(state => state.rulesDraftByAgentId)
  const setOrganizationId = useAgentsWorkbenchStore(state => state.setOrganizationId)
  const setSelectedAgentId = useAgentsWorkbenchStore(state => state.setSelectedAgentId)
  const selectCreatedAgent = useAgentsWorkbenchStore(state => state.selectCreatedAgent)
  const setShowDeactivated = useAgentsWorkbenchStore(state => state.setShowDeactivated)
  const setNewAgentOpen = useAgentsWorkbenchStore(state => state.setNewAgentOpen)
  const loadAgents = useAgentsWorkbenchStore(state => state.loadAgents)
  const applyMemoryFocus = useAgentsWorkbenchStore(state => state.applyMemoryFocus)

  const [templateNameById, setTemplateNameById] = React.useState<Record<string, string>>({})
  const agentListRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setOrganizationId(selectedOrganizationId)
  }, [selectedOrganizationId, setOrganizationId])

  useEffect(() => {
    if (!selectedOrganizationId) return
    void loadAgents()
  }, [loadAgents, selectedOrganizationId])

  useEffect(() => {
    applyMemoryFocus()
  }, [agents, applyMemoryFocus])

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
        log.warn('Agent 模板加载失败，来源角标降级', { organizationId: selectedOrganizationId }, error)
      })
    return () => { cancelled = true }
  }, [ownerName, selectedOrganizationId])

  const listTitle = t('myAgents.listTitle', { defaultValue: '我的 AI 分身' })

  const handleAgentListKeyDown = useCallback((
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
    const buttons = agentListRef.current?.querySelectorAll<HTMLButtonElement>('[data-agent-option]')
    buttons?.[nextIndex]?.focus()
  }, [agents, setSelectedAgentId])

  const handleToggleDeactivated = useCallback(() => {
    setShowDeactivated(!showDeactivated)
  }, [setShowDeactivated, showDeactivated])

  const createDisabled = !selectedOrganizationId

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent" data-testid="sidebar-agents-panel">
      <SidebarAgentsPrimaryNav
        isDeactivatedActive={showDeactivated}
        createDisabled={createDisabled}
        onCreateAgent={() => setNewAgentOpen(true)}
        onToggleDeactivated={handleToggleDeactivated}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className={cn(SIDEBAR_SECTION_HEADER, 'flex items-center pb-1 pt-0')}>
          <span className={SIDEBAR_SECTION_LABEL}>{listTitle}</span>
        </div>

        <div
          ref={agentListRef}
          className="min-h-0 flex-1 overflow-y-auto py-1 scrollbar-hover"
          aria-label={listTitle}
        >
          {loading && agents.length === 0 ? (
            <NavigationListSkeleton count={4} />
          ) : loadError ? (
            <div className="flex flex-col items-start gap-3 px-3 py-6">
              <span className={cn(SIDEBAR_EMPTY_TEXT, 'text-muted-foreground/80')}>
                {t('myAgents.loadFailed', { defaultValue: 'AI 分身列表加载失败' })}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => { void loadAgents() }}>
                <RotateCcw className="h-[1em] w-[1em]" />
                {t('myAgents.retry', { defaultValue: '重试' })}
              </Button>
            </div>
          ) : agents.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <p className={cn('text-center leading-5', SIDEBAR_EMPTY_TEXT, 'text-muted-foreground/80')}>
                {t('myAgents.empty', { defaultValue: '还没有 AI 分身，先开一个新分身。' })}
              </p>
            </div>
          ) : (
            <div className={SIDEBAR_ROW_LIST}>
              {agents.map((agent, index) => {
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
                )
                const isSelected = !showDeactivated && agent.id === selectedAgentId
                return (
                  <AgentSidebarListItem
                    key={agent.id}
                    agent={agent}
                    isActive={isSelected}
                    sourceLabel={sourceLabel ?? t('myAgents.customBadge', { defaultValue: '自建' })}
                    relativeTime={relativeTime || undefined}
                    hasDraft={rulesDraftByAgentId[agent.id] != null}
                    unsavedLabel={t('myAgents.unsaved', { defaultValue: '未保存' })}
                    onSelect={() => setSelectedAgentId(agent.id)}
                    onKeyDown={(event) => handleAgentListKeyDown(event, index)}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>

      <NewAgentDialog
        open={newAgentOpen}
        organizationId={selectedOrganizationId}
        onOpenChange={(open) => {
          setNewAgentOpen(open)
          if (!open) void loadAgents()
        }}
        onAgentCreated={(agent) => {
          selectCreatedAgent(organizationAgentSummaryFromAgent(agent))
        }}
      />
    </div>
  )
})

SidebarAgentsPanel.displayName = 'SidebarAgentsPanel'
