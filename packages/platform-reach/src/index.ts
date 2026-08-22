/**
 * @tabtin/platform-reach
 *
 * 平台化内容获取：平台适配 + 运行时路由 + 优雅降级：
 * 用 TabTin 自有浏览器栈实现——适配器通过 `BrowserPrimitives` 端口驱动，宿主把端口
 * 接到 `browser-core`。本包 electron-free、可单测。
 *
 * 设计与决策：docs/agent/tabweb-platform-reach-design.md
 */

// ========== 归一化领域类型 ==========
export type {
  Verb,
  AuthLevel,
  AuthContext,
  RiskLevel,
  MediaRef,
  NormalizedComment,
  NormalizedItem,
} from './types'
export { makeItem } from './types'

// ========== 浏览器驱动端口 ==========
export type {
  BrowserPrimitives,
  OpenInput,
  OpenResult,
  NetworkCaptureEntry,
  CaptureNetworkInput,
  WaitForInput,
} from './primitives'

// ========== 适配器契约 ==========
export type {
  PlatformAdapter,
  RunContext,
  VerbArgs,
  VerbHandler,
  SessionSpec,
  SearchConstraints,
} from './adapter'
export { EMPTY_SEARCH_CONSTRAINTS, resolveSearchConstraints } from './adapter'

// ========== 注册表 ==========
export { AdapterRegistry, hostnameOf, hostMatchesDomain } from './registry'

// ========== 选路 / doctor ==========
export { selectBackend, describeChoice } from './doctor'
export type { Runtime, PlatformProbe, BackendChoice } from './doctor'

// ========== 选路闸门（用户约束 vs searchConstraints）==========
export {
  decideSearchRouting,
  unmatchedSearchConstraints,
  normalizeSortKey,
} from './routing-gate'
export type { RequestedSearchConstraint, SearchRoutingDecision } from './routing-gate'

// ========== 内置适配器 ==========
export { xiaohongshuAdapter } from './adapters/xiaohongshu'
export { bilibiliAdapter } from './adapters/bilibili'
export { douyinAdapter } from './adapters/douyin'
export { taobaoAdapter, tmallAdapter, jdAdapter } from './adapters/ecommerce'
export { tonghuashunAdapter, eastmoneyAdapter } from './adapters/finance'

export {
  parseXhsSearchFeed,
  parseXhsComments,
  parseNoteCard,
  parseNoteDetailState,
  parseCount,
  buildNoteUrl,
  isSignedNoteUrl,
  extractNoteId,
} from './adapters/xiaohongshu-parse'
export {
  parseBilibiliSearch,
  parseBilibiliView,
  extractBvid,
  isBilibiliVideoUrl,
} from './adapters/bilibili-parse'
export {
  parseDouyinSearch,
  parseDouyinDetail,
  parseDouyinComments,
  parseDouyinDomCards,
  detectDouyinSearchNil,
  splitDouyinStreamFrames,
  extractAwemeId,
  isDouyinVideoUrl,
  buildVideoUrl,
} from './adapters/douyin-parse'
export { parseEcommerceSearch, parseEcommerceDetail } from './adapters/ecommerce-parse'
export {
  buildTaobaoApplySortExpr,
  buildTaobaoSearchUrl,
  taobaoSearchQueryFromArgs,
  mapTaobaoSortToUrl,
  TAOBAO_SEARCH_CONSTRAINTS,
} from './adapters/taobao-query'
export type { TaobaoSearchQuery } from './adapters/taobao-query'
export {
  buildJdSearchUrl,
  jdSearchQueryFromArgs,
  mapJdSortToPsort,
  JD_SEARCH_CONSTRAINTS,
} from './adapters/jd-query'
export type { JdSearchQuery } from './adapters/jd-query'
export {
  parseFinanceSearch,
  parseFinanceDetail,
  parseTonghuashunIwencai,
  parseIwencaiSseEvents,
  buildTonghuashunResultUrl,
} from './adapters/finance-parse'

import { AdapterRegistry } from './registry'
import { xiaohongshuAdapter } from './adapters/xiaohongshu'
import { bilibiliAdapter } from './adapters/bilibili'
import { douyinAdapter } from './adapters/douyin'
import { taobaoAdapter, tmallAdapter, jdAdapter } from './adapters/ecommerce'
import { tonghuashunAdapter, eastmoneyAdapter } from './adapters/finance'

/** 内置平台 id 列表（与 createDefaultRegistry 同步，供 SKILL / doctor 展示）。 */
export const BUILTIN_PLATFORM_IDS = [
  'xiaohongshu',
  'bilibili',
  'douyin',
  'taobao',
  'tmall',
  'jd',
  'tonghuashun',
  'eastmoney',
] as const

/** 建一个装好内置适配器的注册表。宿主启动时调用一次。 */
export function createDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry()
  for (const adapter of [
    xiaohongshuAdapter,
    bilibiliAdapter,
    douyinAdapter,
    taobaoAdapter,
    tmallAdapter,
    jdAdapter,
    tonghuashunAdapter,
    eastmoneyAdapter,
  ]) {
    registry.register(adapter)
  }
  return registry
}
