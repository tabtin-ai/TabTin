/**
 * 淘宝 / 天猫 / 京东适配器
 *
 * 淘宝 live（2026-07 Electron）：
 *  - 匿名：s.taobao.com 只出搜索壳，不发 `mtop.taobao.wsearch.h5search`；
 *    顶栏「亲，请登录」+ 无商品卡 → 抛登录墙（与抖音同款，勿静默空数组）。
 *  - 已登录：拦 wsearch XHR（itemsArray / nid），失败再刮 DOM 商品链。
 *  - search 支持 sort / 价区 / tab / 包邮等查询参数（见 taobao-query.ts）。
 *  - `--use-login` 仍受产品闸门约束；此处「登录」= 用户在 TabWeb 扫码后
 *    复用共享 cookie，不是 CLI 开登录态采集开关。
 *
 * 天猫 live（2026-07）：`list.tmall.com` 现网 302→淘宝登录跳，不能当搜索入口。
 * 改走与淘宝同一套 `s.taobao.com` + `tab=mall`，复用 DOM 优先 / 短 capture / 登录墙。
 * 京东 live（2026-07）：PC 搜已是 SPA，经典 #J_goodsList 失效；主搜
 * `api.m.jd.com` `functionId=pc_search_searchWare` → `data.wareList`；DOM 可用
 * 客服链 `chat.jd.com?...pid=` 兜底拿 sku。勿拼 enc=utf-8（导航策略拒）。
 */
import type { PlatformAdapter, RunContext, VerbArgs } from '../adapter'
import type { NormalizedItem } from '../types'
import { captureJson, delay, pollEval } from './_helpers'
import {
  extractTaobaoItemId,
  normalizeSearchQuery,
  parseEcommerceDetail,
  parseEcommerceDetailDom,
  parseEcommerceDomCards,
  parseEcommerceSearch,
} from './ecommerce-parse'
import {
  buildTaobaoApplySortExpr,
  buildTaobaoSearchUrl,
  mapTaobaoSortToUrl,
  TAOBAO_SEARCH_CONSTRAINTS,
  taobaoSearchQueryFromArgs,
} from './taobao-query'
import {
  buildJdSearchUrl,
  JD_SEARCH_CONSTRAINTS,
  jdSearchQueryFromArgs,
} from './jd-query'

/** DOM 优先后的兜底；勿再串行多 pattern 叠到 48s。 */
const CAPTURE_TIMEOUT_MS = 8_000

/** live：PC 搜索主接口；旧 searchdoor / recommend 作兼容。 */
const TAOBAO_SEARCH_API_PATTERNS = [
  'mtop.taobao.wsearch.h5search',
  'mtop.taobao.wsearch',
  'wsearch.h5search',
] as const

/**
 * 登录墙：顶栏「亲，请登录」且结果区没有任何商品链。
 * （仅「请登录」不够——已登录壳也会在未登录态常驻顶栏文案。）
 */
const TAOBAO_LOGIN_WALL_EXPR =
  `(function(){try{` +
  `var t=(document.body&&document.body.innerText)||'';` +
  `var hasLoginCue=t.indexOf('亲，请登录')>=0||t.indexOf('请登录后继续')>=0;` +
  `if(!hasLoginCue)return false;` +
  `var n=document.querySelectorAll('a[href*="item.taobao.com/item.htm"],a[href*="detail.tmall.com/item.htm"]').length;` +
  `return n===0;` +
  `}catch(e){return false;}})()`

/** DOM 商品卡：限定主列表 #content_items_wrapper，避免侧栏/推荐打乱序。 */
const TAOBAO_DOM_CARDS_EXPR =
  `(function(){try{` +
  `var root=document.querySelector('#content_items_wrapper')||document;` +
  `var out=[];var seen={};` +
  `root.querySelectorAll('a[href*="item.taobao.com/item.htm"],a[href*="detail.tmall.com/item.htm"]').forEach(function(a){` +
  `var href=a.href||a.getAttribute('href')||'';` +
  `if(!href||href.indexOf('javascript:')===0)return;` +
  `try{var u=new URL(href,location.href);href=u.href;}catch(e){return;}` +
  `var id=null;try{id=new URL(href).searchParams.get('id');}catch(e){}` +
  `if(!id||!/^\\d+$/.test(id)||seen[id])return;seen[id]=1;` +
  `var title=(a.getAttribute('title')||'').trim();` +
  `if(!title){var raw=(a.innerText||'').replace(/\\s+/g,' ').trim();var cut=raw.search(/[¥￥]|正在秒杀|人付款|补贴后/);title=(cut>0?raw.slice(0,cut):raw).trim();}` +
  `var price='';var pm=(a.innerText||'').match(/[¥￥]\\s*([\\d]+(?:\\.[\\d]+)?)/);if(pm)price=pm[1];` +
  `var sales='';var sm=(a.innerText||'').match(/(\\d+(?:\\.\\d+)?)\\s*万?\\s*人付款|(\\d+)\\+?人付款/);if(sm)sales=sm[0];` +
  `out.push({id:id,url:href,title:title?title.slice(0,200):undefined,price:price||undefined,sales:sales||undefined});` +
  `});` +
  `return out.length?JSON.stringify(out):null;` +
  `}catch(e){return null;}})()`

/**
 * 详情页 DOM 兜底（live：无 g_config / __ICE / ld+json）。
 * document.title + URL id + 正文首个 ¥ 价 + 店铺链。
 */
const TAOBAO_DETAIL_DOM_EXPR =
  `(function(){try{` +
  `var id=null;try{id=new URL(location.href).searchParams.get('id');}catch(e){}` +
  `var title=(document.title||'').replace(/\\s*[-_|]\\s*(淘宝网|天猫|Tmall)\\s*$/i,'').trim();` +
  `var price='';var t=(document.body&&document.body.innerText)||'';` +
  `var pm=t.match(/[¥￥]\\s*([\\d]+(?:\\.[\\d]+)?)/);if(pm)price=pm[1];` +
  `var nick='';` +
  `var shopAs=document.querySelectorAll('a[href*=".taobao.com/category"],a[href*="shop"][href*="taobao.com"]');` +
  `for(var i=0;i<shopAs.length;i++){` +
  `var n=(shopAs[i].textContent||'').replace(/\\s+/g,' ').trim();` +
  `if(!n||n.length<2||n.length>60)continue;` +
  `if(/开店|收藏|购物车|首页|帮助|客服进店|^进店$/.test(n))continue;` +
  `nick=n.slice(0,80);break;` +
  `}` +
  `if(!id&&!title)return null;` +
  `return JSON.stringify({id:id||undefined,title:title||undefined,price:price||undefined,nick:nick||undefined,url:location.href});` +
  `}catch(e){return null;}})()`

const gDataExpr =
  `(function(){try{if(window.g_config&&window.g_config.idata)return JSON.stringify(window.g_config.idata);if(window.__ICE_APP_CONTEXT__)return JSON.stringify(window.__ICE_APP_CONTEXT__);var m=document.querySelector('script[type="application/ld+json"]');return m?m.textContent:null;}catch(e){return null;}})()`

function buildTaobaoItemUrl(id: string): string {
  return `https://item.taobao.com/item.htm?id=${id}`
}

function buildTmallItemUrl(id: string): string {
  return `https://detail.tmall.com/item.htm?id=${id}`
}

const TMALL_LOGIN_HINT =
  '天猫搜索走淘宝 PC 综合搜的「天猫」tab（list.tmall.com 现网会 302 登录跳）。' +
  '请在 TabTin 浏览器淘宝/天猫标签扫码登录后重试；与淘宝同属阿里系会话。'

/**
 * 只做一轮短 capture。live 取证：串行 3×12s+3×4s=48s 全 miss 后 DOM 18ms 出货；
 * 禁止再烧满多 pattern 预算，否则 CLI 30s/60s 永远到不了 DOM。
 */
async function captureTaobaoSearchJson(
  ctx: RunContext,
  tabId: string,
): Promise<string | undefined> {
  const pattern = TAOBAO_SEARCH_API_PATTERNS[0]
  return (
    (await captureJson(ctx, tabId, pattern, CAPTURE_TIMEOUT_MS, {
      bodyIncludes: 'nid',
    })) ??
    (await captureJson(ctx, tabId, pattern, 3_000, {
      bodyIncludes: 'itemsArray',
    }))
  )
}

async function isTaobaoLoginWall(ctx: RunContext, tabId: string): Promise<boolean> {
  try {
    return (await ctx.browser.eval({ tabId, expression: TAOBAO_LOGIN_WALL_EXPR })) === true
  } catch {
    return false
  }
}

const TAOBAO_LOGIN_HINT =
  '淘宝 PC 搜索匿名不出货（不发 wsearch）。请在 TabTin 浏览器当前淘宝标签扫码登录后重试；批量低频，易滑块/风控。'

export const taobaoAdapter: PlatformAdapter = {
  id: 'taobao',
  domains: ['taobao.com', 'tb.cn'],
  authLevel: 'cookie',
  capabilities: ['search', 'read'],
  searchConstraints: {
    sorts: [...TAOBAO_SEARCH_CONSTRAINTS.sorts],
    filters: [...TAOBAO_SEARCH_CONSTRAINTS.filters],
  },

  session: {
    loginUrl: 'https://login.taobao.com/',
    loginHint: TAOBAO_LOGIN_HINT,
    async probeLoggedIn(ctx: RunContext): Promise<boolean> {
      if (!ctx.tabId) return false
      const result = await ctx.browser.eval({
        tabId: ctx.tabId,
        expression: `!!document.cookie && (document.cookie.includes('cookie2') || document.cookie.includes('_m_h5_tk') || !!document.querySelector('[class*="avatar"], .site-nav-user, .user-name'))`,
      })
      return result === true
    },
  },

  async resolve(_ctx: RunContext, rawId: string): Promise<string> {
    if (/item\.taobao\.com|detail\.tmall\.com/.test(rawId) && /[?&]id=\d+/.test(rawId)) {
      return rawId
    }
    const id = extractTaobaoItemId(rawId)
    if (id) return buildTaobaoItemUrl(id)
    throw new Error(`[taobao] 无法解析商品地址: "${rawId}"（先 search 拿完整 URL）`)
  },

  verbs: {
    search: {
      extraction: 'network-intercept',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const q = taobaoSearchQueryFromArgs(args)
        const query = normalizeSearchQuery(q.query)
        if (!query) throw new Error('[taobao] search 需要 query')
        const searchUrl = buildTaobaoSearchUrl({ ...q, query })
        const runtimeSort = mapTaobaoSortToUrl(q.sort)
        ctx.log?.('[taobao] search open', { url: searchUrl, runtimeSort })
        const opened = await ctx.browser.open({
          url: searchUrl,
          tabId: ctx.tabId,
        })

        // 先等到主列表出卡，再页内点选排序（URL sort 冷启动现网常被忽略）。
        await pollEval(ctx, opened.tabId, TAOBAO_DOM_CARDS_EXPR, {
          max: 12,
          intervalMs: 400,
        })
        if (runtimeSort) {
          const applied = await pollEval(
            ctx,
            opened.tabId,
            buildTaobaoApplySortExpr(runtimeSort),
            { max: 20, intervalMs: 450 },
          )
          const ok =
            applied &&
            typeof applied === 'object' &&
            (applied as { ok?: boolean; sort?: string }).ok === true &&
            (applied as { sort?: string }).sort === runtimeSort
          ctx.log?.('[taobao] apply sort', { runtimeSort, applied, ok })
          if (!ok) {
            ctx.log?.('[taobao] 页内排序未确认，结果可能仍是综合序', { runtimeSort })
          }
          // 列表随 sort 重刷，稍等再刮
          await delay(900)
        }

        const domJson = await pollEval(ctx, opened.tabId, TAOBAO_DOM_CARDS_EXPR, {
          max: 12,
          intervalMs: 400,
        })
        const fromDom = parseEcommerceDomCards(
          'taobao',
          domJson,
          ctx.authContext,
          buildTaobaoItemUrl,
        )
        if (fromDom.length > 0) {
          return fromDom.slice(0, args.limit ?? fromDom.length)
        }

        const body = await captureTaobaoSearchJson(ctx, opened.tabId)
        if (body) {
          const items = parseEcommerceSearch(
            'taobao',
            body,
            ctx.authContext,
            buildTaobaoItemUrl,
          )
          if (items.length > 0) {
            return items.slice(0, args.limit ?? items.length)
          }
          ctx.log?.('[taobao] wsearch 响应无商品条目', { query })
        }

        if (await isTaobaoLoginWall(ctx, opened.tabId)) {
          throw new Error(`[taobao] 搜索被登录墙拦截（匿名不出货）。${TAOBAO_LOGIN_HINT}`)
        }
        ctx.log?.('[taobao] search 未拦到 wsearch 且 DOM 无商品卡', { query })
        return []
      },
    },

    read: {
      extraction: 'page-state',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const raw = args.url?.trim()
        if (!raw) throw new Error('[taobao] read 需要商品 url')
        const url = await taobaoAdapter.resolve!(ctx, raw)
        const opened = await ctx.browser.open({ url, tabId: ctx.tabId })

        const rawBody = await pollEval(ctx, opened.tabId, gDataExpr)
        if (rawBody) {
          const item = parseEcommerceDetail(
            'taobao',
            rawBody,
            url,
            ctx.authContext,
            buildTaobaoItemUrl,
          )
          if (item) return [item]
        }

        // live：新详情壳无 g_config；用 title / ¥ / 店铺链兜底。
        const domJson = await pollEval(ctx, opened.tabId, TAOBAO_DETAIL_DOM_EXPR, {
          max: 10,
          intervalMs: 400,
        })
        const fromDom = parseEcommerceDetailDom(
          'taobao',
          domJson,
          url,
          ctx.authContext,
          buildTaobaoItemUrl,
        )
        if (fromDom?.title) return [fromDom]

        if (await isTaobaoLoginWall(ctx, opened.tabId)) {
          throw new Error(`[taobao] 详情被登录墙拦截。${TAOBAO_LOGIN_HINT}`)
        }
        ctx.log?.('[taobao] read 未取到详情', { url })
        return []
      },
    },
  },
}

/**
 * 天猫：不复用 list.tmall.com（live：302→login.taobao.com，Electron 里也常静默空结果）。
 * 与淘宝同栈：s.taobao.com + tab=mall，DOM 优先 + 短 capture + 登录墙。
 */
export const tmallAdapter: PlatformAdapter = {
  id: 'tmall',
  domains: ['tmall.com', 'tmall.hk'],
  authLevel: 'cookie',
  capabilities: ['search', 'read'],
  // 入口已固定天猫 tab；排序/价区仍走淘宝 SPA，声明与淘宝一致以免 Agent 误回 browser。
  searchConstraints: {
    sorts: [...TAOBAO_SEARCH_CONSTRAINTS.sorts],
    filters: ['free_shipping'],
  },

  session: {
    loginUrl: 'https://login.tmall.com/',
    loginHint: TMALL_LOGIN_HINT,
    async probeLoggedIn(ctx: RunContext): Promise<boolean> {
      if (!ctx.tabId) return false
      const result = await ctx.browser.eval({
        tabId: ctx.tabId,
        expression: `!!document.cookie && (document.cookie.includes('cookie2') || document.cookie.includes('_m_h5_tk') || !!document.querySelector('[class*="avatar"], .site-nav-user, .user-name'))`,
      })
      return result === true
    },
  },

  async resolve(_ctx: RunContext, rawId: string): Promise<string> {
    if (/detail\.tmall\.com|item\.taobao\.com/.test(rawId) && /[?&]id=\d+/.test(rawId)) {
      return rawId
    }
    const id = extractTaobaoItemId(rawId)
    if (id) return buildTmallItemUrl(id)
    throw new Error(`[tmall] 无法解析商品地址: "${rawId}"（先 search 拿完整 URL）`)
  },

  verbs: {
    search: {
      extraction: 'network-intercept',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const q = taobaoSearchQueryFromArgs(args)
        const query = normalizeSearchQuery(q.query)
        if (!query) throw new Error('[tmall] search 需要 query')
        // 强制天猫 tab；忽略调用方再传 tmall filter（已隐含）。
        const filters = ['tmall', ...(q.filters ?? []).filter((f) => f !== 'tmall' && f !== 'mall')]
        const searchUrl = buildTaobaoSearchUrl({ ...q, query, filters })
        const runtimeSort = mapTaobaoSortToUrl(q.sort)
        ctx.log?.('[tmall] search open', { url: searchUrl, runtimeSort })
        const opened = await ctx.browser.open({
          url: searchUrl,
          tabId: ctx.tabId,
        })

        await pollEval(ctx, opened.tabId, TAOBAO_DOM_CARDS_EXPR, {
          max: 12,
          intervalMs: 400,
        })
        if (runtimeSort) {
          const applied = await pollEval(
            ctx,
            opened.tabId,
            buildTaobaoApplySortExpr(runtimeSort),
            { max: 20, intervalMs: 450 },
          )
          const ok =
            applied &&
            typeof applied === 'object' &&
            (applied as { ok?: boolean; sort?: string }).ok === true &&
            (applied as { sort?: string }).sort === runtimeSort
          ctx.log?.('[tmall] apply sort', { runtimeSort, applied, ok })
          if (!ok) {
            ctx.log?.('[tmall] 页内排序未确认，结果可能仍是综合序', { runtimeSort })
          }
          await delay(900)
        }

        const domJson = await pollEval(ctx, opened.tabId, TAOBAO_DOM_CARDS_EXPR, {
          max: 12,
          intervalMs: 400,
        })
        const fromDom = parseEcommerceDomCards(
          'tmall',
          domJson,
          ctx.authContext,
          buildTmallItemUrl,
        )
        if (fromDom.length > 0) {
          return fromDom.slice(0, args.limit ?? fromDom.length)
        }

        const body = await captureTaobaoSearchJson(ctx, opened.tabId)
        if (body) {
          const items = parseEcommerceSearch(
            'tmall',
            body,
            ctx.authContext,
            buildTmallItemUrl,
          )
          if (items.length > 0) {
            return items.slice(0, args.limit ?? items.length)
          }
          ctx.log?.('[tmall] wsearch 响应无商品条目', { query })
        }

        if (await isTaobaoLoginWall(ctx, opened.tabId)) {
          throw new Error(`[tmall] 搜索被登录墙拦截。${TMALL_LOGIN_HINT}`)
        }
        ctx.log?.('[tmall] search 未拦到 wsearch 且 DOM 无商品卡', { query })
        return []
      },
    },

    read: {
      extraction: 'page-state',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const raw = args.url?.trim()
        if (!raw) throw new Error('[tmall] read 需要商品 url')
        const url = await tmallAdapter.resolve!(ctx, raw)
        const opened = await ctx.browser.open({ url, tabId: ctx.tabId })

        const rawBody = await pollEval(ctx, opened.tabId, gDataExpr)
        if (rawBody) {
          const item = parseEcommerceDetail(
            'tmall',
            rawBody,
            url,
            ctx.authContext,
            buildTmallItemUrl,
          )
          if (item) return [item]
        }

        const domJson = await pollEval(ctx, opened.tabId, TAOBAO_DETAIL_DOM_EXPR, {
          max: 10,
          intervalMs: 400,
        })
        const fromDom = parseEcommerceDetailDom(
          'tmall',
          domJson,
          url,
          ctx.authContext,
          buildTmallItemUrl,
        )
        if (fromDom?.title) return [fromDom]

        if (await isTaobaoLoginWall(ctx, opened.tabId)) {
          throw new Error(`[tmall] 详情被登录墙拦截。${TMALL_LOGIN_HINT}`)
        }
        ctx.log?.('[tmall] read 未取到详情', { url })
        return []
      },
    },
  },
}

function buildJdItemUrl(id: string): string {
  return `https://item.jd.com/${id}.html`
}

const JD_LOGIN_HINT =
  '请在 TabTin 浏览器京东标签登录后重试；撞 risk_handler / 验证码时先在页内完成再 search。'

/** live：主搜 color API；过宽的 `search` 会先命中 hotwords 等无 wareList 的响应。 */
const JD_SEARCH_API_PATTERN = 'pc_search_searchWare'

/**
 * 现网商品卡无 item.jd.com 锚点；客服入口带 pid=wareId（与 API 对齐）。
 */
const JD_DOM_CARDS_EXPR =
  `(function(){try{` +
  `var out=[];var seen={};` +
  `document.querySelectorAll('a[href*="chat.jd.com"][href*="pid="],a[href*="item.jd.com/"]').forEach(function(a){` +
  `var href=a.href||a.getAttribute('href')||'';` +
  `if(!href||href.indexOf('javascript:')===0)return;` +
  `var id=null;var title='';` +
  `try{` +
  `var u=new URL(href,location.href);` +
  `id=u.searchParams.get('pid');` +
  `if(id)title=u.searchParams.get('wname')||'';` +
  `if(!id){var m=u.pathname.match(/\\/(\\d+)\\.html/);if(m)id=m[1];}` +
  `}catch(e){return;}` +
  `if(!id||!/^\\d+$/.test(id)||seen[id])return;seen[id]=1;` +
  `if(!title){var raw=(a.innerText||'').replace(/\\s+/g,' ').trim();title=raw.slice(0,200);}` +
  `out.push({id:id,url:'https://item.jd.com/'+id+'.html',title:title||undefined});` +
  `});` +
  `return out.length?JSON.stringify(out):null;` +
  `}catch(e){return null;}})()`

const JD_RISK_OR_LOGIN_EXPR =
  `(function(){try{` +
  `var href=location.href||'';` +
  `if(/risk_handler|passport\\.jd\\.com\\/new\\/login/i.test(href))return 'risk_or_login';` +
  `var t=(document.body&&document.body.innerText)||'';` +
  `if(/risk_handler/.test(href))return 'risk_or_login';` +
  `var n=document.querySelectorAll('a[href*="chat.jd.com"][href*="pid="],a[href*="item.jd.com/"]').length;` +
  `if(n===0&&(/请登录|登录后|账号登录/.test(t)))return 'login';` +
  `return false;` +
  `}catch(e){return false;}})()`

const JD_DETAIL_DOM_EXPR =
  `(function(){try{` +
  `var id=null;try{var m=location.pathname.match(/\\/(\\d+)\\.html/);if(m)id=m[1];}catch(e){}` +
  `if(!/item\\.jd\\.com\\/\\d+\\.html/i.test(location.href||''))return null;` +
  `var title=(document.title||'').replace(/\\s*[-_|]\\s*京东.*$/,'').trim();` +
  `if(/正品低价|品质保障|轻松购物/.test(title))title='';` +
  `var price='';var t=(document.body&&document.body.innerText)||'';` +
  `var pm=t.match(/[¥￥]\\s*([\\d]+(?:\\.[\\d]+)?)/);if(pm)price=pm[1];` +
  `var h1=document.querySelector('.sku-name, .itemInfo-wrap .sku-name, [class*="skuName"]');` +
  `if(h1){var ht=(h1.textContent||'').replace(/\\s+/g,' ').trim();if(ht)title=ht.slice(0,200);}` +
  `if(!id&&!title)return null;` +
  `return JSON.stringify({id:id||undefined,title:title||undefined,price:price||undefined,url:location.href});` +
  `}catch(e){return null;}})()`

const JD_PAGE_CONFIG_EXPR =
  `(function(){try{if(window.pageConfig&&window.pageConfig.product)return JSON.stringify(window.pageConfig.product);return null;}catch(e){return null;}})()`

async function captureJdSearchJson(
  ctx: RunContext,
  tabId: string,
): Promise<string | undefined> {
  return (
    (await captureJson(ctx, tabId, JD_SEARCH_API_PATTERN, CAPTURE_TIMEOUT_MS, {
      bodyIncludes: 'wareList',
    })) ??
    (await captureJson(ctx, tabId, JD_SEARCH_API_PATTERN, 3_000, {
      bodyIncludes: 'wareId',
    }))
  )
}

async function jdPageBlockReason(ctx: RunContext, tabId: string): Promise<string | false> {
  try {
    const v = await ctx.browser.eval({ tabId, expression: JD_RISK_OR_LOGIN_EXPR })
    return typeof v === 'string' && v ? v : false
  } catch {
    return false
  }
}

/**
 * 京东：专用适配器（不再用 makeEcommerceAdapter 宽 pattern `search`）。
 * live：拦 pc_search_searchWare；DOM 用 chat.jd.com?pid= 兜底。
 */
export const jdAdapter: PlatformAdapter = {
  id: 'jd',
  domains: ['jd.com', 'jd.hk', '3.cn'],
  authLevel: 'cookie',
  capabilities: ['search', 'read'],
  searchConstraints: {
    sorts: [...JD_SEARCH_CONSTRAINTS.sorts],
    filters: [...JD_SEARCH_CONSTRAINTS.filters],
  },

  session: {
    loginUrl: 'https://passport.jd.com/',
    loginHint: JD_LOGIN_HINT,
    async probeLoggedIn(ctx: RunContext): Promise<boolean> {
      if (!ctx.tabId) return false
      const result = await ctx.browser.eval({
        tabId: ctx.tabId,
        expression: `!!document.cookie && (document.cookie.includes('pin=') || document.cookie.includes('thor=') || !!document.querySelector('.nickname, .user-name, [class*="user"]'))`,
      })
      return result === true
    },
  },

  async resolve(_ctx: RunContext, rawId: string): Promise<string> {
    if (/item\.jd\.com\/\d+\.html/.test(rawId)) return rawId
    const m = rawId.match(/item\.jd\.com\/(\d+)\.html/)
    if (m?.[1]) return buildJdItemUrl(m[1])
    if (/^\d+$/.test(rawId.trim())) return buildJdItemUrl(rawId.trim())
    throw new Error(`[jd] 无法解析商品地址: "${rawId}"（先 search 拿完整 URL）`)
  },

  verbs: {
    search: {
      extraction: 'network-intercept',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const q = jdSearchQueryFromArgs(args)
        const query = normalizeSearchQuery(q.query)
        if (!query) throw new Error('[jd] search 需要 query')
        // 勿加 enc=utf-8：Electron 导航策略会拒（UNVERIFIED_NAVIGATION_URL）。
        // 销量等排序：URL psort → searchWare body.psort（live：sale→3）。
        const searchUrl = buildJdSearchUrl({ ...q, query })
        ctx.log?.('[jd] search open', { url: searchUrl, sort: q.sort })
        const opened = await ctx.browser.open({ url: searchUrl, tabId: ctx.tabId })

        // open 返回后 searchWare 常已结束；同 URL 再 open 触发端口 reloadIgnoringCache 补抓。
        let body = await captureJdSearchJson(ctx, opened.tabId)
        if (!body) {
          await ctx.browser.open({ url: searchUrl, tabId: opened.tabId })
          body = await captureJdSearchJson(ctx, opened.tabId)
        }
        if (body) {
          const items = parseEcommerceSearch('jd', body, ctx.authContext, buildJdItemUrl)
          if (items.length > 0) {
            return items.slice(0, args.limit ?? items.length)
          }
          ctx.log?.('[jd] searchWare 响应无 wareList 条目', { query })
        }

        const domJson = await pollEval(ctx, opened.tabId, JD_DOM_CARDS_EXPR, {
          max: 12,
          intervalMs: 400,
        })
        const fromDom = parseEcommerceDomCards('jd', domJson, ctx.authContext, buildJdItemUrl)
        if (fromDom.length > 0) {
          return fromDom.slice(0, args.limit ?? fromDom.length)
        }

        const block = await jdPageBlockReason(ctx, opened.tabId)
        if (block) {
          throw new Error(`[jd] 搜索被${block === 'login' ? '登录墙' : '风控/登录'}拦截。${JD_LOGIN_HINT}`)
        }
        ctx.log?.('[jd] search 未拦到 searchWare 且 DOM 无商品', { query })
        return []
      },
    },

    read: {
      extraction: 'page-state',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const raw = args.url?.trim()
        if (!raw) throw new Error('[jd] read 需要商品 url')
        const url = await jdAdapter.resolve!(ctx, raw)
        const opened = await ctx.browser.open({ url, tabId: ctx.tabId })

        const rawBody = await pollEval(ctx, opened.tabId, JD_PAGE_CONFIG_EXPR)
        if (rawBody) {
          const item = parseEcommerceDetail('jd', rawBody, url, ctx.authContext, buildJdItemUrl)
          if (item) return [item]
        }

        const capt = await captureJson(ctx, opened.tabId, 'item', 5_000)
        if (capt) {
          const item = parseEcommerceDetail('jd', capt, url, ctx.authContext, buildJdItemUrl)
          if (item) return [item]
        }

        const domJson = await pollEval(ctx, opened.tabId, JD_DETAIL_DOM_EXPR, {
          max: 10,
          intervalMs: 400,
        })
        const fromDom = parseEcommerceDetailDom(
          'jd',
          domJson,
          url,
          ctx.authContext,
          buildJdItemUrl,
        )
        if (fromDom?.title) return [fromDom]

        const block = await jdPageBlockReason(ctx, opened.tabId)
        if (block) {
          throw new Error(`[jd] 详情被${block === 'login' ? '登录墙' : '风控/登录'}拦截。${JD_LOGIN_HINT}`)
        }
        ctx.log?.('[jd] read 未取到详情', { url })
        return []
      },
    },
  },
}
