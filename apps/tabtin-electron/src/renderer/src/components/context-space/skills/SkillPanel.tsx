/**
 * SkillPanel — Skills 一级面板
 *
 * 横向 Tab：技能市场（卡片 + 弹窗）| 团队共享 | 我的 | 已启用（master-detail）
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Sparkles, Code2, User,
  AlertCircle, RefreshCw, Settings, Plus, Download, X, Search,
  Trash2, ArrowUpCircle, Copy, Pencil,
  Users, EyeOff, Store, MoreVertical, FolderTree,
  Tags, BookText, LayoutGrid, Package, Monitor, ChevronDown,
  type LucideIcon,
} from 'lucide-react'
import {
  Button, Input, ScrollArea, toast, Skeleton,
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, ConfirmDialog,
  Dialog, DialogContent, DialogFooter,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  RadioGroup, RadioGroupItem,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
  Sheet, SheetContent, SheetTitle, VisuallyHidden,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { SKELETON_GRID_CARD } from '@/constants/skeletonUi'
import {
  useSkillsListQuery,
  useSkillConfigsQuery,
  useDisableSkillMutation,
  useDeleteSkillMutation,
  useUpgradeSkillMutation,
  useSaveAsCopyMutation,
  useUpdateSkillCategoryMutation,
  useImportSkillMutation,
  useWorkspaceSkillsScanQueries,
  createSkillSilent,
  publishSkillSilent,
  restorePublishedSkillForShare,
  deleteSkillSilent,
  invalidateSkillSpaceQueries,
} from '@/hooks/queries/skills'
import { useQueryClient } from '@tanstack/react-query'
import type { UpgradeResolution } from '@/skills/types'
import { useAuthStore } from '@/stores/useAuthStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { MarketplaceCardText } from '@components/context-space/capability-marketplace/MarketplaceCardText'
import { useDeviceStore } from '@/stores/useDeviceStore'
import { getSyncedDeviceIdentity } from '@/utils/deviceId'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { resolveOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useUIStore } from '@/stores/useUIStore'
import { useComposerPresetStore } from '@/stores/useComposerPresetStore'
import { useSkillSync } from './useSkillSync'
import {
  getSkillDetailProductState,
  isSkillOwnedByCurrentUser,
  canEditSkillFiles,
  type SkillDetailKind,
  type SkillPanelTab,
  isMineManagementTab,
} from './skillProductState'
import {
  findExistingSaveAsCopy,
} from './saveAsCopyIdempotency'
import {
  filterSkillsBySearch,
  getSkillKey,
  isSkillEnabledInCurrentSpace,
} from './skillPanelFilters'
import type { SkillIndexEntry, SkillConfig, AgentDefinition } from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'
import { getSkillCatalogIdentity } from '@/skills/skillCatalogIdentity'
import { SkillConfigDialog } from './SkillConfigDialog'
import {
  AssignSkillToAgentDialog,
  useSkillAgentAssignments,
} from './AssignSkillToAgentDialog'
import { withImplicitDefaultAgentDeviceAssignments } from './skillAgentAssignment'
import { CreateSkillDialog } from './CreateSkillDialog'
import { ImportDialog } from './ImportDialog'
import { SkillInstallToSpacesDialog } from './SkillInstallToSpacesDialog'
import { skillCategoryLabelKeyWithFallback, groupSkillsByCategory } from './skillCategory'
import { formatSkillVersionLabel } from './skillSemver'
import {
  resolveShareSourceDir,
  shareSkillToOrganization,
} from './skillShare'
import { formatSkillPanelTitle, resolveSkillDisplayName } from './skillSlug'
import { SkillMdEditor } from './SkillMdEditor'
import { SkillVersionHistoryDialog } from './SkillVersionHistoryDialog'
import { SkillCurrentVersionChip } from './SkillCurrentVersionChip'
import { resolveSkillLocalPath } from './skillMdUtils'
import { collectSkillFiles, hasSkillMd } from './skillPublishFiles'
import { materializeImportedSkill } from './skillImport'
import { getDraftComposerPresetScopeId, resolveComposerPresetScopeId } from '@/components/chat/composer-presets/scope'
import {
  buildSkillQuickUseGeneratedState,
  resolveSkillQuickUse,
  type ResolvedSkillQuickUse,
} from '@/components/chat/composer-presets/presets/skills/skillQuickUse'
import {
  computeReadiness,
} from './skillReadiness'
import type { SkillReadiness } from './skillReadiness'
import { SETTINGS_GROUP_LABEL } from '@components/settings/settingsUi'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { ContextPageHeader } from '../ContextPageHeader'
import { StandaloneModulePage } from '../StandaloneModulePage'
import { SkillsPageSubtitle } from './SkillsPageSubtitle'
import { ContextPageToolbar } from '../ContextPageToolbar'
import { ContextDialogHeader } from '../ContextDialogHeader'
import { contextRegistry } from '../registry'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import {
  CONTEXT_PAGE_HEADER_GAP,
  CONTEXT_PAGE_SHELL,
  CONTEXT_PAGE_SHELL_BLEED,
  CONTEXT_PAGE_TOOLBAR_BTN,
} from '../constants'

import {
  type TopChipGroup,
  type MineScopeFilter,
  TOP_CHIP_GROUP_ORDER,
  classifySkillGroup,
  classifyTopChipGroup,
  isMarketplaceMineShelfSkill,
  isMarketplaceSkillManaged,
  isOrganizationSharedUserSkill,
  isRecommendedMarketCatalogSkill,
  matchesTopChipFilter,
  matchesMineScope,
} from './skillSourceGroups'
import {
  dedupeMachineDiscoveredSkills,
  isWorkspaceScanSkill,
  mapWorkspaceScanToSkillIndexEntry,
  resolveWorkspaceSkillScanTargets,
  shouldScanWorkspaceSkills,
} from './workspaceSkillScan'
import {
  resolveSkillMarketCategory,
  SKILL_MARKET_CATEGORY_ORDER,
  type SkillMarketCategory as MarketplaceCategory,
} from '../capability-marketplace/skillMarketTaxonomy'
import {
  EMPTY_MARKETPLACE_SHELF_FILTERS,
  shouldResetMarketplaceShelfFilters,
} from '../capability-marketplace/marketplaceShelfFilterReset'
import { MarketplacePagination } from '../capability-marketplace/MarketplacePagination'
import type { LocalWorkspaceCandidate } from '@/components/sidebar/localWorkspaceNeed'
import { createLogger } from '@/utils/logger'

const log = createLogger('Skills')

// 顶层来源 chip 固定钉住的核心入口（本机 device 不单列，已折叠进「我的」）。
const PINNED_SOURCE_CHIPS: TopChipGroup[] = ['mine', 'organization', 'builtin']

const SOURCE_CHIP_ICONS: Record<TopChipGroup | 'all', LucideIcon> = {
  all: LayoutGrid,
  mine: BookText,
  organization: Users,
  builtin: Package,
  public_market: Store,
}

const MINE_SCOPE_FILTER_ORDER: MineScopeFilter[] = ['all', 'created', 'device']

function SkillTooltip({
  content,
  side = 'top',
  delayDuration,
  children,
}: {
  content: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  delayDuration?: number
  children: React.ReactNode
}) {
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side}>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}


const SOURCE_STYLES: Record<string, string> = {
  platform: 'bg-muted text-muted-foreground/80',
  app: 'bg-purple-500/10 text-purple-500 dark:text-purple-400',
  device: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  user: 'bg-blue-500/10 text-blue-500 dark:text-blue-400',
}

function sourceStyle(raw: string): string {
  return SOURCE_STYLES[normalizeSkillSource(raw)] ?? SOURCE_STYLES.user
}

function getSkillPanelIdentityKey(skill: SkillIndexEntry): string {
  const canonicalKey = getSkillCatalogIdentity(skill)
  if (!isWorkspaceScanSkill(skill)) return canonicalKey
  const workspaceId = String(skill.meta?.workspace_space_id ?? '')
  const localPath = String(skill.meta?.realpath ?? skill.doc_path ?? skill.path ?? '')
  return `${canonicalKey}::${workspaceId}::${localPath}`
}

function resolveManagedSkillSpaceId(
  skill: SkillIndexEntry | null,
  fallbackSpaceId: string,
): string {
  if (!skill || !isWorkspaceScanSkill(skill)) return fallbackSpaceId
  const workspaceSpaceId = String(skill.meta?.workspace_space_id ?? '').trim()
  return workspaceSpaceId || fallbackSpaceId
}

// ---------------------------------------------------------------------------
// SkillPanel — Main component
// ---------------------------------------------------------------------------

interface SkillPanelProps {
  spaceId?: string | null
  tabScopeKey?: string
  /** 统一市场入口：来源筛选使用“推荐 / 组织精选 / 我的”的产品语言。 */
  marketplaceMode?: boolean
  /**
   * 市场「技能」页签是否可见；为 false 时停止列表轮询（，与连接器 catalogActive 对称）。
   * 非市场入口忽略，默认视为可见。
   */
  catalogActive?: boolean
  /** 外部入口（如 Skill 市场「去管理」）要求打开的 skill key */
  focusSkillKey?: string
  /** 每次点击「去管理」递增，用于同 key 重复锚定 */
  focusAt?: number
  /**
   * 页面壳：default = 应用门 CONTEXT_PAGE_SHELL（含 clamp 水平内边距）；
   * bleed = 任务侧栏技能库，外边距/页眉由 AppFullPageHost 统一承接。
   */
  contentShell?: 'default' | 'bleed'
  /** bleed 时隐藏内置 ContextPageHeader（工作台已渲染同款页眉）。 */
  hidePageHeader?: boolean
}

export const SkillPanel: React.FC<SkillPanelProps> = ({
  spaceId,
  tabScopeKey,
  marketplaceMode = false,
  catalogActive = true,
  focusSkillKey,
  focusAt,
  contentShell = 'default',
  hidePageHeader = false,
}) => {
  const { t } = useTranslation('context')
  const currentSpaceId = spaceId ?? ''
  const [search, setSearch] = useState('')
  // 单一网格：来源筛选（'all' 或某个来源组）+「只看已启用」开关。
  const [sourceFilter, setSourceFilter] = useState<TopChipGroup | 'all'>(
    marketplaceMode ? 'builtin' : 'all',
  )
  const [marketCategoryFilter, setMarketCategoryFilter] = useState<MarketplaceCategory | 'all'>('all')
  // 本机发现区只有在存在 Skill 时才渲染，因此首次出现应直接展开，
  // 让用户立即看到发现结果；之后仍可通过标题栏手动收起。
  const [localDiscoverOpen, setLocalDiscoverOpen] = useState(true)
  // 「我的」内的子筛选（本机只读 vs 我创建的），仅在选中「我的」chip 时生效。
  const [mineScopeFilter, setMineScopeFilter] = useState<MineScopeFilter>('all')
  /** ：选中某个工作区 tab 时列出该 working_dir 扫到的 Skill；与 mineScopeFilter 互斥。 */
  const [workspaceScopeId, setWorkspaceScopeId] = useState<string | null>(null)
  // 详情抽屉：打开的 skill key + 它来自哪个区（决定详情页给哪些动作）。
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [detailOrigin, setDetailOrigin] = useState<SkillPanelTab>('enabled')
  const [pendingSelectSkillKey, setPendingSelectSkillKey] = useState<string | null>(null)
  const [configSkill, setConfigSkill] = useState<SkillIndexEntry | null>(null)
  const [managedSkill, setManagedSkill] = useState<SkillIndexEntry | null>(null)
  const [categorySkill, setCategorySkill] = useState<SkillIndexEntry | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<SkillIndexEntry | null>(null)
  const [removeFromMineTarget, setRemoveFromMineTarget] = useState<SkillIndexEntry | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  /** 市场 / 内置：可选「另存为我的」时先选目标 Space。本机主路径是开关启停，不走此对话框。 */
  const [installToSpacesTarget, setInstallToSpacesTarget] = useState<SkillIndexEntry | null>(null)
  const [installToSpacesLoading, setInstallToSpacesLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SkillIndexEntry | null>(null)
  const [shareTarget, setShareTarget] = useState<SkillIndexEntry | null>(null)
  const [shareInFlight, setShareInFlight] = useState(false)
  const shareInFlightRef = React.useRef(false)
  const saveAsCopyInFlightRef = React.useRef(false)
  const [upgradeConflictTarget, setUpgradeConflictTarget] = useState<{
    skill: SkillIndexEntry
    latestVersion: number
  } | null>(null)

  const openDetail = useCallback((skill: SkillIndexEntry, origin: SkillPanelTab) => {
    setDetailOrigin(origin)
    setDetailKey(getSkillPanelIdentityKey(skill))
  }, [])
  const closeDetail = useCallback(() => setDetailKey(null), [])

  const queryClient = useQueryClient()
  const currentUserId = useAuthStore(state => state.user?.id != null ? String(state.user.id) : '')
  // 与 useSkillsListQuery 同口径（pending > space > selected），避免  滤空。
  const organizationIdFromSpace = useSpaceStore(state =>
    state.spaces.find(s => s.id === currentSpaceId)?.organization_id ?? null,
  )
  const selectedOrganizationId = useOrganizationStore(
    state => state.selectedOrganization?.id ?? null,
  )
  const pendingOrganizationId = useOrganizationStore(state => state.pendingOrganizationId)
  const organizationId = resolveOrganizationId({
    pendingOrganizationId,
    selectedOrganizationId,
    contextOrganizationId: organizationIdFromSpace,
  })
  const {
    agents: marketplaceAgents,
    agentIdsBySkillKey: assignedAgentIdsBySkillKey,
    defaultAgentLinkedKeys,
    isLoading: marketplaceAssignmentsLoading,
  } = useSkillAgentAssignments(organizationId, marketplaceMode)
  //  / ：upgrade/import 传 agent_id；#7122 删总闸时误删声明，补回与同目录对话框一致。
  const selectedAgentId = useSpaceStore(state => state.selectedAgent?.id ?? '')
  const spaces = useSpaceStore(state => state.spaces)
  const currentDevice = useDeviceStore(state => state.currentDevice)
  const devices = useDeviceStore(state => state.devices)
  const loadDevices = useDeviceStore(state => state.loadDevices)
  const syncedDeviceIdentity = getSyncedDeviceIdentity()
  const syncedDeviceFingerprint = syncedDeviceIdentity?.fingerprint ?? null
  const localDeviceForWorkspaceScan = useMemo(
    () => currentDevice ?? (
      syncedDeviceFingerprint
        ? {
            id: syncedDeviceFingerprint,
            fingerprint: syncedDeviceFingerprint,
          }
        : null
    ),
    [currentDevice, syncedDeviceFingerprint],
  )
  useEffect(() => {
    if (organizationId) void loadDevices(organizationId)
  }, [organizationId, loadDevices])

  // 切换组织后货架数据与工作区 tab 都变了，搜索 / 分类 / 「我的」子筛选不能跨组织残留。
  useEffect(() => {
    setSearch(EMPTY_MARKETPLACE_SHELF_FILTERS.search)
    setMarketCategoryFilter(EMPTY_MARKETPLACE_SHELF_FILTERS.category as MarketplaceCategory | 'all')
    setMineScopeFilter(EMPTY_MARKETPLACE_SHELF_FILTERS.mineScope as MineScopeFilter)
    setWorkspaceScopeId(EMPTY_MARKETPLACE_SHELF_FILTERS.workspaceScopeId)
  }, [organizationId])

  const workspaceScanTargets = useMemo(
    () => resolveWorkspaceSkillScanTargets(
      spaces as LocalWorkspaceCandidate[],
      organizationId,
      localDeviceForWorkspaceScan,
      devices,
    ),
    [spaces, organizationId, localDeviceForWorkspaceScan, devices],
  )
  // 个人组织下「共享给组织」无同事可看，是噪音——隐藏该动作。
  // 信号取自 organization 的显式 type 标志（'personal'/'team'），按当前 Space
  // 的 organization 精确匹配；列表里找不到时按多人组织对待（宁可显示，也不误隐藏真组织的功能）。
  const isPersonalOrganization = useOrganizationStore(state =>
    organizationId ? state.organizations.find(w => w.id === organizationId)?.type === 'personal' : false,
  )

  // 单一网格里没有「区」了——详情动作上下文按 skill 自身关系派生：
  // 我拥有 / 本机 → 'mine'（管理，含共享给组织）；他人组织共享 → 'organization'；
  // 其余（内置/市场已装）→ 'enabled'。
  // 本机在顶层 chip 已并入「我的」，详情也必须走 mine，否则共享入口被 isMineTab 挡掉。
  const detailContextOf = useCallback((skill: SkillIndexEntry): SkillPanelTab => {
    const group = classifySkillGroup(skill, currentUserId)
    if (group === 'mine' || group === 'device') return 'mine'
    if (group === 'organization') return 'organization'
    return 'enabled'
  }, [currentUserId])

  const { data: skills = [], isLoading, isError, refetch } = useSkillsListQuery(
    currentSpaceId,
    undefined,
    {
      liveCatalog: marketplaceMode,
      catalogActive: !marketplaceMode || catalogActive,
      includeWorkspaceSkills: shouldScanWorkspaceSkills({
        sourceFilter,
        workspaceScopeId,
      }),
    },
  )
  // 后台 refetch 时保留已有列表；仅真正无数据的首屏才出骨架，避免市场轮询闪屏。
  const showSkillsInitialLoading = isLoading && skills.length === 0
  const { data: skillConfigs = {} } = useSkillConfigsQuery(currentSpaceId)
  const disableMutation = useDisableSkillMutation()
  const deleteMutation = useDeleteSkillMutation()
  const upgradeMutation = useUpgradeSkillMutation()
  const saveAsCopyMutation = useSaveAsCopyMutation()
  const importMutation = useImportSkillMutation()
  const updateCategoryMutation = useUpdateSkillCategoryMutation()

  useSkillSync(currentSpaceId)

  const sortByName = useCallback(
    (a: SkillIndexEntry, b: SkillIndexEntry) =>
      resolveSkillDisplayName(a).localeCompare(resolveSkillDisplayName(b), undefined, { sensitivity: 'base' }),
    [],
  )

  // 单一网格：内置 + 本机 + 我的 + 团队 + 市场已装。
  // 工作区目录 Skill 走二级「工作区」tab（独立 scan），不混进主网格避免与 tab 重复。
  // 只按名字排序——不要「已启用优先」，否则开关一翻卡片就跳位，手感很差。
  const allSkills = useMemo(() => {
    const catalog = skills.filter((skill) => !isWorkspaceScanSkill(skill))
    const base = filterSkillsBySearch(catalog, search)
    if (search.trim()) return base
    return [...base].sort(sortByName)
  }, [skills, search, sortByName])
  const agentIdsBySkillKey = useMemo(
    () => withImplicitDefaultAgentDeviceAssignments(
      assignedAgentIdsBySkillKey,
      marketplaceAgents,
      allSkills,
      defaultAgentLinkedKeys,
    ),
    [allSkills, assignedAgentIdsBySkillKey, defaultAgentLinkedKeys, marketplaceAgents],
  )

  // 核心管理入口固定显示，避免「组织共享」等功能在当前无数据时从 UI 消失。
  // 其它来源仍按当前列表动态出现，降低低频入口噪音。
  // organization chip 固定钉住；若列表里已有组织共享 skill，也确保计入 present。
  // ：有工作区根时钉住「我的」，否则仅目录 Skill 时顶层 chip 会消失。
  const sourceGroupsPresent = useMemo(() => {
    const present = new Set<TopChipGroup>(PINNED_SOURCE_CHIPS)
    for (const skill of allSkills) {
      present.add(classifyTopChipGroup(skill, currentUserId))
      if (isOrganizationSharedUserSkill(skill, organizationId)) present.add('organization')
    }
    if (workspaceScanTargets.length > 0) present.add('mine')
    return TOP_CHIP_GROUP_ORDER.filter(group => present.has(group))
  }, [allSkills, currentUserId, organizationId, workspaceScanTargets.length])

  // 创建 / 导入 / 另存为副本 / 市场「去管理」：等 skill 出现在列表里，
  // 切到来源 chip、打开详情，并滚到对应卡片。
  useEffect(() => {
    if (!pendingSelectSkillKey) return
    const target = skills.find(s => getSkillKey(s) === pendingSelectSkillKey)
    if (target) {
      const key = getSkillPanelIdentityKey(target)
      const group = target.visibility === 'organization'
        ? 'organization'
        : classifyTopChipGroup(target, currentUserId)
      setSourceFilter(group)
      setWorkspaceScopeId(null)
      setDetailOrigin(group === 'organization' ? 'organization' : detailContextOf(target))
      setDetailKey(key)
      setPendingSelectSkillKey(null)
      // 消费完外部锚定信号，避免切回 Skills 面板时重复弹开。
      if (focusSkillKey && tabScopeKey) {
        const tabKey = contextRegistry.buildTabKey('apphome', 'skill')
        useSpaceContextTabsStore.getState().setItemMeta(tabScopeKey, tabKey, {
          skillKey: undefined,
          focusAt: undefined,
        })
      }
      // 等 chip 过滤 + 详情打开后再滚到卡片。
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.querySelector(
            `[data-skill-key="${CSS.escape(key)}"]`,
          ) as HTMLElement | null
          el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        })
      })
    }
  }, [
    skills,
    pendingSelectSkillKey,
    detailContextOf,
    focusSkillKey,
    tabScopeKey,
    currentUserId,
  ])

  // Skill 市场「去管理」等外部入口：按 focusSkillKey 锚定打开详情。
  // focusAt 变化时即使 key 相同也重新打开（用户连续点同一张卡）。
  useEffect(() => {
    if (!focusSkillKey) return
    setPendingSelectSkillKey(focusSkillKey)
  }, [focusSkillKey, focusAt])

  // --- 网格视图派生（来源筛选 chip） ---
  // 只要有结果就展示来源 chip（「全部」+ 各来源）；多来源时才真正起过滤作用。
  const showSourceChips = marketplaceMode || sourceGroupsPresent.length >= 1
  const effectiveSourceFilter: TopChipGroup | 'all' =
    marketplaceMode && sourceFilter !== 'all'
      ? sourceFilter
      : showSourceChips && sourceFilter !== 'all' && sourceGroupsPresent.includes(sourceFilter)
      ? sourceFilter
      : 'all'
  const sourceChips: Array<TopChipGroup | 'all'> = marketplaceMode
    ? ['builtin', 'organization', 'mine']
    : ['all', ...sourceGroupsPresent]

  // 「我的」chip 选中时，才显示 / 应用二级子筛选（全部 / 我创建的 / 本机 / 各工作区）。
  const isMineChipActive = effectiveSourceFilter === 'mine'
  const detailOriginForVisibleShelf = useCallback((skill: SkillIndexEntry): SkillPanelTab => {
    if (effectiveSourceFilter === 'organization') return 'organization'
    if (effectiveSourceFilter === 'mine') return 'mine'
    return detailContextOf(skill)
  }, [detailContextOf, effectiveSourceFilter])
  const catalogMineScopeCounts = useMemo(() => {
    if (!isMineChipActive) return null
    const mineSkills = allSkills.filter(s => classifyTopChipGroup(s, currentUserId) === 'mine')
    const device = mineSkills.filter(s => matchesMineScope(s, 'device')).length
    return { catalogAll: mineSkills.length, created: mineSkills.length - device, device }
  }, [isMineChipActive, allSkills, currentUserId])
  // 无本机 skill 且无工作区根时子筛选是纯噪音，隐藏。
  const showMineScopeFilter = !marketplaceMode
    && isMineChipActive
    && ((catalogMineScopeCounts?.device ?? 0) > 0 || workspaceScanTargets.length > 0)
  // 进入「我的 / 工作区」后再扫，避免默认货架为计数触发 Windows 全盘目录遍历。
  const workspaceScanEnabled = shouldScanWorkspaceSkills({
    sourceFilter: effectiveSourceFilter,
    workspaceScopeId,
  })
  const workspaceScanQueries = useWorkspaceSkillsScanQueries(
    workspaceScanTargets.map(({ spaceId, workspaceRoot }) => ({ spaceId, workspaceRoot })),
    workspaceScanEnabled && workspaceScanTargets.length > 0,
  )
  const workspaceScanBySpaceId = useMemo(() => {
    const map = new Map<string, SkillIndexEntry[]>()
    workspaceScanTargets.forEach((target, index) => {
      const result = workspaceScanQueries[index]?.data
      const entries = (result?.skills ?? []).map((entry) =>
        mapWorkspaceScanToSkillIndexEntry(entry, {
          spaceId: target.spaceId,
          spaceName: target.spaceName,
        }),
      )
      map.set(target.spaceId, entries)
    })
    return map
  }, [workspaceScanTargets, workspaceScanQueries])

  // --- Detail drawer selection（含工作区扫到的只读 Skill） ---
  const detailSkill = useMemo(() => {
    if (!detailKey) return null
    const fromCatalog = skills.find(s => getSkillPanelIdentityKey(s) === detailKey)
    if (fromCatalog) return fromCatalog
    for (const list of workspaceScanBySpaceId.values()) {
      const hit = list.find(s => getSkillPanelIdentityKey(s) === detailKey)
      if (hit) return hit
    }
    return null
  }, [skills, detailKey, workspaceScanBySpaceId])

  useEffect(() => {
    if (detailKey && !detailSkill) setDetailKey(null)
  }, [detailKey, detailSkill])

  const detailCfg = detailSkill ? skillConfigs[detailSkill.skill_key || ''] : undefined
  const detailReadiness = detailSkill ? computeReadiness(detailSkill, detailCfg) : undefined

  const workspaceScopeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const target of workspaceScanTargets) {
      counts[target.spaceId] = workspaceScanBySpaceId.get(target.spaceId)?.length ?? 0
    }
    return counts
  }, [workspaceScanTargets, workspaceScanBySpaceId])
  /** 各工作区目录 Skill 合计（主网格刻意排除，总数单独加回）。 */
  const workspaceSkillsTotal = useMemo(
    () => Object.values(workspaceScopeCounts).reduce((sum, n) => sum + n, 0),
    [workspaceScopeCounts],
  )
  const sourceChipCounts = useMemo(() => {
    const counts: Partial<Record<TopChipGroup | 'all', number>> = { all: allSkills.length }
    for (const skill of allSkills) {
      // organization 计数与过滤同口径：含「我共享到组织」的 skill。
      if (isOrganizationSharedUserSkill(skill, organizationId)) {
        counts.organization = (counts.organization ?? 0) + 1
      }
      // 顶层归组：本机 device 计入「我的」。
      const group = classifyTopChipGroup(skill, currentUserId)
      if (group !== 'organization') {
        counts[group] = (counts[group] ?? 0) + 1
      }
    }
    // ：工作区目录 Skill 不进主网格，但计入「全部 / 我的」总数。
    if (workspaceSkillsTotal > 0) {
      counts.all = (counts.all ?? 0) + workspaceSkillsTotal
      counts.mine = (counts.mine ?? 0) + workspaceSkillsTotal
    }
    return counts
  }, [allSkills, currentUserId, organizationId, workspaceSkillsTotal])
  const mineScopeCounts = useMemo(() => {
    if (!catalogMineScopeCounts) return null
    return {
      all: catalogMineScopeCounts.catalogAll + workspaceSkillsTotal,
      created: catalogMineScopeCounts.created,
      device: catalogMineScopeCounts.device,
    }
  }, [catalogMineScopeCounts, workspaceSkillsTotal])
  /** 扫描未落定前先全量展示，避免空 tab 先叠起再弹开造成跳动。 */
  const workspaceScansSettled = showMineScopeFilter
    && workspaceScanTargets.length > 0
    && workspaceScanTargets.every((_, index) => workspaceScanQueries[index]?.isFetched)
  const { filledWorkspaceTabs, emptyWorkspaceTabs } = useMemo(() => {
    if (!workspaceScansSettled) {
      return {
        filledWorkspaceTabs: workspaceScanTargets,
        emptyWorkspaceTabs: [] as typeof workspaceScanTargets,
      }
    }
    const filled: typeof workspaceScanTargets = []
    const empty: typeof workspaceScanTargets = []
    for (const target of workspaceScanTargets) {
      if ((workspaceScopeCounts[target.spaceId] ?? 0) > 0) filled.push(target)
      else empty.push(target)
    }
    return { filledWorkspaceTabs: filled, emptyWorkspaceTabs: empty }
  }, [workspaceScansSettled, workspaceScanTargets, workspaceScopeCounts])
  const activeWorkspaceScopeId = showMineScopeFilter
    && workspaceScopeId
    && workspaceScanTargets.some((t) => t.spaceId === workspaceScopeId)
    ? workspaceScopeId
    : null
  const activeEmptyWorkspaceTab = activeWorkspaceScopeId
    ? emptyWorkspaceTabs.find((t) => t.spaceId === activeWorkspaceScopeId) ?? null
    : null
  const effectiveMineScope: MineScopeFilter = showMineScopeFilter && !activeWorkspaceScopeId
    ? mineScopeFilter
    : 'all'

  const workspaceScopedSkills = useMemo(() => {
    if (!activeWorkspaceScopeId) return null
    const raw = workspaceScanBySpaceId.get(activeWorkspaceScopeId) ?? []
    const searched = filterSkillsBySearch(raw, search)
    return [...searched].sort(sortByName)
  }, [activeWorkspaceScopeId, workspaceScanBySpaceId, search, sortByName])

  const visibleSkills = workspaceScopedSkills ?? allSkills.filter(skill =>
    (
      marketplaceMode && effectiveSourceFilter === 'builtin'
        ? isRecommendedMarketCatalogSkill(skill)
        : marketplaceMode && effectiveSourceFilter === 'mine'
          ? isMarketplaceMineShelfSkill(skill, currentUserId, organizationId)
          : matchesTopChipFilter(skill, effectiveSourceFilter, currentUserId, organizationId)
    )
    && (!isMineChipActive || matchesMineScope(skill, effectiveMineScope))
    && (
      !marketplaceMode
      || marketCategoryFilter === 'all'
      || resolveSkillMarketCategory(skill.category) === marketCategoryFilter
    ),
  )
  const machineDiscoveredSkills = useMemo(() => {
    if (!marketplaceMode || !isMineChipActive) return []
    const workspaceCandidates = workspaceScanTargets.flatMap(target =>
      workspaceScanBySpaceId.get(target.spaceId) ?? [],
    )
    const deviceCandidates = allSkills.filter(
      skill => normalizeSkillSource(skill.source) === 'device',
    )
    const catalogSkills = allSkills.filter(
      skill => normalizeSkillSource(skill.source) !== 'device',
    )
    const deduped = dedupeMachineDiscoveredSkills(
      [...workspaceCandidates, ...deviceCandidates],
      catalogSkills,
    )
    return filterSkillsBySearch(deduped, search).filter(skill =>
      (
        marketCategoryFilter === 'all'
        || resolveSkillMarketCategory(skill.category) === marketCategoryFilter
      )
    ).sort(sortByName)
  }, [
    allSkills,
    isMineChipActive,
    marketCategoryFilter,
    marketplaceMode,
    search,
    sortByName,
    workspaceScanBySpaceId,
    workspaceScanTargets,
  ])
  const activeWorkspaceScanLoading = Boolean(
    activeWorkspaceScopeId
    && workspaceScanTargets.some((target, index) =>
      target.spaceId === activeWorkspaceScopeId
      && workspaceScanQueries[index]?.isLoading,
    ),
  )
  // 按分类分组呈现：把一大片平铺卡片切成「能力域 / 消费类」有语义的小段，降低扫读负担。
  const skillCategoryGroups = useMemo(() => groupSkillsByCategory(visibleSkills), [visibleSkills])

  // --- Handlers ---

  // 详情 Sheet 与 ConfirmDialog 同层 z-modal；先关抽屉再弹确认，避免确认框被挡。
  const handleUninstall = useCallback((skill: SkillIndexEntry) => {
    closeDetail()
    setUninstallTarget(skill)
  }, [closeDetail])

  const executeUninstall = useCallback(async () => {
    if (!uninstallTarget) return
    const skillName = resolveSkillDisplayName(uninstallTarget)
    const canonicalKey = uninstallTarget.skill_key || uninstallTarget.skill_id
    try {
      const result = await disableMutation.mutateAsync({ canonicalKey, spaceId: currentSpaceId, skill: uninstallTarget, removeLocal: true })
      if (result?.found) {
        toast.success(t('skills.uninstallSuccessDescription', { skillName }))
      } else {
        toast.error(t('skills.uninstallFailedDescription'))
      }
    } catch (err) {
      log.error('卸载 Skill 失败', { canonicalKey, spaceId: currentSpaceId }, err)
      toast.error(t('skills.uninstallFailedDescription'))
    }
  }, [uninstallTarget, disableMutation, currentSpaceId, t])

  const handleRemoveFromMine = useCallback((skill: SkillIndexEntry) => {
    closeDetail()
    setRemoveFromMineTarget(skill)
  }, [closeDetail])

  const executeRemoveFromMine = useCallback(async () => {
    if (!removeFromMineTarget) return
    const skillName = resolveSkillDisplayName(removeFromMineTarget)
    const canonicalKey = removeFromMineTarget.skill_key || removeFromMineTarget.skill_id
    try {
      const result = await disableMutation.mutateAsync({
        canonicalKey,
        spaceId: currentSpaceId,
        skill: removeFromMineTarget,
        removeLocal: true,
        forgetAcquisition: true,
      })
      if (result?.found) {
        toast.success(t('skills.removeFromMineSuccess', { skillName }))
      } else {
        toast.error(t('skills.removeFromMineFailed'))
      }
    } catch (err) {
      log.error('从我的 Skill 移除失败', { canonicalKey, spaceId: currentSpaceId }, err)
      toast.error(t('skills.removeFromMineFailed'))
    }
  }, [removeFromMineTarget, disableMutation, currentSpaceId, t])

  const handleOpenConfig = useCallback((skill: SkillIndexEntry) => {
    setConfigSkill(skill)
  }, [])

  // 删除 owner 自己的 user skill。别人还在用也不拦；组织精选会先给成员留副本。
  const executeDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await deleteMutation.mutateAsync({
        skillId: deleteTarget.skill_id,
        spaceId: currentSpaceId,
      })
      toast.success(t('skills.discardSuccess'))
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      toast.error(message || t('skills.deleteFailed'))
    }
  }, [deleteTarget, deleteMutation, currentSpaceId, t])

  const handleUpgrade = useCallback(async (skill: SkillIndexEntry) => {
    try {
      let autoResolution: UpgradeResolution | undefined
      const hashFn = window.tabtin?.fileSystem?.computeSkillContentHash
      if (hashFn && skill.path && skill.install_content_hash) {
        try {
          const hr = await hashFn(skill.path)
          if (hr?.success && hr.hash === skill.install_content_hash) {
            autoResolution = 'accept_new'
          }
        } catch { /* proceed without auto-resolution */ }
      }
      const result = await upgradeMutation.mutateAsync({
        skillId: skill.skill_id,
        spaceId: currentSpaceId,
        organization_id: organizationId ?? '',
        agent_id: selectedAgentId ?? '',
        resolution: autoResolution,
        skill,
      })
      if (result?.status === 'already_latest') {
        toast.info(t('skills.upgrade.alreadyLatest'))
      } else if (result?.status === 'upgraded') {
        toast.success(t('skills.upgrade.upgraded'))
      } else if (result?.status === 'conflict') {
        setUpgradeConflictTarget({
          skill,
          latestVersion: result.latest_version_seq ?? 0,
        })
      }
    } catch (err) {
      log.error('升级 Skill 失败', { skillId: skill.skill_id, spaceId: currentSpaceId }, err)
      toast.error(t('skills.upgrade.failed'))
    }
  }, [upgradeMutation, currentSpaceId, organizationId, selectedAgentId, t])

  const executeUpgradeResolution = useCallback(async (resolution: UpgradeResolution) => {
    if (!upgradeConflictTarget) return
    try {
      const result = await upgradeMutation.mutateAsync({
        skillId: upgradeConflictTarget.skill.skill_id,
        spaceId: currentSpaceId,
        organization_id: organizationId ?? '',
        agent_id: selectedAgentId ?? '',
        resolution,
        skill: upgradeConflictTarget.skill,
      })
      if (result?.status === 'forked') {
        toast.success(t('skills.upgrade.forked', { name: result.fork_skill_name }))
      } else if (result?.status === 'kept_local') {
        toast.success(t('skills.upgrade.keptLocal'))
      } else {
        toast.success(t('skills.upgrade.upgraded'))
      }
    } catch (err) {
      log.error('解决 Skill 升级冲突失败', { skillId: upgradeConflictTarget.skill.skill_id, spaceId: currentSpaceId, resolution }, err)
      toast.error(t('skills.upgrade.failed'))
    }
    setUpgradeConflictTarget(null)
  }, [upgradeConflictTarget, upgradeMutation, currentSpaceId, organizationId, selectedAgentId, t])

  const handleSaveAsCopy = useCallback(async (skill: SkillIndexEntry) => {
    if (saveAsCopyInFlightRef.current) return
    saveAsCopyInFlightRef.current = true
    try {
      // 列表已有同名自有副本 → 复用（连点 / 远端 API 尚未幂等时也不再造第二张卡）
      const existingCopy = currentUserId
        ? findExistingSaveAsCopy(skills, skill, currentUserId)
        : undefined
      if (existingCopy) {
        const nextKey = existingCopy.skill_key || existingCopy.skill_id
        toast.success(t('skills.saveAsCopySuccess', { name: existingCopy.name || '' }))
        if (nextKey) {
          setPendingSelectSkillKey(nextKey)
          toast.info(t('skills.enableAfterCreateHint'))
        }
        return
      }

      const result = await saveAsCopyMutation.mutateAsync({
        sourceSkillId: skill.skill_id,
        spaceId: currentSpaceId,
      })
      const nextKey = result?.skill_key || result?.skill_id
      // 后端 fork 只写 Django sandbox；Electron Agent 读的是本地 platform-data——必须物化，否则副本空壳。
      if (nextKey && organizationId) {
        try {
          const fs = window.tabtin?.fileSystem
          let skillDir = ''
          const sourceKey = skill.skill_key || ''
          if (sourceKey) {
            const resolvedSrc = await resolveSkillLocalPath({
              spaceId: currentSpaceId,
              organizationId,
              skillKey: sourceKey,
              searchAcrossSpaces: true,
            })
            if (resolvedSrc?.mdExists) skillDir = resolvedSrc.skillDir
          }
          if (!skillDir) skillDir = skill.path || ''
          if (skillDir && fs) {
            const collected = await collectSkillFiles(skillDir, fs)
            if (hasSkillMd(collected.files)) {
              const resolvedDst = await resolveSkillLocalPath({
                spaceId: currentSpaceId,
                organizationId,
                skillKey: nextKey,
              })
              if (resolvedDst?.skillDir) {
                await materializeImportedSkill(fs, resolvedDst.skillDir, collected.files)
              }
            }
          }
        } catch (materializeErr) {
          log.warn('另存为副本本地物化失败（后端已建记录）', {
            sourceSkillId: skill.skill_id,
            nextKey,
            spaceId: currentSpaceId,
          }, materializeErr)
        }
      }
      toast.success(t('skills.saveAsCopySuccess', { name: result?.name || '' }))
      if (nextKey) {
        setPendingSelectSkillKey(nextKey)
        // 另存为只落库，不自动启用——与导入 / 本机扫描 opt-in 同口径。
        toast.info(t('skills.enableAfterCreateHint'))
      }
    } catch (err) {
      log.error('Skill 另存为副本失败', { sourceSkillId: skill.skill_id, spaceId: currentSpaceId }, err)
      toast.error(t('skills.saveAsCopyFailed'))
    } finally {
      saveAsCopyInFlightRef.current = false
    }
  }, [saveAsCopyMutation, currentSpaceId, organizationId, t, currentUserId, skills])

  const executeInstallToSpacesForSkill = useCallback(async (skill: SkillIndexEntry, targetSpaceIds: string[]) => {
    if (!organizationId) return
    const isDeviceLocal = normalizeSkillSource(skill.source) === 'device'
    const spaceIds = targetSpaceIds.length > 0 ? targetSpaceIds : [currentSpaceId]
    setInstallToSpacesLoading(true)
    try {
      const fs = window.tabtin?.fileSystem
      const skillKey = skill.skill_key || ''
      let skillDir = ''
      if (skillKey && !isDeviceLocal) {
        const resolved = await resolveSkillLocalPath({
          spaceId: currentSpaceId,
          organizationId,
          skillKey,
          searchAcrossSpaces: true,
        })
        if (resolved?.mdExists) skillDir = resolved.skillDir
      }
      if (!skillDir) skillDir = skill.path || ''
      if (!skillDir || !fs) {
        toast.error(t(isDeviceLocal ? 'skills.importToSpaceFailed' : 'skills.forkToMineNoLocal'))
        return
      }
      const collected = await collectSkillFiles(skillDir, fs)
      if (!hasSkillMd(collected.files)) {
        toast.error(t(isDeviceLocal ? 'skills.importToSpaceFailed' : 'skills.forkToMineNoLocal'))
        return
      }
      const nameSuffix = isDeviceLocal
        ? t('skills.importToSpaceNameSuffix')
        : t('skills.forkToMineNameSuffix')
      const displayName = `${resolveSkillDisplayName(skill)}${nameSuffix}`
      let firstKey = ''
      let firstName = displayName
      for (const targetSpaceId of spaceIds) {
        // ：import 走 organization_id 锚点；跨 Space fork 也落到当前组织。
        void targetSpaceId
        const result = await importMutation.mutateAsync({
          organization_id: organizationId ?? '',
          agent_id: selectedAgentId ?? undefined,
          items: [{
            name: displayName,
            files: collected.files,
          }],
        })
        const skillEntry = result?.results?.[0]?.ok
          ? (result.results[0].skill || result)
          : result
        const nextKey = skillEntry?.skill_key || skillEntry?.skill_id || result?.skill_key || result?.skill_id || ''
        if (nextKey && !firstKey) {
          firstKey = nextKey
          firstName = skillEntry?.name || result?.name || displayName
          try {
            const resolvedDst = await resolveSkillLocalPath({
              spaceId: targetSpaceId,
              organizationId,
              skillKey: nextKey,
            })
            if (resolvedDst?.skillDir) {
              const filesToWrite = Array.isArray(skillEntry?.normalized_files) && skillEntry.normalized_files.length > 0
                ? skillEntry.normalized_files
                : collected.files
              await materializeImportedSkill(fs, resolvedDst.skillDir, filesToWrite)
            }
          } catch (materializeErr) {
            log.warn('市场/内置/本机 fork 本地物化失败', { skillKey, nextKey }, materializeErr)
          }
        }
      }
      if (firstKey) setPendingSelectSkillKey(firstKey)
      // 只导入，不自动启用——与「默认关闭、需手动开启」同口径。
      toast.success(
        t(isDeviceLocal ? 'skills.importToSpaceSuccess' : 'skills.forkToMineSuccess', {
          name: firstName,
        }),
      )
      toast.info(t('skills.enableAfterCreateHint'))
      setInstallToSpacesTarget(null)
    } catch (err) {
      log.error('Skill 导入/另存为我的失败', { skillKey: skill.skill_key, spaceId: currentSpaceId }, err)
      toast.error(t(isDeviceLocal ? 'skills.importToSpaceFailed' : 'skills.forkToMineFailed'))
    } finally {
      setInstallToSpacesLoading(false)
    }
  }, [organizationId, currentSpaceId, selectedAgentId, importMutation, t])

  /** 市场 / 内置另存为我的：先选 Space。本机主路径是开关，另存为我的默认只启用当前 Space。 */
  const handleForkToMine = useCallback((skill: SkillIndexEntry) => {
    if (!organizationId) {
      toast.error(t('skills.forkToMineNoOrg'))
      return
    }
    if (normalizeSkillSource(skill.source) === 'device') {
      void executeInstallToSpacesForSkill(skill, [currentSpaceId])
      return
    }
    setInstallToSpacesTarget(skill)
  }, [organizationId, currentSpaceId, t, executeInstallToSpacesForSkill])

  const executeInstallToSpaces = useCallback(async (targetSpaceIds: string[]) => {
    const skill = installToSpacesTarget
    if (!skill) return
    await executeInstallToSpacesForSkill(skill, targetSpaceIds)
  }, [installToSpacesTarget, executeInstallToSpacesForSkill])

  const handleImport = useCallback(() => {
    setShowImportDialog(true)
  }, [])

  // 共享给组织：每次物化只读静态快照；标识名先对照组织精选，再由后端闸门兜底。
  const requestMakeTeamVisible = useCallback((skill: SkillIndexEntry) => {
    if (!organizationId) {
      toast.error(t('skills.makeTeamVisibleNoTeam', { defaultValue: '当前不在组织中，无法设为组织共享' }))
      return
    }
    if (shareInFlightRef.current) return
    setShareTarget(skill)
  }, [organizationId, t])

  const executeMakeTeamVisible = useCallback(async () => {
    const skill = shareTarget
    if (!skill || !organizationId) return
    if (shareInFlightRef.current) return

    shareInFlightRef.current = true
    setShareInFlight(true)
    try {
      log.info('共享给组织：开始', {
        skillKey: skill.skill_key,
        source: skill.source,
        name: resolveSkillDisplayName(skill),
      })
      const result = await shareSkillToOrganization({
        skill,
        organizationId,
        currentUserId,
        displayName: resolveSkillDisplayName(skill),
        description: skill.description || '',
        organizationSkills: skills,
        reloadSkills: async () => (await refetch()).data || [],
        resolveSkillDir: () => resolveShareSourceDir({
          skill,
          spaceId: currentSpaceId,
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
      const nextKey = result.skill.skill_key || result.skill.skill_id
      if (nextKey) setPendingSelectSkillKey(nextKey)
      if (result.skippedFileCount > 0) {
        toast.warning(t('skills.editorDialog.skippedFilesNote', { count: result.skippedFileCount }))
      }
      setShareTarget(null)
      toast.success(t('skills.makeTeamVisibleSuccess', {
        name: result.skill.name || resolveSkillDisplayName(skill),
      }))
      log.info('共享给组织：成功', {
        mode: result.mode,
        skillId: result.skill.skill_id,
      })
    } catch (err) {
      invalidateSkillSpaceQueries(queryClient, organizationId)
      const detail = err instanceof Error ? err.message : String(err)
      log.error('共享给组织失败', { detail }, err)
      toast.error(`${t('skills.makeTeamVisibleFailed')}：${detail}`)
      throw err
    } finally {
      shareInFlightRef.current = false
      setShareInFlight(false)
    }
  }, [
    shareTarget,
    currentSpaceId,
    organizationId,
    currentUserId,
    skills,
    refetch,
    queryClient,
    t,
  ])

  const handleRemoveFromOrg = useCallback(async (skill: SkillIndexEntry) => {
    if (!skill.skill_id) return
    try {
      // 组织精选是由私有原件物化出的独立静态快照；移除时直接删除快照，
      // 不能降级成 private，否则会在「我的」凭空多出第二份 Skill。
      await deleteSkillSilent({ skillId: skill.skill_id })
      closeDetail()
      invalidateSkillSpaceQueries(queryClient, organizationId)
      toast.success(t('skills.removeFromOrgSuccess'))
    } catch (err) {
      log.error('从组织移除失败', { skillId: skill.skill_id }, err)
      toast.error(t('skills.removeFromOrgFailed'))
    }
  }, [organizationId, queryClient, t, closeDetail])

  const handleSaveCategory = useCallback(async (skill: SkillIndexEntry, category: string | null) => {
    if (!skill.skill_id) return
    try {
      const result = await updateCategoryMutation.mutateAsync({
        skillId: skill.skill_id,
        spaceId: currentSpaceId,
        category,
      })
      setCategorySkill(null)
      // 分类变更可能改变 skill_key（slug 派生）——同步详情抽屉指向的 key，避免详情空掉。
      if (result?.skill_key && detailKey) setDetailKey(result.skill_key)
      toast.success(t('skills.categoryDialog.success'))
    } catch (err) {
      log.error('修改 Skill 分类失败', { skillId: skill.skill_id, spaceId: currentSpaceId, category }, err)
      toast.error(t('skills.categoryDialog.failed'))
    }
  }, [updateCategoryMutation, currentSpaceId, t, detailKey])

  // --- Render ---

  if (!currentSpaceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-body text-muted-foreground/60">{t('skills.panel.selectSpace')}</p>
      </div>
    )
  }

  const pageShellClass =
    contentShell === 'bleed' ? CONTEXT_PAGE_SHELL_BLEED : CONTEXT_PAGE_SHELL
  const showPageHeader = !hidePageHeader
  const useStandaloneShell = showPageHeader && contentShell === 'default'

  const panelBody = (
    <>
        {marketplaceMode ? (
          <div
            className="mb-4 flex min-w-0 flex-wrap items-center gap-3 sm:flex-nowrap"
            data-marketplace-layout="prototype"
          >
            <p className="w-full min-w-0 text-body leading-relaxed text-muted-foreground/80 sm:flex-1">
              {t('skills.marketplace.intro')}
            </p>
            <div className="relative min-w-0 flex-1 sm:w-[220px] sm:max-w-[40%] sm:flex-none">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60"
              />
              <Input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder={t('skills.marketplace.searchPlaceholder')}
                aria-label={t('skills.marketplace.searchPlaceholder')}
                className="h-8 rounded-md border-border/80 bg-transparent pl-8 text-body shadow-none"
              />
            </div>
            {/* ：新建/导入只属于「我的」；推荐 / 组织精选是浏览货架，不露 + */}
            {isMineChipActive ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 shrink-0 rounded-lg"
                    aria-label={t('skills.marketplace.actionsLabel')}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[6.5rem]">
                  <DropdownMenuItem onClick={() => setShowCreateDialog(true)}>
                    <Sparkles className="h-3.5 w-3.5" />
                    {t('skills.panel.createButton')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleImport}>
                    <Download className="h-3.5 w-3.5" />
                    {t('skills.importButton')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ) : (
          <ContextPageToolbar
          // 工作台嵌入时外层已有 CONTEXT_PAGE_HEADER_GAP，与自动化列表一致关掉二次间距。
          withHeaderGap={showPageHeader && !useStandaloneShell}
          className={showPageHeader && !useStandaloneShell ? undefined : 'pb-2'}
          actions={(
            <>
              <Button size="sm" className={cn('shrink-0', CONTEXT_PAGE_TOOLBAR_BTN)} onClick={() => setShowCreateDialog(true)}>
                <Plus className="h-[1em] w-[1em]" />
                {t('skills.panel.createButton')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn('shrink-0', CONTEXT_PAGE_TOOLBAR_BTN)}
                onClick={handleImport}
              >
                <Download className="h-[1em] w-[1em]" />
                {t('skills.importButton')}
              </Button>
            </>
          )}
          searchPlaceholder={t('skills.panel.searchPlaceholder')}
          searchValue={search}
          onSearchChange={setSearch}
          />
        )}

        {!showSkillsInitialLoading && !isError && showSourceChips ? (
          <div
            className={cn(
              'flex min-w-0 flex-wrap items-center gap-2',
              marketplaceMode ? 'mb-2.5' : 'mt-3',
            )}
            role="tablist"
            aria-label={t('skills.panel.filterAll')}
          >
            {sourceChips.map(chip => {
              const activeChip = effectiveSourceFilter === chip
              const marketplaceLabelKey = chip === 'builtin'
                ? 'skills.marketplaceSource.recommended'
                : chip === 'organization'
                  ? 'skills.marketplaceSource.organization'
                  : chip === 'mine'
                    ? 'skills.marketplaceSource.mine'
                    : null
              const label = marketplaceMode && marketplaceLabelKey
                ? t(marketplaceLabelKey)
                : chip === 'all'
                  ? t('skills.panel.filterAll')
                  : t(`skills.sourceGroup5.${chip}`)
              const count = sourceChipCounts[chip] ?? 0
              const ChipIcon = SOURCE_CHIP_ICONS[chip]
              return (
                <button
                  key={chip}
                  type="button"
                  role="tab"
                  aria-selected={activeChip}
                  onClick={() => {
                    if (shouldResetMarketplaceShelfFilters(sourceFilter, chip)) {
                      // 切「推荐 / 组织精选 / 我的」时清空筛选，避免上一个货架条件串台。
                      setSearch(EMPTY_MARKETPLACE_SHELF_FILTERS.search)
                      setMarketCategoryFilter(
                        EMPTY_MARKETPLACE_SHELF_FILTERS.category as MarketplaceCategory | 'all',
                      )
                      setMineScopeFilter(
                        EMPTY_MARKETPLACE_SHELF_FILTERS.mineScope as MineScopeFilter,
                      )
                      setWorkspaceScopeId(EMPTY_MARKETPLACE_SHELF_FILTERS.workspaceScopeId)
                    }
                    setSourceFilter(chip)
                  }}
                  className={cn(
                    'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 transition-colors',
                    CANVAS_TAB_TEXT,
                    marketplaceMode
                      ? activeChip
                        ? 'bg-foreground font-semibold text-background'
                        : 'bg-muted/60 font-medium text-muted-foreground/80 hover:bg-muted hover:text-foreground'
                      : activeChip
                        ? 'surface-row-active font-medium text-foreground'
                        : 'bg-muted/45 text-muted-foreground/70 hover:bg-muted/70 hover:text-foreground',
                  )}
                  title={`${label} ${count}`}
                >
                  {!marketplaceMode ? (
                    <ChipIcon
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        activeChip ? 'text-accent-text' : 'opacity-70',
                      )}
                      strokeWidth={1.75}
                    />
                  ) : null}
                  <span>{label}</span>
                  {!marketplaceMode ? (
                    <span
                      className={cn(
                        'tabular-nums',
                        activeChip ? 'text-muted-foreground/70' : 'text-muted-foreground/45',
                      )}
                    >
                      {count}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}

        {!showSkillsInitialLoading && !isError && marketplaceMode ? (
          <div
            className="mb-6 flex min-w-0 flex-wrap items-center gap-1.5"
            role="tablist"
            aria-label={t('skills.marketplaceCategory.label')}
          >
            {(['all', ...SKILL_MARKET_CATEGORY_ORDER] as const).map(category => {
              const activeCategory = marketCategoryFilter === category
              return (
                <button
                  key={category}
                  type="button"
                  role="tab"
                  aria-selected={activeCategory}
                  onClick={() => setMarketCategoryFilter(category)}
                  className={cn(
                    'inline-flex h-6 shrink-0 items-center rounded-full border px-2.5 transition-colors',
                    CANVAS_TAB_TEXT,
                    activeCategory
                      ? 'border-foreground/20 bg-foreground/[0.06] font-semibold text-foreground'
                      : 'border-border/80 bg-transparent font-medium text-muted-foreground/80 hover:bg-muted/40 hover:text-foreground',
                  )}
                >
                  {t(`skills.marketplaceCategory.${category}`)}
                </button>
              )
            })}
          </div>
        ) : null}

        {!showSkillsInitialLoading && !isError && showMineScopeFilter ? (
          <div
            className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 pl-0.5"
            role="tablist"
            aria-label={t('skills.panel.mineScope.label')}
          >
            {MINE_SCOPE_FILTER_ORDER.map((scope) => {
              const activeScope = !activeWorkspaceScopeId && effectiveMineScope === scope
              const count = mineScopeCounts?.[scope] ?? 0
              return (
                <button
                  key={scope}
                  type="button"
                  role="tab"
                  aria-selected={activeScope}
                  onClick={() => {
                    setMineScopeFilter(scope)
                    setWorkspaceScopeId(null)
                  }}
                  className={cn(
                    'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 transition-colors', CANVAS_TAB_TEXT,
                    activeScope
                      ? 'bg-foreground/[0.06] font-medium text-foreground'
                      : 'text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {scope === 'device'
                    ? <Monitor className="h-3 w-3 shrink-0 opacity-70" strokeWidth={1.75} />
                    : null}
                  <span>{t(`skills.panel.mineScope.${scope}`)}</span>
                  <span className="tabular-nums text-muted-foreground/40">{count}</span>
                </button>
              )
            })}
            {filledWorkspaceTabs.map((target) => {
              const activeScope = activeWorkspaceScopeId === target.spaceId
              const count = workspaceScopeCounts[target.spaceId] ?? 0
              return (
                <button
                  key={`ws:${target.spaceId}`}
                  type="button"
                  role="tab"
                  aria-selected={activeScope}
                  title={target.workspaceRoot}
                  onClick={() => {
                    setWorkspaceScopeId(target.spaceId)
                  }}
                  className={cn(
                    'inline-flex h-6 max-w-[10rem] shrink-0 items-center gap-1 rounded-full px-2.5 transition-colors', CANVAS_TAB_TEXT,
                    activeScope
                      ? 'bg-foreground/[0.06] font-medium text-foreground'
                      : 'text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  <FolderTree className="h-3 w-3 shrink-0 opacity-70" strokeWidth={1.75} />
                  <span className="truncate">{target.spaceName}</span>
                  <span className="tabular-nums text-muted-foreground/40">{count}</span>
                </button>
              )
            })}
            {emptyWorkspaceTabs.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={Boolean(activeEmptyWorkspaceTab)}
                    title={t('skills.panel.mineScope.emptyWorkspacesHint', {
                      count: emptyWorkspaceTabs.length,
                      defaultValue: `${emptyWorkspaceTabs.length} 个工作空间未扫到 Skill`,
                    })}
                    className={cn(
                      'inline-flex h-6 max-w-[12rem] shrink-0 items-center gap-1 rounded-full px-2.5 transition-colors',
                      // 叠层阴影：把多个空工作区收成一叠
                      'shadow-[1px_1px_0_0_hsl(var(--border)),2px_2px_0_0_hsl(var(--muted))]',
                      CANVAS_TAB_TEXT,
                      activeEmptyWorkspaceTab
                        ? 'bg-foreground/[0.06] font-medium text-foreground'
                        : 'text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <FolderTree className="h-3 w-3 shrink-0 opacity-70" strokeWidth={1.75} />
                    <span className="truncate">
                      {activeEmptyWorkspaceTab
                        ? activeEmptyWorkspaceTab.spaceName
                        : t('skills.panel.mineScope.emptyWorkspaces', {
                            count: emptyWorkspaceTabs.length,
                            defaultValue: `无 Skill ${emptyWorkspaceTabs.length}`,
                          })}
                    </span>
                    <span className="tabular-nums text-muted-foreground/40">
                      {activeEmptyWorkspaceTab ? 0 : emptyWorkspaceTabs.length}
                    </span>
                    <ChevronDown className="h-3 w-3 shrink-0 opacity-60" strokeWidth={1.75} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[10rem] max-w-[16rem]">
                  {emptyWorkspaceTabs.map((target) => (
                    <DropdownMenuItem
                      key={`ws-empty:${target.spaceId}`}
                      title={target.workspaceRoot}
                      onClick={() => setWorkspaceScopeId(target.spaceId)}
                      className={cn(
                        'gap-2',
                        activeWorkspaceScopeId === target.spaceId && 'bg-accent',
                      )}
                    >
                      <FolderTree className="h-3.5 w-3.5 shrink-0 opacity-60" strokeWidth={1.75} />
                      <span className="min-w-0 flex-1 truncate">{target.spaceName}</span>
                      <span className="tabular-nums text-muted-foreground/45">0</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ) : null}

        {showSkillsInitialLoading || (Boolean(activeWorkspaceScopeId) && activeWorkspaceScanLoading) ? (
          <div className={cn(
            marketplaceMode ? '' : CONTEXT_PAGE_HEADER_GAP,
            'grid grid-cols-1 gap-2.5',
            marketplaceMode
              ? 'sm:grid-cols-[repeat(auto-fill,minmax(20rem,1fr))]'
              : 'sm:grid-cols-2',
          )}>
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className={cn(SKELETON_GRID_CARD, marketplaceMode ? 'h-[122px]' : 'h-20')}>
                <Skeleton height="100%" rounded="lg" />
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className={cn(
            marketplaceMode ? '' : CONTEXT_PAGE_HEADER_GAP,
            'flex flex-col items-center justify-center gap-2 py-8',
          )}>
            <AlertCircle className="h-6 w-6 text-destructive/60" />
            <p className={CANVAS_TEXT_META}>{t('skills.panel.loadError')}</p>
            <Button variant="outline" size="sm" className="mt-1" onClick={() => refetch()}>
              <RefreshCw className="mr-1.5 h-3 w-3" />
              {t('skills.panel.retry')}
            </Button>
          </div>
        ) : (
          <div className={cn(marketplaceMode ? '' : CONTEXT_PAGE_HEADER_GAP, 'pb-6')}>
            {marketplaceMode ? (
              <>
                {visibleSkills.length > 0 ? (
                  <MarketplacePagination
                    key={`${organizationId}:${effectiveSourceFilter}:${effectiveMineScope}:${activeWorkspaceScopeId ?? ''}:${marketCategoryFilter}:${search}`}
                    items={visibleSkills}
                    getKey={getSkillPanelIdentityKey}
                    renderItem={skill => (
                      <SkillCard
                        skill={skill}
                        config={skillConfigs[skill.skill_key || '']}
                        active={getSkillPanelIdentityKey(skill) === detailKey}
                        marketplace
                        organizationShelf={effectiveSourceFilter === 'organization'}
                        onOpen={() => openDetail(skill, detailOriginForVisibleShelf(skill))}
                        onManage={() => setManagedSkill(skill)}
                        configuredAgentCount={agentIdsBySkillKey.get(
                          skill.acquired_copy_skill_key || skill.skill_key || '',
                        )?.length ?? 0}
                        onUpgrade={(s) => { void handleUpgrade(s) }}
                      />
                    )}
                  />
                ) : (
                  <div className="rounded-[10px] border border-dashed border-border/80 px-6 py-10 text-center">
                    <p className="text-body text-muted-foreground/60">
                      {t('skills.marketplace.noResults')}
                    </p>
                  </div>
                )}

                {isMineChipActive && machineDiscoveredSkills.length > 0 ? (
                  <section
                    className="mt-2 overflow-hidden rounded-[10px] border border-border/80 bg-card"
                    aria-labelledby="local-discover-title"
                  >
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3.5 py-3 text-left transition-colors hover:bg-muted/20"
                      aria-expanded={localDiscoverOpen}
                      aria-controls="local-discover-body"
                      onClick={() => setLocalDiscoverOpen(open => !open)}
                    >
                      <ChevronDown
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform',
                          localDiscoverOpen && 'rotate-180',
                        )}
                        strokeWidth={2}
                      />
                      <span id="local-discover-title" className="min-w-0 flex-1 text-body font-medium text-foreground">
                        {t('skills.marketplace.localDiscover.title')}{' '}
                        <span className="text-caption tabular-nums text-muted-foreground/60">
                          {machineDiscoveredSkills.length}
                        </span>{' '}
                        {t('skills.marketplace.localDiscover.unit')}
                      </span>
                      <span className="text-caption text-muted-foreground/60">
                        {t('skills.marketplace.localDiscover.hint')}
                      </span>
                    </button>
                    {localDiscoverOpen ? (
                      <div id="local-discover-body" className="border-t border-border/80 px-3.5 pb-3.5 pt-3">
                        <MarketplacePagination
                          key={`${organizationId}:local:${marketCategoryFilter}:${search}`}
                          items={machineDiscoveredSkills}
                          getKey={getSkillPanelIdentityKey}
                          renderItem={skill => (
                            <SkillCard
                              skill={skill}
                              config={undefined}
                              active={getSkillPanelIdentityKey(skill) === detailKey}
                              marketplace
                              localDiscovery
                              onOpen={() => openDetail(skill, 'mine')}
                              onManage={() => setManagedSkill(skill)}
                              configuredAgentCount={agentIdsBySkillKey.get(
                                skill.acquired_copy_skill_key || skill.skill_key || '',
                              )?.length ?? 0}
                            />
                          )}
                        />
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </>
            ) : visibleSkills.length === 0 ? (
              <div className="rounded-[12px] border border-dashed border-border/60 bg-muted/10 px-3 py-6 text-center">
                <p className="text-body text-muted-foreground/80">
                  {search.trim()
                    ? t('skills.panel.searchNoResults')
                    : activeWorkspaceScopeId
                      ? t('skills.panel.workspaceEmpty', {
                          defaultValue: '这个工作区目录下还没有扫到 Skill',
                        })
                      : effectiveSourceFilter === 'mine'
                        ? t('skills.panel.mineEmpty.subtitle')
                        : effectiveSourceFilter === 'organization'
                          ? t('skills.panel.teamEmpty.subtitle')
                          : t('skills.empty')}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-7">
                {skillCategoryGroups.map(group => (
                  <section key={group.groupId ?? 'unclassified'}>
                    <div className="mb-3 flex items-center gap-2 px-0.5">
                      <h3 className="text-body font-semibold text-foreground">
                        {t(group.labelKey)}
                      </h3>
                      <span className={cn('tabular-nums', 'text-muted-foreground/45', CANVAS_TEXT_META)}>
                        {group.skills.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                      {group.skills.map(skill => (
                        <SkillCard
                          key={getSkillPanelIdentityKey(skill)}
                          skill={skill}
                          config={skillConfigs[skill.skill_key || '']}
                          active={getSkillPanelIdentityKey(skill) === detailKey}
                          onOpen={() => openDetail(skill, detailOriginForVisibleShelf(skill))}
                          onUpgrade={(s) => { void handleUpgrade(s) }}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        )}

      <SkillConfigDialog
        open={Boolean(configSkill)}
        onOpenChange={(next) => { if (!next) setConfigSkill(null) }}
        skill={configSkill}
        spaceId={currentSpaceId}
      />

      <AssignSkillToAgentDialog
        open={Boolean(managedSkill)}
        onOpenChange={(next) => { if (!next) setManagedSkill(null) }}
        skill={managedSkill}
        organizationId={organizationId}
        spaceId={resolveManagedSkillSpaceId(managedSkill, currentSpaceId)}
        agents={marketplaceAgents}
        assignedAgentIds={managedSkill
          ? agentIdsBySkillKey.get(
              managedSkill.acquired_copy_skill_key || managedSkill.skill_key || '',
            ) ?? []
          : []}
        assignmentsLoading={marketplaceAssignmentsLoading}
      />

      <SkillCategoryDialog
        open={Boolean(categorySkill)}
        onOpenChange={(next) => { if (!next) setCategorySkill(null) }}
        skill={categorySkill}
        saving={updateCategoryMutation.isPending}
        onSave={handleSaveCategory}
      />

      <ConfirmDialog
        open={!!uninstallTarget}
        onOpenChange={(open) => { if (!open) setUninstallTarget(null) }}
        title={t('skills.uninstall')}
        description={t('skills.uninstallConfirm', {
          skillName: uninstallTarget ? resolveSkillDisplayName(uninstallTarget) : '',
        })}
        confirmText={t('skills.uninstall')}
        variant="destructive"
        onConfirm={executeUninstall}
      />

      <ConfirmDialog
        open={!!removeFromMineTarget}
        onOpenChange={(open) => { if (!open) setRemoveFromMineTarget(null) }}
        title={t('skills.removeFromMineConfirmTitle')}
        description={t('skills.removeFromMineConfirmBody', {
          skillName: removeFromMineTarget ? resolveSkillDisplayName(removeFromMineTarget) : '',
        })}
        confirmText={t('skills.removeFromMine')}
        variant="destructive"
        isLoading={disableMutation.isPending}
        onConfirm={executeRemoveFromMine}
      />

      <CreateSkillDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        spaceId={currentSpaceId}
        organizationId={organizationId}
        onCreateSuccess={(skillKey) => {
          setPendingSelectSkillKey(skillKey)
        }}
      />

      <ImportDialog
        open={showImportDialog}
        onOpenChange={setShowImportDialog}
        spaceId={currentSpaceId}
        organizationId={organizationId}
        onImportSuccess={(key) => {
          setPendingSelectSkillKey(key)
        }}
      />

      <SkillInstallToSpacesDialog
        open={!!installToSpacesTarget}
        onOpenChange={(open) => {
          if (!open && !installToSpacesLoading) setInstallToSpacesTarget(null)
        }}
        spaceId={currentSpaceId}
        organizationId={organizationId}
        skillName={installToSpacesTarget ? resolveSkillDisplayName(installToSpacesTarget) : ''}
        isLoading={installToSpacesLoading}
        onConfirm={executeInstallToSpaces}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title={t('skills.discardConfirmTitle')}
        description={
          deleteTarget?.visibility === 'organization'
            ? t('skills.discardConfirmBodyOrgShared')
            : t('skills.discardConfirmBody')
        }
        confirmText={t('skills.discardConfirmAction')}
        variant="destructive"
        isLoading={deleteMutation.isPending}
        onConfirm={executeDelete}
      />

      <ConfirmDialog
        open={!!shareTarget}
        onOpenChange={(open) => {
          // 进行中禁止关掉，避免半截请求 + 状态机卡死。
          if (!open && !shareInFlightRef.current) setShareTarget(null)
        }}
        title={t('skills.makeTeamVisibleConfirmTitle')}
        description={t('skills.makeTeamVisibleConfirmBody')}
        confirmText={t('skills.makeTeamVisibleConfirmAction')}
        isLoading={shareInFlight}
        onConfirm={executeMakeTeamVisible}
      />

      <UpgradeConflictDialog
        target={upgradeConflictTarget}
        isLoading={upgradeMutation.isPending}
        onResolve={executeUpgradeResolution}
        onClose={() => setUpgradeConflictTarget(null)}
      />

      {/* 详情：右侧抽屉。点卡片打开，按来源区（启用 / 我的 / 团队）传 panelTab，
          复用现有 SkillDetailPane 的全部动作（启停 / 配置 / 编辑 / 版本 / 卸载…）。 */}
      <Sheet open={!!detailSkill} onOpenChange={(open) => { if (!open) closeDetail() }}>
        <SheetContent
          side="right"
          closeable={false}
          className="app-region-no-drag no-drag flex w-full flex-col gap-0 p-0 sm:max-w-[640px]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <VisuallyHidden>
            <SheetTitle>{detailSkill ? resolveSkillDisplayName(detailSkill) : ''}</SheetTitle>
          </VisuallyHidden>
          <div
            className="app-region-no-drag no-drag flex shrink-0 items-center justify-end border-b border-border/40 px-3 py-2"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={closeDetail}
              aria-label={t('skills.detail.close', { defaultValue: '关闭' })}
              className="app-region-no-drag no-drag h-7 w-7 p-0 text-muted-foreground/80"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            {detailSkill && detailReadiness ? (
              <SkillDetailPane
                key={`${getSkillPanelIdentityKey(detailSkill)}:${detailOrigin}`}
                skill={detailSkill}
                panelTab={detailOrigin}
                // 推荐货架是浏览心智：详情不露卸载；「我的」已获取仍可卸。
                suppressUninstall={marketplaceMode && effectiveSourceFilter === 'builtin'}
                spaceId={currentSpaceId}
                organizationId={organizationId}
                isPersonalOrganization={isPersonalOrganization}
                config={detailCfg}
                readiness={detailReadiness}
                currentUserId={currentUserId}
                onConfigure={handleOpenConfig}
                onUninstall={handleUninstall}
                onRemoveFromMine={handleRemoveFromMine}
                onDelete={setDeleteTarget}
                onRemoveFromOrg={handleRemoveFromOrg}
                onMakeTeamVisible={requestMakeTeamVisible}
                onChangeCategory={setCategorySkill}
                onUpgrade={handleUpgrade}
                onSaveAsCopy={handleSaveAsCopy}
                onForkToMine={handleForkToMine}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )

  if (useStandaloneShell) {
    return (
      <StandaloneModulePage
        icon={<BookText strokeWidth={1.5} absoluteStrokeWidth aria-hidden />}
        title={t('skills.title')}
        description={<SkillsPageSubtitle />}
        descriptionClassName="whitespace-normal"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-hover px-3">
          {panelBody}
        </div>
      </StandaloneModulePage>
    )
  }

  return (
    <div className={cn(
      'min-w-0 w-full max-w-none',
      marketplaceMode ? '' : 'h-full overflow-y-auto',
    )}>
      <div className={pageShellClass}>
        {showPageHeader ? (
          <ContextPageHeader
            icon={<BookText strokeWidth={1.5} absoluteStrokeWidth aria-hidden />}
            title={t('skills.title')}
            description={<SkillsPageSubtitle />}
            descriptionClassName="whitespace-normal"
          />
        ) : null}
        {panelBody}
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// SkillCard — 卡片（启用区 / 能力库共用），点开右侧详情抽屉
// ---------------------------------------------------------------------------

function hasUpgradeAvailable(skill: SkillIndexEntry, currentUserId?: string): boolean {
  if (normalizeSkillSource(skill.source) !== 'user') return false
  if (skill.installed_version_seq == null) return false
  const isOwner = currentUserId ? isSkillOwnedByCurrentUser(skill, currentUserId) : false
  // Owner 通过版本列表「切换」管理版本，不走升级流。
  if (isOwner) return false
  const targetSeq = skill.latest_approved_version_seq ?? skill.latest_version_seq
  if (targetSeq == null) return false
  return skill.installed_version_seq < targetSeq
}

/** 升级徽章：优先用 label；缺 label 时用 seq 兜底成 vN。 */
function formatUpgradeVersionHint(
  label: string | null | undefined,
  seq: number | null | undefined,
): string {
  const fromLabel = formatSkillVersionLabel(label || '')
  if (fromLabel) return fromLabel
  if (seq != null && Number.isFinite(seq)) return `v${seq}`
  return ''
}

const SkillCard: React.FC<{
  skill: SkillIndexEntry
  config: SkillConfig | undefined
  active: boolean
  marketplace?: boolean
  organizationShelf?: boolean
  showMarketplacePath?: boolean
  localDiscovery?: boolean
  configuredAgentCount?: number
  onOpen: () => void
  onManage?: () => void
  onUpgrade?: (skill: SkillIndexEntry) => void
}> = React.memo(({
  skill,
  config,
  active,
  marketplace = false,
  organizationShelf = false,
  showMarketplacePath = false,
  localDiscovery = false,
  configuredAgentCount = 0,
  onOpen,
  onManage,
  onUpgrade,
}) => {
  const { t } = useTranslation('context')
  const uid = useAuthStore(state => state.user?.id != null ? String(state.user.id) : '')
  const readiness = computeReadiness(skill, config)
  const enabled = isSkillEnabledInCurrentSpace(skill)
  const upgradeAvailable = hasUpgradeAvailable(skill, uid)
  const fromVersion = formatUpgradeVersionHint(null, skill.installed_version_seq)
  const toVersion = formatUpgradeVersionHint(
    skill.latest_version_label,
    skill.latest_approved_version_seq ?? skill.latest_version_seq,
  )
  const showUpgradeCta = Boolean(upgradeAvailable && onUpgrade)

  if (marketplace) {
    // 市场「已管理」与 chip / Agent 携带分层：
    // 本人创建的 Skill（含已共享到组织）即使尚未写 UserSkillPreference，
    // 也直接「管理」；队友的组织共享仍须显式获取。
    const installed = isMarketplaceSkillManaged(skill, uid, {
      localDiscovery,
      configuredAgentCount,
    })
    const sharedByMe = organizationShelf
      && skill.visibility === 'organization'
      && isSkillOwnedByCurrentUser(skill, uid)
    const configuredForAgent = installed && configuredAgentCount > 0
    const isPrimaryAction = !installed
    const displayName = resolveSkillDisplayName(skill)
    return (
      <article
        data-skill-key={getSkillKey(skill)}
        className={cn(
          'flex h-[128px] min-w-0 flex-col overflow-hidden rounded-[10px] border border-border/80 bg-card px-4 py-3.5 shadow-sm transition-colors',
          'hover:border-border hover:bg-muted/20 hover:shadow',
          active && 'border-foreground/25 bg-muted/20',
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          className="flex min-h-0 min-w-0 flex-1 items-start gap-3 overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-foreground/[0.04] text-subtitle text-primary-text"
            aria-hidden
          >
            {skill.emoji
              ? skill.emoji
              : <BookText className="h-4 w-4" strokeWidth={1.5} absoluteStrokeWidth />}
          </span>
          <span className="min-w-0 flex-1">
            <MarketplaceCardText
              text={displayName}
              lines={1}
              className="text-body font-semibold text-foreground"
            />
            {skill.description ? (
              <MarketplaceCardText
                text={skill.description}
                lines={2}
                className="mt-1 text-caption leading-relaxed text-muted-foreground/80"
              />
            ) : null}
            {(showMarketplacePath || localDiscovery) && skill.path ? (
              <span
                className="mt-1.5 block truncate font-mono text-caption text-muted-foreground/60"
                title={skill.path}
              >
                {skill.path}
              </span>
            ) : null}
          </span>
        </button>
        <footer className="mt-2.5 flex shrink-0 items-center justify-end gap-2">
          {sharedByMe ? (
            <span className="ml-auto text-caption font-medium text-primary-text">
              {t('skills.marketplace.sharedByMe')}
            </span>
          ) : installed ? (
            <span className={cn(
              'mr-auto text-caption font-medium',
              configuredForAgent
                ? 'text-primary-text'
                : 'text-muted-foreground/60',
            )}>
              {configuredForAgent
                ? t('skills.marketplace.configuredAgentCount', { count: configuredAgentCount })
                : t('skills.marketplace.notConfigured')}
            </span>
          ) : null}
          {!sharedByMe && (!localDiscovery || onManage) ? (
            <Button
              type="button"
              variant={isPrimaryAction ? 'default' : 'ghost'}
              size="sm"
              onClick={onManage ?? onOpen}
              className={cn(
                'h-7 rounded-md px-3 text-caption font-medium',
                !isPrimaryAction && 'bg-muted/60 hover:bg-muted',
              )}
            >
              {installed
                ? t('skills.marketplace.manageAction')
                : t('skills.marketplace.getAction')}
            </Button>
          ) : null}
        </footer>
      </article>
    )
  }

  const mainRow = (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 flex-1 items-start gap-2.5 text-left font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-md"
    >
      <span
        className={cn(
          'mt-px flex h-5 w-5 shrink-0 items-center justify-center leading-none',
          enabled ? 'text-accent-text' : 'text-muted-foreground/40',
        )}
        aria-hidden
      >
        {skill.emoji
          ? <span className="text-body">{skill.emoji}</span>
          : <BookText className="h-4 w-4" strokeWidth={1.5} absoluteStrokeWidth />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
            {resolveSkillDisplayName(skill)}
          </span>
          {isWorkspaceScanSkill(skill) ? (
            <span className={cn('shrink-0', 'inline-flex', 'items-center', 'gap-0.5', 'rounded-full', 'bg-sky-500/10', 'px-1.5', 'py-px', 'font-medium', 'text-sky-600', 'dark:text-sky-400', CANVAS_TEXT_MICRO)}>
              <FolderTree className="h-2.5 w-2.5" strokeWidth={2} />
              {typeof skill.meta?.workspace_space_name === 'string' && skill.meta.workspace_space_name
                ? skill.meta.workspace_space_name
                : t('skills.panel.mineScope.workspace', { defaultValue: '工作区' })}
            </span>
          ) : normalizeSkillSource(skill.source) === 'device' ? (
            <span className={cn('shrink-0', 'inline-flex', 'items-center', 'gap-0.5', 'rounded-full', 'bg-emerald-500/10', 'px-1.5', 'py-px', 'font-medium', 'text-emerald-600', 'dark:text-emerald-400', CANVAS_TEXT_MICRO)}>
              <Monitor className="h-2.5 w-2.5" strokeWidth={2} />
              {t('skills.deviceReadonly')}
            </span>
          ) : null}
          {upgradeAvailable ? (
            <span className={cn('shrink-0', 'inline-flex', 'items-center', 'gap-0.5', 'rounded-full', 'bg-foreground/[0.04]', 'px-1.5', 'py-px', 'text-primary-text', CANVAS_TEXT_META_BASE)}>
              <ArrowUpCircle className="h-2.5 w-2.5" />
              {fromVersion && toVersion
                ? t('skills.upgrade.badgeRange', {
                  from: fromVersion,
                  to: toVersion,
                  defaultValue: `有更新 ${fromVersion} → ${toVersion}`,
                })
                : t('skills.upgrade.badge', { version: toVersion || '?' })}
            </span>
          ) : null}
        </div>
        {skill.description ? (
          <p className={cn('mt-0.5', 'break-words', 'line-clamp-1', CANVAS_TEXT_SECONDARY)}>
            {skill.description}
          </p>
        ) : null}
      </div>
    </button>
  )

  return (
    <div
      data-skill-key={getSkillKey(skill)}
      className={cn(
        showUpgradeCta
          ? 'group flex min-w-0 flex-col gap-2 rounded-[12px] p-3.5 transition-colors'
          : 'group flex min-w-0 items-center gap-3 rounded-[12px] p-3.5 transition-colors',
        active
          ? 'surface-row-active'
          : 'bg-foreground/[0.03] hover:bg-foreground/[0.045] dark:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06]',
        (!enabled || readiness === 'incompatible') && !active && 'opacity-60',
      )}
    >
      {showUpgradeCta ? (
        <div className="flex min-w-0 items-center gap-3">{mainRow}</div>
      ) : mainRow}
      {showUpgradeCta && (
        <div className="flex flex-wrap items-center gap-1.5 pl-7">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 text-primary-text"
            onClick={(e) => {
              e.stopPropagation()
              onUpgrade?.(skill)
            }}
          >
            <ArrowUpCircle className="h-[1em] w-[1em]" />
            {t('skills.upgrade.updateToLatest', { defaultValue: '更新到最新' })}
          </Button>
        </div>
      )}
    </div>
  )
})
SkillCard.displayName = 'SkillCard'

// ---------------------------------------------------------------------------
// SkillDetailPane — 右侧详情面板
// ---------------------------------------------------------------------------

const SkillDetailPane: React.FC<{
  skill: SkillIndexEntry
  panelTab: SkillPanelTab
  /** 市场「推荐」货架浏览态：强制隐藏卸载入口 */
  suppressUninstall?: boolean
  spaceId: string
  organizationId: string | null
  isPersonalOrganization: boolean
  config: SkillConfig | undefined
  readiness: SkillReadiness
  currentUserId: string
  onConfigure: (skill: SkillIndexEntry) => void
  onUninstall: (skill: SkillIndexEntry) => void
  onRemoveFromMine: (skill: SkillIndexEntry) => void
  onDelete: (skill: SkillIndexEntry) => void
  onRemoveFromOrg: (skill: SkillIndexEntry) => void
  onMakeTeamVisible: (skill: SkillIndexEntry) => void
  onChangeCategory: (skill: SkillIndexEntry) => void
  onUpgrade: (skill: SkillIndexEntry) => void
  onSaveAsCopy: (skill: SkillIndexEntry) => void
  onForkToMine: (skill: SkillIndexEntry) => void
}> = React.memo(({ skill, panelTab, suppressUninstall = false, spaceId, organizationId, isPersonalOrganization, config, readiness: _readiness, currentUserId, onConfigure, onUninstall, onRemoveFromMine, onDelete, onRemoveFromOrg, onMakeTeamVisible, onChangeCategory, onUpgrade, onSaveAsCopy, onForkToMine }) => {
  const { t } = useTranslation('context')
  const agents = skill.agents ?? []
  const mineManagement = isMineManagementTab(panelTab)
  const productState = getSkillDetailProductState(skill, currentUserId, panelTab, isPersonalOrganization)
  const {
    isOwner,
    isUserSkill,
    canShowUninstall: canShowUninstallRaw,
    canShowMakeTeamVisible,
    canShowRemoveFromOrg,
    canShowDelete,
    canShowRemoveFromMine,
    canShowSaveAsCopy,
    canShowForkToMine,
    canShowImportToSpace,
    canShowChangeCategory,
  } = productState
  const canShowUninstall = canShowUninstallRaw && !suppressUninstall
  // Marketplace 安装包是 install/uninstall 心智。
  // 从组织移除 = 将组织快照改回 private，不影响「我的」原件。
  const needsConfig = Boolean(skill.primary_env)
    || (skill.requires?.env || []).length > 0
    || (skill.install || []).length > 0
  const requiredBins = skill.requires?.bins || []
  const hasUpgrade = hasUpgradeAvailable(skill, currentUserId)
  const canEditFiles = canEditSkillFiles(skill, currentUserId, panelTab, organizationId)
  const canShowEditAction = mineManagement && canEditFiles
  // 快速使用：泛化为「builtin 代码注册表 ‖ user skill 激活版本/草稿的 quick_use preset 列表」。
  // 一个 skill 可有多个预填示例（详情页列出供用户直观感知能力）。
  // 解析有副作用（user 来源会为每个 preset 注册动态 descriptor），按 skill 身份与列表缓存。
  const quickUseList = useMemo(
    () => resolveSkillQuickUse(skill),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skill.skill_key, skill.skill_id, skill.app_id, skill.slug, skill.source, skill.quick_use],
  )
  const canQuickUse = quickUseList.length > 0
  // 版本历史：user 来源且已有发布版本才有可看的历史（builtin / 未发布草稿无）。
  const canShowVersionHistory = isUserSkill && Boolean(skill.has_published)
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const startDraftSessionForSpace = useChatStore(s => s.startDraftSessionForSpace)
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)

  const handleInsertQuickUse = useCallback((preset: ResolvedSkillQuickUse) => {
    // 律 1「唤起不流放」（principle/workspace-project.md §7.2，）：
    // 只展开副驾栏注入 preset，不再 setActiveKey(spaceId, null) 把用户从
    // 技能详情页踢回 Space Home。
    useUIStore.getState().setChatSidePanelCollapsed(false)

    let scopeId = resolveComposerPresetScopeId(currentSessionId, spaceId)
    if (!currentSessionId) {
      startDraftSessionForSpace(spaceId)
      scopeId = getDraftComposerPresetScopeId(spaceId)
    }
    if (!scopeId) return

    const presetStore = useComposerPresetStore.getState()
    const existingPresets = presetStore.getPresets(scopeId)
    if (existingPresets.length > 0) {
      toast({
        title: '已替换原本的预设表单',
        description: '上一份未发送的表单内容已被本次快速使用覆盖。',
      })
    }

    presetStore.addPreset(
      scopeId,
      preset.presetId,
      {
        source: 'skill_detail_quick_use',
        skill_key: skill.skill_key,
        skill_name: skill.display_name || skill.name || preset.skillKey,
        preset_label: preset.label,
      },
      buildSkillQuickUseGeneratedState(preset),
    )
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('[data-chat-input-textarea="true"]')?.focus()
    })
    toast({
      title: t('skills.quickUse.toastTitle', '已生成到输入框'),
      description: t('skills.quickUse.toastDescription', '你可以先微调预设内容，再确认发送。'),
    })
  }, [currentSessionId, skill.display_name, skill.name, skill.skill_key, spaceId, startDraftSessionForSpace, t])

  return (
    <ScrollArea className="h-full">
      <div className="flex h-full min-h-0 flex-col px-5 py-4">
        <div className="space-y-5">
          {/* Header */}
          <ContextPageHeader
            icon={skill.emoji ? (
              <span className="text-title leading-none">{skill.emoji}</span>
            ) : (
              <Code2 className="h-7 w-7" />
            )}
            title={resolveSkillDisplayName(skill)}
            description={(
              <span className="font-mono">{formatSkillPanelTitle(skill)}</span>
            )}
            actions={(
              <div className="flex shrink-0 items-center gap-1">
                {canShowEditAction && (
                  <SkillTooltip content={t('skills.editor.edit')}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditorOpen(true)}
                      className="h-7 w-7 shrink-0 rounded-full p-0 text-muted-foreground/60 hover:text-foreground"
                      aria-label={t('skills.editor.edit')}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </SkillTooltip>
                )}
                {/* 配置——仅当 skill 需要环境/凭据配置时外显 */}
                {needsConfig && (
                  <SkillTooltip content={t('skills.panel.configure')}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onConfigure(skill)}
                      className="h-7 w-7 shrink-0 rounded-full p-0 text-muted-foreground/60 hover:text-foreground"
                      aria-label={t('skills.panel.configure')}
                    >
                      <Settings className="h-4 w-4" />
                    </Button>
                  </SkillTooltip>
                )}
                {/* 升级——有新版本时是时效性 CTA，外显并用降饱和主题色点睛 */}
                {hasUpgrade && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onUpgrade(skill)}
                    className="shrink-0 text-primary-text"
                  >
                    <ArrowUpCircle className="h-[1em] w-[1em]" />
                    {t('skills.upgrade.updateToLatest', { defaultValue: '更新到最新' })}
                  </Button>
                )}
                {/* 共享给组织：我的 Skill 改可见性，不新建副本 */}
                {canShowMakeTeamVisible && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onMakeTeamVisible(skill)}
                    className="shrink-0"
                  >
                    <Users className="h-[1em] w-[1em]" />
                    {t('skills.makeTeamVisible')}
                  </Button>
                )}
                {/* 本机主路径是开关启停；市场/内置不再提供「另存为我的再编辑」。 */}
                {canShowImportToSpace && (
                  <SkillTooltip content={t('skills.importToSpaceHint')}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onForkToMine(skill)}
                      className="shrink-0"
                    >
                      <Copy className="h-[1em] w-[1em]" />
                      {t('skills.importToSpace')}
                    </Button>
                  </SkillTooltip>
                )}
                <SkillDetailActionsMenu
                  skill={skill}
                  canShowUninstall={canShowUninstall}
                  canShowRemoveFromMine={canShowRemoveFromMine}
                  canShowMakeTeamVisible={false}
                  canShowRemoveFromOrg={canShowRemoveFromOrg}
                  canShowDelete={canShowDelete}
                  canShowSaveAsCopy={canShowSaveAsCopy}
                  canShowForkToMine={canShowForkToMine && !canShowImportToSpace}
                  canShowChangeCategory={canShowChangeCategory}
                  onDelete={onDelete}
                  onUninstall={onUninstall}
                  onRemoveFromMine={onRemoveFromMine}
                  onRemoveFromOrg={onRemoveFromOrg}
                  onMakeTeamVisible={onMakeTeamVisible}
                  onChangeCategory={onChangeCategory}
                  onSaveAsCopy={onSaveAsCopy}
                  onForkToMine={onForkToMine}
                />
              </div>
            )}
            footer={(
              <div className="flex flex-wrap items-center gap-1.5">
                <SkillRelationBadge skill={skill} detailKind={productState.detailKind} />
                <SkillCategoryBadge skill={skill} />
                <SkillCurrentVersionChip
                  skill={skill}
                  canOpenHistory={canShowVersionHistory}
                  onOpenHistory={() => setVersionHistoryOpen(true)}
                />
                {requiredBins.length > 0 && (
                  <span className={cn('inline-flex', 'items-center', 'rounded-full', 'bg-foreground/[0.04]', 'px-1.5', 'py-0.5', 'text-warning', CANVAS_TEXT_META_BASE)}>
                    {t('skills.requiresBinsShort', { bins: requiredBins.join(', ') })}
                  </span>
                )}
              </div>
            )}
          />

          {/* Description */}
          {skill.description && (
            <div className="space-y-1">
              <h3 className={SETTINGS_GROUP_LABEL}>{t('skills.detail.descriptionLabel')}</h3>
              <p className="text-body text-muted-foreground">{skill.description}</p>
            </div>
          )}

          {/* Agents */}
          {agents.length > 0 && (
            <div className="space-y-2">
              <h3 className={SETTINGS_GROUP_LABEL}>
                {t('skills.panel.agents')}
              </h3>
              <div className="space-y-0.5">
                {agents.map(agent => (
                  <AgentRow key={agent.name} agent={agent} />
                ))}
              </div>
            </div>
          )}

          {/* 快速使用：preset 列表——点任一项填表生成提示词插入对话框，让用户直观感知能力。 */}
          {canQuickUse && (
            <div className="space-y-2.5">
              <div className="space-y-1">
                <h3 className={SETTINGS_GROUP_LABEL}>{t('skills.quickUse.sectionTitle')}</h3>
                <p className={CANVAS_TEXT_META}>
                  {t('skills.quickUse.autoDescription', '无需填写参数，TabTin 会先生成一条可发送的任务草稿。')}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                {quickUseList.map(preset => (
                  <Button
                    key={preset.presetId}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleInsertQuickUse(preset)}
                    className="group flex h-auto items-center justify-start gap-2.5 whitespace-normal rounded-[12px] bg-foreground/[0.03] px-3 py-2.5 text-left font-normal transition-colors hover:bg-foreground/[0.045] dark:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06]"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.04] text-accent-text transition-colors dark:bg-foreground/[0.06]">
                      <Sparkles className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-medium text-foreground">{preset.label}</span>
                      <span className={cn('block', 'truncate', CANVAS_TEXT_META)}>
                        {t('skills.quickUse.cardHint', '自动生成一条提示词草稿，放到 Chat 输入区确认发送。')}
                      </span>
                    </span>
                    <span className={cn('shrink-0', 'rounded-full', 'bg-foreground/[0.04]', 'px-2', 'py-0.5', 'font-medium', 'transition-colors', 'group-hover:text-accent-text', CANVAS_TEXT_META)}>
                      {t('skills.quickUse.insertAction')}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* SKILL.md — fill the remaining detail-pane height with its own scroll area. */}
        <SkillMdEditor
          skill={skill}
          spaceId={spaceId}
          organizationId={organizationId}
          currentUserId={currentUserId}
          allowOwnerEdit={mineManagement || (panelTab === 'organization' && isOwner)}
          editableOverride={canEditFiles}
          hideEntryButton
          editorOpen={editorOpen}
          onEditorOpenChange={setEditorOpen}
          className="pt-5"
          fillRemaining
        />
        {canShowVersionHistory && (
          <SkillVersionHistoryDialog
            open={versionHistoryOpen}
            onOpenChange={setVersionHistoryOpen}
            skill={skill}
            spaceId={spaceId}
            isOwner={isOwner}
          />
        )}
      </div>
    </ScrollArea>
  )
})
SkillDetailPane.displayName = 'SkillDetailPane'

const SkillDetailActionsMenu: React.FC<{
  skill: SkillIndexEntry
  canShowUninstall: boolean
  canShowRemoveFromMine: boolean
  canShowMakeTeamVisible: boolean
  canShowRemoveFromOrg: boolean
  canShowDelete: boolean
  canShowSaveAsCopy: boolean
  canShowForkToMine: boolean
  canShowChangeCategory: boolean
  onUninstall: (skill: SkillIndexEntry) => void
  onRemoveFromMine: (skill: SkillIndexEntry) => void
  onDelete: (skill: SkillIndexEntry) => void
  onRemoveFromOrg: (skill: SkillIndexEntry) => void
  onMakeTeamVisible: (skill: SkillIndexEntry) => void
  onChangeCategory: (skill: SkillIndexEntry) => void
  onSaveAsCopy: (skill: SkillIndexEntry) => void
  onForkToMine: (skill: SkillIndexEntry) => void
}> = ({
  skill,
  canShowUninstall,
  canShowRemoveFromMine,
  canShowMakeTeamVisible,
  canShowRemoveFromOrg,
  canShowDelete,
  canShowSaveAsCopy,
  canShowForkToMine,
  canShowChangeCategory,
  onUninstall,
  onRemoveFromMine,
  onDelete,
  onRemoveFromOrg,
  onMakeTeamVisible,
  onChangeCategory,
  onSaveAsCopy,
  onForkToMine,
}) => {
  const { t } = useTranslation('context')
  const hasPrimaryActions = canShowChangeCategory
    || canShowSaveAsCopy
    || canShowForkToMine
    || canShowMakeTeamVisible
    || canShowRemoveFromOrg
  const hasDangerActions = canShowUninstall || canShowRemoveFromMine || canShowDelete

  if (!hasPrimaryActions && !hasDangerActions) return null

  const itemClassName = 'gap-2 text-foreground/80 focus:text-foreground'
  const itemIconClassName = 'h-3.5 w-3.5 text-muted-foreground/80'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 rounded-full p-0 text-muted-foreground/60 hover:text-foreground"
          aria-label={t('skills.panel.moreActions')}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[176px]">
        {canShowChangeCategory && (
          <DropdownMenuItem onSelect={() => onChangeCategory(skill)} className={itemClassName}>
            <Tags className={itemIconClassName} />
            {t('skills.categoryDialog.menuItem')}
          </DropdownMenuItem>
        )}
        {canShowSaveAsCopy && (
          <DropdownMenuItem onSelect={() => onSaveAsCopy(skill)} className={itemClassName}>
            <Copy className={itemIconClassName} />
            {t('skills.saveAsCopy')}
          </DropdownMenuItem>
        )}
        {canShowForkToMine && (
          <DropdownMenuItem onSelect={() => onForkToMine(skill)} className={itemClassName}>
            <Copy className={itemIconClassName} />
            {t('skills.forkToMine')}
          </DropdownMenuItem>
        )}
        {canShowMakeTeamVisible && (
          <DropdownMenuItem onSelect={() => onMakeTeamVisible(skill)} className={itemClassName}>
            <Users className={itemIconClassName} />
            {t('skills.makeTeamVisible')}
          </DropdownMenuItem>
        )}
        {canShowRemoveFromOrg && (
          <DropdownMenuItem onSelect={() => onRemoveFromOrg(skill)} className={itemClassName}>
            <EyeOff className={itemIconClassName} />
            {t('skills.removeFromOrg')}
          </DropdownMenuItem>
        )}
        {hasPrimaryActions && hasDangerActions && <DropdownMenuSeparator />}
        {canShowUninstall && (
          <DropdownMenuItem
            onSelect={() => onUninstall(skill)}
            className="gap-2 text-destructive focus:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('skills.uninstall')}
          </DropdownMenuItem>
        )}
        {canShowRemoveFromMine && (
          <DropdownMenuItem
            onSelect={() => onRemoveFromMine(skill)}
            className="gap-2 text-destructive focus:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('skills.removeFromMine')}
          </DropdownMenuItem>
        )}
        {canShowDelete && (
          <DropdownMenuItem
            onSelect={() => onDelete(skill)}
            className="gap-2 text-destructive focus:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('skills.discardDraft')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const SkillCategoryDialog: React.FC<{
  open: boolean
  onOpenChange: (open: boolean) => void
  skill: SkillIndexEntry | null
  saving: boolean
  onSave: (skill: SkillIndexEntry, category: string | null) => void
}> = ({ open, onOpenChange, skill, saving, onSave }) => {
  const { t } = useTranslation('context')
  // 与市场「全部」后的分类 chip 同源（文档写作 / 协作效率 / …），不含「全部」与旧 27 细分类。
  const [category, setCategory] = useState<string>(SKILL_MARKET_CATEGORY_ORDER[0])

  useEffect(() => {
    if (!open) return
    setCategory(resolveSkillMarketCategory(skill?.category) ?? SKILL_MARKET_CATEGORY_ORDER[0])
  }, [open, skill?.category])

  if (!skill) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <ContextDialogHeader
          className="px-0 pt-0"
          icon={<Tags className="h-7 w-7" />}
          title={t('skills.categoryDialog.title')}
          description={t('skills.categoryDialog.description', { name: resolveSkillDisplayName(skill) })}
        />

        <div className="space-y-3 py-2">
          <label className="block space-y-1.5">
            <span className={cn('font-medium', 'text-foreground/80', CANVAS_TEXT_META_BASE)}>
              {t('skills.categoryDialog.fieldLabel')}
            </span>
            <Select
              value={category}
              onValueChange={setCategory}
              disabled={saving}
            >
              <SelectTrigger className="h-8 bg-background" aria-label={t('skills.categoryDialog.fieldLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SKILL_MARKET_CATEGORY_ORDER.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`skills.marketplaceCategory.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('skills.categoryDialog.cancel')}
          </Button>
          <Button onClick={() => onSave(skill, category || null)} disabled={saving}>
            {saving ? t('skills.categoryDialog.saving') : t('skills.categoryDialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// AgentRow
// ---------------------------------------------------------------------------

const AgentRow: React.FC<{ agent: AgentDefinition }> = React.memo(({ agent }) => (
  <div className="flex items-start gap-2 rounded-interactive px-2 py-1.5 hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]">
    <User className="h-3.5 w-3.5 shrink-0 text-primary-text mt-0.5" />
    <div className="min-w-0 flex-1 overflow-hidden">
      <span className="text-body font-medium text-foreground/80">{agent.name}</span>
      {agent.description && (
        <p className={cn('break-words', 'm-0', CANVAS_TEXT_META)}>{agent.description}</p>
      )}
      {(agent.model || agent.tool_domains?.length) && (
        <div className="flex flex-wrap gap-1 mt-1">
          {agent.model && (
            <span className={cn('inline-flex', 'items-center', 'rounded-full', 'bg-foreground/[0.04]', 'px-1.5', 'py-px', CANVAS_TEXT_META)}>
              {agent.model}
            </span>
          )}
          {agent.tool_domains?.map(domain => (
            <span key={domain} className={cn('inline-flex', 'items-center', 'rounded-full', 'bg-foreground/[0.04]', 'px-1.5', 'py-px', CANVAS_TEXT_META)}>
              {domain}
            </span>
          ))}
        </div>
      )}
    </div>
  </div>
))
AgentRow.displayName = 'AgentRow'

// ---------------------------------------------------------------------------
// UpgradeConflictDialog — PRD §7.4 三选一
// ---------------------------------------------------------------------------

const UpgradeConflictDialog: React.FC<{
  target: { skill: SkillIndexEntry; latestVersion: number } | null
  isLoading: boolean
  onResolve: (resolution: UpgradeResolution) => void
  onClose: () => void
}> = ({ target, isLoading, onResolve, onClose }) => {
  const { t } = useTranslation('context')
  const [selected, setSelected] = useState<UpgradeResolution>('keep_local')

  if (!target) return null

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={t('skills.upgrade.conflictTitle')}
      description=""
      confirmText={t('skills.upgrade.confirm')}
      isLoading={isLoading}
      onConfirm={() => onResolve(selected)}
    >
      <div className="space-y-3 py-2">
        <p className="text-body text-muted-foreground">
          {t('skills.upgrade.conflictBody', { version: target.latestVersion })}
        </p>
        <RadioGroup
          value={selected}
          onValueChange={value => setSelected(value as UpgradeResolution)}
          className="space-y-1.5"
        >
          {(['keep_local', 'accept_new', 'fork_as_copy'] as const).map(opt => (
            <label
              key={opt}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-interactive px-3 py-2.5 transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                selected === opt && 'surface-row-active',
              )}
            >
              <RadioGroupItem value={opt} className="mt-0.5 shrink-0" />
              <span className={cn('text-body', opt === 'accept_new' && 'text-destructive')}>
                {t(`skills.upgrade.${opt === 'keep_local' ? 'keepLocal' : opt === 'accept_new' ? 'acceptNew' : 'forkAsCopy'}`)}
              </span>
            </label>
          ))}
        </RadioGroup>
      </div>
    </ConfirmDialog>
  )
}

// ---------------------------------------------------------------------------
// SourceBadge
// ---------------------------------------------------------------------------

const SourceBadge: React.FC<{ source: string }> = React.memo(({ source }) => {
  const { t } = useTranslation('context')
  const normalized = normalizeSkillSource(source)
  return (
    <span className={cn(
      'shrink-0 inline-flex items-center rounded px-1 py-px CANVAS_TEXT_MICRO leading-tight font-medium',
      sourceStyle(source),
    )}>
      {t(`skills.source.${normalized}`, { defaultValue: normalized })}
    </span>
  )
})
SourceBadge.displayName = 'SourceBadge'

const SkillCategoryBadge: React.FC<{ skill: SkillIndexEntry }> = ({ skill }) => {
  const { t } = useTranslation('context')
  const marketCategory = resolveSkillMarketCategory(skill.category)
  const label = marketCategory
    ? t(`skills.marketplaceCategory.${marketCategory}`)
    : t(skillCategoryLabelKeyWithFallback(skill.category))
  return (
    <span className={cn('inline-flex', 'items-center', 'rounded-full', 'bg-foreground/[0.04]', 'px-1.5', 'py-0.5', CANVAS_TEXT_META)}>
      {label}
    </span>
  )
}
SkillCategoryBadge.displayName = 'SkillCategoryBadge'

const SkillRelationBadge: React.FC<{
  skill: SkillIndexEntry
  detailKind: SkillDetailKind
}> = React.memo(({ skill, detailKind }) => {
  const { t } = useTranslation('context')
  if (detailKind === 'marketplace_installed') {
    return (
      <span className={cn(
        'shrink-0 inline-flex items-center rounded px-1 py-px CANVAS_TEXT_MICRO leading-tight font-medium',
        sourceStyle(skill.source),
      )}>
        {t('skills.sourceGroup5.public_market')}
      </span>
    )
  }
  if (detailKind === 'organization_skill') {
    return (
      <span className={cn(
        'shrink-0 inline-flex items-center rounded px-1 py-px CANVAS_TEXT_MICRO leading-tight font-medium',
        sourceStyle(skill.source),
      )}>
        {t('skills.sourceGroup5.organization')}
      </span>
    )
  }
  if (detailKind === 'my_skill') {
    return (
      <span className={cn(
        'shrink-0 inline-flex items-center rounded px-1 py-px CANVAS_TEXT_MICRO leading-tight font-medium',
        sourceStyle(skill.source),
      )}>
        {t('skills.sourceGroup5.mine')}
      </span>
    )
  }
  if (detailKind === 'device_local') {
    if (isWorkspaceScanSkill(skill)) {
      const workspaceName = typeof skill.meta?.workspace_space_name === 'string'
        ? skill.meta.workspace_space_name
        : ''
      return (
        <span className={cn(
          'shrink-0 inline-flex items-center rounded px-1 py-px CANVAS_TEXT_MICRO leading-tight font-medium',
          'bg-sky-500/10 text-sky-600 dark:text-sky-400',
        )}>
          {workspaceName || t('skills.panel.mineScope.workspace')}
        </span>
      )
    }
    return (
      <span className={cn(
        'shrink-0 inline-flex items-center rounded px-1 py-px CANVAS_TEXT_MICRO leading-tight font-medium',
        sourceStyle(skill.source),
      )}>
        {t('skills.deviceReadonly')}
      </span>
    )
  }
  return <SourceBadge source={skill.source} />
})
SkillRelationBadge.displayName = 'SkillRelationBadge'
