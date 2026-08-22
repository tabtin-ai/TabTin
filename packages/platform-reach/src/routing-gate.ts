/**
 * 选路闸门：用户附加约束 vs 适配器 searchConstraints 对表。
 * Agent / doctor 共用——有缺口则禁止再调 reach search 交差。
 */
import {
  EMPTY_SEARCH_CONSTRAINTS,
  type SearchConstraints,
  resolveSearchConstraints,
  type PlatformAdapter,
} from './adapter'

/** 从用户话术归一化后的约束（平台无关键）。 */
export type RequestedSearchConstraint =
  | { kind: 'sort'; key: string }
  | { kind: 'filter'; key: string }

const SORT_ALIASES: Record<string, string> = {
  sale: 'sale',
  sales: 'sale',
  'sale-desc': 'sale',
  sale_desc: 'sale',
  销量: 'sale',
  按销量: 'sale',
  销量优先: 'sale',
  price: 'price_asc',
  price_asc: 'price_asc',
  'price-asc': 'price_asc',
  价格升序: 'price_asc',
  从低到高: 'price_asc',
  price_desc: 'price_desc',
  'price-desc': 'price_desc',
  价格降序: 'price_desc',
  从高到低: 'price_desc',
  latest: 'latest',
  newest: 'latest',
  最新: 'latest',
  最新发布: 'latest',
  default: 'default',
  综合: 'default',
  默认: 'default',
}

/**
 * 把用户/Agent 提到的排序说法收成规范键；认不出则原样小写返回（便于对表失败）。
 */
export function normalizeSortKey(raw: string): string {
  const t = raw.trim().toLowerCase()
  if (!t) return t
  return SORT_ALIASES[t] ?? SORT_ALIASES[raw.trim()] ?? t
}

export function unmatchedSearchConstraints(
  declared: SearchConstraints,
  requested: RequestedSearchConstraint[],
): RequestedSearchConstraint[] {
  const sorts = new Set(declared.sorts.map((s) => normalizeSortKey(s)))
  const filters = new Set(declared.filters.map((f) => f.trim().toLowerCase()))
  const miss: RequestedSearchConstraint[] = []
  for (const req of requested) {
    if (req.kind === 'sort') {
      const key = normalizeSortKey(req.key)
      // 默认/综合 = 无附加约束，不算缺口
      if (key === 'default' || key === '') continue
      if (!sorts.has(key)) miss.push({ kind: 'sort', key })
    } else {
      const key = req.key.trim().toLowerCase()
      if (!key) continue
      if (!filters.has(key)) miss.push({ kind: 'filter', key })
    }
  }
  return miss
}

export type SearchRoutingDecision =
  | { allowReach: true; searchConstraints: SearchConstraints }
  | {
      allowReach: false
      searchConstraints: SearchConstraints
      unmatched: RequestedSearchConstraint[]
      hint: string
    }

/**
 * 对表：有未覆盖约束 → 禁止 reach search，改 browser / collect。
 */
export function decideSearchRouting(
  adapter: Pick<PlatformAdapter, 'searchConstraints'> | undefined,
  requested: RequestedSearchConstraint[],
): SearchRoutingDecision {
  const searchConstraints = adapter
    ? resolveSearchConstraints(adapter)
    : { ...EMPTY_SEARCH_CONSTRAINTS }
  const unmatched = unmatchedSearchConstraints(searchConstraints, requested)
  if (unmatched.length === 0) {
    return { allowReach: true, searchConstraints }
  }
  const parts = unmatched.map((u) =>
    u.kind === 'sort' ? `排序=${u.key}` : `筛选=${u.key}`,
  )
  return {
    allowReach: false,
    searchConstraints,
    unmatched,
    hint:
      `reach search 不支持：${parts.join('、')}。` +
      `禁止再用默认序 reach 交差；改用 browser 打开带对应参数的页面（如淘宝 sort=sale-desc）` +
      `或 skills_read("app:tabweb/browser-collect") / browser-operator。`,
  }
}
