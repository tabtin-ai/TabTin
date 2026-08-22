/**
 * AgentsDetailCanvas — AI 分身域主画布：选中分身的详情 / 已停用列表 / 空态。
 */

import React, { useEffect, useMemo } from 'react'
import { Bot } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useAgentsWorkbenchStore } from '@stores/useAgentsWorkbenchStore'
import { useSkillLibraryContextSpaceId } from '@components/settings/panels/SkillLibraryPanel'
import {
  DeactivatedAgentsPanel,
} from '@components/settings/panels/MyAgentsPanel'
import { AgentWorkbenchDetail } from '@components/layout/agent-workbench/AgentWorkbenchDetail'

export const AgentsDetailCanvas: React.FC = () => {
  const { t } = useTranslation('settings')
  const selectedOrganizationId = useOrganizationStore(
    state => state.selectedOrganization?.id ?? null,
  )
  const workbenchOrganizationId = useAgentsWorkbenchStore(state => state.organizationId)
  const organizationId = selectedOrganizationId
  const agents = useAgentsWorkbenchStore(state => state.agents)
  const loading = useAgentsWorkbenchStore(state => state.loading)
  const selectedAgentId = useAgentsWorkbenchStore(state => state.selectedAgentId)
  const showDeactivated = useAgentsWorkbenchStore(state => state.showDeactivated)
  const rulesDraftByAgentId = useAgentsWorkbenchStore(state => state.rulesDraftByAgentId)
  const focusMemoryId = useAgentsWorkbenchStore(state => state.focusMemoryId)
  const setRulesDraft = useAgentsWorkbenchStore(state => state.setRulesDraft)
  const setShowDeactivated = useAgentsWorkbenchStore(state => state.setShowDeactivated)
  const loadAgents = useAgentsWorkbenchStore(state => state.loadAgents)

  const updateAgent = useSpaceStore(state => state.updateAgent)
  const deleteAgent = useSpaceStore(state => state.deleteAgent)
  const skillContextSpaceId = useSkillLibraryContextSpaceId(organizationId)
  const isOrganizationSynced = workbenchOrganizationId === selectedOrganizationId

  const selectedAgent = useMemo(
    () => agents.find(agent => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  )

  useEffect(() => {
    if (agents.length === 0) return
    if (!selectedAgentId || !agents.some(agent => agent.id === selectedAgentId)) {
      useAgentsWorkbenchStore.getState().setSelectedAgentId(agents[0]?.id ?? null)
    }
  }, [agents, selectedAgentId])

  const handleAgentUpdated = () => {
    void loadAgents()
  }

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      data-testid="agents-detail-canvas"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-5">
        {!isOrganizationSynced ? (
          <div
            className="flex h-full items-center justify-center text-body text-muted-foreground"
            data-testid="agents-detail-loading"
          >
            {t('myAgents.loading', { defaultValue: '正在加载 AI 分身…' })}
          </div>
        ) : showDeactivated && organizationId ? (
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover">
            <DeactivatedAgentsPanel
              organizationId={organizationId}
              onBack={() => setShowDeactivated(false)}
              onRestored={handleAgentUpdated}
            />
          </div>
        ) : selectedAgent && organizationId ? (
          <AgentWorkbenchDetail
            organizationId={organizationId}
            agent={selectedAgent}
            skillContextSpaceId={skillContextSpaceId}
            updateAgent={updateAgent}
            deleteAgent={deleteAgent}
            onUpdated={handleAgentUpdated}
            onDeactivated={handleAgentUpdated}
            rulesDraft={rulesDraftByAgentId[selectedAgent.id] ?? null}
            onRulesDraftChange={(draft) => setRulesDraft(selectedAgent.id, draft)}
            focusMemoryId={focusMemoryId}
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
      </div>
    </div>
  )
}

AgentsDetailCanvas.displayName = 'AgentsDetailCanvas'
