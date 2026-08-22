/**
 * Context handler 注册入口。
 *
 * 仅自动发现并注册 handlers/ 下的 tab 处理器，避免任何 contextRegistry 调用
 * 都顺带把 Home 资源面板的 section 实现打进首屏 bundle。
 */
import { contextRegistry, homeSectionRegistry } from './instance'
import {
  HIDDEN_APPS,
  HANDLER_ORDER,
  orderIndex,
  stemFromPath,
} from './moduleRegistryUtils'
import type { ContextTypeHandler } from './types'
import { createGenericEmbeddedWebHandler, type EmbeddedWebAppSpec } from './genericEmbeddedWebFactory'
import { createEmbeddedWebHomeSection } from './homeSections/embeddedWebApp'
import { useSpaceApps } from '@stores/useSpaceApps'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { openResourceTabGuarded } from '../restore/openResourceMembershipGuard'
import { installTabdocDirtyProvider } from '../tabdoc/tabdocDirtyProvider'
import { registerDesktopTabHandler } from '../desktopTabHandler'
import type { ManifestOpens } from '@tabtin/resource-router'
import { logger } from '@/utils/logger'
import {
  adaptIndustryParams,
  enrichTabtrackerOpenParams,
  resourceRouterRegistry,
  wireResourceRouter,
} from '@/services/resourceRouter'
import { enrichOssFileOpenParams } from '@/services/enrichOssFileOpenParams'
import { createResourceOpenPreferenceAdapter } from '@/stores/useResourceOpenPreferences'
import { createResourceTelemetryEmitter } from '@/services/resourceTelemetryEmitter'
import { openWebTabInSpace, isHttpUrlId } from '@/services/openWebTabInSpace'
import { resolveBrowserOpenTabScopeKey } from '@/components/chat/subagent/openSubagentTab'
import { openTeamSpaceTabdoc } from '@/services/openTeamSpaceTabdoc'
import { resolveLocalFileResource } from '@/services/localFileResourceResolver'
import { getRemoteExecutionAccess } from '@/services/remoteExecutionGuard'
import i18n from '@/i18n'
import type { OpenIntentHints } from '@shared/open-intent'

// ─── Auto-discover ContextTypeHandlers ────────────────────────────
const handlerModules = import.meta.glob(
  './handlers/*.tsx',
  { eager: true },
) as Record<string, Record<string, unknown>>

const handlerEntries: Array<[string, ContextTypeHandler]> = []
for (const [path, mod] of Object.entries(handlerModules)) {
  const stem = stemFromPath(path)
  for (const val of Object.values(mod)) {
    if (val && typeof val === 'object' && 'type' in val) {
      handlerEntries.push([stem, val as ContextTypeHandler])
      break
    }
  }
}
handlerEntries.sort((a, b) => orderIndex(a[0], HANDLER_ORDER) - orderIndex(b[0], HANDLER_ORDER))
for (const [stem, handler] of handlerEntries) {
  if (HIDDEN_APPS.has(stem)) {
    // 仍在 HIDDEN_APPS 的 stem 不注册（如 UI 关闭时的 tabslide Home）。
    // ：slide handler 已从 HIDDEN_APPS 移出，供 Agent `<apps>` 元数据。
    continue
  }
  contextRegistry.register(handler)
}

function readOpenIntentHints(meta: Record<string, unknown> | undefined): OpenIntentHints | undefined {
  const raw = meta?.openIntentHints
  if (!raw || typeof raw !== 'object') return undefined
  const hints = raw as Record<string, unknown>
  return {
    ...(typeof hints.filename === 'string' && hints.filename ? { filename: hints.filename } : {}),
    ...(typeof hints.mimeType === 'string' && hints.mimeType ? { mimeType: hints.mimeType } : {}),
    ...(typeof hints.assetId === 'string' && hints.assetId ? { assetId: hints.assetId } : {}),
  }
}

// ─── ResourceRouter 启动期 wiring + manifest opens 注册 ──────────────
//
// W3 接 chat 闭环时实例化 ResourceRouter（RFC §9 ContextRegistry 薄包装层）：
//   1. wireResourceRouter() 把 contextRegistry / openResourceTab / openExternal
//      注入到单例
//   2. 通过 import.meta.glob 静态扫描 packages/apps/*/app.json 的 opens 字段
//      聚合到 resourceRouterRegistry，与现有 marketplace 工具卡同款套路
//      （参见 chat/registry/marketplaceToolCardDiscovery.ts）
//
// 任何"在 Space 内打开"的入口（chat MarkdownRenderer / open_in_space 工具 /
// 富 ResourceCard / Tracker 通知跳转）都通过这个单例派发，是 D1 的统一收口。
wireResourceRouter({
  contextRegistry: {
    hasHandlerByAppId: (appId) => contextRegistry.getHandlerByAppId(appId) !== undefined,
    getAppIdsForType: (type) => {
      const handler = contextRegistry.getHandler(type)
      return handler?.appId ? [handler.appId] : []
    },
  },
  openResourceTab: async (spaceId, params) => {
    // 行业格式 type 适配：router 行业分支传 type=pointer.scheme（'https'/'file'
    // /'mailto'），但 ContextRegistry handler 用 ContextItemType（'tabweb'/
    // 'tabfolder'/'tabmail'）。adaptIndustryParams 走 backendTypeMap → manifest
    // opens.schemes 反查 carrier 两级 fallback 升级 type，确保下游 tab 渲染
    // 能找到正确的 handler（RFC §1.4 行业格式落点 + D1 下沉）。
    const adapted = adaptIndustryParams(params, {
      resolveHandlerByType: (type) => contextRegistry.getHandler(type),
      lookupCarriersByScheme: (scheme) => resourceRouterRegistry.lookupByScheme(scheme),
      resolveHandlerByAppId: (appId) => contextRegistry.getHandlerByAppId(appId),
    })
    // 未传 / 传裸 spaceId 时升到前台 desktop:/conversation: 桶。
    const tabScopeKey = resolveBrowserOpenTabScopeKey(spaceId, adapted.tabScopeKey)

    // BR-31：tabweb 承载一个 http(s) URL 时，通用 openResourceTab 只会塞一条 id=URL
    // 的壳 tab，**从不创建 WebContentsView / 不导航** → 顶栏出现标签但内容区空白。
    // 这里分流到 openWebTabInSpace 走真实流程（ensureSpaceCrawlspace + createView(viewId,
    // url) + setActiveView，tab key 用 viewId）。失败时 throw，让 ResourceRouter
    // 捕获后 outcome='error' → chat 链接落到 BR-25 的 http(s) 兜底 openExternal，
    // 而非假阳性 in_space_opened（见 MarkdownRenderer link onClick 的 outcome 处理）。
    if (adapted.type === 'tabweb' && isHttpUrlId(adapted.id)) {
      const opened = await openWebTabInSpace(spaceId, adapted.id, {
        title: adapted.title,
        tabScopeKey,
        openIntentHints: readOpenIntentHints(adapted.meta),
      })
      if (!opened.ok) {
        throw new Error(
          `openWebTabInSpace failed for url: ${adapted.id}: ${opened.error}`,
        )
      }
      return
    }

    const targetSpace = useSpaceStore.getState().spaces.find(item => item.id === spaceId)
    if (targetSpace?.type === 'team_space' && adapted.type === 'tabdoc') {
      const opened = await openTeamSpaceTabdoc({
        teamSpaceId: spaceId,
        documentId: adapted.id,
        title: adapted.title,
        organizationId: targetSpace.organization_id,
      })
      if (!opened) {
        throw new Error(`openTeamSpaceTabdoc failed for document: ${adapted.id}`)
      }
      return
    }

    // 文件已在 tab 中打开时（同 type:id → 同 tabKey），openResourceTab 内部按
    // tabKey 去重，并在非 silent 时 setActiveKey 切到该标签；meta 变化（新的
    // local_file_refresh_token）同时触发预览刷新。因此不对已打开的 local file
    // artifact 做 silent 降级——再次打开（卡片点击 / auto_open / present_to_user local_file）一律
    // 切到已存在标签，而不是静默停留在当前标签。
    //
    // tabtracker 详情依赖 meta.taskId（通知/侧栏路径都会写）；ResourceRouter
    // 通用落地不会注入——这里对齐契约，避免「开了 tab 却只见列表」。
    //
    // 聊天附件 FileRecord UUID 常被 Agent 当成 resource_ref(video/file) 打开；
    // 查 OSS 命中则改写成 oss_file，TabFiles 用 access_url 预览（含 mp4）。
    const withTracker = enrichTabtrackerOpenParams(adapted, spaceId)
    const withOss = await enrichOssFileOpenParams(withTracker)
    // ：chat / open_in_space 等统一落地也打 membership pending
    openResourceTabGuarded(tabScopeKey, withOss, spaceId)
  },
  shellOpenExternal: async (url) => {
    const result = await window.tabtin?.openExternal?.(url)
    if (result && result.success === false) {
      throw new Error(result.error || 'shell.openExternal returned success=false')
    }
  },
  localFileResolver: async ({ spaceId, pointer }) => {
    const remote = getRemoteExecutionAccess(spaceId)
    if (remote.isRemoteViewer) {
      throw new Error(remote.controlDeviceName
        ? i18n.t('chat:card.openFile.remoteUnavailableWithDevice', {
            device: remote.controlDeviceName,
            defaultValue: '这个文件属于「{{device}}」上的工作空间。当前设备只能查看消息，不能直接打开或定位该文件。',
          })
        : i18n.t('chat:card.openFile.remoteUnavailableNoDevice', {
            defaultValue: '这个文件属于工作空间的执行设备。当前设备只能查看消息，不能直接打开或定位该文件。',
          }))
    }
    const state = useSpaceStore.getState()
    const space = state.spaces.find((s) => s.id === spaceId)
      ?? (state.selectedSpace?.id === spaceId ? state.selectedSpace : null)
    const agentId = space?.execution_agent_id ?? space?.agent_id ?? null
    const agent = agentId
      ? (state.agentCache[agentId] ?? (state.selectedAgent?.id === agentId ? state.selectedAgent : null))
      : null

    return resolveLocalFileResource({
      pointer,
      workingDir: space?.working_dir || agent?.working_dir || null,
      pathExists: async (absolutePath) => {
        const pathExists = window.tabtin?.fileSystem?.pathExists
        if (!pathExists) {
          throw new Error('当前环境不支持本地文件检查')
        }
        return pathExists(absolutePath)
      },
    })
  },
  // W4「Agent 产物在 Space 内的打开」：注入 useResourceOpenPreferences zustand
  // store。给 router 提供 D2 第 1 层 user_pref + 第 2 层 session_override 数据
  // 源；router 内部按"options.forceCarrierAppId 显式传入 > store
  // sessionOverride > 不注入"次序处理 sessionOverride，user_pref 在 resolve()
  // 内永远胜过其他层。
  preferenceStore: createResourceOpenPreferenceAdapter(),
  // W7「Agent 产物在 Space 内的打开」埋点上报通路接通：每次 router.open
  // 完成时 emit ResourceOpenEvent → IPC `telemetry:resource-open:emit`
  // → main 进程 telemetry queue（5s flush 或 100 条触发批量 POST 到 Django）
  // → PG `agent_engine_resource_open_event`。
  //
  // emitter 内部从 useAuthStore + useOrganizationStore 注入 user_id / organization_id
  // （preload IPC 调用前），并 best-effort 不阻塞 UI（任何 throw 都被 catch）。
  // 详见 RFC §8.3 + 总控 §2 W7。
  emitEvent: createResourceTelemetryEmitter(),
})

interface ManifestWithOpens {
  id?: string
  opens?: ManifestOpens
}

// import.meta.glob 静态聚合 builtin App manifest（构建期 Vite 扫描，运行时零开销）。
// 路径选用相对路径 9 级 `..` 与 marketplaceToolCardDiscovery.ts 保持同款约束。
const manifestModules = import.meta.glob<ManifestWithOpens>(
  '../../../../../../../../packages/apps/*/app.json',
  { eager: true, import: 'default' },
)

let _opensRegistered = 0
for (const [path, manifest] of Object.entries(manifestModules)) {
  if (!manifest || typeof manifest !== 'object') continue
  const appId = manifest.id
  if (!appId || typeof appId !== 'string') {
    logger.warn('[resourceRouter] manifest 缺 id，跳过', { path })
    continue
  }
  if (!manifest.opens) continue
  try {
    resourceRouterRegistry.register(appId, manifest.opens)
    _opensRegistered++
  } catch (err) {
    // register 抛错是 manifest schema 不合法（priority 非数字 / scheme 不带冒号等），
    // 记日志但不阻塞首屏——继续注册其余 App。
    logger.warn('[resourceRouter] register 失败', { appId, path, err })
  }
}
logger.debug('[resourceRouter] manifest opens 注册完成', {
  count: _opensRegistered,
  total: Object.keys(manifestModules).length,
})

// ─── main → renderer 兜底事件订阅 ─────────────────────────────────
//
// W3：主窗口 / crawlspace 的 setWindowOpenHandler 把第三方组件 / 历史代码
// 触发的 window.open 通过 IPC 转过来——这里 dispatch 给 ResourceRouter 接管
// （RFC §4.2 / §4.3）。订阅在模块初始化时一次性挂上，与 contextRegistry 同生命周期。
//
// W8 L33 / L88：Chromium 把 ⌘+click / middle-click 表示为
// disposition === 'foreground-tab'——renderer 收不到 metaKey 因为
// click 已经被 setWindowOpenHandler 吞掉。D2 第 5 层「⌘ 修饰键短路」
// 在 fallback 路径只能靠 disposition 还原（见 ./windowOpenFallback.ts 抽出的纯函数）。
import { isModifierExternalDisposition } from './windowOpenFallback'

if (typeof window !== 'undefined' && typeof window.tabtin?.resourceRouter?.onOpenFallback === 'function') {
  // 异步 import 避免循环依赖（resourceRouter.ts → 注入 contextRegistry → registry/index.ts）
  void import('@/services/resourceRouter').then(async ({ resourceRouter }) => {
    const { parseResourcePointer } = await import('@tabtin/resource-router')
    const { useSpaceStore } = await import('@/stores/useSpaceStore')
    const { tryOpenPreviewableDirectUrl } = await import('@/components/chat/preview/assetPreviewResolver')
    window.tabtin!.resourceRouter!.onOpenFallback(({ url, source, disposition, filename, mimeType, assetId }) => {
      const modifierExternal = isModifierExternalDisposition(disposition)
      // ⌘/Ctrl 仍走系统应用；普通 window.open 的 xlsx/pdf/image 进 Preview Modal。
      if (!modifierExternal && tryOpenPreviewableDirectUrl(url, {
        filename,
        mimeType,
        fileId: assetId,
      })) {
        logger.info('[resourceRouter] window-open-fallback → Preview Modal', { url, source })
        return
      }
      const spaceId = useSpaceStore.getState().selectedSpace?.id ?? ''
      const pointer = parseResourcePointer(url)
      void resourceRouter.open(spaceId, pointer, {
        triggerSource: 'window_open_fallback',
        ...(modifierExternal ? { modifierExternal: true } : {}),
      }).catch((err) => {
        logger.warn('[resourceRouter] window-open-fallback 派发失败', { url, source, err })
      })
    })
  })
}

// ─── Marketplace install checker ──────────────────────────────────
// 基于 Space Apps API 统一数据源：appId 出现在任意已加载 Space 的已启用 app 列表中即视为已安装
contextRegistry.setMarketplaceInstallChecker((appId: string) => {
  const allApps = useSpaceApps.getState().appsBySpace
  for (const apps of Object.values(allApps)) {
    if (apps.some(a => a.id === appId && a.enabled)) return true
  }
  return false
})

// ─── dispatchClose 契约守卫的状态采集器 ──────────────────────────────
// 让守卫在 handler.onClose 调用前后比对 activeKey + tabOrder 快照，
// 违约的 handler 在 dev/test 环境直接 throw（CI 挂掉），prod 环境降级为 warn。
contextRegistry.setCloseGuardSnapshotProvider((spaceId) => {
  const tabsState = useSpaceContextTabsStore.getState()
  return {
    activeKey: tabsState.activeKeyBySpace[spaceId] ?? null,
    tabOrder: tabsState.tabOrderBySpace[spaceId] ?? [],
  }
})

// ─── Dirty 资源聚合 provider 注册 ─────────────────────────────────
// W2.5 T9: ⌘Q 退出 / 删除 Space 时通过 collectAllDirty(spaceId?) 聚合各类型 dirty 资源，
// 弹合并对话框替代 tab 级 FIFO。tabdoc 是当前唯一接入；未来 tabslide/tabwhiteboard 等
// 接入时只需新建对应 provider 文件并在此 install 即可。
installTabdocDirtyProvider()

// ─── 虚拟系统标签 handler ────────────────────────────────────────
// 它们对应的 ContextItem 不来自 useSpaceContextTabsStore（不持久化），
// 而是 SpaceContextContainer 在渲染层把虚拟 item 拼到 orderedItems 最前面。
// 注册入口放在这里而非 ./handlers/ 自动扫描目录，避免被 apphome / quickAction
// / 全局搜索等 handler 遍历器误识别为常规 App。
registerDesktopTabHandler(contextRegistry)

// ─── Runtime registration for embeddedWeb apps ──────────────────

/**
 * 为没有手写 handler 的 embeddedWeb app 注册通用 ContextTypeHandler + HomeSectionHandler。
 * 由 useSpaceApps 的 loadSpaceApps 成功后调用。
 *
 * 幂等：已注册的 appId 会被跳过。
 */
export function registerGenericEmbeddedWebHandlers(
  apps: Array<{
    id: string
    name: string
    ui_runtime?: string
    context_type?: string | null
    embedded_web?: { baseUrl: string; urlPatterns?: string[]; sessionMode?: string } | null
    context_url_field?: string
  }>,
): void {
  for (const app of apps) {
    if (app.ui_runtime !== 'embeddedWeb' || !app.embedded_web?.baseUrl) continue
    if (contextRegistry.getHandlerByAppId(app.id)) continue

    const handler = createGenericEmbeddedWebHandler(app as EmbeddedWebAppSpec)
    contextRegistry.register(handler)

    if (!homeSectionRegistry.has(app.id)) {
      homeSectionRegistry.register(createEmbeddedWebHomeSection(app.id))
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────
export { contextRegistry }

export type {
  ContextItem, ContextItemType, ContextTabKey, ContextDragPayload,
  ContextTypeHandler, HomeSectionHandler,
  HomeSectionBaseProps, HomeSectionTableProps, HomeSectionProps,
  ResolveTabContext, ContainerContext,
  DispatchCloseResult, DispatchCloseSnapshot, DispatchCloseSnapshotProvider,
} from './types'
export { ContextRegistry } from './ContextRegistry'
export { HomeSectionRegistry } from './HomeSectionRegistry'
