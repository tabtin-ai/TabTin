/**
 * 同花顺 / 东方财富适配器
 *
 * 四轴：public→cookie /
 * network-intercept / URL 直读 / 2s
 * - eastmoney：资讯 search（JSONP）+ 文章 read
 * - tonghuashun：问财查股（stream-query SSE）→ 个股名片 + 解读
 */
import type { PlatformAdapter, RunContext, VerbArgs } from '../adapter'
import type { NormalizedItem } from '../types'
import { captureJson, pollEval } from './_helpers'
import {
  type FinancePlatform,
  buildTonghuashunResultUrl,
  parseFinanceDetail,
  parseFinanceSearch,
  parseTonghuashunIwencai,
} from './finance-parse'

type Spec = {
  id: FinancePlatform
  domains: string[]
  loginUrl: string
  loginHint: string
  searchPage: (query: string) => string
  searchApiPattern: string
  /** 覆盖默认正文抽取；东方财富全局 `.title` 会误命中侧栏「行情中心」。 */
  readExpr?: string
  /** 问财 SSE 往往 >8s 才齐，单独放宽。 */
  captureTimeoutMs?: number
  /** 同花顺：search/read 走问财 SSE 解析。 */
  iwencai?: boolean
}

/** 东方财富资讯详情：标题在 `.contentwrap .title`，正文在 `#ContentBody`。 */
const EASTMONEY_READ_EXPR = `(function(){try{var titleEl=document.querySelector('.contentwrap .title, .topbox .title');var title=titleEl?(titleEl.textContent||'').trim():'';if(!title){title=(document.title||'').replace(/\\s*_\\s*东方财富网\\s*$/,'').trim();}var bodyEl=document.querySelector('#ContentBody, .contentwrap .txtinfos');var content=bodyEl?(bodyEl.innerText||bodyEl.textContent||'').trim():'';content=content.replace(/^炒股第一步[^\\n]*\\n*/,'').trim();var anchor=content.search(/天眼查|本报讯|记者/);if(anchor>0)content=content.slice(anchor);content=content.slice(0,8000);var meta='';var infos=document.querySelector('.contentwrap .infos, .topbox .infos');if(infos)meta+=(infos.textContent||'');var srcBox=document.querySelector('.contentwrap .sourcebox, .sourcebox');if(srcBox)meta+=' '+(srcBox.textContent||'');meta=meta.replace(/\\s+/g,' ').trim();var source='';var sm=meta.match(/(?:来源|文章来源)[:：]\\s*([^\\s]+)/);if(sm)source=sm[1];var date='';var dm=meta.match(/(\\d{4}年\\d{1,2}月\\d{1,2}日\\s*\\d{1,2}:\\d{2})/);if(dm)date=dm[1];return JSON.stringify({title:title,content:content,mediaName:source,date:date});}catch(e){return null;}})()`

/** 东方财富资讯列表：`.news_list .news_item`（so.eastmoney.com/news/s live 校准）。 */
const EASTMONEY_SEARCH_DOM_EXPR = `(function(){try{var nodes=document.querySelectorAll('.news_list .news_item');var out=[];for(var i=0;i<nodes.length;i++){var n=nodes[i];var a=n.querySelector('.news_item_t a');if(!a||!a.href)continue;var href=a.href;var m=href.match(/\\/a\\/(\\d+)\\.html/);var timeEl=n.querySelector('.news_item_time');var cEl=n.querySelector('.news_item_c');var content=cEl?(cEl.textContent||'').replace(/^\\d{4}-\\d{2}-\\d{2}[\\s\\S]*?-\\s*/,'').trim():'';out.push({code:m?m[1]:'',title:(a.textContent||'').trim(),url:href,date:timeEl?(timeEl.textContent||'').replace(/\\s*-\\s*$/,'').trim():'',content:content.slice(0,2000),mediaName:''});}return out.length?JSON.stringify(out):null;}catch(e){return null;}})()`

/**
 * 同花顺问财结果页 DOM 兜底：从正文抽「名称(代码)」+ 摘要。
 * 网络 SSE 在 reach 重放导航时偶发进不了 NetworkLog。
 */
const TONGHUASHUN_IWENCAI_DOM_EXPR = `(function(){try{var t=(document.body&&document.body.innerText)||'';t=t.replace(/\\s+/g,' ').trim();if(t.length<30)return null;var m=t.match(/([\\u4e00-\\u9fffA-Za-z0-9·]{2,20})[（(](\\d{6})[）)]/);var name=m?m[1]:'';var code=m?m[2]:'';if(!code){var m2=t.match(/\\b(\\d{6})\\b/);code=m2?m2[1]:'';}if(!code&&!name)return null;var subjects={};if(code){subjects[code]={code:code,name:name||code};}return JSON.stringify({voice_txt:t.slice(0,1600),subjects:subjects});}catch(e){return null;}})()`

function makeFinanceAdapter(spec: Spec): PlatformAdapter {
  const adapter: PlatformAdapter = {
    id: spec.id,
    domains: spec.domains,
    authLevel: 'public',
    capabilities: ['search', 'read'],

    session: {
      loginUrl: spec.loginUrl,
      loginHint: spec.loginHint,
      async probeLoggedIn(ctx: RunContext): Promise<boolean> {
        if (!ctx.tabId) return false
        const result = await ctx.browser.eval({
          tabId: ctx.tabId,
          expression: `!!document.cookie && document.cookie.length > 20`,
        })
        return result === true
      },
    },

    verbs: {
      search: {
        extraction: 'network-intercept',
        risk: 'read',
        async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
          const query = (args.query ?? '').trim()
          if (!query) throw new Error(`[${spec.id}] search 需要 query`)
          const pageUrl = spec.searchPage(query)
          const opened = await ctx.browser.open({
            url: pageUrl,
            tabId: ctx.tabId,
          })
          // 东方财富：优先资讯 JSONP；同花顺问财：等 SSE 里出现 subjects 再取。
          const body = await captureJson(
            ctx,
            opened.tabId,
            spec.searchApiPattern,
            spec.captureTimeoutMs,
            spec.id === 'eastmoney'
              ? { preferUrlIncludes: 'cmsArticleWebOld' }
              : spec.iwencai
                ? // subjects 在 SSE 尾部；voice_txt 更靠前，先就绪即可解析（无 subjects 时用名称(代码)兜底）
                  { bodyIncludes: 'voice_txt' }
                : undefined,
          )
          let items = body
            ? parseFinanceSearch(spec.id, body, ctx.authContext, {
                query,
                resultUrl: pageUrl,
              })
            : []
          // 问财：网络缓冲未齐时宽扫 voice_txt；仍空则读页面正文兜底。
          if (items.length === 0 && spec.iwencai) {
            const entries = await ctx.browser.captureNetwork({
              tabId: opened.tabId,
              timeoutMs: 4000,
              bodyIncludes: 'voice_txt',
            })
            const fallback = entries.find((e) => e.responseBody?.includes('voice_txt'))
              ?.responseBody
            if (fallback) {
              items = parseFinanceSearch(spec.id, fallback, ctx.authContext, {
                query,
                resultUrl: pageUrl,
              })
            }
          }
          if (items.length === 0 && spec.iwencai) {
            ctx.log?.(`[${spec.id}] search 网络空，尝试问财 DOM 兜底`, { query })
            const dom = await pollEval(
              ctx,
              opened.tabId,
              TONGHUASHUN_IWENCAI_DOM_EXPR,
              { max: 16, intervalMs: 500 },
            )
            if (dom) {
              items = parseTonghuashunIwencai(dom, ctx.authContext, {
                query,
                resultUrl: pageUrl,
              })
            }
          }
          // 页面已渲染但 Script/JSONP 体未入 NetworkLog 时，读 DOM 兜底（live 已验证选择器）。
          if (items.length === 0 && spec.id === 'eastmoney') {
            ctx.log?.(`[${spec.id}] search 网络拦截空，尝试 DOM 兜底`, { query })
            const dom = await pollEval(
              ctx,
              opened.tabId,
              EASTMONEY_SEARCH_DOM_EXPR,
            )
            items = parseFinanceSearch(spec.id, dom, ctx.authContext, { query })
          } else if (!body) {
            ctx.log?.(`[${spec.id}] search 未拦到响应`, { query })
          }
          return items.slice(0, args.limit ?? items.length)
        },
      },

      read: {
        extraction: spec.iwencai ? 'network-intercept' : 'page-state',
        risk: 'read',
        async run(ctx: RunContext, args: VerbArgs): Promise<NormalizedItem[]> {
          let url = args.url?.trim()
          if (!url) throw new Error(`[${spec.id}] read 需要文章/个股 url`)
          // 与 search 产物对齐：eastmoney 入参若仍是 http，升 https 再开页。
          if (spec.id === 'eastmoney') {
            try {
              const u = new URL(url)
              if (u.protocol === 'http:') {
                u.protocol = 'https:'
                url = u.href
              }
            } catch {
              /* 非法 URL 交给后续 open 报错 */
            }
          }
          const opened = await ctx.browser.open({ url, tabId: ctx.tabId })

          // 同花顺：结果页会再打 stream-query，复用问财解析。
          if (spec.iwencai) {
            const body = await captureJson(
              ctx,
              opened.tabId,
              spec.searchApiPattern,
              spec.captureTimeoutMs,
              { bodyIncludes: 'voice_txt' },
            )
            if (body) {
              let q = ''
              try {
                q = new URL(url).searchParams.get('w') ?? ''
              } catch {
                /* ignore */
              }
              const items = parseTonghuashunIwencai(body, ctx.authContext, {
                query: q,
                resultUrl: url,
              })
              if (items.length > 0) return items.slice(0, 1)
            }
            ctx.log?.(`[${spec.id}] read 未拦到问财 SSE，尝试页面正文`, { url })
          }

          const expr =
            spec.readExpr ??
            `(function(){try{var t=document.querySelector('h1, .title, .article-title, .newsTitle');var b=document.querySelector('article, .article-body, .content, #articleContent, .main-text');return JSON.stringify({title:t?t.textContent.trim():document.title,content:b?b.textContent.trim().slice(0,8000):''});}catch(e){return null;}})()`
          const state = await pollEval(ctx, opened.tabId, expr)
          if (!state) {
            ctx.log?.(`[${spec.id}] read 未取到正文`, { url })
            return []
          }
          const item = parseFinanceDetail(spec.id, state, url, ctx.authContext)
          return item ? [item] : []
        },
      },
    },
  }
  return adapter
}

export const tonghuashunAdapter = makeFinanceAdapter({
  id: 'tonghuashun',
  domains: ['10jqka.com.cn', 'hexin.cn'],
  loginUrl: 'https://www.10jqka.com.cn/',
  loginHint: '同花顺问财查股匿名可用；个人持仓/付费指标需登录。',
  searchPage: (q) => buildTonghuashunResultUrl(q),
  // 问财结果 SSE（勿用宽泛 search——会误中 suggest / user-info）
  // 注意：browser_network filter 按正则匹配，避免多余元字符。
  searchApiPattern: 'stream-query',
  captureTimeoutMs: 15000,
  iwencai: true,
})

export const eastmoneyAdapter = makeFinanceAdapter({
  id: 'eastmoney',
  domains: ['eastmoney.com', 'dfcfw.com'],
  loginUrl: 'https://passport2.eastmoney.com/',
  loginHint: '东方财富资讯/行情多数公开；股吧发帖互动需登录。',
  searchPage: (q) => {
    const u = new URL('https://so.eastmoney.com/news/s')
    u.searchParams.set('keyword', q)
    return u.toString()
  },
  // 真结果接口；勿用宽泛 'search'——会先命中 searchapi/searchadapter 联想接口。
  searchApiPattern: 'search-api-web.eastmoney.com/search/jsonp',
  readExpr: EASTMONEY_READ_EXPR,
})
