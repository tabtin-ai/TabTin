/**
 * 京东 PC 搜索 URL 查询参数（reach search 扩展）。
 * live 2026-07：销量序打开 Search?psort=3 时，searchWare body 含 `"psort":"3"`。
 */
import { normalizeSearchQuery } from './ecommerce-parse'
import { normalizeSortKey } from '../routing-gate'

export type JdSearchQuery = {
  query: string
  /** 规范排序：sale / price_asc / price_desc / latest / default */
  sort?: string
  page?: number
}

/** 京东适配器声明的 searchConstraints。 */
export const JD_SEARCH_CONSTRAINTS = {
  sorts: ['sale', 'price_asc', 'price_desc', 'latest', 'default'],
  filters: [] as string[],
} as const

/**
 * 现网 URL `psort`（PC 搜）：
 * - 综合：省略 / 空
 * - 销量：3（live 核实）
 * - 价格：2（升/降由页面二次点选；URL 侧先落到价格簇）
 * - 评论：4
 * - 新品：5
 */
const SORT_TO_PSORT: Record<string, string | undefined> = {
  sale: '3',
  price_asc: '2',
  price_desc: '2',
  latest: '5',
  default: undefined,
}

export function mapJdSortToPsort(sort: string | undefined): string | undefined {
  if (!sort) return undefined
  const key = normalizeSortKey(sort)
  if (key === 'default' || key === '') return undefined
  return SORT_TO_PSORT[key]
}

export function buildJdSearchUrl(input: JdSearchQuery): string {
  const u = new URL('https://search.jd.com/Search')
  u.searchParams.set('keyword', normalizeSearchQuery(input.query))
  const psort = mapJdSortToPsort(input.sort)
  if (psort) u.searchParams.set('psort', psort)
  const page = input.page
  if (page != null && Number.isFinite(page) && page >= 2) {
    u.searchParams.set('page', String(Math.floor(page)))
  }
  return u.toString()
}

export function jdSearchQueryFromArgs(args: {
  query?: string
  sort?: unknown
  page?: unknown
}): JdSearchQuery {
  const query = typeof args.query === 'string' ? args.query : ''
  const sort = typeof args.sort === 'string' ? args.sort : undefined
  const pageRaw = args.page
  const page =
    typeof pageRaw === 'number'
      ? pageRaw
      : typeof pageRaw === 'string' && pageRaw.trim()
        ? Number(pageRaw)
        : undefined
  return {
    query,
    ...(sort ? { sort } : {}),
    ...(page != null && Number.isFinite(page) ? { page } : {}),
  }
}
