import React from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { Presentation } from 'lucide-react'
import type { ContextTypeHandler } from '../types'
import { useClosedTabsStore } from '@stores/useClosedTabsStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { TABSLIDE_UI_ENABLED } from '@/utils/featureFlags'
import i18n from '@/i18n'

/** 历史版本 i18n 缺失时曾把键名写入 item.title / 持久化，需视为「无标题」再翻译 */
const STALE_SLIDE_TITLE_KEYS = new Set(['label.untitledSlide', 'label.untitledPpt'])

function slideUntitledLabel(): string {
  return i18n.t('label.untitledSlide', { ns: 'context' })
}

function resolveSlideTabTitle(stored?: string | null): string {
  const t = (stored ?? '').trim()
  if (!t || STALE_SLIDE_TITLE_KEYS.has(t)) return slideUntitledLabel()
  return t
}

const loadSlideEditorHost = () =>
  import('@components/slide/SlideEditorHost').then(m => ({ default: m.SlideEditorHost }))
const SlideEditorHost = React.lazy(loadSlideEditorHost)

/**
 * TabSlide ContextType Handler
 *
 * 注册 'tabslide' 类型，使用 @tabtin/tabslide 的 SlideEditor 渲染演示文稿。
 */
export const slideHandler: ContextTypeHandler = {
  type: 'tabslide',
  appId: 'tabslide',
  prefetch: loadSlideEditorHost,
  persistOnly: true,
  appEntryMode: 'resources',
  aggregateAppId: 'cloud-resources',
  keepAlive: true,
  displayLabel: 'Slides',
  displayEmoji: '📽️',
  agent: {
    displayName: '演示',
    capability: '把内容排成精美幻灯片，一步生成并交付本地 .pptx 演示文件（不产生需要在应用内打开的云项目），适合产品介绍、汇报、教学、总结 deck。',
    aliases: ['ppt', '幻灯片', 'slides', '演示文稿'],
    // backendAliases[0]='ppt' 是后端 item_type 别名，真实 CLI 是 `tabtin slide`。
    cliKey: 'slide',
  },
  backendAliases: ['ppt', 'slide'],
  //  / ：UI 关闭时仍注册 handler 供 Agent `<apps>`；搜索与「新建」入口继续藏。
  // searchLabelKey 也一并关掉——其 i18n「幻灯片」与 agent.displayName「演示」本就不对齐，
  // 打开 UI 时再单独收敛产品名（不在本 issue 范围）。
  searchable: TABSLIDE_UI_ENABLED,
  ...(TABSLIDE_UI_ENABLED
    ? {
        searchLabelKey: 'organization:search.presentations',
        quickAction: {
          icon: <Presentation className="h-3.5 w-3.5" />,
          labelKey: 'context:home.quickActions.newPpt',
          shortLabelKey: 'context:home.quickActions.shortPpt',
        },
      }
    : {}),
  appMeta: { idField: 'current_slide_id', titleField: 'current_slide_title' },
  attachToChat: {
    refType: 'slide',
    buildRef: (item) => {
      if (!item.id) return null
      return {
        resourceId: item.id,
        label: resolveSlideTabTitle(item.title),
      }
    },
  },

  onSelect: (item, ctx) => {
    useSpaceContextTabsStore.getState().openResourceTab(ctx.tabScopeKey ?? resolveForegroundTabScopeKey(ctx.spaceId), {
      type: 'tabslide',
      id: item.id,
      title: item.title,
      meta: item.meta,
    })
  },

  onClose: (item, ctx) => {
    useClosedTabsStore.getState().push({
      type: 'tabslide',
      id: item.id,
      tabKey: item.tabKey,
      title: resolveSlideTabTitle(item.title),
      spaceId: ctx.spaceId,
    })
  },

  getTabLabel: (item) => resolveSlideTabTitle(item.title),

  getTabIcon: () => <TabTypeEmoji appIdOrType="tabslide" />,

  getDragPayload: (item) => ({ type: 'tabslide', id: item.id }),

  buildCanvasContent: (item) => ({ tabKey: item.tabKey }),

  buildCanvasContentFromDrag: (tabKey) => ({ tabKey }),

  renderPane: (item, ctx) => (
    <React.Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <span className="text-body text-muted-foreground">{i18n.t('label.loading', { ns: 'context' })}</span>
        </div>
      }
    >
      <div
        className="h-full w-full"
        onPointerDownCapture={() => ctx?.onPaneInteraction?.()}
        onFocusCapture={() => ctx?.onPaneInteraction?.()}
        onKeyDownCapture={() => ctx?.onPaneInteraction?.()}
      >
        <SlideEditorHost
          slideId={item.id}
          className="h-full w-full"
          tabScopeKey={ctx.tabScopeKey ?? resolveForegroundTabScopeKey(ctx.spaceId)}
        />
      </div>
    </React.Suspense>
  ),
}
