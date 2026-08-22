import React, { useCallback, useMemo, useState } from 'react'
import { Settings, Trash2, Search, KeyRound, Download, ExternalLink, FolderOpen, Sparkles, Users } from 'lucide-react'
import {
  Button,
  Input,
  toast,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  ConfirmDialog,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import {
  useSkillsListQuery,
  useSkillConfigsQuery,
  useDisableSkillMutation,
  useDeleteSkillMutation,
  createSkillSilent,
  publishSkillSilent,
  restorePublishedSkillForShare,
  deleteSkillSilent,
  invalidateSkillSpaceQueries,
} from '@/hooks/queries/skills'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useFolderContextStore } from '@components/context-space/folder/useFolderStore'
import { contextRegistry } from '@components/context-space/registry'
import { resolveAppHomeTabModel } from '@components/context-space/registry/resolveUtils'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { useAuthStore } from '@/stores/useAuthStore'
import { useSkillSync } from './useSkillSync'
import type { SkillIndexEntry, SkillInstallSpec } from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'
import { SkillConfigDialog } from './SkillConfigDialog'
import {
  handleResourceLinkClick,
  handleResourceLinkContextMenu,
} from '@/services/openResourceLink'
import {
  computeReadiness,
  isConfigurable,
  isUninstallable,
  READINESS_STYLES,
  READINESS_ORDER,
} from './skillReadiness'
import type { SkillReadiness } from './skillReadiness'
import { isSkillOwnedByCurrentUser } from './skillProductState'
import { resolveSkillLocalPath } from './skillMdUtils'
import { collectSkillFiles, hasSkillMd } from './skillPublishFiles'
import {
  resolveShareSourceDir,
  shareSkillToOrganization,
} from './skillShare'
import {
  type SourceGroup5,
  SOURCE_GROUP_5_ORDER,
  classifySkillGroup,
} from './skillSourceGroups'
import { formatSkillPanelTitle, resolveSkillDisplayName } from './skillSlug'
import { isSkillEnabledInCurrentSpace } from './skillPanelFilters'
import { formatIpcErrorForUser } from '@/services/ipc-error'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import {
  SIDEBAR_ICON_BUTTON,
  SIDEBAR_ROW,
  SIDEBAR_ROW_FULL_WIDTH,
  SIDEBAR_ROW_INACTIVE,
} from '@components/layout/sidebarUi'
import { ContextPageHeader } from '../ContextPageHeader'
import { SkillsPageSubtitle } from './SkillsPageSubtitle'

type SkillWithMeta = { skill: SkillIndexEntry; readiness: SkillReadiness; group: SourceGroup5 }

function ReadinessTooltip({
  content,
  children,
}: {
  content: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="bottom">{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function canUninstallSkill(skill: SkillIndexEntry): boolean {
  return isUninstallable(skill.source) || (
    normalizeSkillSource(skill.source) === 'app'
    && skill.distribution === 'marketplace'
  )
}

function groupBySource5(items: SkillWithMeta[]): { group: SourceGroup5; items: SkillWithMeta[] }[] {
  const groups = new Map<SourceGroup5, SkillWithMeta[]>()
  for (const item of items) {
    const list = groups.get(item.group) || []
    list.push(item)
    groups.set(item.group, list)
  }
  return SOURCE_GROUP_5_ORDER
    .filter((g) => groups.has(g))
    .map((g) => ({ group: g, items: groups.get(g)! }))
}

// ---------------------------------------------------------------------------
// Install command
// ---------------------------------------------------------------------------

function buildInstallCommand(spec: SkillInstallSpec): string {
  switch (spec.kind) {
    case 'brew':
      return `brew install ${spec.formula || ''}`
    case 'pip':
      return `pip install ${spec.package || ''}`
    case 'node':
      return `npm install -g ${spec.package || ''}`
    case 'go':
      return `go install ${spec.module || ''}`
    default:
      return spec.label || ''
  }
}

// ---------------------------------------------------------------------------
// Readiness dot indicator
// ---------------------------------------------------------------------------

function ReadinessDot({ status, label }: { status: SkillReadiness; label: string }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0" title={label}>
      {status === 'ready' ? (
        <span className={`absolute inline-flex h-full w-full rounded-full opacity-40 animate-none ${READINESS_STYLES[status]}`} />
      ) : null}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${READINESS_STYLES[status]}`} />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SkillsSectionProps {
  spaceId: string
  canManage?: boolean
}

export const SkillsSection: React.FC<SkillsSectionProps> = ({ spaceId, canManage = true }) => {
  const { t } = useTranslation('context')
  const { t: tSpace } = useTranslation('space')
  const space = useSpaceStore(state => state.spaces.find(item => item.id === spaceId) ?? null)
  const currentUserId = useAuthStore(state => state.user?.id != null ? String(state.user.id) : '')

  const { data: skills = [], isLoading: loading, refetch: refetchSkills } = useSkillsListQuery(spaceId)
  const { data: skillConfigs = {}, refetch: refetchConfigs } = useSkillConfigsQuery(spaceId)
  const disableMutation = useDisableSkillMutation()
  const deleteMutation = useDeleteSkillMutation()
  const queryClient = useQueryClient()
  const [shareInFlight, setShareInFlight] = useState(false)
  const shareInFlightRef = React.useRef(false)

  const organizationId = space?.organization_id ?? null
  // 个人组织下「共享给组织」无同事可看，是噪音——隐藏（与 SkillPanel 同口径）。
  const isPersonalOrganization = useOrganizationStore(state =>
    organizationId ? state.organizations.find(w => w.id === organizationId)?.type === 'personal' : false,
  )

  const addSpaceFolder = useFolderContextStore((s) => s.addSpaceFolder)
  const setActiveKey = useSpaceContextTabsStore((s) => s.setActiveKey)

  const [search, setSearch] = useState('')
  const [configSkill, setConfigSkill] = useState<SkillIndexEntry | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SkillIndexEntry | null>(null)
  useSkillSync(spaceId)

  const handleOpenMarketplace = useCallback(() => {
    const model = resolveAppHomeTabModel('marketplace')
    // 设置面板是全局 overlay，不在标签 scope 树内，拿不到注入的 tabScopeKey——
    // 用官方转换器按当前前台 scope 解析出应写入的标签桶键（资源归属仍用 spaceId）。
    useSpaceContextTabsStore.getState().openResourceTab(resolveForegroundTabScopeKey(spaceId), {
      type: 'apphome',
      id: 'marketplace',
      title: model.title,
      meta: {
        spaceId,
        appId: 'marketplace',
        labelKey: model.labelKey,
        displayLabel: model.displayLabel,
        displayEmoji: model.displayEmoji,
      },
    })
  }, [spaceId])

  const handleOpenLocalSkills = useCallback(async () => {
    const tabtin = window.tabtin
    const ensureSpaceSandbox = tabtin?.fileSystem?.ensureSpaceSandbox
    if (!ensureSpaceSandbox) {
      toast({ title: t('skills.localUnsupported'), variant: 'destructive' })
      return
    }
    // contract W2-β：旧 envelope `{success, path}` 改为 invokeIpc 直接返 `{ path }` 或
    // throw —— sandbox path 缺失视为业务失败提示用户，IPC 异常由 catch 兜底。
    //
    // **2026-05-04 重构后**：skills 目录不再在 workspace 下，走 platform-data。
    // ensureSpaceSandbox 返回的 `skillsPath` 直接指向 platform-data 下的真实
    // skills 目录，不需要再拼 `${path}/skills`。
    let result: { path?: string; skillsPath?: string } | undefined
    try {
      result = await ensureSpaceSandbox(spaceId)
    } catch (err) {
      toast({ title: formatIpcErrorForUser(err, t('skills.localOpenFailed')), variant: 'destructive' })
      return
    }
    if (!result?.skillsPath) {
      toast({ title: t('skills.localOpenFailed'), variant: 'destructive' })
      return
    }
    const skillsPath = result.skillsPath

    // kind:'user' — browse shortcut into the platform-data skills/ dir.
    // Agent 的 workspace 是 workspace 目录本身（result.path），skills 跟它物理
    // 分离在 platform-data 下——这次打开的是 skills 目录，不是 workspace。
    const { folderId } = addSpaceFolder(spaceId, {
      rootPath: skillsPath,
      kind: 'user',
      title: t('skills.localSkills'),
    })
    const tabKey = contextRegistry.buildTabKey('tabfolder', folderId)
    // 同上：设置面板 overlay 无注入 scope，按前台 scope 解析标签桶键。
    setActiveKey(resolveForegroundTabScopeKey(spaceId), tabKey)

    void refetchSkills()
  }, [spaceId, refetchSkills, addSpaceFolder, setActiveKey, t])

  // 共享给组织：每次物化只读静态快照；标识名先对照组织精选，再由后端闸门兜底。
  const handleMakeTeamVisible = useCallback(async (skill: SkillIndexEntry) => {
    if (!organizationId) {
      toast({ title: t('skills.makeTeamVisibleNoTeam', { defaultValue: '当前不在组织中，无法设为组织共享' }), variant: 'destructive' })
      return
    }
    if (shareInFlightRef.current) return
    shareInFlightRef.current = true
    setShareInFlight(true)
    try {
      const result = await shareSkillToOrganization({
        skill,
        organizationId,
        currentUserId,
        displayName: resolveSkillDisplayName(skill),
        description: skill.description || '',
        organizationSkills: skills,
        reloadSkills: async () => (await refetchSkills()).data || [],
        resolveSkillDir: () => resolveShareSourceDir({
          skill,
          spaceId,
          organizationId,
          resolveLocalPath: resolveSkillLocalPath,
          restorePublishedVersion: restorePublishedSkillForShare,
        }),
        collectFiles: async (skillDir) => {
          const fs = window.tabtin?.fileSystem
          if (!fs) throw new Error('skill dir unavailable')
          return collectSkillFiles(skillDir, fs)
        },
        hasSkillMd,
        createSkill: (payload) => createSkillSilent(payload),
        publishSkill: (payload) => publishSkillSilent(payload),
        deleteSkill: async (skillId) => {
          await deleteSkillSilent({ skillId })
        },
      })
      invalidateSkillSpaceQueries(queryClient, organizationId)
      toast({
        title: t('skills.makeTeamVisibleSuccess', {
          defaultValue: '已将「{{name}}」的当前版本共享为组织精选快照。',
          name: result.skill.name || resolveSkillDisplayName(skill),
        }),
      })
    } catch (err) {
      invalidateSkillSpaceQueries(queryClient, organizationId)
      const detail = err instanceof Error ? err.message : String(err)
      toast({ title: `${t('skills.makeTeamVisibleFailed', { defaultValue: '设置组织可见失败' })}：${detail}`, variant: 'destructive' })
    } finally {
      shareInFlightRef.current = false
      setShareInFlight(false)
    }
  }, [organizationId, currentUserId, spaceId, skills, refetchSkills, queryClient, t])

  const handleRemoveFromOrg = useCallback(async (skill: SkillIndexEntry) => {
    if (!skill.skill_id) return
    try {
      // 私有原件仍在本地 /「我的」；这里只移除独立的组织静态快照。
      await deleteSkillSilent({ skillId: skill.skill_id })
      invalidateSkillSpaceQueries(queryClient, organizationId)
      toast({ title: t('skills.removeFromOrgSuccess', { defaultValue: '已从组织中移除' }) })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      toast({ title: `${t('skills.removeFromOrgFailed', { defaultValue: '从组织移除失败' })}：${detail}`, variant: 'destructive' })
    }
  }, [organizationId, queryClient, t])

  const skillsWithMeta = useMemo(() => {
    return skills.map((skill) => {
      const key = skill.skill_key || ''
      const cfg = skillConfigs[key]
      const readiness = computeReadiness(skill, cfg)
      const group = classifySkillGroup(skill, currentUserId)
      return { skill, readiness, group }
    })
  }, [skills, skillConfigs, currentUserId])

  const filteredSkills = useMemo(() => {
    let list = skillsWithMeta
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        ({ skill: s }) =>
          (s.display_name || '').toLowerCase().includes(q) ||
          (s.name || '').toLowerCase().includes(q) ||
          (s.description || '').toLowerCase().includes(q) ||
          (s.skill_id || '').toLowerCase().includes(q) ||
          (s.tags || []).some((tag) => tag.toLowerCase().includes(q))
      )
    }
    const sorted = [...list].sort((a, b) => READINESS_ORDER[a.readiness] - READINESS_ORDER[b.readiness])
    return sorted
  }, [skillsWithMeta, search])

  const groupedSkills = useMemo(() => groupBySource5(filteredSkills), [filteredSkills])

  const readinessCounts = useMemo(() => {
    const counts = { ready: 0, needs_config: 0, needs_install: 0, incompatible: 0 }
    for (const { readiness } of skillsWithMeta) {
      counts[readiness]++
    }
    return counts
  }, [skillsWithMeta])

  const getReadinessLabel = (status: SkillReadiness, enabled = true) => {
    if (!enabled) return t('skills.readiness.disabled')
    return t(`skills.readiness.${status}`, { defaultValue: status })
  }

  const isSkillEnabled = (skill: SkillIndexEntry) =>
    isSkillEnabledInCurrentSpace(skill)

  const handleOpenConfig = useCallback(async (skill: SkillIndexEntry) => {
    await refetchConfigs()
    setConfigSkill(skill)
  }, [refetchConfigs])

  const handleUninstall = async (skill: SkillIndexEntry) => {
    const canonicalKey = skill.skill_key || skill.skill_id
    try {
      const result = await disableMutation.mutateAsync({ canonicalKey, spaceId, skill })
      if (result?.found) {
        toast({
          title: t('skills.uninstallSuccessTitle'),
          description: t('skills.uninstallSuccessDescription', {
            skillName: resolveSkillDisplayName(skill),
          }),
        })
      } else {
        toast({
          title: t('skills.uninstallFailedTitle'),
          description: t('skills.uninstallFailedDescription'),
          variant: 'destructive',
        })
      }
    } catch {
      toast({
        title: t('skills.uninstallFailedTitle'),
        description: t('skills.uninstallFailedDescription'),
        variant: 'destructive',
      })
    }
  }

  const executeDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await deleteMutation.mutateAsync({
        skillId: deleteTarget.skill_id,
        spaceId,
      })
      toast({ title: t('skills.discardSuccess', { defaultValue: 'Skill deleted' }) })
      setDeleteTarget(null)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      toast({
        title: t('skills.deleteFailed', { defaultValue: 'Failed to delete skill' }),
        description: detail || undefined,
        variant: 'destructive',
      })
    }
  }, [deleteMutation, deleteTarget, spaceId, t])

  // Don't render the section if loading and no skills yet
  if (loading && skills.length === 0) {
    return (
      <ContextPageHeader
        icon={<Sparkles className="h-7 w-7" />}
        title={tSpace('tabs.skills')}
        description={t('skills.loading')}
      />
    )
  }

  if (skills.length === 0) {
    return (
      <>
        <div className="w-full min-w-0 space-y-3">
          <ContextPageHeader
            icon={<Sparkles className="h-7 w-7" />}
            title={tSpace('tabs.skills')}
            description={<SkillsPageSubtitle />}
            descriptionClassName="whitespace-normal"
            actions={canManage ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleOpenMarketplace}
                className="h-auto gap-1 px-1 py-0.5 text-body font-normal text-muted-foreground/60 hover:text-foreground"
              >
                <Sparkles className="h-[1em] w-[1em]" />
                {t('skills.exploreSkills', { defaultValue: '探索 Skill' })}
              </Button>
            ) : undefined}
          />
          <div className="rounded-[12px] border border-dashed border-border/40 px-4 py-8 text-center text-body text-muted-foreground">
            {t('skills.empty')}
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="w-full min-w-0 space-y-3">
        <ContextPageHeader
          icon={<Sparkles className="h-7 w-7" />}
          title={tSpace('tabs.skills')}
          description={<SkillsPageSubtitle />}
          descriptionClassName="whitespace-normal"
          footer={(readinessCounts.ready > 0 || readinessCounts.needs_config > 0 || readinessCounts.needs_install > 0) ? (
            <span className={cn('inline-flex', 'flex-wrap', 'items-center', 'gap-2', CANVAS_TEXT_META)}>
              {readinessCounts.ready > 0 && (
                <ReadinessTooltip content={t('skills.readiness.ready')}>
                  <span className="inline-flex items-center gap-1 cursor-default">
                    <span className="h-1.5 w-1.5 rounded-full bg-success" />
                    {readinessCounts.ready}
                  </span>
                </ReadinessTooltip>
              )}
              {readinessCounts.needs_config > 0 && (
                <ReadinessTooltip content={t('skills.readiness.needs_config')}>
                  <span className="inline-flex items-center gap-1 cursor-default">
                    <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                    {readinessCounts.needs_config}
                  </span>
                </ReadinessTooltip>
              )}
              {readinessCounts.needs_install > 0 && (
                <ReadinessTooltip content={t('skills.readiness.needs_install')}>
                  <span className="inline-flex items-center gap-1 cursor-default">
                    <span className="h-1.5 w-1.5 rounded-full bg-info" />
                    {readinessCounts.needs_install}
                  </span>
                </ReadinessTooltip>
              )}
            </span>
          ) : undefined}
          actions={canManage ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleOpenMarketplace}
                className="h-auto gap-1 px-1 py-0.5 text-body font-normal text-muted-foreground/60 hover:text-foreground"
              >
                <Sparkles className="h-[1em] w-[1em]" />
                {t('skills.exploreSkills', { defaultValue: '探索 Skill' })}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleOpenLocalSkills}
                className="h-auto gap-1 px-1 py-0.5 text-body font-normal text-muted-foreground/60 hover:text-foreground"
              >
                <FolderOpen className="h-[1em] w-[1em]" />
                {t('skills.localSkills')}
              </Button>
            </div>
          ) : undefined}
        />

        {/* Search */}
        {skills.length > 5 && (
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/40" />
            <Input
              className="h-7 pl-7 text-body"
              placeholder={t('skills.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}

        {/* Skills — grouped by 5 档来源 */}
        <div className="space-y-6">
          {groupedSkills.map(({ group, items }) => (
            <div key={group}>
              <div className={cn('mb-2', 'px-1', 'font-medium', CANVAS_TEXT_META)}>
                {t(`skills.sourceGroup5.${group}`)}
              </div>
              <div className="space-y-1">
                {items.map(({ skill, readiness }) => {
                  const skillKey = skill.skill_key || ''
                  const enabled = isSkillEnabled(skill)
                  const canConfigure = isConfigurable(skill.source)
                  const canUninstall = canUninstallSkill(skill)
                  // ：在设置页直接管理「我的」skill 的团队共享（与 SkillPanel 同口径）。
                  const isOwnUserSkill = normalizeSkillSource(skill.source) === 'user'
                    && isSkillOwnedByCurrentUser(skill, currentUserId)
                  const isDeviceLocal = normalizeSkillSource(skill.source) === 'device'
                  const canShareToTeam = !isPersonalOrganization && (
                    (isOwnUserSkill && skill.visibility === 'private')
                    || isDeviceLocal
                  )
                  const canRemoveFromOrg = isOwnUserSkill && skill.visibility === 'organization'
                  // 组织可只用「从组织中移除」，不暴露删除。
                  const canDeleteOwnUserSkill = isOwnUserSkill && skill.visibility !== 'organization'
                  const hasApiKey = Boolean(skill.primary_env)
                  const hasRequiredEnv = (skill.requires?.env || []).length > 0
                  const needsEnvConfig = hasApiKey || hasRequiredEnv
                  const uninstallVars = disableMutation.variables as
                    | { canonicalKey?: string; spaceId?: string }
                    | null
                    | undefined
                  const uninstallTarget = uninstallVars?.canonicalKey ?? ''
                  const rowKey = skillKey || skill.skill_id
                  const isUninstalling = disableMutation.isPending && uninstallTarget === rowKey
                  const isDeleting = deleteMutation.isPending && deleteTarget?.skill_id === skill.skill_id
                  const isIncompat = readiness === 'incompatible'
                  const installSpec = (skill.install || [])[0]
                  const installCmd = installSpec ? buildInstallCommand(installSpec) : ''

                  const actionButton = canConfigure
                    ? { icon: <Settings className="h-3 w-3" />, label: t('apps.config'), onClick: () => void handleOpenConfig(skill), opensConfigDialog: true }
                    : !canConfigure && needsEnvConfig
                      ? { icon: <KeyRound className="h-3 w-3" />, label: t('skills.configApiKey'), onClick: () => void handleOpenConfig(skill), opensConfigDialog: true }
                      : !canConfigure && !needsEnvConfig && installCmd
                        ? {
                            icon: <Download className="h-3 w-3" />,
                            label: t('skills.install'),
                            onClick: () => {
                              void navigator.clipboard.writeText(installCmd)
                              toast({ title: t('skills.installCopiedTitle'), description: installCmd })
                            },
                            opensConfigDialog: false,
                          }
                        : null

                  return (
                    <div
                      key={skillKey || skill.skill_id}
                      className={cn(
                        SIDEBAR_ROW,
                        SIDEBAR_ROW_FULL_WIDTH,
                        SIDEBAR_ROW_INACTIVE,
                        'py-2',
                        (!enabled || isIncompat) && 'opacity-50'
                      )}
                    >
                      <ReadinessDot status={readiness} label={getReadinessLabel(readiness, enabled)} />
                      <span className="text-body shrink-0">
                        {skill.emoji || ''}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-body font-medium text-foreground font-mono">
                          {formatSkillPanelTitle(skill)}
                        </span>
                        {skill.description && (
                          <span className={cn('ml-1.5', 'text-muted-foreground/40', 'truncate', 'inline-block', 'max-w-[200px]', 'align-middle', CANVAS_TEXT_META)}>
                            {skill.description}
                          </span>
                        )}
                      </div>

                      {/* Actions — visible on hover */}
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        {skill.homepage && (
                          // W8 L29 / L77：skill 主页走 ResourceRouter（D1 一视同仁）
                          <a
                            href={skill.homepage}
                            onClick={(e) => handleResourceLinkClick(e, skill.homepage!)}
                            onContextMenu={(e) => handleResourceLinkContextMenu(e, skill.homepage!)}
                            className={cn(SIDEBAR_ICON_BUTTON, 'text-muted-foreground/30')}
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        {actionButton && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={actionButton.onClick}
                            disabled={actionButton.opensConfigDialog && !canManage}
                            className={cn('px-2', 'hover:text-foreground', CANVAS_TEXT_META)}
                          >
                            {actionButton.icon}
                            {actionButton.label}
                          </Button>
                        )}
                        {canShareToTeam && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleMakeTeamVisible(skill)}
                            disabled={shareInFlight}
                            className={cn('px-2', 'hover:text-foreground', CANVAS_TEXT_META)}
                          >
                            <Users className="h-3 w-3" />
                            {t('skills.makeTeamVisible', { defaultValue: '共享给组织' })}
                          </Button>
                        )}
                        {canRemoveFromOrg && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleRemoveFromOrg(skill)}
                            className={cn('px-2', 'hover:text-foreground', CANVAS_TEXT_META)}
                          >
                            {t('skills.removeFromOrg', { defaultValue: '从组织中移除' })}
                          </Button>
                        )}
                        {canDeleteOwnUserSkill && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteTarget(skill)}
                            disabled={isDeleting || !canManage}
                            aria-label={t('skills.discardDraft', { defaultValue: 'Delete skill' })}
                            title={t('skills.discardDraft', { defaultValue: 'Delete skill' })}
                            className={cn('px-2', 'hover:text-destructive', CANVAS_TEXT_META)}
                          >
                            <Trash2 className="h-3 w-3" />
                            {t('skills.discardDraft', { defaultValue: 'Delete skill' })}
                          </Button>
                        )}
                        {canUninstall && !canDeleteOwnUserSkill && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleUninstall(skill)}
                            disabled={isUninstalling || !canManage}
                            aria-label={t('skills.uninstall', { defaultValue: 'Uninstall' })}
                            title={t('skills.uninstall', { defaultValue: 'Uninstall' })}
                            className="h-7 w-7 p-0 text-muted-foreground/30 hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {filteredSkills.length === 0 && search.trim() && (
          <p className={cn('text-muted-foreground/40', 'py-2', CANVAS_TEXT_META)}>{t('skills.empty')}</p>
        )}
      </div>

      <SkillConfigDialog
        open={Boolean(configSkill)}
        onOpenChange={(next) => {
          if (!next) setConfigSkill(null)
        }}
        skill={configSkill}
        spaceId={spaceId}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={t('skills.discardConfirmTitle', { defaultValue: 'Delete skill?' })}
        description={
          deleteTarget?.visibility === 'organization'
            ? t('skills.discardConfirmBodyOrgShared', {
                defaultValue: 'This deletes the organization-shared copy only. Your local or private original is unchanged.',
              })
            : deleteTarget?.has_published
              ? t('skills.deletePublishedConfirmBody', {
                  defaultValue: 'This skill has published versions. Deleting it permanently removes the skill, all its published versions, and local files. This cannot be undone.',
                })
              : t('skills.discardConfirmBody', {
                  defaultValue: 'This cannot be undone. The skill and all local files will be permanently deleted.',
                })
        }
        confirmText={t('skills.discardConfirmAction', { defaultValue: 'Delete' })}
        variant="destructive"
        isLoading={deleteMutation.isPending}
        onConfirm={executeDelete}
      />
    </>
  )
}
