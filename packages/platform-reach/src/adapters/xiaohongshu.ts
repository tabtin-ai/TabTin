/**
 * 小红书适配器
 *
 *  - 鉴权级：cookie
 *  - 抽取：search/comments → network-intercept；read → page-state（__INITIAL_STATE__）
 *  - 寻址：xsec_token 两跳——resolve 对裸 ID 抛错，逼先 search
 *
 * 已 live 校准（search / read / comments）；web 字段路径仍可能随前端改版漂移。写操作不在范围。
 */
import type { PlatformAdapter, RunContext, VerbArgs } from '../adapter'
import type { NormalizedItem } from '../types'
import {
  extractNoteId,
  isSignedNoteUrl,
  parseNoteDetailState,
  parseXhsComments,
  parseXhsSearchFeed,
} from './xiaohongshu-parse'

// 小红书 web 搜索接口现为 so.xiaohongshu.com/api/sns/web/v2/search/notes；
// 用 `/search/notes` 子串匹配，对 v1/v2 与域名变化都稳（live 2026-07 核实为 v2）。
const SEARCH_API = '/search/notes'
const COMMENT_API = '/api/sns/web/v2/comment/page'
const CAPTURE_TIMEOUT_MS = 8000
// read 走 __INITIAL_STATE__ 轮询（SSR 填充可能晚于 open 返回）。
const STATE_POLL_MAX = 12
const STATE_POLL_INTERVAL_MS = 400

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function searchUrl(query: string): string {
  const u = new URL('/search_result', 'https://www.xiaohongshu.com')
  u.searchParams.set('keyword', query)
  u.searchParams.set('source', 'web_explore_feed')
  return u.toString()
}

/**
 * 在页面上下文取 `__INITIAL_STATE__.note.noteDetailMap[id].note` 并 JSON 序列化。
 * 优先按 URL 里的 noteId 取，取不到回退到 map 首项。返回 JSON 字符串或 null。
 */
function noteDetailStateExpr(noteId?: string): string {
  const idLit = noteId ? JSON.stringify(noteId) : 'null'
  return `(function(){try{var s=window.__INITIAL_STATE__;if(!s||!s.note)return null;var m=s.note.noteDetailMap||{};var k=${idLit};var e=(k&&m[k])||m[Object.keys(m)[0]];if(!e)return null;var n=e.note||e;return JSON.stringify(n);}catch(err){return null;}})()`
}

/** 拦截首个 URL 命中 pattern 且有响应体的请求，返回其 body。 */
async function captureJson(
  ctx: RunContext,
  tabId: string,
  pattern: string,
): Promise<string | undefined> {
  const entries = await ctx.browser.captureNetwork({ tabId, urlPattern: pattern, timeoutMs: CAPTURE_TIMEOUT_MS })
  const hit = entries.find((e) => e.responseBody && e.url.includes(pattern))
  return hit?.responseBody
}

export const xiaohongshuAdapter: PlatformAdapter = {
  id: 'xiaohongshu',
  domains: ['xiaohongshu.com', 'xhslink.com'],
  authLevel: 'cookie',
  capabilities: ['search', 'read', 'comments'],

  session: {
    loginUrl: 'https://www.xiaohongshu.com/explore',
    loginHint: '在小红书标签页里扫码登录一次，登录态会留在当前浏览环境供后续复用。',
    async probeLoggedIn(ctx: RunContext): Promise<boolean> {
      if (!ctx.tabId) return false
      // 登录后页面有用户侧栏/头像；未登录则常驻"登录"按钮。以 DOM 存在性粗判。
      const result = await ctx.browser.eval({
        tabId: ctx.tabId,
        expression: `!!document.querySelector('.user, .side-bar .user, [class*="avatar"]') && !document.querySelector('.login-btn, [class*="login"] button')`,
      })
      return result === true
    },
  },

  /**
   * xsec_token 两跳硬约束：已签名 URL 原样放行；裸 ID 拒绝并要求先 search。
   * 小红书 web 端裸 note_id 已不可靠直读，这条约束固化进代码而非靠文档提醒。
   */
  async resolve(_ctx: RunContext, rawId: string): Promise<string> {
    if (isSignedNoteUrl(rawId)) return rawId
    throw new Error(
      `[xiaohongshu] 裸笔记 ID "${rawId}" 不可直读：小红书要求带 xsec_token 的签名 URL。` +
        `请先用 search/feed 拿到结果里的完整 URL，再 read/comments。`,
    )
  },

  verbs: {
    search: {
      extraction: 'network-intercept',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const query = (args.query ?? '').trim()
        if (!query) throw new Error('[xiaohongshu] search 需要 query')
        const opened = await ctx.browser.open({ url: searchUrl(query), tabId: ctx.tabId })
        const body = await captureJson(ctx, opened.tabId, SEARCH_API)
        if (!body) {
          ctx.log?.('[xiaohongshu] search 未拦到 feed 响应，可能是登录墙/验证码', { query })
          return []
        }
        const items = parseXhsSearchFeed(body, ctx.authContext)
        const limit = args.limit ?? items.length
        return items.slice(0, limit)
      },
    },

    read: {
      // 正文走页面状态：小红书详情页把笔记 SSR 进 __INITIAL_STATE__，不发详情 XHR，
      // network-intercept 天生抓不到（评论仍走 XHR，见 comments）。
      extraction: 'page-state',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const url = args.url
        if (!url || !isSignedNoteUrl(url)) {
          throw new Error('[xiaohongshu] read 需要带 xsec_token 的签名 URL（先 search 拿到）')
        }
        const opened = await ctx.browser.open({ url, tabId: ctx.tabId })
        const noteId = extractNoteId(url)
        // __INITIAL_STATE__ 可能在 open 返回后才填充，短轮询取笔记详情对象。
        const expr = noteDetailStateExpr(noteId)
        let note: unknown = null
        for (let i = 0; i < STATE_POLL_MAX; i++) {
          note = await ctx.browser.eval({ tabId: opened.tabId, expression: expr })
          if (note) break
          await delay(STATE_POLL_INTERVAL_MS)
        }
        if (!note) {
          ctx.log?.('[xiaohongshu] read 未取到 __INITIAL_STATE__ 笔记详情（登录墙/验证码/结构变更）', { url })
          return []
        }
        const item = parseNoteDetailState(note, url, ctx.authContext)
        return item ? [item] : []
      },
    },

    comments: {
      extraction: 'network-intercept',
      risk: 'read',
      async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
        const url = args.url
        if (!url || !isSignedNoteUrl(url)) {
          throw new Error('[xiaohongshu] comments 需要带 xsec_token 的签名 URL（先 search 拿到）')
        }
        const opened = await ctx.browser.open({ url, tabId: ctx.tabId })
        const body = await captureJson(ctx, opened.tabId, COMMENT_API)
        const comments = body ? parseXhsComments(body) : []
        const noteId = extractNoteId(url) ?? url
        // 评论挂在笔记条目下返回，便于下游按笔记聚合。
        return [
          {
            platform: 'xiaohongshu',
            id: noteId,
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
