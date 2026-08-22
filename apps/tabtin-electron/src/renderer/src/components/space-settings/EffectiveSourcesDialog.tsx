/**
 * EffectiveSourcesDialog — 「本次生效的规则与 Skill」查看器（ W3 / ）。
 *
 * 目录携带（就近优先）/ Agent 携带 / 平台供给；规则区分个人通用与 Agent 专属。
 * 目录 Skill 不再受 Workspace Trust 门控（Trust UI 未落地）。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Folder, Package, UserCog } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  ScrollArea,
} from '@components/ui'
import { useAgentSkillsQuery } from '@/hooks/queries/agentSkills'
import { useSkillsListQuery } from '@/hooks/queries/skills'
// 同源遮蔽判定（安全验证应修项 #3）：与 main 合成（mergeWorkspaceSkillsForRuntime）
// 共用同一纯函数，查看器不自算第二份「谁遮蔽谁」。子路径模块零 node 依赖。
import {
  computeWorkspaceShadowing,
  type SkillSlugRef,
} from '@tabtin/agent-runtime/skills/workspace-skill-merge'
import { classifySkillGroup } from '@components/context-space/skills/skillSourceGroups'
import { getSkillKey } from '@components/context-space/skills/skillPanelFilters'
import { resolveSkillDisplayName } from '@components/context-space/skills/skillSlug'
import { ContextDialogHeader } from '@components/context-space/ContextDialogHeader'
import { useAuthStore } from '@/stores/useAuthStore'
import { useSpaceExecutionAgent } from './hooks/useSpaceExecutionAgent'
import { SETTINGS_GROUP_LABEL } from '@components/settings/settingsUi'
import { cn } from '@utils/cn'

interface WorkspaceScanEntry {
  key: string
  slug: string
  name: string
  display_name?: string
  description?: string
  emoji?: string
  rel_path?: string
}

type WorkspaceSkillScanApi = {
  workspaceScan?: (params: {
    workspaceRoot: string
  }) => Promise<{
    truncated?: boolean
    skills: WorkspaceScanEntry[]
  }>
}

interface EffectiveSourcesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  spaceId: string
  /** 直接指定 Agent（「我的 Agent」详情路径）；缺省按 spaceId 解析执行 Agent。 */
  agentId?: string
}

type SourceKind = 'workspace' | 'agent' | 'platform'

interface EffectiveSkillRow {
  key: string
  label: string
  emoji?: string
  source: SourceKind
  /** 为什么生效/不生效的单句备注（遮蔽 / 待信任 / 停用）。 */
  note?: string
  injected: boolean
}

export const EffectiveSourcesDialog: React.FC<EffectiveSourcesDialogProps> = ({
  open,
  onOpenChange,
  spaceId,
  agentId: directAgentId,
}) => {
  const { t } = useTranslation('context')
  const currentUserId = useAuthStore(s => (s.user?.id != null ? String(s.user.id) : ''))
  const { space, agent, agentId: resolvedAgentId } = useSpaceExecutionAgent(spaceId)
  const agentId = directAgentId ?? resolvedAgentId

  const { data: links = [] } = useAgentSkillsQuery(open ? agentId : null)
  const { data: poolSkills = [] } = useSkillsListQuery(open ? spaceId : null)

  //  PR2b：目录只认 workspace/space 现值（AgentOut 已无 working_dir）
  const workingDir = space?.working_dir ?? ''
  const [workspaceSkills, setWorkspaceSkills] = useState<WorkspaceScanEntry[]>([])

  useEffect(() => {
    let cancelled = false
    if (!open || !workingDir) {
      setWorkspaceSkills([])
      return
    }
    const api = (
      window.tabtin?.skill as (typeof window.tabtin.skill & WorkspaceSkillScanApi) | undefined
    )?.workspaceScan
    if (!api) return
    void api({ workspaceRoot: workingDir })
      .then((result) => {
        if (!cancelled) setWorkspaceSkills(result?.skills ?? [])
      })
      .catch(() => {
        if (!cancelled) setWorkspaceSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [open, workingDir])

  const rows = useMemo<EffectiveSkillRow[]>(() => {
    const out: EffectiveSkillRow[] = []

    // 携带集条目没有独立 slug 字段，从 canonical key 尾段派生（数据可用性妥协，
    // 与后端 slug 定义一致：user:<slug> / platform:<domain>/<slug> 的最后一段）。
    const carriedRefs: Array<SkillSlugRef & { link: (typeof links)[number] }> = links.map(
      (link) => ({
        canonicalKey: link.skill_canonical_key,
        slug: link.skill_canonical_key.split(/[:/]/).pop() ?? '',
        link,
      }),
    )
    const carriedKeys = new Set(carriedRefs.map((r) => r.canonicalKey))
    const platformEntries = poolSkills.filter((skill) => {
      if (carriedKeys.has(getSkillKey(skill))) return false
      const group = classifySkillGroup(skill, currentUserId)
      // 平台供给只列 builtin / device（随运行时常在注入）；用户/团队/市场技能
      // 在 Agent-first 口径下经携带集进入（上面已列）。
      return group === 'builtin' || group === 'device'
    })

    // 同源遮蔽判定：与 main 合成同一纯函数。
    const workspaceRefs: SkillSlugRef[] = workspaceSkills.map((ws) => ({
      canonicalKey: ws.key,
      slug: ws.slug,
    }))
    const baseRefs: SkillSlugRef[] = [
      ...carriedRefs,
      ...platformEntries.map((skill) => ({
        canonicalKey: getSkillKey(skill),
        slug: skill.slug ?? '',
      })),
    ]
    const shadowing = computeWorkspaceShadowing(baseRefs, workspaceRefs)
    const hiddenKeys = new Set(shadowing.shadowed.map((s) => s.hiddenKey))
    const duplicateWorkspaceKeys = new Set(shadowing.duplicateWorkspaceKeys)

    for (const ws of workspaceSkills) {
      const duplicated = duplicateWorkspaceKeys.has(ws.key)
      out.push({
        key: ws.key,
        label: ws.display_name || ws.name,
        emoji: ws.emoji,
        source: 'workspace',
        //  / ：工作区发现；注入看携带集（缺键过渡放行）
        injected: !duplicated,
        note: duplicated
          ? t('skills.effectiveSources.duplicateInWorkspace', {
              defaultValue: '目录内同名，保留更浅层版本',
            })
          : t('skills.effectiveSources.workspaceNote', {
              defaultValue: '来自工作目录 {{path}}',
              path: ws.rel_path ?? '',
            }),
      })
    }

    for (const { link } of carriedRefs) {
      // 历史 workspace: 行不进携带集展示（已在上方工作区区块）
      if (link.skill_canonical_key.startsWith('workspace:')) continue
      const shadowed = hiddenKeys.has(link.skill_canonical_key)
      out.push({
        key: link.skill_canonical_key,
        label: link.name,
        emoji: link.emoji,
        source: 'agent',
        injected: link.enabled && !shadowed,
        note: shadowed
          ? t('skills.effectiveSources.shadowedByWorkspace', { defaultValue: '同名技能以工作目录版本优先' })
          : !link.enabled
            ? t('skills.readiness.disabled')
            : undefined,
      })
    }

    for (const skill of platformEntries) {
      const key = getSkillKey(skill)
      const shadowed = hiddenKeys.has(key)
      out.push({
        key,
        label: resolveSkillDisplayName(skill),
        emoji: skill.emoji,
        source: 'platform',
        injected: !shadowed,
        note: shadowed
          ? t('skills.effectiveSources.shadowedByWorkspace', { defaultValue: '同名技能以工作目录版本优先' })
          : undefined,
      })
    }
    return out
  }, [workspaceSkills, links, poolSkills, currentUserId, t])

  const sourceLabel: Record<SourceKind, string> = {
    workspace: t('skills.effectiveSources.sourceWorkspace', { defaultValue: '目录携带' }),
    agent: t('skills.effectiveSources.sourceAgent', { defaultValue: 'Agent 携带' }),
    platform: t('skills.effectiveSources.sourcePlatform', { defaultValue: '平台供给' }),
  }
  const SourceIcon: Record<SourceKind, React.FC<{ className?: string }>> = {
    workspace: Folder,
    agent: Bot,
    platform: Package,
  }

  const personalRules = (agent?.personal_rules ?? '').trim()
  const customRules = (agent?.custom_rules ?? '').trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <ContextDialogHeader
          className="px-0 pt-0"
          icon={<Package className="h-7 w-7" />}
          title={t('skills.effectiveSources.title', { defaultValue: '本次生效的规则与技能' })}
          description={t('skills.effectiveSources.description', {
            defaultValue: '下一条消息发出时，Agent 会带着这些内容工作。每条都标注了它从哪来。',
          })}
        />

        <ScrollArea className="max-h-[420px]">
          <div className="space-y-5 py-1 pr-2">
            {/* 规则 */}
            <section className="space-y-1.5">
              <h3 className={SETTINGS_GROUP_LABEL}>
                {t('skills.effectiveSources.rulesSection', { defaultValue: '规则' })}
              </h3>
              <RuleRow
                icon={<UserCog className="h-3.5 w-3.5" />}
                label={t('skills.effectiveSources.personalRules', { defaultValue: '个人通用规则' })}
                present={Boolean(personalRules)}
                preview={personalRules}
                emptyText={t('skills.effectiveSources.notSet', { defaultValue: '未设置' })}
              />
              <RuleRow
                icon={<Bot className="h-3.5 w-3.5" />}
                label={t('skills.effectiveSources.agentRules', { defaultValue: 'Agent 专属规则' })}
                present={Boolean(customRules)}
                preview={customRules}
                emptyText={t('skills.effectiveSources.notSet', { defaultValue: '未设置' })}
              />
            </section>

            {/* Skill */}
            <section className="space-y-1.5">
              <h3 className={SETTINGS_GROUP_LABEL}>Skill</h3>
              {rows.length === 0 ? (
                <p className="px-1 py-3 text-body text-muted-foreground/80">
                  {t('skills.effectiveSources.empty', { defaultValue: '没有会生效的技能' })}
                </p>
              ) : (
                rows.map((row) => {
                  const Icon = SourceIcon[row.source]
                  return (
                    <div
                      key={`${row.source}:${row.key}`}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-2 py-1.5',
                        !row.injected && 'opacity-55',
                      )}
                    >
                      <span className="shrink-0 text-body leading-none" aria-hidden>
                        {row.emoji || '🔧'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-body text-foreground">
                        {row.label}
                      </span>
                      {row.note ? (
                        <span className="hidden max-w-[40%] truncate text-caption text-muted-foreground/60 sm:inline">
                          {row.note}
                        </span>
                      ) : null}
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.04] px-1.5 py-px text-caption text-muted-foreground/80">
                        <Icon className="h-3 w-3" />
                        {sourceLabel[row.source]}
                      </span>
                    </div>
                  )
                })
              )}
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

const RuleRow: React.FC<{
  icon: React.ReactNode
  label: string
  present: boolean
  preview: string
  emptyText: string
}> = ({ icon, label, present, preview, emptyText }) => (
  <div className="flex items-start gap-2 rounded-md px-2 py-1.5">
    <span className="mt-0.5 shrink-0 text-muted-foreground/80">{icon}</span>
    <div className="min-w-0 flex-1">
      <p className="text-body font-medium text-foreground">{label}</p>
      <p className={cn('truncate text-caption', present ? 'text-muted-foreground/80' : 'text-muted-foreground/60')}>
        {present ? preview : emptyText}
      </p>
    </div>
  </div>
)
