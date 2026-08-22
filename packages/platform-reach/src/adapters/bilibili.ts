/**
 * B站适配器
 *
 * 四轴取值：
 *  - 鉴权级：public（搜索/详情只读一般无需登录；字幕等能力另议）
 *  - 抽取：page-state（搜索页读 __pinia.searchResponse；详情读 __INITIAL_STATE__.videoData）
 *  - 寻址流：BV 号可直读，无需签名两跳
 *  - 限频：1.5s（公开接口相对宽松）
 *
 * ⚠️ LIVE-VERIFY：SSR 状态键（__pinia.searchResponse / __INITIAL_STATE__.videoData）可能随前端改版漂移。
 */
import type { PlatformAdapter, RunContext, VerbArgs } from '../adapter'
import type { NormalizedItem } from '../types'
import { pollEval } from './_helpers'
import {
  buildVideoUrl,
  extractBvid,
  isBilibiliVideoUrl,
  parseBilibiliSearch,
  parseBilibiliView,
} from './bilibili-parse'

// B站搜索页与视频详情页均为 SSR 直出（live 2026-07 核实）：
//  - 综合搜索：结果不发结果 XHR（只有 suggest/default），塞在 __pinia.searchResponse.searchAllResponse.result[]
//  - 视频详情：view 接口不稳定拦（易撞 view/conclusion/judge），videoData 直出在 __INITIAL_STATE__.videoData
// 故 search / read 均走 page-state。
const SEARCH_STATE_EXPR =
  `(function(){try{var p=window.__pinia||{};var r=p.searchResponse||p.searchTypeResponse;return r?JSON.stringify(r):null;}catch(e){return null;}})()`
const VIEW_STATE_EXPR =
  `(function(){try{var s=window.__INITIAL_STATE__;if(!s)return null;var v=s.videoData||s.videoInfo||s;return v?JSON.stringify(v):null;}catch(e){return null;}})()`

function searchUrl(query: string): string {
  const u = new URL('https://search.bilibili.com/all')
  u.searchParams.set('keyword', query)
  return u.toString()
}

export const bilibiliAdapter: PlatformAdapter = {
  id: 'bilibili',
  domains: ['bilibili.com', 'b23.tv'],
  authLevel: 'public',
  capabilities: ['search', 'read'],

  session: {
    loginUrl: 'https://www.bilibili.com/',
    loginHint: 'B站搜索/详情多数公开可读；若撞风控，在标签页登录一次即可。',
    async probeLoggedIn(ctx: RunContext): Promise<boolean> {
      if (!ctx.tabId) return false
      const result = await ctx.browser.eval({
        tabId: ctx.tabId,
        expression: `!!document.cookie.match(/DedeUserID=/)`,
      })
      return result === true
    },
  },

  async resolve(_ctx: RunContext, rawId: string): Promise<string> {
    if (isBilibiliVideoUrl(rawId)) return rawId
    const bvid = extractBvid(rawId)
    if (bvid) return buildVideoUrl(bvid)
    throw new Error(`[bilibili] 无法解析视频地址: "${rawId}"（需要 BV 号或 bilibili.com/video/ 链接）`)
  },

  verbs: {
    search: {
      // B站搜索页 SSR 直出，结果在 __pinia.searchResponse；走 page-state 读页面状态。
      extraction: 'page-state',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const query = (args.query ?? '').trim()
        if (!query) throw new Error('[bilibili] search 需要 query')
        const opened = await ctx.browser.open({ url: searchUrl(query), tabId: ctx.tabId })
        const state = await pollEval(ctx, opened.tabId, SEARCH_STATE_EXPR)
        if (!state) {
          ctx.log?.('[bilibili] search 未取到 __pinia.searchResponse（结构变更/风控）', { query })
          return []
        }
        const items = parseBilibiliSearch(state, ctx.authContext)
        return items.slice(0, args.limit ?? items.length)
      },
    },

    read: {
      // 视频详情 SSR 直出在 __INITIAL_STATE__.videoData；走 page-state。
      extraction: 'page-state',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const raw = args.url?.trim()
        if (!raw) throw new Error('[bilibili] read 需要 url（BV 或视频页链接）')
        const url = await bilibiliAdapter.resolve!(ctx, raw)
        const opened = await ctx.browser.open({ url, tabId: ctx.tabId })
        const state = await pollEval(ctx, opened.tabId, VIEW_STATE_EXPR)
        if (!state) {
          ctx.log?.('[bilibili] read 未取到 __INITIAL_STATE__.videoData（结构变更/风控）', { url })
          return []
        }
        const item = parseBilibiliView(state, url, ctx.authContext)
        return item ? [item] : []
      },
    },
  },
}
