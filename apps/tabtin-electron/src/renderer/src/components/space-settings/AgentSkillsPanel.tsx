/**
 * AgentSkillsPanel — Agent 详情页「技能」携带集视图（ W3）。
 *
 * Agent-first 心智：Skill 是教给 Agent 的本事，跟 Agent 走、不跟房间走。
 * 本面板展示 Agent 的携带集（它会什么）：
 *   - 左列名单：技能名 + 来源分组 + 启用开关（PATCH）+ 私有配置 + 移除（DELETE）
 *   - 右列说明书：会做什么 / 什么时候用 / 怎么叫（AgentSkillGuide）
 *   - 「添加技能」：技能池左选右看，确认后再 POST 携带集（幂等）
 *   - 「已修改」badge：本地物料指纹 ≠ 安装基线（客户端判定，随技能池匹配补出）
 *
 * 携带集走 agent 维度 API（AgentSkillLink）；技能池（useSkillsListQuery）
 * 按组织加载，只作 meta 补全与挑选数据源。
 * 独立组件、独立文件——与同期 IA 线的 Agent 入口改动保持最小冲突面。
 */
import React, { useMemo, useState } from 'react'
import {
  AlertCircle,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  Input,
  ScrollArea,
  Skeleton,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  toast,
} from '@components/ui'
import {
  useAgentSkillsQuery,
  useAttachAgentSkillMutation,
  useDetachAgentSkillMutation,
  useUpdateAgentSkillLinkMutation,
} from '@/hooks/queries/agentSkills'
import { useSkillsListQuery } from '@/hooks/queries/skills'
import { useAuthStore } from '@/stores/useAuthStore'
import type { AgentSkillLinkItem, SkillIndexEntry } from '@/skills/types'
import { classifySkillGroup } from '@components/context-space/skills/skillSourceGroups'
import {
  canAssignSkillToAgent,
  filterSkillsBySearch,
  getSkillKey,
} from '@components/context-space/skills/skillPanelFilters'
import { useSkillLocalChanges } from '@components/context-space/skills/useSkillLocalChanges'
import {
  formatSkillPanelTitle,
  resolveSkillCarryTitle,
  resolveSkillDisplayName,
} from '@components/context-space/skills/skillSlug'
import { ContextDialogHeader } from '@components/context-space/ContextDialogHeader'
import { useSpaceExecutionAgent } from './hooks/useSpaceExecutionAgent'
import { AgentSkillConfigDialog } from './AgentSkillConfigDialog'
import { AgentSkillGuide, AgentSkillGuideEmpty } from './AgentSkillGuide'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'

const log = createLogger('Skills')

// ---------------------------------------------------------------------------
// 携带行 ↔ 技能池匹配
// ---------------------------------------------------------------------------

function buildPoolIndex(poolSkills: SkillIndexEntry[]): Map<string, SkillIndexEntry> {
  const index = new Map<string, SkillIndexEntry>()
  for (const skill of poolSkills) {
    const key = getSkillKey(skill)
    if (key) index.set(key, skill)
  }
  return index
}

function buildDiscoveredDeviceLinks(
  poolSkills: SkillIndexEntry[],
  carriedKeys: ReadonlySet<string>,
): AgentSkillLinkItem[] {
  return poolSkills.flatMap((skill) => {
    const key = getSkillKey(skill)
    if (!key || skill.source !== 'device' || carriedKeys.has(key)) return []
    return [{
      skill_canonical_key: key,
      source: 'device',
      skill_id: skill.skill_id || null,
      enabled: true,
      agent_enabled: true,
      user_enabled: true,
      config_json: {},
      name: resolveSkillDisplayName(skill),
      description: skill.description || '',
      emoji: skill.emoji || '',
      created_at: null,
      updated_at: null,
    }]
  })
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface AgentSkillsPanelProps {
  spaceId: string
  /**
   * 直接指定 Agent（「设置 → 我的 Agent」详情路径）：跳过按 spaceId
   * 解析执行 Agent 的步骤。spaceId 此时仅作为技能池（picker）的查询锚。
   */
  agentId?: string
  canManage: boolean
  /** 默认 Agent：平台 / 已装 App Skill 锁定不可关；也可由 link.locked 权威判定 */
  isDefaultAgent?: boolean
}

function isDefaultAgentLockedSkill(
  link: AgentSkillLinkItem,
  isDefaultAgent: boolean,
): boolean {
  // 后端 link.locked 权威（已排除 marketplace 推荐 pack）。
  if (link.locked === true) return true
  if (link.locked === false) return false
  if (!isDefaultAgent) return false
  const prefix = (link.skill_canonical_key || '').split(':')[0]
  if (prefix === 'platform') return true
  if (prefix === 'app') {
    // 缺 locked 字段时的回退：marketplace 推荐 pack 可关；其余 app 仍锁定。
    const distribution = (link.config_json as { distribution?: string } | null | undefined)
      ?.distribution
    return distribution !== 'marketplace'
  }
  return false
}

export const AgentSkillsPanel: React.FC<AgentSkillsPanelProps> = ({
  spaceId,
  agentId: directAgentId,
  canManage,
  isDefaultAgent = false,
}) => {
  const { t } = useTranslation('context')
  const currentUserId = useAuthStore(state => state.user?.id != null ? String(state.user.id) : '')
  const { agentId: resolvedAgentId, isLoading: resolveLoading } = useSpaceExecutionAgent(spaceId)
  const agentId = directAgentId ?? resolvedAgentId
  const agentLoading = directAgentId ? false : resolveLoading

  const {
    data: links = [],
    isLoading: linksLoading,
    isError,
    error,
    refetch,
  } = useAgentSkillsQuery(agentId)
  // 携带集是 Agent 私有资源：非 owner 时后端 get_agent 返回 None，API 发 404
  // （历史注释写 403）。两种状态码都给明确权限提示，避免伪装成笼统失败。
  const errorStatus = (error as { status?: number } | null)?.status
  const isForbidden = isError && (errorStatus === 403 || errorStatus === 404)
  const {
    data: poolSkills = [],
    isLoading: poolSkillsLoading,
    isError: poolSkillsError,
    refetch: refetchPoolSkills,
  } = useSkillsListQuery(spaceId)
  const localChanges = useSkillLocalChanges(poolSkills)

  const attachMutation = useAttachAgentSkillMutation()
  const detachMutation = useDetachAgentSkillMutation()
  const updateLinkMutation = useUpdateAgentSkillLinkMutation()

  const poolIndex = useMemo(() => buildPoolIndex(poolSkills), [poolSkills])
  const carriedKeys = useMemo(
    () => new Set(links.map(l => l.skill_canonical_key)),
    [links],
  )
  // ：工作区目录 Skill 不进携带集 UI（历史 opt-out 行也隐藏）
  const regularLinks = useMemo(
    () => links.filter(l => !l.skill_canonical_key.startsWith('workspace:')),
    [links],
  )
  // 其他分身只展示真实携带行：模板导入 / 用户分配的都要留下，
  // 不注入未分配的本机发现项。平台与内置 App 只要在携带集里就不能藏。
  const visibleLinks = useMemo(
    () => [
      ...regularLinks,
      ...(isDefaultAgent ? buildDiscoveredDeviceLinks(poolSkills, carriedKeys) : []),
    ],
    [carriedKeys, isDefaultAgent, regularLinks, poolSkills],
  )

  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [configLink, setConfigLink] = useState<AgentSkillLinkItem | null>(null)
  const [detachTarget, setDetachTarget] = useState<AgentSkillLinkItem | null>(null)
  const selectedLink = visibleLinks.find(link => link.skill_canonical_key === selectedKey)
    ?? visibleLinks[0]
    ?? null
  const selectedPoolSkill = selectedLink
    ? poolIndex.get(selectedLink.skill_canonical_key) ?? null
    : null

  const handleToggleEnabled = async (link: AgentSkillLinkItem, checked: boolean) => {
    if (!agentId) return
    try {
      // ：重新打开时带上技能库元数据，补本机物化
      const poolSkill = poolIndex.get(link.skill_canonical_key)
      const materializeSkill: SkillIndexEntry | undefined = checked
        ? (poolSkill ?? {
            skill_key: link.skill_canonical_key,
            skill_id: link.skill_id || link.skill_canonical_key,
            name: link.name,
            description: link.description || '',
            source: link.source || 'user',
          })
        : undefined
      await updateLinkMutation.mutateAsync({
        agentId,
        skillCanonicalKey: link.skill_canonical_key,
        enabled: checked,
        spaceId,
        skill: materializeSkill,
      })
    } catch (err) {
      log.error('切换携带集启用状态失败', {
        agentId, canonicalKey: link.skill_canonical_key,
      }, err)
      toast.error(t('skills.toggleFailed'))
    }
  }

  const executeDetach = async () => {
    if (!agentId || !detachTarget) return
    try {
      await detachMutation.mutateAsync({
        agentId,
        skillCanonicalKey: detachTarget.skill_canonical_key,
        spaceId,
      })
      toast.success(t('skills.agentSkills.detachSuccess', {
        defaultValue: '已收回「{{skillName}}」',
        skillName: detachTarget.name,
      }))
    } catch (err) {
      log.error('收回携带集技能失败', {
        agentId, canonicalKey: detachTarget.skill_canonical_key,
      }, err)
      toast.error(t('skills.agentSkills.detachFailed', { defaultValue: '收回失败' }))
    }
  }

  const handleAttach = async (skill: SkillIndexEntry) => {
    if (!agentId) return
    const canonicalKey = skill.skill_key || ''
    try {
      await attachMutation.mutateAsync({
        agentId,
        skillCanonicalKey: canonicalKey,
        spaceId,
        skill,
      })
      toast.success(t('skills.agentSkills.attachSuccess', {
        defaultValue: '已添加「{{skillName}}」',
        skillName: resolveSkillDisplayName(skill),
      }))
    } catch (err) {
      log.error('携带集添加技能失败', { agentId, canonicalKey }, err)
      const detail = err instanceof Error ? err.message : ''
      toast.error(detail || t('skills.agentSkills.attachFailed', { defaultValue: '添加失败' }))
    }
  }

  const isLoading = agentLoading || (Boolean(agentId) && linksLoading)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部说明 + 添加入口 */}
      <div className="flex shrink-0 items-start justify-between gap-3 pb-3">
        <p className="text-body text-foreground-secondary">
          {t('skills.agentSkills.subtitle', {
            defaultValue: '这个 AI 分身会的本事。技能跟着 AI 分身走，在哪儿干活都带着。',
          })}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {canManage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={!agentId || linksLoading || isError}
              onClick={() => setPickerOpen(true)}
            >
              <Plus className="h-[1em] w-[1em]" />
              {t('skills.agentSkills.addButton', { defaultValue: '添加技能' })}
            </Button>
          )}
        </div>
      </div>

      {/* 列表 */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-12">
              <Skeleton height="100%" rounded="lg" />
            </div>
          ))}
        </div>
      ) : !agentId ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10">
          <AlertCircle className="h-5 w-5 text-muted-foreground/40" />
          <p className="text-body text-foreground-secondary">
            {t('skills.agentSkills.noAgent', {
              defaultValue: '还没有可用的执行 AI 分身，先完成 AI 分身初始化。',
            })}
          </p>
        </div>
      ) : isForbidden ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10">
          <AlertCircle className="h-5 w-5 text-muted-foreground/40" />
          <p className="text-body text-foreground-secondary">
            {t('skills.agentSkills.forbidden', {
              defaultValue: '只有这个 AI 分身的拥有者能查看和管理它的技能。',
            })}
          </p>
        </div>
      ) : isError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10">
          <AlertCircle className="h-5 w-5 text-destructive/60" />
          <p className="text-caption text-muted-foreground">{t('skills.panel.loadError')}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {t('skills.panel.retry')}
          </Button>
        </div>
      ) : visibleLinks.length === 0 ? (
        <div className="rounded-[12px] border border-dashed border-border/60 bg-muted/10 px-3 py-8 text-center">
          <Sparkles className="mx-auto mb-2 h-5 w-5 text-muted-foreground/40" />
          <p className="text-body text-muted-foreground/80">
            {t('skills.agentSkills.empty', {
              defaultValue: '还没教它任何本事。点「添加技能」从技能库挑一个。',
            })}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ScrollArea className="w-72 shrink-0 border-r border-border/40 pr-2">
            <div
              data-testid="agent-skill-list"
              aria-label={t('skills.agentSkills.listLabel', { defaultValue: '已携带的技能' })}
              className="space-y-0.5 pb-3 pr-1"
            >
              {visibleLinks.map(link => (
                <AgentSkillRow
                  key={link.skill_canonical_key}
                  link={link}
                  poolSkill={poolIndex.get(link.skill_canonical_key) ?? null}
                  selected={selectedLink?.skill_canonical_key === link.skill_canonical_key}
                  modified={localChanges[link.skill_canonical_key] === true}
                  currentUserId={currentUserId}
                  canManage={canManage}
                  discoveredDeviceSkill={
                    link.source === 'device' && !carriedKeys.has(link.skill_canonical_key)
                  }
                  skillLocked={isDefaultAgentLockedSkill(link, isDefaultAgent)}
                  onSelect={setSelectedKey}
                  onToggleEnabled={handleToggleEnabled}
                  onConfigure={setConfigLink}
                  onDetach={setDetachTarget}
                />
              ))}
            </div>
          </ScrollArea>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 pb-3">
            {selectedLink ? (
              <AgentSkillGuide
                title={resolveSkillCarryTitle({
                  display_name: selectedPoolSkill?.display_name,
                  name: selectedPoolSkill?.name || selectedLink.name,
                  skill_key: selectedLink.skill_canonical_key,
                })}
                description={selectedLink.description || selectedPoolSkill?.description || ''}
                slashCommand={formatSkillPanelTitle({
                  slug: selectedPoolSkill?.slug,
                  skill_key: selectedLink.skill_canonical_key,
                  name: selectedPoolSkill?.name || selectedLink.name,
                  skill_id: selectedPoolSkill?.skill_id || selectedLink.skill_id,
                })}
                groupLabel={selectedPoolSkill
                  ? t(`skills.sourceGroup5.${classifySkillGroup(selectedPoolSkill, currentUserId)}`)
                  : t(`skills.source.${selectedLink.source}`, { defaultValue: selectedLink.source })}
                emoji={selectedLink.emoji || selectedPoolSkill?.emoji}
              />
            ) : (
              <AgentSkillGuideEmpty />
            )}
          </div>
        </div>
      )}

      {/* 添加技能：从技能池挑 */}
      <AgentSkillPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        poolSkills={poolSkills}
        carriedKeys={carriedKeys}
        isDefaultAgent={isDefaultAgent}
        pending={attachMutation.isPending}
        loading={poolSkillsLoading}
        error={poolSkillsError}
        onRetry={() => { void refetchPoolSkills() }}
        onPick={handleAttach}
      />

      {/* 私有配置（credential / env，按 agent 维度） */}
      {agentId ? (
        <AgentSkillConfigDialog
          open={Boolean(configLink)}
          onOpenChange={(next) => { if (!next) setConfigLink(null) }}
          agentId={agentId}
          spaceId={spaceId}
          link={configLink}
          poolSkill={configLink ? poolIndex.get(configLink.skill_canonical_key) ?? null : null}
        />
      ) : null}

      {/* 收回确认 */}
      <ConfirmDialog
        open={Boolean(detachTarget)}
        onOpenChange={(open) => { if (!open) setDetachTarget(null) }}
        title={t('skills.agentSkills.detachConfirmTitle', { defaultValue: '收回这个技能？' })}
        description={t('skills.agentSkills.detachConfirmBody', {
          defaultValue: '「{{skillName}}」将从这个 AI 分身的携带集移除，它的私有配置一并清除。技能本身仍留在技能库里。',
          skillName: detachTarget?.name ?? '',
        })}
        confirmText={t('skills.agentSkills.detachAction', { defaultValue: '收回' })}
        variant="destructive"
        onConfirm={executeDetach}
      />

    </div>
  )
}

// ---------------------------------------------------------------------------
// 携带行
// ---------------------------------------------------------------------------

const AgentSkillRow: React.FC<{
  link: AgentSkillLinkItem
  poolSkill: SkillIndexEntry | null
  selected: boolean
  modified: boolean
  currentUserId: string
  canManage: boolean
  discoveredDeviceSkill: boolean
  skillLocked: boolean
  onSelect: (skillCanonicalKey: string) => void
  onToggleEnabled: (link: AgentSkillLinkItem, checked: boolean) => void
  onConfigure: (link: AgentSkillLinkItem) => void
  onDetach: (link: AgentSkillLinkItem) => void
}> = React.memo(({
  link,
  poolSkill,
  selected,
  modified,
  currentUserId,
  canManage,
  discoveredDeviceSkill,
  skillLocked,
  onSelect,
  onToggleEnabled,
  onConfigure,
  onDetach,
}) => {
  const { t } = useTranslation('context')

  // 来源分组：池里匹配到 → 五分组口径；匹配不到 → 通用来源标签兜底。
  const groupLabel = poolSkill
    ? t(`skills.sourceGroup5.${classifySkillGroup(poolSkill, currentUserId)}`)
    : t(`skills.source.${link.source}`, { defaultValue: link.source })

  // 需要配置入口：声明了 primary_env / requires.env / install 的技能，
  // 或携带行已有配置（保证已配的还能改）。
  const needsConfig = Boolean(poolSkill?.primary_env)
    || (poolSkill?.requires?.env || []).length > 0
    || (poolSkill?.install || []).length > 0
    || Object.keys(link.config_json || {}).length > 0

  const lockedTooltip = t('skills.agentSkills.lockedTooltip', {
    defaultValue: '系统预置分身的默认技能不可关闭或收回',
  })

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-interactive px-2 py-2 transition-colors',
        selected
          ? 'surface-row-active'
          : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
        !link.enabled && !skillLocked && 'opacity-60',
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(link.skill_canonical_key)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="shrink-0 text-body leading-none" aria-hidden>
          {link.emoji || poolSkill?.emoji || '🔧'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-body font-medium text-foreground">
              {resolveSkillCarryTitle({
                display_name: poolSkill?.display_name,
                name: poolSkill?.name || link.name,
                skill_key: link.skill_canonical_key,
              })}
            </span>
            {link.user_enabled === false && (
              <span
                className="shrink-0 inline-flex items-center rounded-full bg-muted px-1.5 py-px text-caption text-muted-foreground"
                title={t('skills.agentSkills.userGateOffTooltip', {
                  defaultValue: '技能库总闸已关闭，不会注入；请先在技能库打开',
                })}
              >
                {t('skills.agentSkills.userGateOff', { defaultValue: '总闸关' })}
              </span>
            )}
            {modified && (
              <span
                className="shrink-0 inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-px text-caption text-amber-600 dark:text-amber-400"
                title={t('skills.localChanges.badgeTooltip', { defaultValue: '本地物料与安装版本不一致' })}
              >
                {t('skills.localChanges.badge', { defaultValue: '已修改' })}
              </span>
            )}
          </div>
          <span className="mt-0.5 inline-flex rounded-full bg-foreground/[0.04] px-1.5 py-px text-caption text-muted-foreground/80">
            {groupLabel}
          </span>
        </div>
      </button>
      {canManage && !discoveredDeviceSkill && needsConfig && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onConfigure(link)}
                className="h-7 w-7 shrink-0 rounded-full p-0 text-muted-foreground hover:text-foreground"
                aria-label={t('skills.panel.configure')}
              >
                <Settings className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('skills.panel.configure')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {canManage && !discoveredDeviceSkill && !skillLocked && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onDetach(link)}
                className="h-7 w-7 shrink-0 rounded-full p-0 text-muted-foreground hover:text-destructive"
                aria-label={t('skills.agentSkills.detachAction', { defaultValue: '收回' })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t('skills.agentSkills.detachAction', { defaultValue: '收回' })}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Switch
                checked={Boolean(link.enabled) || skillLocked}
                disabled={!canManage || link.user_enabled === false || skillLocked || discoveredDeviceSkill}
                onCheckedChange={(checked) => onToggleEnabled(link, checked)}
                aria-label={
                  discoveredDeviceSkill
                    ? t('skills.agentSkills.localDiscoveredDefault', { defaultValue: '本机发现的技能默认可用' })
                    : skillLocked
                    ? lockedTooltip
                    : t('skills.configEnabled')
                }
              />
            </span>
          </TooltipTrigger>
          {skillLocked ? (
            <TooltipContent side="top">{lockedTooltip}</TooltipContent>
          ) : null}
        </Tooltip>
      </TooltipProvider>
    </div>
  )
})
AgentSkillRow.displayName = 'AgentSkillRow'

// ---------------------------------------------------------------------------
// 添加技能：技能池挑选器
// ---------------------------------------------------------------------------

const AgentSkillPickerDialog: React.FC<{
  open: boolean
  onOpenChange: (open: boolean) => void
  poolSkills: SkillIndexEntry[]
  carriedKeys: Set<string>
  isDefaultAgent: boolean
  pending: boolean
  loading: boolean
  error: boolean
  onRetry: () => void
  onPick: (skill: SkillIndexEntry) => void
}> = ({
  open,
  onOpenChange,
  poolSkills,
  carriedKeys,
  isDefaultAgent,
  pending,
  loading,
  error,
  onRetry,
  onPick,
}) => {
  const { t } = useTranslation('context')
  const currentUserId = useAuthStore(state => state.user?.id != null ? String(state.user.id) : '')
  const [search, setSearch] = useState('')
  const [pickedKey, setPickedKey] = useState<string | null>(null)

  // 只列「有 canonical key、且还没被携带」的技能。
  const assignableSkills = useMemo(
    () => poolSkills.filter(skill => canAssignSkillToAgent(skill, { isDefaultAgent })),
    [isDefaultAgent, poolSkills],
  )
  const availableSkills = useMemo(
    () => assignableSkills.filter(skill => !carriedKeys.has(skill.skill_key || '')),
    [assignableSkills, carriedKeys],
  )
  const candidates = useMemo(
    () => filterSkillsBySearch(availableSkills, search),
    [availableSkills, search],
  )
  const selectedSkill = candidates.find(skill => getSkillKey(skill) === pickedKey)
    ?? candidates[0]
    ?? null

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSearch('')
      setPickedKey(null)
    }
    onOpenChange(nextOpen)
  }

  const pickerStatus = loading
    ? 'loading'
    : error
      ? 'error'
      : candidates.length === 0
        ? 'empty'
        : 'ready'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <ContextDialogHeader
          className="px-0 pt-0"
          icon={<Sparkles className="h-7 w-7" />}
          title={t('skills.agentSkills.pickerTitle', { defaultValue: '添加技能' })}
          description={t('skills.agentSkills.pickerDescription', {
            defaultValue: '先看说明，再教给这个 AI 分身。',
          })}
        />

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            aria-label={t('skills.panel.searchPlaceholder')}
            placeholder={t('skills.panel.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={loading || error}
            className="h-7 w-full pl-8 text-body"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
              aria-label={t('skills.panel.clearSearch', { defaultValue: '清空搜索' })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        {pickerStatus === 'loading' ? (
          <div
            className="space-y-2 py-1"
            aria-busy="true"
            aria-label={t('skills.agentSkills.pickerLoading', { defaultValue: '正在加载技能库' })}
          >
            {[1, 2, 3].map(item => (
              <div key={item} className="h-12">
                <Skeleton height="100%" rounded="lg" />
              </div>
            ))}
          </div>
        ) : pickerStatus === 'error' ? (
          <div role="alert" className="flex flex-col items-center gap-2 px-3 py-6 text-center">
            <AlertCircle className="h-5 w-5 text-destructive/60" />
            <p className="text-body text-foreground-secondary">
              {t('skills.agentSkills.pickerLoadFailed', {
                defaultValue: '技能库加载失败，暂时无法判断哪些技能可以添加。',
              })}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t('skills.panel.retry')}
            </Button>
          </div>
        ) : pickerStatus === 'empty' ? (
          <p className="px-1 py-6 text-center text-body text-foreground-secondary">
            {search.trim()
              ? t('skills.panel.searchNoResults')
              : assignableSkills.length === 0
                ? t('skills.agentSkills.pickerNoSkills', {
                  defaultValue: '技能库里还没有可添加的技能。',
                })
                : t('skills.agentSkills.pickerEmpty', {
                  defaultValue: '技能库里的技能都已经教给它了。',
                })}
          </p>
        ) : (
          <div className="flex min-h-[360px] gap-3">
            <ScrollArea className="w-[min(280px,42%)] shrink-0 border-r border-border/40 pr-2">
              <div
                aria-label={t('skills.agentSkills.pickerListLabel', { defaultValue: '可添加的技能' })}
                className="space-y-0.5 py-1 pr-1"
              >
                {candidates.map(skill => {
                  const key = getSkillKey(skill)
                  const selected = key === getSkillKey(selectedSkill)
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setPickedKey(key)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-interactive px-2 py-2 text-left',
                        selected
                          ? 'surface-row-active'
                          : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                      )}
                    >
                      {skill.emoji ? (
                        <span className="shrink-0 text-body leading-none" aria-hidden>{skill.emoji}</span>
                      ) : (
                        <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
                        {resolveSkillDisplayName(skill)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </ScrollArea>
            <div className="min-w-0 flex-1 overflow-y-auto">
              {selectedSkill ? (
                <AgentSkillGuide
                  title={resolveSkillDisplayName(selectedSkill)}
                  description={selectedSkill.description || ''}
                  slashCommand={formatSkillPanelTitle(selectedSkill)}
                  groupLabel={t(`skills.sourceGroup5.${classifySkillGroup(selectedSkill, currentUserId)}`)}
                  emoji={selectedSkill.emoji}
                  footer={(
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      disabled={pending}
                      onClick={() => onPick(selectedSkill)}
                    >
                      {t('skills.agentSkills.pickAction', { defaultValue: '添加' })}
                    </Button>
                  )}
                />
              ) : (
                <AgentSkillGuideEmpty />
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
