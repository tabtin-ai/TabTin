/**
 * 淘宝 PC 搜索 URL 查询参数映射（reach search 扩展）。
 * 规范键（Agent / CLI）→ s.taobao.com 现网参数；未识别的键忽略不拼。
 */
import { normalizeSearchQuery } from './ecommerce-parse'
import { normalizeSortKey } from '../routing-gate'

export type TaobaoSearchQuery = {
  query: string
  /** 规范排序：sale / price_asc / price_desc / latest / default */
  sort?: string
  /** 最低价 */
  minPrice?: number
  /** 最高价 */
  maxPrice?: number
  /** 页码，从 1 起 */
  page?: number
  /**
   * 规范筛选键，可多选：
   * - tmall：仅天猫（tab=mall）
   * - free_shipping：包邮（filter 含 myf）
   */
  filters?: string[]
}

/** 淘宝适配器声明的 searchConstraints（与 URL 映射对齐）。 */
export const TAOBAO_SEARCH_CONSTRAINTS = {
  sorts: ['sale', 'price_asc', 'price_desc', 'latest', 'default'],
  filters: ['tmall', 'free_shipping'],
} as const

/**
 * 现网 `__last_search_params.sort` 取值（2026-07 live 校准）：
 * - 综合 `_coefp` · 销量 `_sale` · 价格升序 `bid` · 价格降序 `_bid`
 * URL 带 sort 冷启动常被 SPA 忽略，真正生效靠页内点选（见 applyTaobaoSortInPage）。
 */
const SORT_TO_RUNTIME: Record<string, string | undefined> = {
  sale: '_sale',
  price_asc: 'bid',
  price_desc: '_bid',
  latest: 'oldstart',
  default: undefined,
}

function normalizeFilterKey(raw: string): string {
  const t = raw.trim().toLowerCase()
  const map: Record<string, string> = {
    tmall: 'tmall',
    mall: 'tmall',
    天猫: 'tmall',
    仅天猫: 'tmall',
    free_shipping: 'free_shipping',
    freeshipping: 'free_shipping',
    myf: 'free_shipping',
    包邮: 'free_shipping',
  }
  return map[t] ?? map[raw.trim()] ?? t
}

/** 规范排序 → 现网 runtime/URL sort 值。 */
export function mapTaobaoSortToUrl(sort: string | undefined): string | undefined {
  if (!sort) return undefined
  const key = normalizeSortKey(sort)
  if (key === 'default' || key === '') return undefined
  return SORT_TO_RUNTIME[key]
}

/** @deprecated 与 mapTaobaoSortToUrl 相同，保留旧名。 */
export const mapTaobaoSortToRuntime = mapTaobaoSortToUrl

/**
 * 页内应用排序的 eval 表达式。
 * 成功返回 `{ok:true,sort}`；未就绪必须返回 `false`（勿用 null——eval 包装对象会被 pollEval 当成已成功）。
 *
 * live 校准：URL `sort=` 冷启动常被忽略；价格浮层默认 `visible:false` 不挂 DOM，
 * `.click()` / querySelector(priceTag) 会失败。应对 React props 树里 key=`bid`/`_bid`
 * 的 onClick 直调（销量仍走 Tab 的 React onClick）。
 */
export function buildTaobaoApplySortExpr(runtimeSort: string): string {
  const want = JSON.stringify(runtimeSort)
  return (
    `(function(){try{` +
    `var want=${want};` +
    `var cur=(window.__last_search_params&&window.__last_search_params.sort)||'';` +
    `function activeLabels(){` +
    `return [].slice.call(document.querySelectorAll('.next-tabs-tab')).filter(function(e){` +
    `return /active|Active|selected|Selected/.test(e.className||'');` +
    `}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').trim();});}` +
    // 价格序：params.sort 已是目标但 UI 仍只亮「综合」→ 视为未生效，继续点选
    `if(cur===want){` +
    `if((want==='bid'||want==='_bid')&&activeLabels().indexOf('价格')<0){/* fallthrough */}` +
    `else return {ok:true,sort:cur,already:true};` +
    `}` +
    `function synthClick(){return {nativeEvent:new MouseEvent('click',{bubbles:true}),` +
    `preventDefault:function(){},stopPropagation:function(){},persist:function(){},type:'click'};}` +
    `function reactTabClick(label){` +
    `var tab=[].slice.call(document.querySelectorAll('.next-tabs-tab')).find(function(e){` +
    `return ((e.innerText||'').replace(/\\s+/g,' ').trim()).indexOf(label)===0;});` +
    `if(!tab)return false;` +
    `var pk=Object.keys(tab).find(function(k){return k.indexOf('__reactProps$')===0;});` +
    `var props=pk?tab[pk]:null;` +
    `if(props&&typeof props.onClick==='function'){props.onClick(synthClick());return true;}` +
    `tab.click();return true;}` +
    `function findPropOnClick(node,key,depth){` +
    `if(!node||depth>40)return null;` +
    `if(node.key===key&&node.props&&typeof node.props.onClick==='function')return node.props.onClick;` +
    `var ch=node.props&&node.props.children;` +
    `if(Array.isArray(node)){for(var i=0;i<node.length;i++){var a=findPropOnClick(node[i],key,depth+1);if(a)return a;}}` +
    `if(Array.isArray(ch)){for(var j=0;j<ch.length;j++){var b=findPropOnClick(ch[j],key,depth+1);if(b)return b;}}` +
    `else if(ch&&typeof ch==='object')return findPropOnClick(ch,key,depth+1);` +
    `return null;}` +
    `function reactPriceSort(key){` +
    `var rootEl=document.getElementById('sortBarWrap_left')||document.querySelector('[class*="sortBarWrapTop"]');` +
    `if(!rootEl)return false;` +
    `var fk=Object.keys(rootEl).find(function(k){return k.indexOf('__reactFiber$')===0;});` +
    `var f=fk?rootEl[fk]:null;var onClick=null;var climbed=0;` +
    `while(f&&climbed++<24){` +
    `onClick=findPropOnClick({props:f.memoizedProps,key:null},key,0)||` +
    `findPropOnClick(f.memoizedProps&&f.memoizedProps.children,key,0);` +
    `if(onClick)break;f=f.return;` +
    `}` +
    `if(typeof onClick!=='function')return false;` +
    `onClick(synthClick());return true;` +
    `}` +
    `var acted=false;` +
    `if(want==='_sale'){acted=reactTabClick('销量');}` +
    `else if(want==='bid'){acted=reactPriceSort('bid');}` +
    `else if(want==='_bid'){acted=reactPriceSort('_bid');}` +
    `else{return false;}` +
    `cur=(window.__last_search_params&&window.__last_search_params.sort)||'';` +
    `if(cur===want)return {ok:true,sort:cur,acted:acted};` +
    `return false;` +
    `}catch(e){return false;}})()`
  )
}

/**
 * 拼淘宝搜索 URL。page≥2 时带 page；价区用 start_price/end_price；
 * 天猫用 tab=mall；包邮用 filter=myf（可与其它 filter 逗号拼接预留）。
 */
export function buildTaobaoSearchUrl(input: TaobaoSearchQuery): string {
  const q = normalizeSearchQuery(input.query)
  const u = new URL('https://s.taobao.com/search')
  u.searchParams.set('q', q)

  const sortUrl = mapTaobaoSortToUrl(input.sort)
  if (sortUrl) u.searchParams.set('sort', sortUrl)

  if (input.minPrice != null && Number.isFinite(input.minPrice) && input.minPrice >= 0) {
    u.searchParams.set('start_price', String(input.minPrice))
  }
  if (input.maxPrice != null && Number.isFinite(input.maxPrice) && input.maxPrice >= 0) {
    u.searchParams.set('end_price', String(input.maxPrice))
  }

  const page = input.page
  if (page != null && Number.isFinite(page) && page >= 2) {
    u.searchParams.set('page', String(Math.floor(page)))
  }

  const filters = (input.filters ?? []).map(normalizeFilterKey)
  const wantTmall = filters.includes('tmall')
  const wantShip = filters.includes('free_shipping')
  if (wantTmall) u.searchParams.set('tab', 'mall')
  else u.searchParams.set('tab', 'all')

  if (wantShip) {
    // live 常用 myf=包邮；与历史 filter=mall,myf 写法对齐
    u.searchParams.set('filter', 'myf')
  }

  return u.toString()
}

/** 从 VerbArgs 宽松字段抽出淘宝查询（非法数字忽略）。 */
export function taobaoSearchQueryFromArgs(args: {
  query?: string
  sort?: unknown
  minPrice?: unknown
  maxPrice?: unknown
  min_price?: unknown
  max_price?: unknown
  page?: unknown
  filter?: unknown
  filters?: unknown
}): TaobaoSearchQuery {
  const query = typeof args.query === 'string' ? args.query : ''
  const sort = typeof args.sort === 'string' ? args.sort : undefined
  const minRaw = args.minPrice ?? args.min_price
  const maxRaw = args.maxPrice ?? args.max_price
  const minPrice =
    typeof minRaw === 'number'
      ? minRaw
      : typeof minRaw === 'string' && minRaw.trim()
        ? Number(minRaw)
        : undefined
  const maxPrice =
    typeof maxRaw === 'number'
      ? maxRaw
      : typeof maxRaw === 'string' && maxRaw.trim()
        ? Number(maxRaw)
        : undefined
  const pageRaw = args.page
  const page =
    typeof pageRaw === 'number'
      ? pageRaw
      : typeof pageRaw === 'string' && pageRaw.trim()
        ? Number(pageRaw)
        : undefined

  const filters: string[] = []
  const pushFilter = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) {
      for (const part of v.split(/[,|]/)) {
        const p = part.trim()
        if (p) filters.push(p)
      }
    } else if (Array.isArray(v)) {
      for (const x of v) pushFilter(x)
    }
  }
  pushFilter(args.filter)
  pushFilter(args.filters)

  return {
    query,
    ...(sort ? { sort } : {}),
    ...(minPrice != null && Number.isFinite(minPrice) ? { minPrice } : {}),
    ...(maxPrice != null && Number.isFinite(maxPrice) ? { maxPrice } : {}),
    ...(page != null && Number.isFinite(page) ? { page } : {}),
    ...(filters.length ? { filters } : {}),
  }
}
