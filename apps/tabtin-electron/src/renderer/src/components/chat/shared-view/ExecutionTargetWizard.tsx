/**
 * ExecutionTargetWizard — 通用「执行目标」两步向导。
 *
 * 场景：共享任务 fork（shared-fork）与接力接手（take-over-session）都需要
 * 接收人选定「用哪个 Agent × 落到哪个 Workspace」再由服务端物化新会话。
 *
 * 两步：选 Agent（当前用户组织内 Agent 列表，预选最近使用 / 默认 / 第一个）
 * → 选 Workspace（个人 Workspace 列表，显示名称与目录，预选默认执行 Workspace）
 * → 确认。提交动作由调用方 onConfirm 决定；失败 toast 后端 message，弹窗保持打开。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Check, ChevronLeft, Folder, Loader2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@components/ui'
import { toast } from '@tabtin/smartsheet-ui'
import { AgentApiService, type Agent, type Space } from '@tabtin/app-shell'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { resolveDefaultExecutionWorkspaceId } from '@/utils/defaultExecutionSpace'
import { ColorAvatar } from '@components/tabchat/ColorAvatar'
import { createLogger } from '@/utils/logger'
import { cn } from '@utils/cn'

const log = createLogger('ExecutionTargetWizard')

export interface ExecutionTargetWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  /** 提交动作由调用方决定（shared-fork / take-over-session）；抛错则 toast 并保持打开。 */
  onConfirm: (agentId: string, workspaceId: string) => Promise<void>
}

/** 个人执行 Workspace 口径：排除归档与 Project(team_space)，限当前组织。 */
function isPersonalWorkspace(space: Space, organizationId: string | null): boolean {
  return (
    !space.is_archived
    && space.type !== 'team_space'
    && (!organizationId || space.organization_id === organizationId)
  )
}

export const ExecutionTargetWizard: React.FC<ExecutionTargetWizardProps> = ({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
}) => {
  const { t } = useTranslation('chat')
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const spaces = useSpaceStore((s) => s.spaces)
  const selectedAgent = useSpaceStore((s) => s.selectedAgent)

  const [step, setStep] = useState<'agent' | 'workspace'>('agent')
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentsLoading, setAgentsLoading] = useState(false)
  const [agentsLoadFailed, setAgentsLoadFailed] = useState(false)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const workspaces = useMemo(
    () => spaces.filter((space) => isPersonalWorkspace(space, organizationId)),
    [spaces, organizationId],
  )

  // 打开时重置并拉 Agent 列表
  useEffect(() => {
    if (!open) return
    setStep('agent')
    setAgentId(null)
    setWorkspaceId(null)
    setAgentsLoadFailed(false)
    if (!organizationId) {
      setAgents([])
      return
    }
    let cancelled = false
    setAgentsLoading(true)
    AgentApiService.listAgents(organizationId)
      .then((items) => {
        if (cancelled) return
        setAgents(items.filter((agent) => agent.is_active !== false))
      })
      .catch((err) => {
        if (cancelled) return
        log.warn('load agents failed', { organizationId, err })
        setAgents([])
        setAgentsLoadFailed(true)
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, organizationId])

  // 预选 Agent：最近使用（全局 selectedAgent）> 默认身份 > 第一个
  useEffect(() => {
    if (!open || agentId || agents.length === 0) return
    const preferred =
      (selectedAgent && agents.find((a) => a.id === selectedAgent.id))
      ?? agents.find((a) => a.is_default)
      ?? agents[0]
    setAgentId(preferred?.id ?? null)
  }, [open, agents, agentId, selectedAgent])

  // 预选 Workspace：默认执行 Workspace（本机最后使用 > 主场 > 最近活跃）
  useEffect(() => {
    if (!open || workspaceId || workspaces.length === 0) return
    const lastUsed = useSpaceViewPrefsStore.getState().getLastUsedWorkspaceId(organizationId)
    const preferred = resolveDefaultExecutionWorkspaceId(organizationId, workspaces, lastUsed)
    setWorkspaceId(preferred ?? workspaces[0]?.id ?? null)
  }, [open, workspaces, workspaceId, organizationId])

  const handleConfirm = useCallback(async () => {
    if (!agentId || !workspaceId || submitting) return
    setSubmitting(true)
    try {
      await onConfirm(agentId, workspaceId)
      // 成功后由调用方决定关闭 / 导航；这里不主动 onOpenChange(false)，
      // 避免调用方成功回调里已关时二次触发。
    } catch (err) {
      log.warn('execution target confirm failed', { agentId, workspaceId, err })
      toast({
        title: t('executionWizard.confirmFailed', { defaultValue: '操作失败' }),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }, [agentId, workspaceId, submitting, onConfirm, t])

  // 关闭整棵卸载，避免 OverlayContainer 场景幽灵遮罩（同 HandoffCard TranscriptViewer）
  if (!open) return null

  const selectedAgentItem = agents.find((a) => a.id === agentId) ?? null
  const isAgentStep = step === 'agent'

  return (
    <Dialog open onOpenChange={(next) => { if (!submitting) onOpenChange(next) }}>
      <DialogContent
        container={null}
        className="flex w-[420px] max-w-[calc(100vw-32px)] flex-col gap-0 overflow-hidden p-0"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="border-b border-border/60 px-4 py-3">
          <DialogTitle className="text-body font-medium">{title}</DialogTitle>
          <p className="mt-0.5 text-caption text-muted-foreground">
            {description
              ?? (isAgentStep
                ? t('executionWizard.stepAgent', { defaultValue: '第 1 步 · 选择执行 Agent' })
                : t('executionWizard.stepWorkspace', { defaultValue: '第 2 步 · 选择 Workspace' }))}
          </p>
        </div>

        <div className="max-h-[52vh] overflow-y-auto px-2 py-2">
          {isAgentStep ? (
            agentsLoading ? (
              <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-caption text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('executionWizard.loading', { defaultValue: '加载中…' })}
              </div>
            ) : agents.length === 0 ? (
              <div className="px-3 py-6 text-center text-caption text-muted-foreground">
                {agentsLoadFailed
                  ? t('executionWizard.agentsLoadFailed', { defaultValue: 'Agent 列表加载失败，请重试' })
                  : t('executionWizard.noAgents', { defaultValue: '当前组织没有可用的 Agent' })}
              </div>
            ) : (
              agents.map((agent) => {
                const label = agent.display_name || agent.name
                const active = agent.id === agentId
                return (
                  <button
                    key={agent.id}
                    type="button"
                    disabled={submitting}
                    onClick={() => setAgentId(agent.id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                      active ? 'bg-accent/10' : 'hover:bg-muted/40',
                    )}
                  >
                    <ColorAvatar
                      name={label}
                      seed={agent.id}
                      isAgent
                      fallbackIcon={<Bot className="h-3.5 w-3.5" />}
                      className="h-7 w-7"
                      fallbackClassName="text-caption"
                    />
                    <span className="min-w-0 flex-1 truncate text-body text-foreground/90">
                      {label}
                    </span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                  </button>
                )
              })
            )
          ) : workspaces.length === 0 ? (
            <div className="px-3 py-6 text-center text-caption text-muted-foreground">
              {t('executionWizard.noWorkspaces', { defaultValue: '没有可用的个人 Workspace' })}
            </div>
          ) : (
            workspaces.map((space) => {
              const active = space.id === workspaceId
              return (
                <button
                  key={space.id}
                  type="button"
                  disabled={submitting}
                  onClick={() => setWorkspaceId(space.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    active ? 'bg-accent/10' : 'hover:bg-muted/40',
                  )}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/40 text-muted-foreground">
                    <Folder className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-foreground/90">{space.name}</span>
                    {space.working_dir ? (
                      <span className="block truncate text-caption text-muted-foreground/80">
                        {space.working_dir}
                      </span>
                    ) : null}
                  </span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                </button>
              )
            })
          )}
        </div>

        <DialogFooter className="border-t border-border/60 px-4 py-3">
          {isAgentStep ? (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={submitting}
                onClick={() => onOpenChange(false)}
              >
                {t('executionWizard.cancel', { defaultValue: '取消' })}
              </Button>
              <Button
                type="button"
                disabled={!agentId || submitting}
                onClick={() => setStep('workspace')}
              >
                {t('executionWizard.next', { defaultValue: '下一步' })}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={submitting}
                onClick={() => setStep('agent')}
              >
                <ChevronLeft className="mr-1 h-3.5 w-3.5" />
                {t('executionWizard.back', { defaultValue: '上一步' })}
              </Button>
              <Button
                type="button"
                disabled={!agentId || !workspaceId || submitting}
                onClick={() => { void handleConfirm() }}
              >
                {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {t('executionWizard.confirm', {
                  defaultValue: '确认',
                })}
                {selectedAgentItem && !submitting ? (
                  <span className="ml-1 max-w-[96px] truncate font-normal opacity-80">
                    · {selectedAgentItem.display_name || selectedAgentItem.name}
                  </span>
                ) : null}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
