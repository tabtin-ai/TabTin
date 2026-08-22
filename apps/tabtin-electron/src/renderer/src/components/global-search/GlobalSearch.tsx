/**
 * GlobalSearch — 统一搜索（PRD 3.x + 8.x；Wave 3 重写）
 *
 * 与旧版区别：
 * - 唯一调用 `unifiedSearch`（/api/search），废弃 SpaceApiService.searchOrganization +
 *   sessions.listAll 两路调用合并的脏路径
 * - 6 类卡片严格按 PRD 3.4 渲染（消息/资源/Agent/Space/备忘录/IM）
 * - 严格 IME composing 屏蔽 + AbortController 取消过时请求（PRD 8.3.A/B）
 * - SafeHighlight 渲染 `<em>` 高亮（不用 dangerouslySetInnerHTML，PRD 8.3.C）
 * - Loading 分级：200ms 静默 → 500ms skeleton → 2s "搜索较慢" → 5s "取消"（PRD 8.3.D）
 * - 搜索历史：localStorage `tabtin:search-history` 最近 10 条（PRD 8.3.E）
 * - 降级反馈三级：partial / fallback / unavailable，9 种 reason 全 i18n（PRD 3.12 / W2-5）
 * - 空态：最近打开 + 搜索历史；空结果：suggestions + 历史（PRD 3.6 / 3.7）
 * - 类型 Tab + 资源子类型二级筛选；Scope 徽章（Space）；点击卡片 Space 路径 → 收窄
 * - W2-2 IM 导航：result.type === 'im' 时 session_id 是 conversation_id，
 *   走 useSpaceListStore.activateConversation；其他消息走 enterChatSession + messageId
 * - R2-11 兼容：在不支持 agent_id 跨索引筛的 Tab 上显示提示
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Search, X, AlertTriangle, Loader2, History as HistoryIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { OPAQUE_OVERLAY_SURFACE_CLASS, ScrollArea, Skeleton } from '@components/ui'
import { toast } from '@tabtin/smartsheet-ui/toast'
import {
  unifiedSearch as _unifiedSearch,
  type FtsResultType,
  type FtsSearchResultItem,
  type UnifiedSearchParams,
} from '@tabtin/app-shell'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceContextTabsStore, type ContextItemRecord } from '@stores/useSpaceContextTabsStore'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { ChipTabBar, type ChipTabBarItem } from '@components/common/ChipTabBar'
import { contextRegistry, type ContextTabKey, type ContextItemType } from '@components/context-space/registry'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { navigateSearchResult } from '@/services/searchResultNavigation'
import { useAuthStore } from '@stores/useAuthStore'
import { useUnifiedSearch } from './hooks/useUnifiedSearch'
import {
  MessageResultCard,
  ResourceResultCard,
  AgentResultCard,
  SpaceResultCard,
  MemoResultCard,
  IMResultCard,
} from './cards'
import { getDegradedMessage, getResourceSubtypeLabel, getResultTypeLabel, RESULT_TYPE_EMOJI } from './i18n'
import { pushSearchHistory, readSearchHistory, clearSearchHistory } from './searchHistory'
import {
  pushRecentOpened,
  readRecentOpened,
  clearRecentOpened,
  type RecentOpenedItem,
} from './recentOpened'
import {
  InputScopePickers,
  parseScopeTrigger,
  removeScopeTrigger,
  type ActiveScopePicker,
} from './components/InputScopePickers'
import { useCliCommandMode, isCliCommand, type CliCommandKind } from './hooks/useCliCommandMode'
import { useTrackerStore } from '@/stores/useTrackerStore'

// 仅引用以避免 vitest hoist mock 时类型抖动（重写后不再用）
void _unifiedSearch

const GROUP_ORDER: FtsResultType[] = ['agent', 'space', 'message', 'resource', 'memo', 'im']
const GROUP_LIMIT_IN_ALL = 5
const SLOW_HINT_AFTER_MS = 2000
const CANCEL_BUTTON_AFTER_MS = 5000
const SKELETON_AFTER_MS = 500
const RESOURCE_SUBTYPES = ['tabdoc', 'tabdata', 'tabslide', 'tabcode', 'tabsite', 'tabfolder']

const TYPE_TABS: Array<{ key: '' | FtsResultType; labelKey: string; defaultLabel: string }> = [
  { key: '', labelKey: 'globalSearch:tabs.all', defaultLabel: '全部' },
  { key: 'message', labelKey: 'globalSearch:tabs.messages', defaultLabel: '消息' },
  { key: 'resource', labelKey: 'globalSearch:tabs.resources', defaultLabel: '资源' },
  { key: 'agent', labelKey: 'globalSearch:tabs.agents', defaultLabel: 'Agent' },
  { key: 'space', labelKey: 'globalSearch:tabs.spaces', defaultLabel: 'Space' },
  { key: 'memo', labelKey: 'globalSearch:tabs.memos', defaultLabel: '备忘录' },
  { key: 'im', labelKey: 'globalSearch:tabs.im', defaultLabel: 'IM' },
]

/** result type → 后端 logical types（GET ?types=...） */
const RESULT_TYPE_TO_LOGICAL: Record<FtsResultType, string> = {
  message: 'messages',
  resource: 'resources',
  agent: 'agents',
  space: 'spaces',
  memo: 'memos',
  im: 'im',
}

const isMac = typeof navigator !== 'undefined' && (
  /Mac|Macintosh/i.test(navigator.platform || '') ||
  /Mac OS X/i.test(navigator.userAgent || '')
)
const MOD_KEY = isMac ? '⌘' : 'Ctrl+'

const EMPTY_TAB_ORDER: string[] = []
const EMPTY_ITEMS_MAP: Record<string, ContextItemRecord> = {}

interface GlobalSearchProps {
  open: boolean
  onClose: () => void
  organizationId?: string | null
  activeSpaceId?: string | null
  /** 主 renderer 算好的前台标签 scope key（overlay 子窗口场景必传，见 OverlayGlobalSearchPayload）。 */
  tabScopeKey?: string | null
}

export function GlobalSearch({
  open,
  onClose,
  organizationId: organizationIdOverride,
  activeSpaceId: activeSpaceIdOverride,
  tabScopeKey: tabScopeKeyOverride,
}: GlobalSearchProps) {
  const { t } = useTranslation('globalSearch')
  const inputRef = useRef<HTMLInputElement>(null)
  const inputBoxRef = useRef<HTMLDivElement>(null)  // Picker 锚点
  // 用 ref 间接引用 handleNavigate，避免「最近打开 click → handleNavigate 未声明」
  // 的 TDZ 错误。声明必须在 handleRecentOpenedClick / handleNavigate 之前。
  const navigateRef = useRef<((item: FtsSearchResultItem) => Promise<void>) | null>(null)

  const [rawInput, setRawInput] = useState('')
  const [committedQuery, setCommittedQuery] = useState('')
  const [isComposing, setIsComposing] = useState(false)
  const [typeTab, setTypeTab] = useState<'' | FtsResultType>('')
  const [resourceSubtype, setResourceSubtype] = useState<string>('')
  const [scopeSpace, setScopeSpace] = useState<{ id: string; name: string } | null>(null)
  // PRD 3.8.A：Agent 筛选 Scope；agentId 来自 space.execution_agent_id（不是 space.id）
  const [scopeAgent, setScopeAgent] = useState<{ agentId: string; name: string } | null>(null)
  // PRD 3.8.B：creator 维度 toggle（所有 / 只看我 / 只看 Agent）
  const [creatorFilter, setCreatorFilter] = useState<'any' | 'user' | 'agent'>('any')
  const [retryNonce, setRetryNonce] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [recentOpened, setRecentOpened] = useState<RecentOpenedItem[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // @ / # / in: 触发的 picker 状态（基于 rawInput 实时解析）
  const scopeParse = useMemo(() => parseScopeTrigger(rawInput), [rawInput])
  const activePicker: ActiveScopePicker = scopeParse.picker

  const resourceSubtypeChipItems = useMemo<Array<ChipTabBarItem<string>>>(() => [
    { value: '', label: t('resourceSubtype.all', '全部类型') },
    ...RESOURCE_SUBTYPES.map((it) => ({
      value: it,
      label: (
        <>
          {contextRegistry.getDisplayEmoji(it) || '📄'}{' '}
          {getResourceSubtypeLabel(t, it)}
        </>
      ),
    })),
  ], [t])

  const selectedOrganizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const organizationId = organizationIdOverride ?? selectedOrganizationId

  const currentUserId = useAuthStore((s) => s.user?.id ?? null)
  const selfLabel = t('selfLabel', '你')

  // 已打开标签（本地匹配，不进 unifiedSearch）
  const selectedSpaceId = useSpaceStore((s) => s.selectedSpace?.id ?? null)
  const activeSpaceId = activeSpaceIdOverride ?? selectedSpaceId
  // 标签桶已 scope 化：读写都必须走前台 scope key，裸 spaceId 是
  // 没人读的 legacy 死桶。overlay 子窗口场景用主 renderer push 来的 override；
  // 主 renderer 内嵌 / 测试兜底场景自行解析。
  const activeTabScopeKey = useMemo(
    () => tabScopeKeyOverride ?? (activeSpaceId ? resolveForegroundTabScopeKey(activeSpaceId) : null),
    [tabScopeKeyOverride, activeSpaceId],
  )
  const tabOrder = useSpaceContextTabsStore((s) =>
    activeTabScopeKey ? s.tabOrderBySpace[activeTabScopeKey] ?? EMPTY_TAB_ORDER : EMPTY_TAB_ORDER,
  )
  const itemsMap = useSpaceContextTabsStore((s) =>
    activeTabScopeKey ? s.itemsBySpace[activeTabScopeKey] ?? EMPTY_ITEMS_MAP : EMPTY_ITEMS_MAP,
  )

  // 打开时重置 + focus + 加载历史
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => inputRef.current?.focus(), 50)
    setRawInput('')
    setCommittedQuery('')
    setTypeTab('')
    setResourceSubtype('')
    setScopeSpace(null)
    setScopeAgent(null)
    setCreatorFilter('any')
    setHistory(readSearchHistory())
    // 「最近打开」按当前 organization 过滤：避免切团队后空态展示上一团队的资源；
    // 兼容历史无 organizationId 的旧条目（按 null 处理 → 不展示在任何 organization 下，
    // 用户清空一次后这些遗留就消失）。
    setRecentOpened(
      readRecentOpened().filter((r) => organizationId && r.organizationId === organizationId),
    )
    setActiveIdx(0)
    return () => clearTimeout(timer)
  }, [open, organizationId])

  // 任何关键状态变化 → 重置选中项到第一个，避免索引越界
  useEffect(() => {
    setActiveIdx(0)
  }, [committedQuery, typeTab, resourceSubtype, scopeSpace, scopeAgent, creatorFilter])

  // IME 屏蔽：composing 期间不触发新查询，结束时同步 rawInput → committedQuery
  // 注意：committedQuery 仅在没有激活 picker 时同步——picker 显示中输入末段是
  // picker 内部搜索词（如 "@Cod"），不应被当作搜索关键词触发 unifiedSearch
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setRawInput(v)
    const parse = parseScopeTrigger(v)
    if (!isComposing) {
      // picker 激活时不更新 committedQuery（避免发送脏关键词到后端）；
      // 用户取消 picker 时（例如删除 @），committedQuery 跟随 v 变化
      if (parse.picker) {
        // committedQuery 维持上次（picker 选中后/取消后再同步）
      } else {
        setCommittedQuery(v)
      }
    }
  }, [isComposing])
  const handleCompositionStart = useCallback(() => setIsComposing(true), [])
  const handleCompositionEnd = useCallback((e: React.CompositionEvent<HTMLInputElement>) => {
    setIsComposing(false)
    const v = (e.target as HTMLInputElement).value
    const parse = parseScopeTrigger(v)
    if (!parse.picker) {
      setCommittedQuery(v)
    }
  }, [])

  // Picker 选中回调：把前缀从 rawInput 移除 + 设置对应 scope state
  const handlePickerSelectAgent = useCallback((agentId: string, name: string) => {
    setScopeAgent({ agentId, name })
    const next = removeScopeTrigger(rawInput, scopeParse.prefixStart)
    setRawInput(next)
    setCommittedQuery(next)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [rawInput, scopeParse])

  const handlePickerSelectType = useCallback((type: FtsResultType, subtype?: string) => {
    setTypeTab(type)
    setResourceSubtype(subtype || '')
    const next = removeScopeTrigger(rawInput, scopeParse.prefixStart)
    setRawInput(next)
    setCommittedQuery(next)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [rawInput, scopeParse])

  const handlePickerSelectSpace = useCallback((spaceId: string, name: string) => {
    setScopeSpace({ id: spaceId, name })
    const next = removeScopeTrigger(rawInput, scopeParse.prefixStart)
    setRawInput(next)
    setCommittedQuery(next)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [rawInput, scopeParse])

  const handlePickerCancel = useCallback(() => {
    // 用户主动取消（例如点击外部 / 按 ESC）：把前缀从 rawInput 移除，回到 normal 搜索
    if (scopeParse.prefixStart >= 0) {
      const next = removeScopeTrigger(rawInput, scopeParse.prefixStart)
      setRawInput(next)
      setCommittedQuery(next)
    }
  }, [rawInput, scopeParse])

  // 构造 unifiedSearch 请求参数（稳定引用：靠 useMemo + 对所有 dep 解析）
  // Wave 4:命令模式时不发搜索请求(避免后端无意义压力)
  const searchParams = useMemo<UnifiedSearchParams | null>(() => {
    if (!organizationId || !committedQuery.trim()) return null
    // 命令模式时短路掉搜索
    if (isCliCommand(committedQuery)) return null
    const types = typeTab === '' ? undefined : RESULT_TYPE_TO_LOGICAL[typeTab]
    return {
      q: committedQuery.trim(),
      organization_id: organizationId,
      types,
      item_type: typeTab === 'resource' && resourceSubtype ? resourceSubtype : undefined,
      space_id: scopeSpace?.id,
      // PRD 3.8.A：按 Agent 筛选；R2-11 提示——后端 agent_id 仅在 messages/agents 索引上生效
      agent_id: scopeAgent?.agentId,
      // PRD 3.8.B：按 creator 筛选；'any' 不传，让后端用默认值；'agent' 在
      // resources/memos/im 索引上后端会忽略（R2-11 同源问题，UI 层会显示提示）
      creator_type: creatorFilter === 'any' ? undefined : creatorFilter,
      limit: typeTab === '' ? 30 : 20,
    }
  }, [organizationId, committedQuery, typeTab, resourceSubtype, scopeSpace, scopeAgent, creatorFilter])

  const { loading, elapsedMs, response, error, cancel } = useUnifiedSearch({
    enabled: open,
    params: searchParams,
    retryNonce,
  })

  // 命中后写历史
  useEffect(() => {
    if (response && response.results.length > 0 && committedQuery.trim()) {
      pushSearchHistory(committedQuery.trim())
    }
  }, [response, committedQuery])

  // useMemo 而非裸 default：facets 引用变化才重新分组（避免每次 render 都重算 grouped）
  const facets = useMemo(() => response?.facets ?? {}, [response?.facets])

  // 分组：仅在 typeTab='' 时按 type 分组；单类型直接全部展示
  const grouped = useMemo<Array<{ type: FtsResultType; items: FtsSearchResultItem[]; total: number }>>(() => {
    if (!response) return []
    if (typeTab !== '') {
      // 单类型 Tab：直接展开
      return [{ type: typeTab, items: response.results, total: facets[RESULT_TYPE_TO_LOGICAL[typeTab]] ?? response.results.length }]
    }
    // "全部" Tab：按 type 分组
    const groups = new Map<FtsResultType, FtsSearchResultItem[]>()
    for (const item of response.results) {
      const arr = groups.get(item.type) ?? []
      arr.push(item)
      groups.set(item.type, arr)
    }
    const out: Array<{ type: FtsResultType; items: FtsSearchResultItem[]; total: number }> = []
    for (const t of GROUP_ORDER) {
      const items = groups.get(t)
      if (!items || items.length === 0) continue
      out.push({
        type: t,
        items: items.slice(0, GROUP_LIMIT_IN_ALL),
        total: facets[RESULT_TYPE_TO_LOGICAL[t]] ?? items.length,
      })
    }
    return out
  }, [response, typeTab, facets])

  // 拍平后的可导航 item 列表（顺序：已打开标签 + 各分组结果），供键盘导航与点击共享
  type FlatNavItem =
    | { kind: 'openTab'; tabKey: string; item: ContextItemRecord }
    | { kind: 'result'; item: FtsSearchResultItem }

  // 已打开标签（本地匹配；只在"全部"或对应 type Tab 上展示）
  const openTabMatches = useMemo(() => {
    const q = committedQuery.trim().toLowerCase()
    if (!activeTabScopeKey) return [] as Array<{ tabKey: string; item: ContextItemRecord }>
    const out: Array<{ tabKey: string; item: ContextItemRecord }> = []
    for (const tabKey of tabOrder) {
      const item = itemsMap[tabKey]
      if (!item) continue
      if (q) {
        const title = (item.title ?? '').toLowerCase()
        if (!title.includes(q)) continue
      } else if (committedQuery) {
        continue
      }
      out.push({ tabKey, item })
      if (out.length >= 5) break
    }
    return out
  }, [tabOrder, itemsMap, activeTabScopeKey, committedQuery])

  const flatNavItems = useMemo<FlatNavItem[]>(() => {
    const out: FlatNavItem[] = []
    for (const m of openTabMatches) out.push({ kind: 'openTab', tabKey: m.tabKey, item: m.item })
    for (const g of grouped) {
      for (const item of g.items) out.push({ kind: 'result', item })
    }
    return out
  }, [openTabMatches, grouped])

  const handleScopeToSpace = useCallback((spaceId: string, spaceName: string) => {
    setScopeSpace({ id: spaceId, name: spaceName })
  }, [])

  const handleNavigate = useCallback(async (item: FtsSearchResultItem) => {
    onClose()
    // 写入"最近打开"localStorage（PRD 3.7）；localStorage 同 origin 跨窗口共享，
    // 子窗口里写、主窗口空态读得到。放在跳转之前避免跳转副作用影响埋点。
    pushRecentOpened({
      type: item.type,
      id: item.id,
      title: item.title || item.session_title || '',
      spaceId: item.space_id,
      sessionId: item.session_id,
      resourceId: item.resource_id,
      itemType: (item.metadata?.item_type as string | undefined) ?? null,
      organizationId: organizationId ?? null,
    })
    // GlobalSearch 跑在透明子窗口（独立 renderer），导航必须代理回主 renderer 执行
    // （store 单例 / enterChatSession / dispatchSelect 都作用于主窗口）。
    const overlay = window.tabtin?.overlay
    if (overlay?.navigateSearchResult) {
      overlay.navigateSearchResult({ item, committedQuery })
      return
    }
    // 兜底：非子窗口环境直接本地执行。
    await navigateSearchResult(item, { committedQuery })
  }, [onClose, organizationId, committedQuery])

  // 让 handleRecentOpenedClick 通过 ref 间接引用 handleNavigate（避免 hoist 死锁）
  navigateRef.current = handleNavigate

  const handleHistoryClick = useCallback((q: string) => {
    setRawInput(q)
    setCommittedQuery(q)
  }, [])

  const handleSuggestion = useCallback((q: string) => {
    setRawInput(q)
    setCommittedQuery(q)
  }, [])

  const handleClearHistory = useCallback(() => {
    clearSearchHistory()
    setHistory([])
  }, [])

  const handleClearRecentOpened = useCallback(() => {
    clearRecentOpened()
    setRecentOpened([])
  }, [])

  /**
   * 点击"最近打开"项：把它转成虚拟 SearchResultItem 走 handleNavigate 同一路径，
   * 这样 IM/资源/Agent 分发与 toast 反馈与正常搜索结果一致。
   * 注意：handleNavigate 在下面定义，这里通过 navigateRef（在组件顶部已声明）
   * 间接引用避免 TDZ。
   *
   * 跨 organization 防御：理论上 setRecentOpened 已经按当前 organization 过滤，但用户
   * 持久化条目可能跨 session 切换；这里复用 notificationNavigation 的
   * ensureOrganizationSelected，跳转前先切到目标 organization（已经是当前 → no-op）。
   */
  const handleRecentOpenedClick = useCallback(async (item: RecentOpenedItem) => {
    if (item.organizationId && item.organizationId !== organizationId) {
      const { ensureOrganizationSelected } = await import('@/services/notificationNavigation')
      const organizationResult = await ensureOrganizationSelected(item.organizationId)
      if (organizationResult === 'cancelled') return
      if (organizationResult !== 'ready') {
        toast.error(t('navigate.organizationNotFound', {
          defaultValue: '目标组织不存在或无权限访问',
        }))
        return
      }
    }
    void navigateRef.current?.({
      id: item.id,
      type: item.type,
      title: item.title,
      snippet: '',
      highlight: {},
      space_id: item.spaceId ?? null,
      session_id: item.sessionId ?? null,
      resource_id: item.resourceId ?? null,
      score: 0,
      rrf_score: 0,
      created_at: new Date(item.openedAt).toISOString(),
      metadata: { item_type: item.itemType ?? undefined },
    } as FtsSearchResultItem)
  }, [organizationId, t])

  // 跳转封装供键盘 Enter 复用
  const navigateOpenTab = useCallback((m: { tabKey: string; item: ContextItemRecord }) => {
    onClose()
    if (!activeSpaceId || !activeTabScopeKey) return
    const cs = useCrawlTabStore.getState().getSpaceCrawlspace(activeSpaceId)
    const ok = contextRegistry.dispatchSelect(
      {
        type: m.item.type as ContextItemType,
        id: m.item.id,
        tabKey: m.tabKey as ContextTabKey,
        title: m.item.title || '',
        meta: m.item.meta,
      },
      // spaceId 保留资源 / 鉴权语义；标签桶写入靠 tabScopeKey
      { spaceId: activeSpaceId, tabScopeKey: activeTabScopeKey, crawlspaceId: cs?.id ?? null, closeBrowserView: () => {} },
    )
    if (!ok) {
      useSpaceContextTabsStore.getState().setActiveKey(activeTabScopeKey, m.tabKey)
    }
  }, [activeSpaceId, activeTabScopeKey, onClose])

  // ── Wave 4: CLI 命令模式(charter §4.1 例外条款) ──
  // 第一个 token 在已知 CLI 命令字典里 → 命令模式;否则 → 自然语言搜索。
  // 命令模式时屏蔽 unifiedSearch 调用,Enter 键直接触发命令。
  const cliMode = useCliCommandMode(rawInput)

  const handleCliCommand = useCallback((parsed: CliCommandKind) => {
    if (parsed.kind === 'tracker_new') {
      // P0-4 修复: dialog 仅由 TrackerPanel 单点渲染。Cmd+K 时若 Tracker 模块 tab 未打开,
      // 仅 setDialogState 改 store 但没组件渲染 dialog → 用户看不到。先 openResourceTab 确保
      // TrackerPanel 挂载,再 setDialogState 触发 dialog。同款修复见
      // ChatSidebarTrackersSection.handleOpenCreate (lines 149-152).
      onClose()
      if (activeSpaceId && activeTabScopeKey) {
        useSpaceContextTabsStore.getState().openResourceTab(activeTabScopeKey, {
          type: 'tabtracker',
          id: `tracker-${activeSpaceId}`,
          meta: { spaceId: activeSpaceId },
        })
      }
      // 通过 module-scoped 全局 hint(简单方案):放进 sessionStorage 让 Dialog 读
      try {
        sessionStorage.setItem(
          'tabtin:tracker:cliInitialValues',
          JSON.stringify({
            name: parsed.name,
            schedulePreset: parsed.preset,
            atTime: parsed.atTime,
          }),
        )
      } catch { /* ignore */ }
      useTrackerStore.getState().setDialogState({
        open: true,
        editTask: null,
      })
      return
    }
    if (parsed.kind === 'tracker_list') {
      // 切到 Tracker 模块的 list 视图(同样需先确保 Tracker 模块 tab 打开)
      onClose()
      if (activeSpaceId && activeTabScopeKey) {
        useSpaceContextTabsStore.getState().openResourceTab(activeTabScopeKey, {
          type: 'tabtracker',
          id: `tracker-${activeSpaceId}`,
          meta: { spaceId: activeSpaceId },
        })
      }
      useTrackerStore.getState().setViewMode('list')
      return
    }
    if (parsed.kind === 'unknown_command') {
      toast.error(parsed.hint)
      return
    }
  }, [onClose, activeSpaceId, activeTabScopeKey])

  // 键盘：ESC 关闭；↑↓ Enter 列表导航；Backspace 在空 query 时清除 scope（PRD 3.10 桌面键盘适配）
  // Wave 4: 命令模式下 Enter 直接执行命令(charter §4.1 例外条款)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
      return
    }
    if (e.nativeEvent.isComposing) return  // IME composing 不抢键
    if (e.key === 'Backspace' && !rawInput && scopeSpace) {
      e.preventDefault()
      setScopeSpace(null)
      return
    }
    // Wave 4: 命令模式 Enter → 直接执行命令
    if (cliMode.isCommand && cliMode.parsed && e.key === 'Enter') {
      e.preventDefault()
      handleCliCommand(cliMode.parsed)
      return
    }
    if (flatNavItems.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, flatNavItems.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const target = flatNavItems[activeIdx]
      if (!target) return
      if (target.kind === 'openTab') {
        navigateOpenTab(target)
      } else {
        void handleNavigate(target.item)
      }
    }
  }, [onClose, rawInput, scopeSpace, flatNavItems, activeIdx, handleNavigate, navigateOpenTab, cliMode, handleCliCommand])

  // 选中项变动时，确保滚动可见（jsdom 等环境无 scrollIntoView，安全降级）
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null
    if (typeof el?.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIdx])

  // ── render helpers ───────────────────────────────────
  const renderResultItem = (item: FtsSearchResultItem, idx: number) => {
    const id = `gs-option-${idx}`
    const selected = idx === activeIdx
    const onClick = () => handleNavigate(item)
    const onMouseEnter = () => setActiveIdx(idx)
    const onScopeToSpace = item.space_id && item.space_name
      ? () => handleScopeToSpace(item.space_id!, item.space_name!)
      : undefined
    const typeBadgeLabel = getResultTypeLabel(t, item.type)
    const baseProps = {
      item,
      dataIdx: idx,
      id,
      selected,
      onClick,
      onMouseEnter,
      currentUserId,
      selfLabel,
      typeBadgeLabel,
    }
    switch (item.type) {
      case 'message':
        return <MessageResultCard key={id} {...baseProps} query={committedQuery} onScopeToSpace={onScopeToSpace} />
      case 'resource':
        return (
          <ResourceResultCard
            key={id}
            {...baseProps}
            query={committedQuery}
            onScopeToSpace={onScopeToSpace}
            itemTypeEmoji={(it) => contextRegistry.getDisplayEmoji(it) || RESULT_TYPE_EMOJI.resource}
            itemTypeLabel={(it) => contextRegistry.getDisplayLabel(it)}
          />
        )
      case 'agent':
        return <AgentResultCard key={id} {...baseProps} />
      case 'space':
        return <SpaceResultCard key={id} {...baseProps} />
      case 'memo':
        return <MemoResultCard key={id} {...baseProps} query={committedQuery} onScopeToSpace={onScopeToSpace} />
      case 'im':
        return <IMResultCard key={id} {...baseProps} />
      default:
        return null
    }
  }

  const isInitialState = !committedQuery.trim() && !cliMode.isCommand
  const hasResults = !!response && response.results.length > 0 && !cliMode.isCommand
  const hasNoResults = !!response && response.results.length === 0 && !!committedQuery.trim() && !loading && !cliMode.isCommand
  const showSkeleton = loading && elapsedMs >= SKELETON_AFTER_MS
  const showSlowHint = loading && elapsedMs >= SLOW_HINT_AFTER_MS
  const showCancelButton = loading && elapsedMs >= CANCEL_BUTTON_AFTER_MS

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-global flex items-start justify-center pt-[12vh]"
          data-overlay-track="true"
          role="dialog"
          aria-modal="true"
          aria-label={t('dialogLabel', '统一搜索')}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          {/* Backdrop — 子窗口内不做跨窗口模糊，保留压暗和 clickaway。 */}
          <motion.div
            className="absolute inset-0 bg-modal-scrim"
            aria-hidden="true"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          />

          <motion.div
            className={`relative w-full max-w-[640px] mx-4 rounded-[20px] overflow-hidden flex flex-col ${OPAQUE_OVERLAY_SURFACE_CLASS}`}
            onKeyDown={handleKeyDown}
            initial={{ opacity: 0, scale: 0.98, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -8 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
          >
            {/* 输入框（PRD 3.11：含 Scope 徽章 + @/#/in: Picker 锚点） */}
            <div ref={inputBoxRef} className="flex items-center gap-2 px-4 py-2 border-b border-border/15 flex-wrap">
              <div className="flex flex-1 min-w-[200px] items-center gap-2 rounded-interactive bg-muted px-3 h-9 focus-within:bg-background focus-within:ring-1 focus-within:ring-inset focus-within:ring-primary/50">
                <Search className="h-4 w-4 text-muted-foreground/60 shrink-0" />
                {scopeSpace && (
                  <span className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-interactive bg-primary/10 text-primary-text text-body font-medium shrink-0 max-w-[160px]">
                    <span className="truncate">📁 {scopeSpace.name}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 hover:bg-primary/20 transition-colors"
                      onClick={() => setScopeSpace(null)}
                      aria-label={t('clearScope', '清除 Space 收窄')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
                {scopeAgent && (
                  <span className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-interactive bg-accent/10 text-accent-text text-body font-medium shrink-0 max-w-[160px]">
                    <span className="truncate">🤖 {scopeAgent.name}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 hover:bg-accent/20 transition-colors"
                      onClick={() => setScopeAgent(null)}
                      aria-label={t('clearAgentScope', '清除 Agent 筛选')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
                <input
                  ref={inputRef}
                  type="text"
                  role="combobox"
                  aria-expanded={hasResults}
                  aria-autocomplete="list"
                  aria-label={t('inputLabel', '搜索关键词')}
                  value={rawInput}
                  onChange={handleInputChange}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  placeholder={
                    scopeSpace
                      ? t('placeholderScoped', { name: scopeSpace.name, defaultValue: `在「${scopeSpace.name}」中搜索...` })
                      : t('placeholder', '搜索消息、资源、Agent、Space、备忘录、IM...')
                  }
                  className="flex-1 min-w-0 bg-transparent text-body text-foreground placeholder:text-muted-foreground/60 outline-none"
                />
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('shortcut.close', '关闭')}
                className="text-caption text-muted-foreground/60 bg-foreground/[0.04] px-2 py-0.5 rounded shrink-0 cursor-pointer hover:bg-foreground/[0.07] hover:text-foreground transition-colors"
              >
                ESC
              </button>
            </div>

            {/* @ / # / in: 触发的 Pickers（Portal 到 dialog modal 容器内，避免 z-index 问题） */}
            <InputScopePickers
              active={activePicker}
              pickerQuery={scopeParse.pickerQuery}
              anchorRef={inputBoxRef}
              callbacks={{
                onSelectAgent: handlePickerSelectAgent,
                onSelectType: handlePickerSelectType,
                onSelectSpace: handlePickerSelectSpace,
                onCancel: handlePickerCancel,
              }}
            />

            {/* 类型 Tab */}
            <ScrollArea scrollBar="horizontal" className="border-b border-border/15">
              <div className="flex gap-0.5 px-4 py-1.5" role="tablist" aria-label={t('typeFilterLabel', '类型筛选')}>
                {TYPE_TABS.map((tab) => {
                  const facetCount = tab.key
                    ? facets[RESULT_TYPE_TO_LOGICAL[tab.key as FtsResultType]] ?? 0
                    : (response?.total ?? 0)
                  const showCount = !!response && committedQuery.trim().length > 0
                  return (
                    <button
                      key={tab.key || 'all'}
                      role="tab"
                      aria-selected={typeTab === tab.key}
                      onClick={() => {
                        setTypeTab(tab.key)
                        if (tab.key !== 'resource') setResourceSubtype('')
                      }}
                      className={`px-3 py-1 text-body rounded-interactive whitespace-nowrap transition-colors ${
                        typeTab === tab.key
                          ? 'bg-foreground/[0.08] text-foreground font-medium'
                          : 'text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]'
                      }`}
                    >
                      {t(tab.labelKey, tab.defaultLabel)}
                      {showCount && <span className="ml-1 text-caption text-muted-foreground/60">{facetCount}</span>}
                    </button>
                  )
                })}
              </div>
            </ScrollArea>

            {/* 资源二级筛选 */}
            {typeTab === 'resource' && (
              <ScrollArea scrollBar="horizontal" className="border-b border-border/15">
                <div className="px-4 py-1">
                  <ChipTabBar
                    items={resourceSubtypeChipItems}
                    value={resourceSubtype}
                    onValueChange={setResourceSubtype}
                    ariaLabel={t('resourceSubtypeLabel', '资源类型')}
                    className="w-max flex-nowrap"
                  />
                </div>
              </ScrollArea>
            )}

            {/* PRD 3.8.B：creator 维度快捷筛选「所有 / 只看我 / 只看 Agent」
                Tab 为 'agent' / 'space' 时隐藏（这两类索引上后端不识别 creator_type） */}
            {typeTab !== 'agent' && typeTab !== 'space' && (
              <div className="flex items-center gap-2 px-4 py-1 border-b border-border/15" role="tablist" aria-label={t('creatorFilterLabel', '创建者筛选')}>
                {(['any', 'user', 'agent'] as const).map((opt) => {
                  const labelKey = opt === 'any'
                    ? 'creatorFilter.any'
                    : opt === 'user'
                      ? 'creatorFilter.userOnly'
                      : 'creatorFilter.agentOnly'
                  const fallback = opt === 'any' ? '所有' : opt === 'user' ? '只看我说的' : '只看 Agent 的'
                  return (
                    <button
                      key={opt}
                      type="button"
                      role="tab"
                      aria-selected={creatorFilter === opt}
                      data-creator-filter={opt}
                      onClick={() => setCreatorFilter(opt)}
                      className={`px-2 py-0.5 text-caption rounded-interactive whitespace-nowrap transition-colors ${
                        creatorFilter === opt
                          ? 'bg-foreground/[0.08] text-foreground font-medium'
                          : 'text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]'
                      }`}
                    >
                      {t(labelKey, fallback)}
                    </button>
                  )
                })}
                {/* R2-11 提示：在不支持 agent_id/creator_type 跨索引筛的 Tab 上选了"只看 Agent" */}
                {creatorFilter === 'agent' && (typeTab === 'resource' || typeTab === 'memo' || typeTab === 'im') && (
                  <span className="text-caption text-muted-foreground/60 ml-auto" data-testid="creator-filter-r2-11-hint">
                    {t('creatorFilter.r2_11Hint', 'Agent 筛选仅对消息/Agent 类型精准生效')}
                  </span>
                )}
              </div>
            )}

            {/* Wave 4: CLI 命令模式 banner(charter §4.1 例外条款) */}
            {cliMode.isCommand && cliMode.parsed && (
              <CliCommandBanner
                parsed={cliMode.parsed}
                onExecute={() => handleCliCommand(cliMode.parsed!)}
                t={t}
              />
            )}

            {/* Wave 5 R4-09：notice banner（"无访问 Space" 等明确状态，区别于"零结果"） */}
            {response?.notice === 'no_accessible_spaces' && (
              <div
                className="px-4 py-2 text-body border-b flex items-start gap-2 text-amber-700 bg-amber-50/60 border-amber-200/60 dark:bg-amber-900/15 dark:text-amber-300 dark:border-amber-800/40"
                role="status"
                data-testid="fts-notice-no-accessible-spaces"
              >
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{t('notice.noAccessibleSpacesTitle', '当前 Organization 内无可访问 Space')}</div>
                  <div className="text-caption text-amber-700/80 dark:text-amber-300/80 mt-0.5">
                    {t(
                      'notice.noAccessibleSpacesHint',
                      '搜索结果为空是因为你在该 Organization 没有任何 Space 的访问权限，并不是真的没有数据。请联系管理员加入相关 Space，或确认登录身份。',
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 降级 banner（PRD 3.12 三级反馈） */}
            {response?.degraded && (() => {
              // partial_failure 视为 Level 1（轻提示）；circuit_open / opensearch_unavailable
              // / health_red / engine_disabled / error_rate_breach 视为 Level 2（中提示）；
              // internal_error / auth_missing 视为 Level 3（重提示，红色 + 引导操作）
              const reason = response.degraded_reason
              let level: 1 | 2 | 3 = 2
              if (reason === 'partial_failure') level = 1
              else if (reason === 'internal_error' || reason === 'auth_missing') level = 3
              const tone =
                level === 1
                  ? 'text-muted-foreground/80 bg-muted/30 border-border/40 dark:text-muted-foreground/80'
                  : level === 2
                    ? 'text-amber-600 bg-amber-50/60 border-amber-200/60 dark:bg-amber-900/15 dark:text-amber-400 dark:border-amber-800/40'
                    : 'text-destructive bg-destructive/10 border-destructive/30 dark:text-destructive'
              return (
                <div className={`px-4 py-1.5 text-caption border-b flex items-center gap-2 ${tone}`} role="status">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 min-w-0 truncate">
                    {getDegradedMessage(t, reason, response.partial_indices)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRetryNonce((n) => n + 1)}
                    className="shrink-0 underline hover:opacity-80 transition-opacity"
                  >
                    {t('retry', '重试')}
                  </button>
                </div>
              )
            })()}

            {/* 结果区 */}
            <ScrollArea className="max-h-[420px] min-h-[200px]">
              <div ref={listRef} role="listbox" aria-label={t('resultsLabel', '搜索结果')} className="py-1">

                {/* 错误（非 abort） */}
                {error && !response && (
                  <div className="px-4 py-8 text-center text-body text-destructive/80" role="alert">
                    {error.message}
                    <button
                      type="button"
                      onClick={() => setRetryNonce((n) => n + 1)}
                      className="ml-2 underline"
                    >
                      {t('retry', '重试')}
                    </button>
                  </div>
                )}

                {/* Loading 分级（PRD 8.3.D） */}
                {showSkeleton && !response && (
                  <SearchSkeleton count={5} />
                )}
                {showSlowHint && (
                  <div className="px-4 py-2 text-caption text-muted-foreground/60 flex items-center gap-2 justify-center">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('slowHint', '搜索较慢，请稍等...')}
                    {showCancelButton && (
                      <button
                        type="button"
                        onClick={cancel}
                        className="underline hover:text-foreground/80 transition-colors"
                      >
                        {t('cancel', '取消')}
                      </button>
                    )}
                  </div>
                )}

                {/* 已打开标签（本地匹配，永远先展示） */}
                {openTabMatches.length > 0 && (
                  <ResultGroupHeader title={t('group.openTabs', '已打开标签')} />
                )}
                {openTabMatches.map(({ tabKey, item }, i) => (
                  <OpenTabRow
                    key={tabKey}
                    tabKey={tabKey}
                    item={item}
                    selected={i === activeIdx}
                    onClick={() => navigateOpenTab({ tabKey, item })}
                    onMouseEnter={() => setActiveIdx(i)}
                    dataIdx={i}
                  />
                ))}

                {/* 分组渲染 */}
                {hasResults && (
                  <ResultGroups
                    grouped={grouped}
                    typeTab={typeTab}
                    renderItem={renderResultItem}
                    onShowAllType={(type) => setTypeTab(type)}
                    t={t}
                    startIdx={openTabMatches.length}
                  />
                )}

                {/* 空结果引导（PRD 3.6） */}
                {hasNoResults && (
                  <EmptyResults
                    query={committedQuery}
                    suggestions={response?.suggestions ?? []}
                    onSuggestionClick={handleSuggestion}
                    history={history}
                    onHistoryClick={handleHistoryClick}
                    t={t}
                  />
                )}

                {/* 空态：未输入关键词（PRD 3.7） */}
                {isInitialState && (
                  <EmptyState
                    history={history}
                    onHistoryClick={handleHistoryClick}
                    onClearHistory={handleClearHistory}
                    recentOpened={recentOpened}
                    onRecentOpenedClick={handleRecentOpenedClick}
                    onClearRecentOpened={handleClearRecentOpened}
                    t={t}
                  />
                )}
              </div>
            </ScrollArea>

            {/* Footer */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-border/15 text-caption text-muted-foreground/60">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={t('shortcut.close', '关闭')}
                  className="inline-flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer hover:bg-foreground/[0.04] hover:text-foreground transition-colors"
                >
                  <kbd className="px-1 py-0.5 bg-foreground/[0.04] rounded">ESC</kbd> {t('shortcut.close', '关闭')}
                </button>
                {scopeSpace && (
                  <span className="inline-flex items-center gap-1">
                    <kbd className="px-1 py-0.5 bg-foreground/[0.04] rounded">⌫</kbd> {t('shortcut.clearScope', '清除 Space 收窄')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {response && committedQuery && (
                  <span>
                    {t('resultsTotal', { total: response.total, defaultValue: `共 ${response.total} 条结果` })}
                    {' · '}
                    {t('tookMs', { ms: response.took_ms, defaultValue: `${response.took_ms}ms` })}
                  </span>
                )}
                <span className="inline-flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-foreground/[0.04] rounded">{MOD_KEY}K</kbd> {t('shortcut.openSearch', '打开搜索')}
                </span>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── 内部子组件 ───────────────────────────────────────────────────

function ResultGroupHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="px-4 py-1.5 text-caption font-medium text-muted-foreground/60 uppercase tracking-wider sticky top-0 bg-[hsl(var(--glass-bg-overlay))] [backdrop-filter:blur(var(--glass-blur-overlay))_saturate(var(--glass-saturate))] [-webkit-backdrop-filter:blur(var(--glass-blur-overlay))_saturate(var(--glass-saturate))] flex items-center justify-between gap-2">
      <span className="truncate">{title}</span>
      {action}
    </div>
  )
}

function OpenTabRow({
  item,
  onClick,
  onMouseEnter,
  dataIdx,
  tabKey,
  selected,
}: {
  item: ContextItemRecord
  onClick: () => void
  onMouseEnter?: () => void
  dataIdx: number
  tabKey: string
  selected?: boolean
}) {
  const emoji = contextRegistry.getDisplayEmoji(item.type) || '📄'
  const tabIcon = contextRegistry.getTabIcon(item as Parameters<typeof contextRegistry.getTabIcon>[0])
  return (
    <div
      role="option"
      aria-selected={selected ?? false}
      data-idx={dataIdx}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={
        'flex items-center gap-3 mx-2 px-2 py-2 rounded-interactive cursor-pointer transition-colors ' +
        (selected
          ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08]'
          : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]')
      }
    >
      <span className="text-subtitle shrink-0 w-5 text-center leading-none" aria-hidden="true">
        {tabIcon || emoji}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-body text-foreground/80 truncate">{item.title || tabKey}</div>
      </div>
      <span className="text-caption text-muted-foreground/60 shrink-0">
        {contextRegistry.getDisplayLabel(item.type)}
      </span>
    </div>
  )
}

function ResultGroups({
  grouped,
  typeTab,
  renderItem,
  onShowAllType,
  t,
  startIdx,
}: {
  grouped: Array<{ type: FtsResultType; items: FtsSearchResultItem[]; total: number }>
  typeTab: '' | FtsResultType
  renderItem: (item: FtsSearchResultItem, idx: number) => React.ReactNode
  onShowAllType: (type: FtsResultType) => void
  t: ReturnType<typeof useTranslation>['t']
  startIdx: number
}) {
  let cursor = startIdx
  return (
    <>
      {grouped.map(({ type, items, total }) => {
        const groupStart = cursor
        cursor += items.length
        const groupTitle = getResultTypeLabel(t, type)
        const showMore = typeTab === '' && total > items.length
        return (
          <div key={type} role="group" aria-label={groupTitle}>
            <ResultGroupHeader
              title={groupTitle}
              action={
                showMore ? (
                  <button
                    type="button"
                    onClick={() => onShowAllType(type)}
                    className="text-caption text-primary-text hover:text-primary-text/80 transition-colors"
                  >
                    {t('group.viewAll', { count: total, defaultValue: `查看全部 ${total} 条` })}
                  </button>
                ) : null
              }
            />
            {items.map((item, i) => renderItem(item, groupStart + i))}
          </div>
        )
      })}
    </>
  )
}

function EmptyResults({
  query,
  suggestions,
  onSuggestionClick,
  history,
  onHistoryClick,
  t,
}: {
  query: string
  suggestions: string[]
  onSuggestionClick: (q: string) => void
  history: string[]
  onHistoryClick: (q: string) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="px-4 py-6 space-y-4 text-body">
      <div className="text-muted-foreground/80">
        {t('empty.noResults', { query, defaultValue: `未找到关于「${query}」的结果` })}
      </div>
      {suggestions.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-caption text-muted-foreground/60">{t('empty.didYouMean', '你是不是要搜：')}</div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSuggestionClick(s)}
                className="text-body text-primary-text hover:text-primary-text/80 underline transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      {history.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-caption text-muted-foreground/60">{t('empty.recentSearches', '最近搜过：')}</div>
          <div className="flex flex-wrap gap-1.5">
            {history.slice(0, 6).map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => onHistoryClick(q)}
                className="text-caption px-2 py-0.5 rounded-interactive bg-foreground/[0.04] text-foreground/80 hover:bg-foreground/[0.07] transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="text-caption text-muted-foreground/60 leading-relaxed">
        {t('empty.tipsTitle', '搜索技巧：')}
        <br />
        {t('empty.tip1', '"精确短语"  ·  in:工作空间  ·  #类型')}
      </div>
    </div>
  )
}

function EmptyState({
  history,
  onHistoryClick,
  onClearHistory,
  recentOpened,
  onRecentOpenedClick,
  onClearRecentOpened,
  t,
}: {
  history: string[]
  onHistoryClick: (q: string) => void
  onClearHistory: () => void
  recentOpened: RecentOpenedItem[]
  onRecentOpenedClick: (item: RecentOpenedItem) => void
  onClearRecentOpened: () => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="px-4 py-5 space-y-4 text-body">
      <div className="text-muted-foreground/80">
        {t('initial.title', '搜索消息、文档、表格、备忘录、Agent...')}
      </div>

      {/* 最近打开（PRD 3.7 P0）：从全局搜索点开过的最近 5 条 */}
      {recentOpened.length > 0 && (
        <div className="space-y-1.5" data-testid="recent-opened-section">
          <div className="text-caption text-muted-foreground/60 flex items-center gap-2">
            <span>{t('initial.recentOpened', '最近打开')}</span>
            <button
              type="button"
              onClick={onClearRecentOpened}
              className="ml-auto underline hover:text-foreground/80 transition-colors"
            >
              {t('initial.clearRecentOpened', '清除')}
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {recentOpened.slice(0, 5).map((item) => {
              // 优先用资源子类型 emoji；否则用 result type 默认 emoji
              const emoji = (item.itemType
                ? contextRegistry.getDisplayEmoji(item.itemType)
                : RESULT_TYPE_EMOJI[item.type])
                ?? RESULT_TYPE_EMOJI[item.type]
              return (
                <button
                  key={`${item.type}:${item.id}`}
                  type="button"
                  onClick={() => onRecentOpenedClick(item)}
                  className="flex items-center gap-2 w-full px-2 py-1 rounded-interactive text-left transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]"
                >
                  <span className="text-subtitle leading-none shrink-0 w-5 text-center" aria-hidden="true">
                    {emoji}
                  </span>
                  <span className="text-body text-foreground/80 truncate flex-1">
                    {item.title || t('initial.untitled', '（无标题）')}
                  </span>
                  <span className="text-caption text-muted-foreground/60 shrink-0">
                    {formatRecentOpenedTime(item.openedAt)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-caption text-muted-foreground/60 flex items-center gap-2">
            <HistoryIcon className="h-3 w-3" />
            <span>{t('initial.recentSearches', '最近搜过')}</span>
            <button
              type="button"
              onClick={onClearHistory}
              className="ml-auto underline hover:text-foreground/80 transition-colors"
            >
              {t('initial.clearHistory', '清除')}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {history.slice(0, 8).map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => onHistoryClick(q)}
                className="text-caption px-2 py-0.5 rounded-interactive bg-foreground/[0.04] text-foreground/80 hover:bg-foreground/[0.07] transition-colors max-w-[180px] truncate"
                title={q}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="text-caption text-muted-foreground/60 leading-relaxed">
        {t('initial.tipsTitle', '搜索技巧：')}
        <br />
        {t('initial.tip1', '@ Agent  ·  # 类型  ·  in:工作空间  ·  "精确短语"')}
        <br />
        {t('initial.tipCli', '命令模式:tracker new "名称" --schedule daily --at 09:00')}
      </div>
    </div>
  )
}

/**
 * Wave 4: CLI 命令模式 banner——charter §4.1 例外条款
 * 显示在结果区上方,用户按 Enter 直接执行命令(不需要 LLM 介入)
 */
function CliCommandBanner({
  parsed,
  onExecute,
  t,
}: {
  parsed: CliCommandKind
  onExecute: () => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  if (parsed.kind === 'tracker_new') {
    const presetLabel = t(`globalSearch:cli.schedule.${parsed.preset}`, parsed.preset)
    const description = parsed.preset === 'manual'
      ? t('globalSearch:cli.trackerNewManualDesc', '手动触发')
      : parsed.preset === 'hourly'
        ? t('globalSearch:cli.trackerNewHourlyDesc', '每小时整点运行')
        : t('globalSearch:cli.trackerNewTimedDesc', { schedule: presetLabel, at: parsed.atTime, defaultValue: `${presetLabel}, ${parsed.atTime}` })
    return (
      <div
        className="px-4 py-2 border-b border-primary/20 bg-primary/5 dark:bg-primary/10"
        role="status"
        data-testid="cli-command-banner"
      >
        <div className="flex items-center gap-2">
          <span className="text-caption font-mono px-2 py-0.5 rounded bg-primary/15 text-primary-text uppercase tracking-wide">
            CLI
          </span>
          <span className="text-body font-medium text-foreground flex-1 min-w-0 truncate">
            {parsed.name
              ? t('globalSearch:cli.trackerNewWithName', { name: parsed.name, defaultValue: `创建自动化任务:「${parsed.name}」` })
              : t('globalSearch:cli.trackerNewNoName', '创建自动化任务(请填名称)')}
          </span>
        </div>
        <div className="text-caption text-muted-foreground mt-1 ml-12">
          {description}
        </div>
        <div className="mt-2 ml-12 flex items-center gap-2">
          <button
            type="button"
            onClick={onExecute}
            className="rounded-interactive bg-primary px-3 py-1 text-body text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t('globalSearch:cli.execute', '执行(Enter)')}
          </button>
          <span className="text-caption text-muted-foreground/60">
            {t('globalSearch:cli.editAfterTip', '执行后会打开表单让你确认')}
          </span>
        </div>
      </div>
    )
  }
  if (parsed.kind === 'tracker_list') {
    return (
      <div className="px-4 py-2 border-b border-primary/20 bg-primary/5 dark:bg-primary/10" role="status">
        <div className="flex items-center gap-2">
          <span className="text-caption font-mono px-2 py-0.5 rounded bg-primary/15 text-primary-text uppercase tracking-wide">
            CLI
          </span>
          <span className="text-body font-medium text-foreground flex-1">
            {t('globalSearch:cli.trackerList', '查看自动化任务列表')}
          </span>
          <button
            type="button"
            onClick={onExecute}
            className="rounded-interactive bg-primary px-3 py-1 text-body text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
          >
            {t('globalSearch:cli.execute', '执行(Enter)')}
          </button>
        </div>
      </div>
    )
  }
  // unknown_command
  return (
    <div
      className="px-4 py-2 border-b border-amber-300/40 bg-amber-50/60 dark:bg-amber-900/15 text-amber-800 dark:text-amber-300"
      role="status"
      data-testid="cli-command-unknown"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-body font-medium">
            {t('globalSearch:cli.unknown', '未识别的命令')}
          </div>
          <div className="text-caption mt-0.5">
            {(parsed as Extract<CliCommandKind, { kind: 'unknown_command' }>).hint}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 最近打开的相对时间（极简，避免与 cardCommon 的全角中文冲突） */
function formatRecentOpenedTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 0) return ''
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return new Date(ts).toLocaleDateString()
}

function SearchSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-0.5 px-4 py-3" role="status" aria-label="loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 rounded-interactive px-2 py-2">
          <Skeleton width={20} height={20} rounded="full" className="opacity-80" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton width="66%" height={12} rounded="md" />
            <Skeleton width="80%" height={10} rounded="full" className="opacity-80" />
          </div>
        </div>
      ))}
    </div>
  )
}

export default GlobalSearch

// 兼容旧消费者：之前 export 命名导出，现在保持
