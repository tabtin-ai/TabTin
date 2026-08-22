/**
 * PlatformAdapter — 平台适配器契约
 *
 * 接第二个平台 = 填一个 PlatformAdapter，框架代码不动（registry / doctor / CLI 都不改）。
 * 平台差异全部关进这里：域名、鉴权级、支持的动词、每个动词的抽取策略/风险/限频/执行。
 */
import type { BrowserPrimitives } from './primitives'
import type { AuthContext, AuthLevel, NormalizedItem, RiskLevel, Verb } from './types'

/** 一次动词执行的运行上下文。 */
export interface RunContext {
  /** 浏览器驱动端口（宿主注入，接 browser-core）。 */
  browser: BrowserPrimitives
  /** 本次用匿名还是登录态——由 doctor 选路 + 产品闸门决定，透传给适配器写进结果。 */
  authContext: AuthContext
  /** 复用的 tab（同域续会话）。适配器 open 时优先带上。 */
  tabId?: string
  /** 取消信号（用户中止 / 超时）。 */
  signal?: AbortSignal
  /** 结构化日志，可选。 */
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

/** 动词入参。宽松结构，具体动词各取所需。 */
export interface VerbArgs {
  /** search 的关键词。 */
  query?: string
  /** read / comments 的目标——**必须是带签名的完整 URL**（见各平台 resolve）。 */
  url?: string
  /** 可选目标句柄（预留）。 */
  target?: string
  /** 结果上限。 */
  limit?: number
  [k: string]: unknown
}

export interface VerbHandler {
  /**
   * 主力取数手段，用于可观测与选路提示。
   * - network-intercept：拦 XHR/fetch 响应体（如小红书 search/comments）
   * - page-state：读服务端直出的页面状态（如小红书详情 __INITIAL_STATE__，无详情 XHR）
   * - dom-snapshot：读渲染后 DOM
   * - public-api：直连平台公开 API
   */
  extraction: 'network-intercept' | 'page-state' | 'dom-snapshot' | 'public-api'
  /** 只读还是需人确认的写操作。 */
  risk: RiskLevel
  run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]>
}

export interface SessionSpec {
  /** 探当前会话是否已登录目标平台（读登录指示元素 / cookie 存在性）。 */
  probeLoggedIn(ctx: RunContext): Promise<boolean>
  /** 撞登录墙时给用户打开的登录页。 */
  loginUrl: string
  /** 撞登录墙时给用户看的一句话引导。 */
  loginHint: string
}

/**
 * search 动词对「用户附加约束」的能力声明（选路闸门用）。
 * 缺省 / 空数组 = 仅站点默认结果序，不支持排序或筛选参数。
 */
export interface SearchConstraints {
  /** 支持的排序键，如 sale / price_asc / latest；空 = 仅默认序 */
  sorts: string[]
  /** 支持的筛选键，如 tmall_only / free_shipping；空 = 无筛选 */
  filters: string[]
}

export const EMPTY_SEARCH_CONSTRAINTS: SearchConstraints = {
  sorts: [],
  filters: [],
}

export function resolveSearchConstraints(
  adapter: Pick<PlatformAdapter, 'searchConstraints'> | undefined,
): SearchConstraints {
  const raw = adapter?.searchConstraints
  return {
    sorts: [...(raw?.sorts ?? [])],
    filters: [...(raw?.filters ?? [])],
  }
}

export interface PlatformAdapter {
  id: string
  domains: string[]
  authLevel: AuthLevel
  capabilities: Verb[]
  session: SessionSpec
  /**
   * search 支持的排序/筛选。未声明视为全空——用户要销量/最新等时禁止硬用 reach。
   */
  searchConstraints?: SearchConstraints
  /**
   * 签名/寻址流逃生口：裸 ID → 可回访的签名 URL。
   * 小红书在这实现 `xsec_token` 两跳约束（裸 ID 直接抛错，逼调用方先 search）。
   * 不需要签名换址的平台（帖子 ID 直读）可不实现。
   */
  resolve?(ctx: RunContext, rawId: string): Promise<string>
  verbs: Partial<Record<Verb, VerbHandler>>
}
