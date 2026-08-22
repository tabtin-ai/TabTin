/**
 * MentionPopover — @提及级联菜单
 *
 * @ 提及菜单：
 *   - 输入 @ 后弹出一级菜单，显示分类（TabData、TabDoc、字段）
 *   - 点击/hover 分类后展开二级面板，列出该分类下的资源
 *   - 输入关键字后在全部分类内检索
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  Columns3, Search, ChevronRight, Loader2,
  FolderOpen, Globe, Layers,
} from 'lucide-react'
import { EmptyState, ScrollArea, useOverlayContainer } from '@tabtin/smartsheet-ui'
import { ZIndex } from '@tabtin/app-shell'
import { cn } from '@utils/cn'
import { COMPOSER_TEXT_META, COMPOSER_TEXT_META_BASE } from '../registry/chatDesignTokens'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import {
  SpaceApiService,
  type SpaceContextItem,
  type SpaceContextSearchItem,
} from '@/services/spaceApi'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useTableStore } from '@/stores/useTableStore'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useCrawlTabStore } from '@/stores/useCrawlTabStore'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { useTranslation } from 'react-i18next'
import { contextRegistry } from '@components/context-space/registry'
import { isUserVisibleTabdataResourceItem } from '@components/context-space/resourceScope'
import type { ContextItemType, ContextTabKey } from '@components/context-space/registry/types'
import type { MentionItem, ContextRefType } from '../types'

type ContextItem = SpaceContextItem | SpaceContextSearchItem
type ActionableContextItem = ContextItem & { resource_id: string }

/* ================================================================
 * Props & 常量
 * ================================================================ */

interface MentionPopoverProps {
  open: boolean
  query: string
  onSelect: (item: MentionItem) => void
  onClose: () => void
  /** 锚点元素（用于 Portal 定位） */
  anchorEl?: HTMLElement | null
  spaceId?: string | null
  spaceName?: string | null
  tabScopeKey?: string | null
  fieldTableId?: string | null
  fieldTableName?: string | null
}

/** 分类定义 */
interface Category {
  key: string
  label: string
  icon: React.FC<{ className?: string }>
  type: string            // API item_type 过滤用
  color: string           // tailwind 颜色类
}

/** 「当前打开的标签」特殊分类 key（来自 useSpaceContextTabsStore，不走 API） */
const OPEN_TABS_CATEGORY_KEY = 'open_tabs'

type TopLevelEntry =
  | { kind: 'current_web'; item: MentionItem }
  | { kind: 'category'; category: Category }

/** 从 registry 动态构建分类 + 特殊分类（打开的标签 / 字段） */
// eslint-disable-next-line tabtin/no-chat-design-violations -- @提及分类身份色（field 类别签名色，与 ContextChip 类型色板对齐），非单点 UI 警示
const FIELD_CATEGORY: Category = { key: 'field', label: 'field', icon: Columns3, type: 'field', color: 'text-warning bg-warning/10' }
const OPEN_TABS_CATEGORY: Category = {
  key: OPEN_TABS_CATEGORY_KEY,
  label: 'open_tabs',
  icon: Layers,
  type: OPEN_TABS_CATEGORY_KEY,
  color: 'text-primary bg-primary/10',
}

function buildCategories(): Category[] {
  const fromRegistry = contextRegistry.getMentionCategories()
  // 「打开的标签」放在最前，体感上是最快的入口
  return [OPEN_TABS_CATEGORY, ...fromRegistry, FIELD_CATEGORY]
}

function displayBrowserTitle(title: string | undefined, url: string): string {
  const trimmed = (title ?? '').trim()
  if (!trimmed || trimmed === 'tabs.untitled' || trimmed === 'tabs.newTabTitle') return url
  return trimmed
}

function buildCurrentWebMentionItem(
  selectedSpace: { id: string; name?: string | null } | null,
  tabScopeKey?: string | null,
): MentionItem | null {
  if (!selectedSpace?.id) return null
  const storageKey = tabScopeKey || selectedSpace.id
  const tabsState = useSpaceContextTabsStore.getState()
  const displayKey = tabsState.displayKeyBySpace[storageKey]
  const parsed = displayKey ? contextRegistry.parseTabKey(displayKey) : null
  if (parsed?.type !== 'tabweb') return null
  const crawlState = useCrawlTabStore.getState()
  const crawlspace = tabScopeKey
    ? crawlState.getScopedCrawlspace(storageKey)
    : crawlState.getSpaceCrawlspace(selectedSpace.id)
  const legacyCrawlspace = crawlspace ?? crawlState.getSpaceCrawlspace(selectedSpace.id)
  const crawlspaceId = legacyCrawlspace?.id
  if (!crawlspaceId) return null

  const viewId = parsed.id

  const view = crawlState.getCrawlspaceViews(crawlspaceId).find(v => v.viewId === viewId)
  if (!view?.url || view.url === 'about:blank' || view.isClosing) return null

  const label = displayBrowserTitle(view.title, view.url)
  return {
    id: `current-web:${view.viewId}`,
    type: 'webpage',
    label,
    subtitle: '当前网页',
    resourceId: view.url,
    tabType: 'tabweb',
    spaceId: selectedSpace.id,
    spaceName: selectedSpace.name ?? undefined,
    meta: {
      pageTitle: label,
      url: view.url,
      viewId: view.viewId,
      ...(view.favicon ? { favicon: view.favicon } : {}),
    },
  }
}

/** 标准化 item_type → MentionItem type（MentionItem.type 现已扩展为 ContextRefType，此处保留回退） */
function normalizeType(type: string): ContextRefType {
  if (type === 'field') return 'field'
  const normalized = contextRegistry.normalizeMentionType(type)
  return normalized as ContextRefType
}

/** 从当前 space 已打开的 tabs 构造 MentionItem 列表（仅含声明了 attachToChat 的 type） */
function buildOpenTabMentionItems(
  selectedSpace: { id: string; name?: string | null } | null,
  tabScopeKey?: string | null,
): MentionItem[] {
  if (!selectedSpace?.id) return []
  const storageKey = tabScopeKey || selectedSpace.id
  const state = useSpaceContextTabsStore.getState()
  const order = state.tabOrderBySpace[storageKey] ?? []
  const items = state.itemsBySpace[storageKey] ?? {}
  const result: MentionItem[] = []
  const currentWeb = buildCurrentWebMentionItem(selectedSpace, tabScopeKey)
  if (currentWeb) result.push(currentWeb)
  for (const tabKey of order) {
    const stored = items[tabKey]
    if (!stored) continue
    const handler = contextRegistry.getHandler(stored.type as ContextItemType)
    if (!handler?.attachToChat) continue
    const built = contextRegistry.buildContextAttachment({
      type: stored.type as ContextItemType,
      id: stored.id,
      tabKey: tabKey as ContextTabKey,
      title: stored.title,
      meta: stored.meta,
    })
    if (!built) continue
    if (result.some(item => item.type === built.refType && item.resourceId === built.resourceId)) continue
    result.push({
      id: tabKey,
      type: built.refType,
      label: built.label,
      subtitle: handler.displayLabel || (stored.type as string),
      resourceId: built.resourceId,
      tabType: stored.type as string,
      spaceId: selectedSpace.id,
      spaceName: selectedSpace.name ?? undefined,
      meta: built.meta,
    })
  }
  return result
}

/* ================================================================
 * 组件
 * ================================================================ */

export const MentionPopover: React.FC<MentionPopoverProps> = ({
  open,
  query,
  onSelect,
  onClose,
  anchorEl,
  spaceId = null,
  spaceName = null,
  tabScopeKey = null,
  fieldTableId = null,
  fieldTableName = null,
}) => {
  const { t } = useTranslation('chat')
  // Wave 4：mention 是输入辅助类浮层——切走 hot Space 时输入意图已经断了，
  // 应主动清理调用方 open state（onClose），让切回时不再"幽灵复活"。
  const { isForeground } = useSpaceActivity()
  // Wave 6.3：portal 到所属 Space 的 OverlayContainer，切走时容器 hidden 自动隐藏；
  // Provider 之外 fallback 到 document.body。
  const overlayContainer = useOverlayContainer()

  const CATEGORIES = useMemo(() => buildCategories(), [])

  const CATEGORY_LABELS: Record<string, string> = useMemo(() => {
    const labels: Record<string, string> = {
      field: t('mention.currentTableFields'),
      [OPEN_TABS_CATEGORY_KEY]: t('mention.openTabs', { defaultValue: '打开的标签' }),
    }
    CATEGORIES.forEach(cat => {
      if (cat.key !== 'field' && cat.key !== OPEN_TABS_CATEGORY_KEY) labels[cat.key] = cat.label
    })
    return labels
  }, [t, CATEGORIES])

  const getCatLabel = useCallback((cat: Category) => CATEGORY_LABELS[cat.key] ?? cat.label, [CATEGORY_LABELS])

  // 状态
  const [activeCategoryKey, setActiveCategoryKey] = useState<string | null>(null)
  const [categoryItems, setCategoryItems] = useState<MentionItem[]>([])
  const [searchResults, setSearchResults] = useState<MentionItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Store
  const organizationId = useOrganizationStore(s => s.selectedOrganization?.id)
  const fields = useTableStore(s => s.fields)
  const selectedTable = useTableStore(s => s.selectedTable)
  const selectedSpace = useMemo(
    () => (spaceId ? { id: spaceId, name: spaceName ?? '' } : null),
    [spaceId, spaceName],
  )
  const fieldContextReady = !fieldTableId || selectedTable?.id === fieldTableId
  const hasFieldContext = Boolean(fieldTableId && fieldContextReady)
  const currentWebMentionItem = useMemo(
    () => (open ? buildCurrentWebMentionItem(selectedSpace, tabScopeKey) : null),
    [open, selectedSpace, tabScopeKey],
  )
  const topLevelEntries: TopLevelEntry[] = useMemo(() => {
    const entries: TopLevelEntry[] = []
    if (currentWebMentionItem) entries.push({ kind: 'current_web', item: currentWebMentionItem })
    CATEGORIES.forEach(category => {
      if (category.key === 'field' && !hasFieldContext) return
      entries.push({ kind: 'category', category })
    })
    return entries
  }, [CATEGORIES, currentWebMentionItem, hasFieldContext])

  /** 过滤 TabData 中对用户不可见的表（system / hidden） */
  function filterVisibleActionableItems(items: ContextItem[]): ActionableContextItem[] {
    return items.filter((item): item is ActionableContextItem => {
      if (!isUserVisibleTabdataResourceItem(item)) return false
      return typeof item.resource_id === 'string' && item.resource_id.length > 0
    })
  }

  const mapContextItem = useCallback((item: ActionableContextItem): MentionItem => {
    return {
      id: item.id,
      type: normalizeType(item.item_type),
      label: item.title || '',
      subtitle: item.space_name || selectedSpace?.name || '',
      resourceId: item.resource_id,
      tableId: item.item_type === 'field'
        ? (item.metadata?.table_id || item.metadata?.tableId || undefined)
        : undefined,
      spaceId: item.space_id ?? undefined,
      spaceName: item.space_name,
    }
  }, [selectedSpace?.name])

  const trimmedQuery = query.trim()
  const isSearchMode = trimmedQuery.length > 0

  /* ----------------------------------------------------------------
   * Portal 定位：基于锚点元素的 BoundingClientRect
   * ---------------------------------------------------------------- */
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!open || !anchorEl) {
      setPosition(null)
      return
    }
    const update = () => {
      const rect = anchorEl.getBoundingClientRect()
      setPosition({
        top: rect.top,   // 弹窗底部对齐锚点顶部
        left: rect.left,
      })
    }
    update()
    // 窗口滚动/resize 时更新位置
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open, anchorEl])

  /* ----------------------------------------------------------------
   * 点击外部关闭
   * ---------------------------------------------------------------- */
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        // 不关闭如果点击在 anchorEl 内（输入框）
        if (anchorEl && anchorEl.contains(e.target as Node)) return
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, anchorEl, onClose])

  /* ----------------------------------------------------------------
   * 搜索模式：输入关键字后统一搜索所有分类
   * ---------------------------------------------------------------- */
  useEffect(() => {
    if (!open || !isSearchMode) {
      setSearchResults([])
      return
    }

    const timer = setTimeout(async () => {
      setIsLoading(true)
      try {
        const items: MentionItem[] = []
        if (currentWebMentionItem) {
          const q = trimmedQuery.toLowerCase()
          const haystack = `${currentWebMentionItem.label} ${currentWebMentionItem.resourceId}`.toLowerCase()
          if (haystack.includes(q)) items.push(currentWebMentionItem)
        }

        // 本地字段匹配
        const matchedFields = (hasFieldContext ? fields : [])
          .filter(f => f.name.toLowerCase().includes(trimmedQuery.toLowerCase()))
          .slice(0, 5)
          .map(f => ({
            id: f.id,
            type: 'field' as const,
            label: f.name,
            subtitle: fieldTableName || '',
            resourceId: f.id,
            tableId: fieldTableId ?? undefined,
            spaceId: selectedSpace?.id,
            spaceName: selectedSpace?.name,
          }))
        items.push(...matchedFields)

        // API 搜索：优先 organization 级搜索（团队内全部可访问资源）
        if (organizationId) {
          const searchResult = await SpaceApiService.searchOrganization(
            organizationId,
            { q: trimmedQuery, page_size: 15 }
          )
          items.push(...filterVisibleActionableItems(searchResult.items).map(mapContextItem))
        } else if (selectedSpace?.id) {
          const searchResult = await SpaceApiService.searchSpace(
            selectedSpace.id,
            { q: trimmedQuery, page_size: 15 }
          )
          items.push(...filterVisibleActionableItems(searchResult.items).map(mapContextItem))
        }

        setSearchResults(items)
        setActiveIndex(0)
      } catch (err) {
        console.error('[MentionPopover] Search failed:', err)
        setSearchResults([])
      } finally {
        setIsLoading(false)
      }
    }, 200)

    return () => clearTimeout(timer)
  }, [open, trimmedQuery, selectedSpace, organizationId, fields, selectedTable, isSearchMode, mapContextItem, hasFieldContext, fieldTableId, fieldTableName, currentWebMentionItem])

  /* ----------------------------------------------------------------
   * 分类模式：选中分类后加载该分类下的资源
   * ---------------------------------------------------------------- */
  useEffect(() => {
    if (!open || isSearchMode || !activeCategoryKey) {
      setCategoryItems([])
      return
    }

    // 字段分类 → 本地数据
    if (activeCategoryKey === 'field') {
      const fieldItems: MentionItem[] = (hasFieldContext ? fields : []).slice(0, 20).map(f => ({
        id: f.id,
        type: 'field' as const,
        label: f.name,
        subtitle: fieldTableName || '',
        resourceId: f.id,
        tableId: fieldTableId ?? undefined,
        spaceId: selectedSpace?.id,
        spaceName: selectedSpace?.name,
      }))
      setCategoryItems(fieldItems)
      setActiveIndex(0)
      return
    }

    // 「打开的标签」分类 → 当前 space 已开 tabs（不走 API）
    if (activeCategoryKey === OPEN_TABS_CATEGORY_KEY) {
      const items = buildOpenTabMentionItems(selectedSpace, tabScopeKey)
      setCategoryItems(items)
      setActiveIndex(0)
      return
    }

    // 表格/文档 → API（organization 级：团队内全部可访问资源）
    let cancelled = false
    const fetchItems = async () => {
      setIsLoading(true)
      try {
        if (!selectedSpace?.id) {
          setCategoryItems([])
          return
        }
        const result = await SpaceApiService.listContextItems(
          selectedSpace.id,
          {
            item_type: activeCategoryKey,
            page_size: 30,
            ...(organizationId ? { scope: 'organization' } : {}),
          }
        )
        if (cancelled) return
        setCategoryItems(filterVisibleActionableItems(result.items).map(mapContextItem))
        setActiveIndex(0)
      } catch (err) {
        console.error('[MentionPopover] Failed to load category resources:', err)
        if (!cancelled) setCategoryItems([])
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    fetchItems()
    return () => { cancelled = true }
  }, [open, activeCategoryKey, isSearchMode, selectedSpace, tabScopeKey, organizationId, fields, selectedTable, mapContextItem, hasFieldContext, fieldTableId, fieldTableName])

  /* ----------------------------------------------------------------
   * 重置状态
   * ---------------------------------------------------------------- */
  useEffect(() => {
    if (!open) {
      setActiveCategoryKey(null)
      setCategoryItems([])
      setSearchResults([])
      setActiveIndex(0)
    }
  }, [open])

  /* ----------------------------------------------------------------
   * Wave 4：Space 切换至后台时强制关闭——调用 onClose 让 ChatInput 的
   * mentionOpen state 同步重置，避免切回时弹窗"幽灵复活"。
   *
   * 调用方 onClose 是 inline arrow（每次 render 新引用）——用 ref 解出 deps，
   * 避免 ChatInput 高频 render（streaming 时逐 token 重渲染）反复重订阅 effect。
   * ---------------------------------------------------------------- */
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (open && !isForeground) {
      onCloseRef.current()
    }
  }, [open, isForeground])

  /* ----------------------------------------------------------------
   * 当前可见列表
   * ---------------------------------------------------------------- */
  const visibleItems = isSearchMode ? searchResults : categoryItems
  const findTopLevelCategoryIndex = useCallback((categoryKey: string | null): number => {
    const index = topLevelEntries.findIndex(entry => (
      entry.kind === 'category' && entry.category.key === categoryKey
    ))
    return index >= 0 ? index : 0
  }, [topLevelEntries])

  /* ----------------------------------------------------------------
   * 键盘导航
   * ---------------------------------------------------------------- */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!open) return
      if (e.isComposing) return
      // 仅当焦点仍停留在触发该 popover 的输入框（聊天框）上时才接管按键。
      // 否则用户用 Tab 切到别处输入框 / 另一个分屏 pane 时，popover 仍开着会
      // 误拦截 Enter（错误选中 mention）和方向键（无法在别处正常移动光标）。
      if (anchorEl && document.activeElement !== anchorEl) return

      // 搜索模式下的列表导航
      if (isSearchMode && visibleItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setActiveIndex(prev => (prev + 1) % visibleItems.length)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setActiveIndex(prev => (prev - 1 + visibleItems.length) % visibleItems.length)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          onSelect(visibleItems[activeIndex])
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
        return
      }

      // 分类模式
      if (!isSearchMode) {
        if (!activeCategoryKey) {
          // 一级菜单导航
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (topLevelEntries.length === 0) return
            setActiveIndex(prev => (prev + 1) % topLevelEntries.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            if (topLevelEntries.length === 0) return
            setActiveIndex(prev => (prev - 1 + topLevelEntries.length) % topLevelEntries.length)
          } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
            e.preventDefault()
            e.stopPropagation()
            const entry = topLevelEntries[activeIndex]
            if (entry?.kind === 'current_web') {
              onSelect(entry.item)
              return
            }
            if (!entry) return
            setActiveCategoryKey(entry.category.key)
            setActiveIndex(0)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        } else {
          // 二级菜单导航
          if (visibleItems.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActiveIndex(prev => (prev + 1) % visibleItems.length)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActiveIndex(prev => (prev - 1 + visibleItems.length) % visibleItems.length)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              onSelect(visibleItems[activeIndex])
            }
          }
          if (e.key === 'ArrowLeft' || e.key === 'Escape') {
            e.preventDefault()
            setActiveCategoryKey(null)
            setActiveIndex(findTopLevelCategoryIndex(activeCategoryKey))
          }
        }
      }
    },
    [open, anchorEl, isSearchMode, activeCategoryKey, visibleItems, activeIndex, onSelect, onClose, topLevelEntries, findTopLevelCategoryIndex]
  )

  useEffect(() => {
    if (open) {
      window.addEventListener('keydown', handleKeyDown, true)
      return () => window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open, handleKeyDown])

  /** 滚动到激活项 */
  useEffect(() => {
    const container = listRef.current || panelRef.current
    if (container) {
      const activeEl = container.querySelector('[data-active="true"]') as HTMLElement | null
      activeEl?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex])

  /* ----------------------------------------------------------------
   * Render
   * ---------------------------------------------------------------- */
  if (!open) return null

  // Portal 定位样式
  const portalStyle: React.CSSProperties = position
    ? {
        position: 'fixed',
        bottom: `${window.innerHeight - position.top + 4}px`,
        left: `${position.left}px`,
        zIndex: ZIndex.dropdown,
      }
    : {
        // fallback：无 anchorEl 时使用 absolute 定位（兼容旧代码）
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 4,
        zIndex: ZIndex.dropdown,
      }

  const content = (
    <div ref={popoverRef} style={portalStyle} className="flex">
      {/* ====== 主面板 ====== */}
      <div className={cn(
        'w-[220px] max-h-[280px] overflow-hidden rounded-interactive',
        OVERLAY_SURFACE_CLASS,
        'flex flex-col'
      )}>
        {/* 头部 */}
        <div className={cn('flex min-w-0 items-center gap-1.5 border-b border-border/30 px-2.5 py-1.5 shrink-0', COMPOSER_TEXT_META)}>
          <Search className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {isSearchMode ? trimmedQuery : t('mention.title')}
          </span>
          {isLoading && <Loader2 className="h-3 w-3 ml-auto animate-spin shrink-0" />}
        </div>

        {/* 内容 */}
        <ScrollArea className="flex-1">
          <div className="py-0.5">
          {isSearchMode ? (
            /* ---------- 搜索结果 ---------- */
            <>
              {searchResults.length === 0 && !isLoading && (
                <EmptyState
                  icon="search"
                  size="sm"
                  title={t('mention.noMatch')}
                  className="px-3 py-5"
                />
              )}
              {searchResults.map((item, index) => (
                <ResourceRow
                  key={`${item.type}-${item.resourceId}`}
                  item={item}
                  active={index === activeIndex}
                  onHover={() => setActiveIndex(index)}
                  onClick={() => onSelect(item)}
                  currentSpaceId={selectedSpace?.id}
                />
              ))}
            </>
          ) : !activeCategoryKey ? (
            /* ---------- 一级分类菜单 ---------- */
            <>
              {/* 当前 Space */}
              {selectedSpace && (
                <div className={cn('flex min-w-0 items-center gap-1 px-2.5 py-1', COMPOSER_TEXT_META, 'text-muted-foreground/40')}>
                  <FolderOpen className="h-2.5 w-2.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{selectedSpace.name}</span>
                </div>
              )}
              {topLevelEntries.map((entry, index) => {
                if (entry.kind === 'current_web') {
                  return (
                    <ResourceRow
                      key={entry.item.id}
                      item={entry.item}
                      active={index === activeIndex}
                      onHover={() => setActiveIndex(index)}
                      onClick={() => onSelect(entry.item)}
                      currentSpaceId={selectedSpace?.id}
                    />
                  )
                }
                const cat = entry.category
                const Icon = cat.icon
                return (
                  <button
                    key={cat.key}
                    type="button"
                    data-active={index === activeIndex}
                    className={cn(
                      'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-body transition-colors',
                      index === activeIndex
                        ? 'bg-accent/10 text-foreground'
                        : 'text-foreground/80 hover:bg-muted/30'
                    )}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => {
                      setActiveCategoryKey(cat.key)
                      setActiveIndex(0)
                    }}
                  >
                    <Icon className={cn('h-3.5 w-3.5 shrink-0', cat.color.split(' ')[0])} />
                    <span className="min-w-0 flex-1 truncate font-medium">{getCatLabel(cat)}</span>
                    <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
                  </button>
                )
              })}
            </>
          ) : (
            /* ---------- 二级资源列表 ---------- */
            <div ref={panelRef}>
              {/* 返回 */}
              <button
                type="button"
                className={cn('flex w-full items-center gap-1.5 px-2.5 py-1 hover:bg-muted/20 border-b border-border/20', COMPOSER_TEXT_META)}
                onClick={() => {
                  setActiveCategoryKey(null)
                  setActiveIndex(findTopLevelCategoryIndex(activeCategoryKey))
                }}
              >
                <ChevronRight className="h-2.5 w-2.5 rotate-180" />
                <span>{(() => { const found = CATEGORIES.find(c => c.key === activeCategoryKey); return found ? getCatLabel(found) : t('mention.back') })()}</span>
              </button>

              {categoryItems.length === 0 && !isLoading && (
                <EmptyState
                  icon="list"
                  size="sm"
                  title={t('mention.emptyCategory')}
                  className="px-3 py-5"
                />
              )}
              {categoryItems.map((item, index) => (
                <ResourceRow
                  key={`${item.type}-${item.resourceId}`}
                  item={item}
                  active={index === activeIndex}
                  onHover={() => setActiveIndex(index)}
                  onClick={() => onSelect(item)}
                  currentSpaceId={selectedSpace?.id}
                />
              ))}
            </div>
          )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )

  // 有 anchorEl 时使用 Portal 脱离 overflow:hidden 限制。
  // Wave 6.3：改走 OverlayContainer——切走 hot Space 时容器 `display:none`
  // 让 portal 跟随消失（onClose effect 仍业务语义保留：把 open 拉回 false 走
  // `if (!open) return null` 短路），不再依赖单独的 isForeground portal 守门。
  if (anchorEl) {
    return createPortal(content, overlayContainer ?? document.body)
  }
  return content
}

/* ================================================================
 * 子组件
 * ================================================================ */

/** mention type → 图标/颜色 查找（从 registry 获取，无模块级缓存） */
function resolveMentionIcon(mentionType: string): { icon: React.FC<{ className?: string }>; color: string } {
  if (mentionType === 'field') return { icon: Columns3, color: 'text-warning' }
  if (mentionType === 'webpage') return { icon: Globe, color: 'text-primary' }
  const cats = contextRegistry.getMentionCategories()
  const match = cats.find(c => contextRegistry.normalizeMentionType(c.type) === mentionType)
  if (match) return { icon: match.icon, color: match.color.split(' ')[0] }
  const fallback = cats[0]
  return fallback ? { icon: fallback.icon, color: fallback.color.split(' ')[0] } : { icon: Columns3, color: 'text-muted-foreground' }
}

/** 资源行 — 紧凑单行 + 跨 Space 来源 */
const ResourceRow: React.FC<{
  item: MentionItem
  active: boolean
  onHover: () => void
  onClick: () => void
  currentSpaceId?: string
}> = ({ item, active, onHover, onClick, currentSpaceId }) => {
  const { icon: Icon, color: iconColor } = resolveMentionIcon(item.type)
  const isOtherSpace = currentSpaceId && item.spaceId && item.spaceId !== currentSpaceId

  return (
    <button
      type="button"
      data-active={active}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-body transition-colors',
        active
          ? 'bg-accent/10 text-foreground'
          : 'text-foreground/80 hover:bg-muted/30'
      )}
      onMouseEnter={onHover}
      onClick={onClick}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', iconColor)} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {isOtherSpace && item.spaceName && (
        <span className={cn('max-w-[80px] shrink-0 truncate', COMPOSER_TEXT_META, 'text-muted-foreground/40')}>{item.spaceName}</span>
      )}
    </button>
  )
}
