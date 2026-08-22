import React, { useEffect, useMemo, useState } from 'react'
import { AgentApiService, type Agent } from '@tabtin/app-shell'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  toast,
} from '@components/ui'
import { useAppCollaborationStore } from '@stores/useAppCollaborationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { enterChatSession } from '@/services/chatSessionNavigation'
import { resolveDefaultExecutionWorkspaceId } from '@/utils/defaultExecutionSpace'
import { createLogger } from '@/utils/logger'

const log = createLogger('AppCollaborationDialog')

export const AppCollaborationDialogHost: React.FC = () => {
  const request = useAppCollaborationStore(state => state.request)
  const close = useAppCollaborationStore(state => state.close)
  const userId = useAuthStore(state => state.user?.id ?? null)
  const organizationId = useOrganizationStore(state => state.selectedOrganization?.id ?? null)
  const spaces = useSpaceStore(state => state.spaces)
  const selectedAgent = useSpaceStore(state => state.selectedAgent)
  const lastUsedWorkspaceId = useSpaceViewPrefsStore(state =>
    state.getLastUsedWorkspaceId(organizationId),
  )
  const [agents, setAgents] = useState<Agent[]>([])
  const [spaceId, setSpaceId] = useState('')
  const [agentId, setAgentId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const availableSpaces = useMemo(
    () => spaces.filter(space => (
      !space.is_archived &&
      space.type !== 'team_space' &&
      (!organizationId || space.organization_id === organizationId)
    )),
    [organizationId, spaces],
  )
  const activeAgents = useMemo(
    () => agents.filter(agent => agent.is_active !== false),
    [agents],
  )
  const selectedWorkspace = useMemo(
    () => availableSpaces.find(space => space.id === spaceId) ?? null,
    [availableSpaces, spaceId],
  )
  const defaultWorkspaceId = useMemo(
    () => resolveDefaultExecutionWorkspaceId(
      organizationId,
      availableSpaces,
      lastUsedWorkspaceId,
    ),
    [availableSpaces, lastUsedWorkspaceId, organizationId],
  )

  useEffect(() => {
    if (!request) return
    setSpaceId(
      availableSpaces.some(space => space.id === request.preferredSpaceId)
        ? request.preferredSpaceId
        : defaultWorkspaceId ?? '',
    )
    setPrompt(request.prompt)
  }, [availableSpaces, defaultWorkspaceId, request])

  useEffect(() => {
    if (!request || !organizationId) {
      setAgents([])
      return
    }
    let cancelled = false
    const agentApi = AgentApiService as typeof AgentApiService & {
      listAgents: (targetOrganizationId: string) => Promise<Agent[]>
    }
    void agentApi.listAgents(organizationId)
      .then((items: Agent[]) => {
        if (cancelled) return
        const nextActiveAgents = items.filter(agent => agent.is_active !== false)
        setAgents(items)
        setAgentId(
          selectedAgent && nextActiveAgents.some(agent => agent.id === selectedAgent.id)
            ? selectedAgent.id
            : nextActiveAgents[0]?.id ?? '',
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          log.warn('load agents failed', error)
          toast.error('无法加载 Agent 列表')
        }
      })
    return () => {
      cancelled = true
    }
  }, [organizationId, request, selectedAgent])

  const handleConfirm = async () => {
    if (!request || !spaceId || !agentId || !prompt.trim() || submitting) return
    const agent = activeAgents.find(item => item.id === agentId)
    const space = availableSpaces.find(item => item.id === spaceId)
    if (!agent || !space) return

    setSubmitting(true)
    try {
      useSpaceStore.setState({ selectedAgent: agent })
      await useChatStore.getState().createSession(space.id, space.organization_id)
      const sessionId = useChatStore.getState().currentSessionIdBySpaceId[space.id] ?? null
      if (!sessionId) throw new Error('Session was not created')

      const scopeKey = `conversation:${sessionId}`
      if (request.sourceItem) {
        useSpaceContextTabsStore.getState().openResourceTab(scopeKey, {
          type: request.sourceItem.type,
          id: request.sourceItem.id,
          title: request.sourceItem.title,
          meta: request.sourceItem.meta,
          silent: true,
        })
      }
      useSpaceViewPrefsStore.getState().setTaskViewModeForScope(scopeKey, 'chat-focus')
      if (userId) {
        useSpaceViewPrefsStore.getState().setSidebarModeForOrganizationUser(
          space.organization_id,
          userId,
          'conversations',
        )
      }
      useMainNavStore.getState().setCurrentTab('agent')
      const entered = await enterChatSession(space.id, sessionId, {
        organizationId: space.organization_id,
      })
      if (!entered) throw new Error('Session navigation failed')
      close()

      void useChatStore.getState().sendMessage(
          prompt.trim(),
          true,
          undefined,
          request.contextBlocks,
          sessionId,
        )
        .catch(error => {
          log.warn('send collaboration message failed', error)
          toast.error('任务已创建，但消息发送失败，请在任务中重试')
        })
    } catch (error) {
      log.warn('create collaboration task failed', error)
      toast.error('发起协作失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={Boolean(request)} onOpenChange={open => { if (!open && !submitting) close() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>发起小Tin协作</DialogTitle>
        </DialogHeader>
        {request ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-body">
              来源：{request.sourceItem?.title || request.sourceLabel}
            </div>
            <label className="block space-y-1.5 text-body">
              <span className="text-muted-foreground">工作空间</span>
              <select
                aria-label="工作空间"
                value={spaceId}
                onChange={event => setSpaceId(event.target.value)}
                className="h-9 w-full rounded-interactive border border-border bg-background px-3"
              >
                {availableSpaces.map(space => (
                  <option key={space.id} value={space.id}>{space.name}</option>
                ))}
              </select>
              <span className="block truncate text-caption text-muted-foreground/60">
                执行目录：{selectedWorkspace?.working_dir || '由 Workspace 执行绑定决定'}
              </span>
            </label>
            <label className="block space-y-1.5 text-body">
              <span className="text-muted-foreground">执行 Agent</span>
              <select
                aria-label="执行 Agent"
                value={agentId}
                onChange={event => setAgentId(event.target.value)}
                className="h-9 w-full rounded-interactive border border-border bg-background px-3"
              >
                {activeAgents.map(agent => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5 text-body">
              <span className="text-muted-foreground">协作任务</span>
              <textarea
                aria-label="协作任务"
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
                rows={4}
                className="w-full resize-none rounded-interactive border border-border bg-background p-3"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={close} disabled={submitting}>取消</Button>
              <Button
                onClick={() => { void handleConfirm() }}
                disabled={submitting || !spaceId || !agentId || !prompt.trim()}
              >
                {submitting ? '正在创建…' : '确认发起'}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
