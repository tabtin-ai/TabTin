/**
 * 抖音适配器
 *
 * 四轴：cookie / network-intercept（+ page-state/DOM 兜底）/ 视频 URL 直读 / 2.5s
 *
 * Live 2026-07 核实（Electron）：
 *  - 匿名：搜索页登录墙「登录后即可搜索…」，不发 search XHR。
 *  - 已登录：搜索走 `/aweme/v1/web/general/search/stream/`（length-prefixed JSON）；
 *    风控时常 `search_nil_type: verify_check` 且 `data:[]`（需用户完成验证后重试）。
 *  - 详情：`/aweme/v1/web/aweme/detail`；无 XHR 时读 `RENDER_DATA` / DOM。
 */
import type { PlatformAdapter, RunContext, VerbArgs } from '../adapter'
import type { NormalizedItem } from '../types'
import { captureJson, pollEval } from './_helpers'
import {
  buildVideoUrl,
  detectDouyinSearchNil,
  extractAwemeId,
  isDouyinVideoUrl,
  parseDouyinComments,
  parseDouyinDetail,
  parseDouyinDomCards,
  parseDouyinSearch,
} from './douyin-parse'

/** live：已登录综合搜索走 stream；旧 single / search/item 作兼容。 */
const SEARCH_API_PATTERNS = [
  '/aweme/v1/web/general/search/stream',
  '/aweme/v1/web/general/search/single',
  '/aweme/v1/web/search/item',
  '/general/search',
] as const
const DETAIL_API_PATTERNS = [
  '/aweme/v1/web/aweme/detail',
  '/aweme/detail',
] as const
const COMMENT_API = '/aweme/v1/web/comment/list'
const CAPTURE_TIMEOUT_MS = 12_000

/** 页面是否仍挡着登录浮层（搜索被挡时不会发结果 XHR）。 */
const LOGIN_WALL_EXPR =
  `(function(){try{` +
  `if(document.getElementById('douyin_login_comp_btn_id'))return true;` +
  `var t=(document.body&&document.body.innerText)||'';` +
  `return t.indexOf('登录后即可搜索')>=0||t.indexOf('扫码登录')>=0;` +
  `}catch(e){return false;}})()`

/** 详情页 SSR / 水合状态（有则优先于空 XHR）。 */
const DETAIL_STATE_EXPR =
  `(function(){try{` +
  `var el=document.getElementById('RENDER_DATA');` +
  `if(el&&el.textContent)return el.textContent;` +
  `if(window.__INITIAL_STATE__)return JSON.stringify(window.__INITIAL_STATE__);` +
  `if(window._ROUTER_DATA)return JSON.stringify(window._ROUTER_DATA);` +
  `return null;` +
  `}catch(e){return null;}})()`

/** DOM 上可见的 /video/ 卡片（登录后结果区或详情相关推荐）。 */
const DOM_CARDS_EXPR =
  `(function(){try{` +
  `var out=[];var seen={};` +
  `document.querySelectorAll('a[href*="/video/"]').forEach(function(a){` +
  `var href=a.href||a.getAttribute('href')||'';` +
  `var m=href.match(/\\/video\\/(\\d+)/);if(!m||seen[m[1]])return;seen[m[1]]=1;` +
  `var title=(a.getAttribute('title')||a.innerText||'').replace(/\\s+/g,' ').trim().slice(0,200);` +
  `out.push({id:m[1],url:href.split('?')[0],title:title||undefined});` +
  `});` +
  `return out.length?JSON.stringify(out):null;` +
  `}catch(e){return null;}})()`

function searchUrl(query: string): string {
  return 'https://www.douyin.com/search/' + encodeURIComponent(query)
}

async function captureFirstJson(
  ctx: RunContext,
  tabId: string,
  patterns: readonly string[],
  opts?: { bodyIncludes?: string },
): Promise<string | undefined> {
  for (const pattern of patterns) {
    const body = await captureJson(ctx, tabId, pattern, CAPTURE_TIMEOUT_MS, {
      bodyIncludes: opts?.bodyIncludes ?? 'aweme_id',
    })
    if (body) return body
  }
  // 再放宽：空列表 / verify_check 没有 aweme_id，但仍需读 search_nil_info。
  for (const pattern of patterns) {
    const body = await captureJson(ctx, tabId, pattern, 3_000, {
      bodyIncludes: 'status_code',
    })
    if (body) return body
  }
  return undefined
}

async function isLoginWall(ctx: RunContext, tabId: string): Promise<boolean> {
  try {
    return (await ctx.browser.eval({ tabId, expression: LOGIN_WALL_EXPR })) === true
  } catch {
    return false
  }
}

export const douyinAdapter: PlatformAdapter = {
  id: 'douyin',
  domains: ['douyin.com', 'iesdouyin.com'],
  authLevel: 'cookie',
  capabilities: ['search', 'read', 'comments'],

  session: {
    loginUrl: 'https://www.douyin.com/',
    loginHint:
      '抖音 web 搜索匿名会弹登录墙（「登录后即可搜索…」）。请在 TabTin 浏览器当前标签扫码/验证码登录后重试；批量低频，易触发验证码。',
    async probeLoggedIn(ctx: RunContext): Promise<boolean> {
      if (!ctx.tabId) return false
      const result = await ctx.browser.eval({
        tabId: ctx.tabId,
        expression: `!!document.cookie.match(/sessionid|passport_csrf_token/)`,
      })
      return result === true
    },
  },

  async resolve(_ctx: RunContext, rawId: string): Promise<string> {
    if (isDouyinVideoUrl(rawId)) return rawId
    const id = extractAwemeId(rawId)
    if (id) return buildVideoUrl(id)
    throw new Error(`[douyin] 无法解析视频地址: "${rawId}"（先 search 拿完整 URL）`)
  },

  verbs: {
    search: {
      extraction: 'network-intercept',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const query = (args.query ?? '').trim()
        if (!query) throw new Error('[douyin] search 需要 query')
        const opened = await ctx.browser.open({ url: searchUrl(query), tabId: ctx.tabId })

        const body = await captureFirstJson(ctx, opened.tabId, SEARCH_API_PATTERNS)
        if (body) {
          const items = parseDouyinSearch(body, ctx.authContext)
          if (items.length > 0) {
            return items.slice(0, args.limit ?? items.length)
          }
          const nil = detectDouyinSearchNil(body)
          if (nil === 'verify_check') {
            throw new Error(
              '[douyin] 搜索被风控 verify_check 置空（已登录也会发生）。' +
                '请在 TabTin 浏览器当前抖音搜索页完成验证码/安全验证后重试；勿高频连搜。',
            )
          }
          if (nil) {
            ctx.log?.('[douyin] search 空结果', { query, searchNilType: nil })
          }
        }

        // 登录后偶发只水合 DOM、不复读 XHR：刮 /video/ 链接。
        const domJson = await pollEval(ctx, opened.tabId, DOM_CARDS_EXPR, {
          max: 8,
          intervalMs: 400,
        })
        const fromDom = parseDouyinDomCards(domJson, ctx.authContext)
        if (fromDom.length > 0) {
          return fromDom.slice(0, args.limit ?? fromDom.length)
        }

        if (await isLoginWall(ctx, opened.tabId)) {
          throw new Error(
            `[douyin] 搜索被登录墙拦截（匿名不出货）。${douyinAdapter.session.loginHint}`,
          )
        }
        ctx.log?.('[douyin] search 未拦到含 aweme_id 的响应，且 DOM 无视频卡', {
          query,
        })
        return []
      },
    },

    read: {
      extraction: 'network-intercept',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const raw = args.url?.trim()
        if (!raw) throw new Error('[douyin] read 需要视频 url')
        const url = await douyinAdapter.resolve!(ctx, raw)
        const opened = await ctx.browser.open({ url, tabId: ctx.tabId })

        const body = await captureFirstJson(ctx, opened.tabId, DETAIL_API_PATTERNS)
        if (body) {
          const item = parseDouyinDetail(body, url, ctx.authContext)
          if (item) return [item]
        }

        const state = await pollEval(ctx, opened.tabId, DETAIL_STATE_EXPR)
        if (state) {
          const item = parseDouyinDetail(state, url, ctx.authContext)
          if (item) return [item]
        }

        if (await isLoginWall(ctx, opened.tabId)) {
          throw new Error(
            `[douyin] 详情被登录墙拦截。${douyinAdapter.session.loginHint}`,
          )
        }
        ctx.log?.('[douyin] read 未拦到详情且无 RENDER_DATA', { url })
        return []
      },
    },

    comments: {
      extraction: 'network-intercept',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const raw = args.url?.trim()
        if (!raw) throw new Error('[douyin] comments 需要视频 url')
        const url = await douyinAdapter.resolve!(ctx, raw)
        const opened = await ctx.browser.open({ url, tabId: ctx.tabId })
        const body =
          (await captureJson(ctx, opened.tabId, COMMENT_API, CAPTURE_TIMEOUT_MS, {
            bodyIncludes: 'cid',
          })) ??
          (await captureJson(ctx, opened.tabId, '/comment/list', CAPTURE_TIMEOUT_MS))
        const comments = body ? parseDouyinComments(body) : []
        if (comments.length === 0 && (await isLoginWall(ctx, opened.tabId))) {
          throw new Error(
            `[douyin] 评论被登录墙拦截。${douyinAdapter.session.loginHint}`,
          )
        }
        const id = extractAwemeId(url) ?? url
        return [
          {
            platform: 'douyin',
            id,
            url,
            comments,
            metrics: { comments: comments.length },
            fetchedAt: new Date().toISOString(),
            authContext: ctx.authContext,
          },
        ]
      },
    },
  },
}
