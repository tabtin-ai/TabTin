import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { notifyManager, useQueryClient, useQueries, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ScrollArea,
  Skeleton,
  toast,
} from '@components/ui'
import { cn } from '@utils/cn'
import {
  agentSkillKeys,
  fetchAgentSkills,
  useAttachAgentSkillMutation,
  useDetachAgentSkillMutation,
} from '@/hooks/queries/agentSkills'
import { skillKeys, useEnableSkillMutation } from '@/hooks/queries/skills'
import { SpaceAccessApiService } from '@/services/spaceAccessApi'
import { useAuthStore } from '@/stores/useAuthStore'
import type { SkillIndexEntry } from '@/skills/types'
import type { OrganizationAgent } from '@/types/space-access'
import {
  buildAgentIdsBySkillKey,
  isAgentCarryingSkill,
  resolveLockedAssignedAgentIds,
  shouldSeedSelectionFromAssignments,
} from './skillAgentAssignment'
import { resolveSkillDisplayName } from './skillSlug'
import { isDeviceSkill } from './skillPanelFilters'
import { isMarketplaceMineSkill } from './skillSourceGroups'
import { isWorkspaceScanSkill } from './workspaceSkillScan'
import { createLogger } from '@/utils/logger'

const log = createLogger('Skills')

export function useSkillAgentAssignments(
  organizationId: string | null,
  enabled: boolean,
) {
  const currentUserId = useAuthStore(state => state.user?.id != null ? String(state.user.id) : '')
  const agentQuery = useQuery({
    queryKey: ['organization-agents', organizationId ?? ''] as const,
    queryFn: async (): Promise<OrganizationAgent[]> => {
      const result = await SpaceAccessApiService.listOrganizationAgents(organizationId!)
      return result.agents ?? []
    },
    enabled: enabled && !!organizationId,
    staleTime: 60_000,
  })

  const agents = useMemo(
    () => (agentQuery.data ?? []).filter(agent =>
      agent.is_active
      && (
        String(agent.owner_user_id ?? '') === currentUserId
        || String(agent.user_id ?? '') === currentUserId
      ),
    ),
    [agentQuery.data, currentUserId],
  )

  const skillQueries = useQueries({
    queries: agents.map(agent => ({
      queryKey: agentSkillKeys.list(agent.id),
      queryFn: () => fetchAgentSkills(agent.id),
      enabled,
      staleTime: 30_000,
    })),
  })

  const agentIdsBySkillKey = useMemo(
    () => buildAgentIdsBySkillKey(
      agents,
      skillQueries.map(query => query.data),
    ),
    [agents, skillQueries],
  )
  const defaultAgentLinkedKeys = useMemo(() => {
    const defaultAgentIndex = agents.findIndex(agent => agent.is_default === true)
    const keys = new Set<string>()
    if (defaultAgentIndex < 0) return keys
    for (const link of skillQueries[defaultAgentIndex]?.data ?? []) {
      if (link.skill_canonical_key) keys.add(link.skill_canonical_key)
    }
    return keys
  }, [agents, skillQueries])

  return {
    agents,
    agentIdsBySkillKey,
    defaultAgentLinkedKeys,
    isLoading: agentQuery.isLoading || skillQueries.some(query => query.isLoading),
  }
}

interface AssignSkillToAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  skill: SkillIndexEntry | null
  organizationId: string | null
  spaceId: string
  agents: OrganizationAgent[]
  assignedAgentIds: string[]
  assignmentsLoading?: boolean
}

export const AssignSkillToAgentDialog: React.FC<AssignSkillToAgentDialogProps> = ({
  open,
  onOpenChange,
  skill,
  organizationId,
  spaceId,
  agents,
  assignedAgentIds,
  assignmentsLoading = false,
}) => {
  const { t } = useTranslation('context')
  const queryClient = useQueryClient()
  const currentUserId = useAuthStore(state => state.user?.id != null ? String(state.user.id) : '')
  const attachMutation = useAttachAgentSkillMutation()
  const detachMutation = useDetachAgentSkillMutation()
  const acquireMutation = useEnableSkillMutation()
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const seededForOpenRef = useRef(false)

  // ：只在打开且加载完成后播种一次；保存刷新不得用 props 覆盖本地勾选。
  useEffect(() => {
    if (!open) {
      seededForOpenRef.current = false
      return
    }
    if (!shouldSeedSelectionFromAssignments({
      open,
      assignmentsLoading,
      seededForOpen: seededForOpenRef.current,
    })) {
      return
    }
    seededForOpenRef.current = true
    setSelectedAgentIds(new Set(assignedAgentIds))
  }, [open, assignmentsLoading, assignedAgentIds])

  if (!skill) return null

  const skillName = resolveSkillDisplayName(skill)
  const canonicalKey = skill.skill_key || ''
  const managedCanonicalKey = skill.acquired_copy_skill_key || canonicalKey
  const lockedAgentIds = resolveLockedAssignedAgentIds(
    agents,
    assignedAgentIds,
    managedCanonicalKey,
    skill.source,
  )
  const mutableAgents = agents.filter(agent => !lockedAgentIds.has(agent.id))
  const allMutableSelected = mutableAgents.length > 0
    && mutableAgents.every(agent => selectedAgentIds.has(agent.id))
  const lockedTooltip = t('skills.agentSkills.lockedTooltip', {
    defaultValue: '系统预置分身的默认技能不可关闭或收回',
  })

  const toggleAgent = (agentId: string, checked: boolean) => {
    if (lockedAgentIds.has(agentId)) return
    setSelectedAgentIds(current => {
      const next = new Set(current)
      if (checked) next.add(agentId)
      else next.delete(agentId)
      return next
    })
  }

  /**
   * 一次取齐并批量写回所有 Agent 携带集，避免每份查询先后完成时把卡片数量
   * 渲染成 1→2→…→N。失败后也用同一路径回正勾选（认 agent_enabled）。
   */
  const syncSelectionFromServer = async (skillCanonicalKey: string): Promise<void> => {
    const lists = await Promise.all(
      agents.map(agent => fetchAgentSkills(agent.id)),
    )
    notifyManager.batch(() => {
      agents.forEach((agent, index) => {
        queryClient.setQueryData(agentSkillKeys.list(agent.id), lists[index] ?? [])
      })
    })
    void queryClient.invalidateQueries({ queryKey: skillKeys.all })

    const next = new Set<string>()
    agents.forEach((agent, index) => {
      const carried = (lists[index] ?? []).some(
        link => link.skill_canonical_key === skillCanonicalKey && isAgentCarryingSkill(link),
      )
      if (carried) next.add(agent.id)
    })
    setSelectedAgentIds(next)
  }

  const handleSave = async () => {
    if (!canonicalKey || !organizationId) return
    const initial = new Set(assignedAgentIds)
    const additions = agents.filter(agent =>
      selectedAgentIds.has(agent.id) && !initial.has(agent.id),
    )
    const removals = agents.filter(agent =>
      initial.has(agent.id) && !selectedAgentIds.has(agent.id),
    )

    setSaving(true)
    let effectiveCanonicalKey = managedCanonicalKey
    try {
      await queryClient.cancelQueries({ queryKey: agentSkillKeys.all })
      // 获取必须先成功；携带集变更用 allSettled，避免中途失败留下不可见半完成态。
      // 本人拥有的 user Skill（含分享到组织）已在库中，不必再走「获取」。
      // attach 成功时后端仍会打开用户总闸。
      let acquiredSkill = skill
      if (
        !isWorkspaceScanSkill(skill)
        && !isDeviceSkill(skill)
        && !isMarketplaceMineSkill(skill, currentUserId)
        && !skill.acquired_copy_skill_key
      ) {
        const acquisition = await acquireMutation.mutateAsync({
          canonicalKey,
          spaceId,
          skill,
        })
        effectiveCanonicalKey = acquisition.skill_canonical_key || canonicalKey
        acquiredSkill = acquisition.skill || skill
      }

      const results = await Promise.allSettled([
        ...additions.map(agent => attachMutation.mutateAsync({
          agentId: agent.id,
          skillCanonicalKey: effectiveCanonicalKey,
          skill: acquiredSkill,
          spaceId,
          organizationId,
          deferQueryInvalidation: true,
        })),
        ...removals.map(agent => detachMutation.mutateAsync({
          agentId: agent.id,
          skillCanonicalKey: effectiveCanonicalKey,
          spaceId,
          deferQueryInvalidation: true,
        })),
      ])

      const failed = results.filter(result => result.status === 'rejected').length
      const succeeded = results.length - failed
      if (failed === 0) {
        await syncSelectionFromServer(effectiveCanonicalKey)
        // 先原子写回最终携带集再关弹层，卡片只渲染一次最终数量。
        toast.success(t('skills.marketplace.agentDialog.saved'))
        onOpenChange(false)
        return
      }

      await syncSelectionFromServer(effectiveCanonicalKey)
      const firstError = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )?.reason
      log.error('保存 Skill Agent 配置部分失败', {
        canonicalKey,
        succeeded,
        failed,
      }, firstError)
      toast.error(
        succeeded > 0
          ? t('skills.marketplace.agentDialog.partialFailed', {
              succeeded,
              failed,
              defaultValue: `部分保存成功（${succeeded} 成功，${failed} 失败），已刷新为当前实际配置`,
            })
          : (firstError instanceof Error
            ? firstError.message
            : t('skills.marketplace.agentDialog.failed')),
      )
    } catch (error) {
      await syncSelectionFromServer(effectiveCanonicalKey)
      log.error('保存 Skill Agent 配置失败', { canonicalKey }, error)
      toast.error(error instanceof Error ? error.message : t('skills.marketplace.agentDialog.failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-3rem)] max-w-[540px] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/80 px-5 pb-4 pt-[18px] text-left">
          <DialogTitle className="text-subtitle font-semibold">
            {t('skills.marketplace.agentDialog.title', { name: skillName })}
          </DialogTitle>
          <DialogDescription className="mt-1 text-body leading-relaxed text-muted-foreground/80">
            {t('skills.marketplace.agentDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 px-5 py-4">
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-border/80 bg-muted/30 px-3 py-2.5 text-body leading-relaxed text-muted-foreground/80">
            <strong className="shrink-0 font-semibold text-foreground">
              {t('skills.marketplace.agentDialog.contextTitle')}
            </strong>
            <span>{t('skills.marketplace.agentDialog.contextBody')}</span>
          </div>

          <div className="mb-2.5 flex items-center gap-2">
            <h3 className="min-w-0 flex-1 text-body font-semibold text-foreground">
              {t('skills.marketplace.agentDialog.availableAgents')}
            </h3>
            <span className="text-caption tabular-nums text-muted-foreground/60">
              {t('skills.marketplace.agentDialog.selectedCount', { count: selectedAgentIds.size })}
            </span>
            <button
              type="button"
              className="text-caption font-medium text-accent-text hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline"
              disabled={mutableAgents.length === 0}
              onClick={() => setSelectedAgentIds(
                allMutableSelected
                  ? new Set(lockedAgentIds)
                  : new Set(agents.map(agent => agent.id)),
              )}
            >
              {allMutableSelected
                ? t('skills.marketplace.agentDialog.clearAll')
                : t('skills.marketplace.agentDialog.selectAll')}
            </button>
          </div>

          <ScrollArea className="max-h-[360px]">
            <div className="grid gap-2 pr-1">
              {assignmentsLoading ? (
                [1, 2, 3].map(item => (
                  <div key={item} className="h-[52px]">
                    <Skeleton height="100%" rounded="lg" />
                  </div>
                ))
              ) : agents.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/80 px-3 py-8 text-center text-body text-muted-foreground/60">
                  {t('skills.marketplace.agentDialog.empty')}
                </p>
              ) : agents.map(agent => {
                const checked = selectedAgentIds.has(agent.id)
                const locked = lockedAgentIds.has(agent.id)
                return (
                  <label
                    key={agent.id}
                    title={locked ? lockedTooltip : undefined}
                    className={cn(
                      'flex cursor-pointer items-start gap-2.5 rounded-[9px] border px-3 py-2.5 transition-colors',
                      locked
                        ? 'cursor-not-allowed border-border/60 bg-muted/30 opacity-55'
                        : checked
                        ? 'border-accent/60 bg-accent/5'
                        : 'border-border/80 hover:border-border hover:bg-muted/20',
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={locked}
                      onCheckedChange={value => toggleAgent(agent.id, value === true)}
                      aria-label={locked
                        ? t('skills.marketplace.agentDialog.lockedAriaLabel', {
                            name: agent.name,
                            defaultValue: '{{name}}，默认 Agent 必须保留此 Skill',
                          })
                        : agent.name}
                      className="mt-0.5"
                    />
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-caption font-semibold text-accent-text">
                      {agent.name.trim().slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-semibold text-foreground">
                        {agent.name}
                        {locked ? (
                          <span className="ml-2 align-middle text-caption font-medium text-muted-foreground">
                            {t('skills.marketplace.agentDialog.lockedLabel', {
                              defaultValue: '默认·必选',
                            })}
                          </span>
                        ) : null}
                      </span>
                      {agent.goal ? (
                        <span className="mt-0.5 block break-words text-caption text-muted-foreground/60">
                          {agent.goal}
                        </span>
                      ) : null}
                    </span>
                  </label>
                )
              })}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter className="border-t border-border/80 px-5 py-3.5">
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            {t('common.cancel', { defaultValue: '取消' })}
          </Button>
          <Button type="button" disabled={saving || assignmentsLoading || !canonicalKey} onClick={() => { void handleSave() }}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('skills.marketplace.agentDialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
