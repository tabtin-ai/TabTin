/**
 * resourceRouter — renderer 侧 ResourceRouter 单例 + 接入 W2 协议骨架
 *
 * 把 `@tabtin/resource-router` 的核心 ResourceRouter / Registry 与 renderer 内
 * 真实运行时（contextRegistry / useSpaceContextTabsStore / window.tabtin.openExternal）
 * 接通，对外仅暴露：
 *   - `resourceRouter`     — 单例实例，chat MarkdownRenderer / 右键菜单 / open_in_space
 *                            等所有「在 Space 内打开」入口共用
 *   - `resourceRouterRegistry` — 倒排索引，registry/index.ts 启动期自动注册时使用
 *
 * 依赖注入决策（RFC §9 ContextRegistry 薄包装层 + harness §1 D1）：
 *   - ContextRegistryAdapter 直接读 contextRegistry，不另起一套 lookup
 *   - openResourceTab 直接走 useSpaceContextTabsStore.openResourceTab，
 *     不再"if type==='X' 分支调"——分支化是 D1 哲学反例
 *   - shellOpenExternal 走 preload `window.tabtin.openExternal`（IPC API 保留，
 *     仅协议白名单删；详见 `apps/.../main/file-system/ipc.ts:shell:openExternal`）
 *   - preferenceStore 由 W4 wireResourceRouter() 注入 useResourceOpenPreferences
 *     zustand store 的 adapter（D2 第 1 层 user_pref + 第 2 层 session_override 数据源）
 *   - emitEvent 暂用 noop（W7 真接 telemetry 后端通路时替换）
 *
 * 不直接 import contextRegistry — 避免和 registry/index.ts 互导致循环。改用
 * 函数闭包注入：renderer 启动期由 `wireResourceRouter()` 一次性绑定。
 */

import { ResourceRouter, ResourceRouterRegistry } from '@tabtin/resource-router'
import { createLogger } from '@/utils/logger'
import type {
  ContextRegistryAdapter,
  LocalFileResourceResolver,
  OpenResourceTabFn,
  OpenResourceTabParams,
  ResourceOpenEvent,
  ResourceOpenPreferenceStore,
  ResourcePointerType,
} from '@tabtin/resource-router'

const log = createLogger('resourceRouter')
let recordFocusRequestSequence = 0

function resolveFirstRecordId(meta: Record<string, unknown> | undefined): string | null {
  const raw = meta?.recordIds ?? meta?.record_ids
  const candidate = Array.isArray(raw) ? raw[0] : raw
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
}

/**
 * 将表格资源链接中的记录 id 收敛为一次性的 UI 聚焦意图。
 * requestId 保证重复点击同一条链接时，已经打开的表格也会重新执行定位。
 */
export function enrichTabdataRecordFocusOpenParams(
  params: OpenResourceTabParams,
): OpenResourceTabParams {
  if (params.type !== 'table' && params.type !== 'tabdata') return params
  const recordId = resolveFirstRecordId(params.meta)
  if (!recordId) return params

  recordFocusRequestSequence += 1
  return {
    ...params,
    meta: {
      ...params.meta,
      recordFocusRecordId: recordId,
      recordFocusRequestId: `record-focus:${Date.now()}:${recordFocusRequestSequence}`,
    },
  }
}

// ─── 单例 ─────────────────────────────────────────────────────────

export const resourceRouterRegistry = new ResourceRouterRegistry()

/**
 * Adapter 默认实现 = 永远找不到 handler。renderer 启动期 `wireResourceRouter()`
 * 注入真实实现替换。这个默认值仅用于：
 *   1. 单元测试可不调 wire 直接构造 mock pointer 测 router
 *   2. registry/index.ts 启动早于 contextRegistry 初始化时不抛错（实际不会发生）
 */
let contextRegistryAdapterImpl: ContextRegistryAdapter = {
  hasHandlerByAppId: () => false,
  getAppIdsForType: () => [],
}

let openResourceTabImpl: OpenResourceTabFn = () => {
  log.warn('openResourceTab not wired yet — call wireResourceRouter() first')
}

let shellOpenExternalImpl: (url: string) => Promise<void> = async (url) => {
  log.warn('shellOpenExternal not wired yet — would have opened:', url)
}

let localFileResolverImpl: LocalFileResourceResolver | undefined

let preferenceStoreImpl: ResourceOpenPreferenceStore = {
  get: () => undefined,
  set: () => {},
  unset: () => {},
  // W4：默认 stub 必须实现 ResourceOpenPreferenceStore 全字段，否则 proxy
  // 转发时 fallback 到 undefined 时不报错但语义被吃掉（见 review C P0-1）
  getSessionOverride: () => undefined,
}

let emitEventImpl: ((event: ResourceOpenEvent) => void) | undefined

const adapter: ContextRegistryAdapter = {
  hasHandlerByAppId: (appId) => contextRegistryAdapterImpl.hasHandlerByAppId(appId),
  getAppIdsForType: (type: ResourcePointerType) => contextRegistryAdapterImpl.getAppIdsForType(type),
}

/**
 * Proxy 把 preferenceStore 接口的全部方法转发到 preferenceStoreImpl 当前值。
 *
 * **任何 ResourceOpenPreferenceStore 接口扩展都必须同步加在这里**——否则
 * 即使 wireResourceRouter 注入了完整 adapter，router 拿到的仍是这个 proxy；
 * proxy 漏字段时 router 端 `optional?.()` 静默返回 undefined，不报错但语义
 * 被丢——如 review A/B/C 三方 P0：W4 第一版漏 getSessionOverride 让 D2
 * 第 2 层在 chat 左键点击主路径完全失效。
 *
 * 加新方法时同步：
 *   1. 这里转发（一行）
 *   2. preferenceStoreImpl 默认 stub 加新字段（防御 wireResourceRouter 没调时不挂）
 *   3. resourceRouter.integration.test.ts 加端到端回归（防止下次再丢）
 */
const preferenceStoreProxy: ResourceOpenPreferenceStore = {
  get: (key) => preferenceStoreImpl.get(key),
  set: (key, val) => preferenceStoreImpl.set(key, val),
  unset: (key) => preferenceStoreImpl.unset(key),
  getSessionOverride: (key) => preferenceStoreImpl.getSessionOverride?.(key),
}

export const resourceRouter = new ResourceRouter(
  {
    contextRegistry: adapter,
    preferenceStore: preferenceStoreProxy,
    openResourceTab: (spaceId, params) =>
      openResourceTabImpl(spaceId, enrichTabdataRecordFocusOpenParams(params)),
    shellOpenExternal: (url) => shellOpenExternalImpl(url),
    localFileResolver: (ctx) => localFileResolverImpl?.(ctx) ?? null,
    emitEvent: (event) => emitEventImpl?.(event),
    client: 'electron',
  },
  resourceRouterRegistry,
)

// ─── 行业格式 type 适配（D1 下沉，RFC §1.4 行业格式落点）──────────────
//
// ResourceRouter.derivePointerOpenParams 对行业格式（scheme=https / file /
// mailto / ...）传 type=pointer.scheme，但 ContextRegistry 注册的
// ContextItemType 是 'tabweb' / 'tabfolder' / 'tabmail'——两者不直接对齐。
//
// 本 helper 走"先按 ContextRefType / backendTypeMap 反查；再按 scheme 走
// resourceRouterRegistry.lookupByScheme 反查 carrier appId 取 handler.type"
// 两级 fallback。
//
// 抽成纯函数便于单元测试覆盖（renderer 启动期 wireResourceRouter 也走它）。

export interface AdaptIndustryParamsDeps {
  /** 已注册的 ContextItemType handler 反查（含 backendTypeMap 自动归一化） */
  resolveHandlerByType: (type: string) => { type: string; appId?: string } | undefined
  /** 按 manifest opens.schemes 反查所有 carrier 候选（priority 降序） */
  lookupCarriersByScheme: (schemeWithColon: string) => readonly { appId: string }[]
  /** 已注册的 ContextItemType handler 反查（按 appId） */
  resolveHandlerByAppId: (appId: string) => { type: string } | undefined
}

export function adaptIndustryParams(
  params: Parameters<OpenResourceTabFn>[1],
  deps: AdaptIndustryParamsDeps,
): Parameters<OpenResourceTabFn>[1] {
  // 自有格式：type 可能是 backend alias（如 'document' / 'table'），ContextRegistry
  // 通过 backendTypeMap 反查到 handler。**必须用 handler.type（frontend type，如
  // 'tabdoc' / 'tabdata'）归一化**——否则 context tab 会用 backend type 建 tabKey
  // （'document:<id>'），而 WorkbenchRestoreCoordinator 的资源存在性校验按 frontend
  // type 索引（membership.byType 的 key 是 'tabdoc'），key 对不上 → 存在的资源被
  // 误判为 stale 自清，表现为「点击产物/资源链接第一次打不开、active 跳回 home tab」。
  const ownHandler = deps.resolveHandlerByType(params.type)
  if (ownHandler) {
    return ownHandler.type !== params.type ? { ...params, type: ownHandler.type } : params
  }

  // 行业格式：按 scheme 反查 carrier
  const schemeKey = params.type.endsWith(':') ? params.type : `${params.type}:`
  const carriers = deps.lookupCarriersByScheme(schemeKey)
  const carrier = carriers[0]
  if (!carrier) return params

  const carrierHandler = deps.resolveHandlerByAppId(carrier.appId)
  if (!carrierHandler) return params

  return { ...params, type: carrierHandler.type }
}

/**
 * Tracker 详情页硬依赖 meta.taskId（见 tabtrackerHandler.renderPane）。
 * ResourceRouter 通用落地只透传 pointer，不会写 taskId——对齐通知/侧栏契约，
 * 在打开前把 id 补进 meta，否则会落到列表面板而非详情。
 */
export function enrichTabtrackerOpenParams(
  params: Parameters<OpenResourceTabFn>[1],
  spaceId: string,
): Parameters<OpenResourceTabFn>[1] {
  if (params.type !== 'tabtracker') return params

  const existingMeta = (params.meta ?? {}) as Record<string, unknown>
  const taskId =
    (typeof existingMeta.taskId === 'string' && existingMeta.taskId) ||
    (typeof existingMeta.eventId === 'string' && existingMeta.eventId) ||
    params.id
  const resolvedSpaceId =
    (typeof existingMeta.spaceId === 'string' && existingMeta.spaceId) || spaceId

  return {
    ...params,
    meta: {
      ...existingMeta,
      spaceId: resolvedSpaceId,
      taskId,
    },
  }
}

// ─── Wire（renderer 启动期一次性绑定） ──────────────────────────────

export interface WireOptions {
  contextRegistry: ContextRegistryAdapter
  openResourceTab: OpenResourceTabFn
  shellOpenExternal: (url: string) => Promise<void>
  localFileResolver?: LocalFileResourceResolver
  preferenceStore?: ResourceOpenPreferenceStore
  emitEvent?: (event: ResourceOpenEvent) => void
}

/**
 * 把真实运行时依赖一次性注入到单例里。`registry/index.ts` 启动期调用。
 * 重复 wire 安全（覆盖语义），便于 hot-reload。
 */
export function wireResourceRouter(opts: WireOptions): void {
  contextRegistryAdapterImpl = opts.contextRegistry
  openResourceTabImpl = opts.openResourceTab
  shellOpenExternalImpl = opts.shellOpenExternal
  localFileResolverImpl = opts.localFileResolver
  if (opts.preferenceStore) preferenceStoreImpl = opts.preferenceStore
  if (opts.emitEvent) emitEventImpl = opts.emitEvent
}
