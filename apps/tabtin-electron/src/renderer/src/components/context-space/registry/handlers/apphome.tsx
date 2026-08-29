import React, { useCallback } from 'react'
import type { ContextItem, ContextTypeHandler, HomeSectionHandler } from '../types'
import { resolveAppHomeTabModel } from '../resolveUtils'
import { useSpaceContextActions } from '@components/context-space/SpaceContextAreaContext'
import type { CreateResourceOptions } from '@components/context-space/hooks/createResourceTypes'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import i18n from '@/i18n'

// 强制触发 homeRegistry 的副作用注册 —— 否则 homeSectionRegistry 是空 Map（之前只被
// `DesktopPanel.tsx`（React.lazy）顶部 import 一次，workspace 的 Agent sticky Tab 通过
// apphome.renderPane 渲染时 DesktopPanel 还没解析，resolveAppHomeTabModel 拿不到 section
// → fallback 到 `<div>{title}</div>` 只显示 Tab 标题。
//
// apphome handler 是所有"应用主页 Tab"的渲染入口，它的工作硬依赖 home sections 已注册。
// 在这里 import 比放在 registry/index.ts 顶部更准确：表达"apphome 需要 home sections"
// 这条契约，而不是污染整个 registry 入口。
import '../homeRegistry'

const loadContextHome = () =>
  import('@components/context-space/ContextHome').then(m => ({ default: m.ContextHome }))
const ContextHome = React.lazy(loadContextHome)

function appIdFromItem(item: ContextItem): string {
  const appId = item.meta?.appId
  return typeof appId === 'string' ? appId : item.id
}

function targetSpaceIdFromItem(item: ContextItem): string | null {
  const targetSpaceId = item.meta?.targetSpaceId
  return typeof targetSpaceId === 'string' && targetSpaceId ? targetSpaceId : null
}

/**
 * 渲染独立 apphome 标签页中的 HomeSection。
 *
 * 关键职责：把 SpaceContextArea 的 createHandlers / onSearchNavigate 注入给 Section，
 * 让 Section 内部触发的 onCreateResource(appId) 能真正路由到对应 App 的创建/打开流程。
 *
 * 此前这里写死 onCreateResource={() => {}}，导致 TabPhoneSection 等独立 apphome 视图
 * 中点击列表项 / 点击「+ 添加设备」均无任何响应（DM-064 仅修了 ContextHome 入口）。
 */
const HomeSectionPaneContent: React.FC<{
  section: HomeSectionHandler
  spaceId: string
  tabScopeKey?: string | null
  contextTabKey: ContextItem['tabKey']
  isPaneActive?: boolean
}> = ({ section, spaceId, tabScopeKey, contextTabKey, isPaneActive }) => {
  const { createHandlers, onSearchNavigate } = useSpaceContextActions()
  const onCreateResource = useCallback(
    (appId: string, options?: CreateResourceOptions) => {
      createHandlers[appId]?.(options)
    },
    [createHandlers],
  )
  const SectionComponent = section.Component
  return (
    <SectionComponent
      spaceId={spaceId}
      tabScopeKey={tabScopeKey}
      contextTabKey={contextTabKey}
      isPaneActive={isPaneActive}
      onCreateResource={onCreateResource}
      onSearchNavigate={onSearchNavigate}
    />
  )
}

export const apphomeHandler: ContextTypeHandler = {
  type: 'apphome',
  prefetch: loadContextHome,
  persistOnly: true,
  renderMode: 'pane',
  // 工作空间目录起始页内嵌 FileTree。与独立 tabfolder 页签保持一致：切页时仅视觉隐藏，
  // 保留目录展开、滚动与选择现场；其他 App 首页仍按需卸载，避免无谓常驻。
  keepAlive: item => appIdFromItem(item) === 'orchestration',
  keepAliveSuspendMode: 'visibility',

  /**
   * 所有 apphome 标签均可关闭，包括 Orchestration 起始页（appId='orchestration'，
   * 即「xxx 的目录」）。关闭后由 useEnsureAgentHomeTab 在下次进入 Space 时按需重新注入，
   * 用户也可通过侧栏入口 / ⌘⇧T 重新打开。
   */
  closable: () => true,

  /**
   * 注入 current_app_home 字段，让 Agent 知道用户当前在哪个 App 的列表/首页。
   * 例如在 TabCode apphome 时 → current_app_home='tabcode'，Agent 可以理解
   * "用户在 TabCode 资源列表，但还没聚焦到具体项目"，从而决定要不要让用户先选一个项目。
   */
  appMeta: {
    idField: '',
    resolve: (item) => {
      const appId = appIdFromItem(item)
      if (!appId) return null
      return { current_app_home: appId }
    },
  },

  getTabLabel: item => {
    const appId = appIdFromItem(item)
    // Orchestration 起始页（含 targetSpaceId 跳转态）优先用 item.title——
    // 容器层按当前 Space 名注入「xxx的目录」，Space rename 后实时跟随。
    if (appId === 'orchestration' || targetSpaceIdFromItem(item)) {
      return item.title || resolveAppHomeTabModel(appId, { title: item.title, meta: item.meta }).title
    }
    return resolveAppHomeTabModel(appId, { title: item.title, meta: item.meta }).title
  },

  getTabIcon: item => {
    const appId = appIdFromItem(item)
    // Orchestration 起始页：Agent 工作环境本身的 Tab——用 accent 染色的 Home 图标
    // 做视觉区分，跟普通 Tab 拉开差异。
    if (appId === 'orchestration') {
      return <TabTypeEmoji appIdOrType={appId} />
    }
    const { section } = resolveAppHomeTabModel(appId, { title: item.title, meta: item.meta })
    // Section 自声明的标签图标优先（如「云盘」复用同款 emoji）
    if (section?.tabIcon) {
      return section.tabIcon
    }
    return <TabTypeEmoji appIdOrType={appId} />
  },

  resolveTabItem: (id, ctx) => {
    const appId = typeof ctx.persistedItem?.meta?.appId === 'string'
      ? ctx.persistedItem.meta.appId
      : id
    const model = resolveAppHomeTabModel(appId, ctx.persistedItem)
    const targetSpaceId = typeof ctx.persistedItem?.meta?.targetSpaceId === 'string'
      ? ctx.persistedItem.meta.targetSpaceId
      : null

    return {
      type: 'apphome',
      id: targetSpaceId ? id : appId,
      tabKey: ctx.tabKey,
      title: targetSpaceId && ctx.persistedItem?.title ? ctx.persistedItem.title : model.title,
      meta: {
        ...(ctx.persistedItem?.meta ?? {}),
        appId,
        displayLabel: model.displayLabel,
        displayEmoji: model.displayEmoji,
        labelKey: model.labelKey,
      },
    }
  },

  renderPane: (item, ctx) => {
    const model = resolveAppHomeTabModel(appIdFromItem(item), { title: item.title, meta: item.meta })
    const spaceId = targetSpaceIdFromItem(item) ?? ctx?.spaceId ?? ''
    const tabScopeKey = ctx?.tabScopeKey ?? ctx?.spaceId ?? spaceId

    let content: React.ReactNode
    if (model.sidebarPanel) {
      const focusSkillKey = typeof item.meta?.skillKey === 'string' ? item.meta.skillKey : undefined
      const focusAt = typeof item.meta?.focusAt === 'number' ? item.meta.focusAt : undefined
      content = React.createElement(model.sidebarPanel, {
        spaceId,
        tabScopeKey,
        focusSkillKey,
        focusAt,
      })
    } else if (model.section?.renderInsideContextHome) {
      content = <ContextHome forcedAssetTab={model.appId} hideAssetSwitcher hideToolbar />
    } else if (model.section?.Component) {
      content = (
        <HomeSectionPaneContent
          section={model.section}
          spaceId={spaceId}
          tabScopeKey={tabScopeKey}
          contextTabKey={item.tabKey}
          isPaneActive={ctx?.isPaneActive !== false}
        />
      )
    } else {
      content = (
        <div className="flex h-full items-center justify-center text-body text-muted-foreground">
          {model.title}
        </div>
      )
    }

    return (
      <React.Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-body text-muted-foreground">
            {i18n.t('label.loading', { ns: 'context' })}
          </div>
        }
      >
        {content}
      </React.Suspense>
    )
  },
}
