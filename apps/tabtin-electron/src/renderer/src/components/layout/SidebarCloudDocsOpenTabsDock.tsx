/**
 * SidebarCloudDocsOpenTabsDock — 云文档侧栏底部「当前打开」会话列表。
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSpaceContextTabsStore, EMPTY_CONTEXT_ITEMS, EMPTY_TAB_ORDER } from '@stores/useSpaceContextTabsStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { invokeCloseContextTab } from '@components/context-space/tools/ContextSpaceToolHandler'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { SidebarMenuItem } from './SidebarMenuItem'
import { ScrollArea, toast } from '@components/ui'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'
import {
  SIDEBAR_CHROME_ICON_SIZE,
  SIDEBAR_CHROME_ICON_STROKE,
  SIDEBAR_EMBEDDED_CONTROL_INSET,
  SIDEBAR_LIST_ICON_SLOT,
  SIDEBAR_OPEN_TABS_DOCK,
  SIDEBAR_OPEN_TABS_DOCK_HEADER,
  SIDEBAR_OPEN_TABS_DOCK_SCROLL,
  SIDEBAR_ROW_MICRO_ACTION,
  SIDEBAR_SCROLLBAR_TYPE,
  SIDEBAR_TEXT_META,
  SIDEBAR_TEXT_SECTION,
} from './sidebarUi'
import {
  resolveCloudDocsCloseFallback,
  selectCloudDocsDockTabs,
  type CloudDocsDockTab,
} from './cloudDocsOpenTabs'

interface SidebarCloudDocsOpenTabsDockProps {
  tabScopeKey: string
  resourceHostSpaceId?: string | null
}

const log = createLogger('SidebarCloudDocsOpenTabsDock')

function dockTabIconKind(tab: CloudDocsDockTab): string {
  if (tab.isHome) return 'cloud-resources'
  return tab.type
}

export const SidebarCloudDocsOpenTabsDock: React.FC<SidebarCloudDocsOpenTabsDockProps> = ({
  tabScopeKey,
  resourceHostSpaceId = null,
}) => {
  const { t } = useTranslation(['sidebar', 'context'])
  const collapsed = useSpaceViewPrefsStore(
    state => state.getPrefs(tabScopeKey).cloudDocsOpenTabsDockCollapsed ?? false,
  )
  const setDockCollapsed = useSpaceViewPrefsStore(state => state.setCloudDocsOpenTabsDockCollapsed)
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const tabOrder = useSpaceContextTabsStore(state => state.tabOrderBySpace[tabScopeKey] ?? EMPTY_TAB_ORDER)
  const itemsByKey = useSpaceContextTabsStore(state => state.itemsBySpace[tabScopeKey] ?? EMPTY_CONTEXT_ITEMS)
  const activeKey = useSpaceContextTabsStore(state => state.activeKeyBySpace[tabScopeKey] ?? null)
  const setActiveKey = useSpaceContextTabsStore(state => state.setActiveKey)
  const closeTab = useSpaceContextTabsStore(state => state.closeTab)

  const dockTabs = useMemo(
    () => selectCloudDocsDockTabs({ tabOrder, itemsByKey }),
    [itemsByKey, tabOrder],
  )
  const closableTabs = useMemo(
    () => dockTabs.filter(tab => tab.closable),
    [dockTabs],
  )

  useEffect(() => {
    if (!activeKey || collapsed) return
    const node = rowRefs.current.get(activeKey)
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeKey, collapsed, dockTabs.length])

  const handleSelect = useCallback((tabKey: string) => {
    setActiveKey(tabScopeKey, tabKey)
  }, [setActiveKey, tabScopeKey])

  const closeBrowserTab = useCallback(async (tab: CloudDocsDockTab) => {
    const item = itemsByKey[tab.tabKey]
    const itemSpaceId = typeof item?.meta?.spaceId === 'string' ? item.meta.spaceId : null
    const crawlspaceId = typeof item?.meta?.crawlspaceId === 'string'
      ? item.meta.crawlspaceId
      : null

    try {
      const result = await invokeCloseContextTab({
        spaceId: itemSpaceId ?? resourceHostSpaceId,
        tabScopeKey,
        crawlspaceId,
        tabKey: tab.tabKey,
      })
      if (result.success) return

      const failure = result as { code?: string; error?: string }
      if (failure.code === 'CLOSE_CANCELLED') return
      log.warn('cloud docs browser tab close was rejected', {
        tabScopeKey,
        tabKey: tab.tabKey,
        code: failure.code,
        error: failure.error,
      })
      toast({
        title: t('context:error.closeWebTabFailed', {
          defaultValue: '关闭网页标签失败',
        }),
        description: failure.error,
        variant: 'destructive',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('cloud docs browser tab close failed', {
        tabScopeKey,
        tabKey: tab.tabKey,
        error: message,
      })
      toast({
        title: t('context:error.closeWebTabFailed', {
          defaultValue: '关闭网页标签失败',
        }),
        description: message,
        variant: 'destructive',
      })
    }
  }, [itemsByKey, resourceHostSpaceId, t, tabScopeKey])

  const handleClose = useCallback((tab: CloudDocsDockTab, event: React.MouseEvent) => {
    event.stopPropagation()
    if (!tab.closable) return
    if (tab.kind === 'tabweb') {
      void closeBrowserTab(tab)
      return
    }
    const fallback = resolveCloudDocsCloseFallback(dockTabs, tab.tabKey)
    closeTab(tabScopeKey, tab.tabKey, fallback)
  }, [closeBrowserTab, closeTab, dockTabs, tabScopeKey])

  const resolveTitle = useCallback((tab: CloudDocsDockTab) => {
    if (tab.isHome) {
      return t('context:home.cloudDocs', { defaultValue: '云文档' })
    }
    return tab.title
  }, [t])

  if (dockTabs.length === 0 || closableTabs.length === 0) return null

  const headerLabel = t('sidebar:cloudDocs.openTabs.label', {
    defaultValue: '当前打开',
  })
  const countLabel = t('sidebar:cloudDocs.openTabs.count', {
    count: closableTabs.length,
    defaultValue: '{{count}}',
  })
  const hintLabel = t('sidebar:cloudDocs.openTabs.hint', {
    defaultValue: '正在编辑区打开的文档与表格',
  })

  return (
    <div
      className={cn(SIDEBAR_OPEN_TABS_DOCK, SIDEBAR_EMBEDDED_CONTROL_INSET)}
      data-testid="cloud-docs-open-tabs-dock"
    >
      <button
        type="button"
        className={SIDEBAR_OPEN_TABS_DOCK_HEADER}
        aria-expanded={!collapsed}
        onClick={() => setDockCollapsed(tabScopeKey, !collapsed)}
      >
        <span className="min-w-0 flex-1">
          <span className={cn(SIDEBAR_TEXT_SECTION, 'text-foreground/75')}>
            {headerLabel}
            <span className={cn('ml-1 tabular-nums', SIDEBAR_TEXT_META, 'text-muted-foreground/50')}>
              {countLabel}
            </span>
          </span>
          {!collapsed && (
            <span className={cn('mt-0.5 block truncate', SIDEBAR_TEXT_META, 'text-muted-foreground/50')}>
              {hintLabel}
            </span>
          )}
        </span>
        {collapsed
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
          : <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
      </button>

      {!collapsed && (
        <ScrollArea
          className={SIDEBAR_OPEN_TABS_DOCK_SCROLL}
          scrollBar="vertical"
          type={SIDEBAR_SCROLLBAR_TYPE}
        >
          <div className="flex flex-col gap-0.5 pb-1">
            {dockTabs.map(tab => {
              const title = resolveTitle(tab)
              const isActive = activeKey === tab.tabKey
              return (
                <div
                  key={tab.tabKey}
                  ref={node => {
                    if (node) rowRefs.current.set(tab.tabKey, node)
                    else rowRefs.current.delete(tab.tabKey)
                  }}
                >
                  <SidebarMenuItem
                    as="div"
                    role="button"
                    tabIndex={0}
                    active={isActive}
                    reserveActions={tab.closable}
                    fullWidth
                    title={title}
                    leading={(
                      <span className={SIDEBAR_LIST_ICON_SLOT}>
                        <TabTypeEmoji
                          appIdOrType={dockTabIconKind(tab)}
                          className="h-4 w-4"
                        />
                      </span>
                    )}
                    label={(
                      <span className="truncate">{title}</span>
                    )}
                    trailing={tab.closable ? (
                      <button
                        type="button"
                        className={cn(
                          SIDEBAR_ROW_MICRO_ACTION,
                          'text-muted-foreground/45 hover:text-foreground',
                        )}
                        aria-label={t('sidebar:cloudDocs.openTabs.close', {
                          title,
                          defaultValue: '关闭 {{title}}',
                        })}
                        onClick={event => handleClose(tab, event)}
                      >
                        <X size={SIDEBAR_CHROME_ICON_SIZE} strokeWidth={SIDEBAR_CHROME_ICON_STROKE} />
                      </button>
                    ) : undefined}
                    onClick={() => handleSelect(tab.tabKey)}
                    data-testid={`cloud-docs-open-tab-${tab.tabKey}`}
                  />
                </div>
              )
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

SidebarCloudDocsOpenTabsDock.displayName = 'SidebarCloudDocsOpenTabsDock'
