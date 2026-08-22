/**
 * 电商平台（淘宝 / 天猫 / 京东）防御式解析。
 *
 * 强登录墙 + 接口频繁改版。字段多路径兜底。
 * 淘宝 live（2026-07）：匿名 PC 搜索页只出壳、不发 `mtop.taobao.wsearch.h5search`；
 * 登录后拦该 XHR（itemsArray / nid）或 DOM 刮 `item.taobao.com` / `detail.tmall.com`。
 * 输出统一 NormalizedItem：id=商品 id，url=可回访商品页。
 */
import type { AuthContext, NormalizedItem } from '../types'
import { makeItem } from '../types'
import {
  asRecord,
  coerceJson,
  numericBag,
  parseCount,
  pickItemsArray,
  strField,
} from './_parse-utils'

export type EcommercePlatform = 'taobao' | 'tmall' | 'jd'

/** 若 query 已被百分号编码过（偶发双重 encode），解到明文再交给 URLSearchParams。 */
export function normalizeSearchQuery(query: string): string {
  let cur = query.trim()
  for (let i = 0; i < 2; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(cur)) break
    try {
      const decoded = decodeURIComponent(cur)
      if (decoded === cur) break
      cur = decoded
    } catch {
      break
    }
  }
  return cur
}

export function extractTaobaoItemId(urlOrId: string): string | undefined {
  try {
    const u = new URL(urlOrId)
    const id = u.searchParams.get('id')
    if (id && /^\d+$/.test(id)) return id
  } catch {
    /* bare */
  }
  if (/^\d+$/.test(urlOrId.trim())) return urlOrId.trim()
  return undefined
}

/**
 * DOM 商品卡：`a[href*="item.taobao.com|detail.tmall.com"]` 刮出的 JSON 数组。
 * 每项至少 `{ id, url, title?, price? }`。
 */
/** 京东 chat/wname 等常把标题放成 percent-encoding。 */
function decodeMaybeUriComponent(raw: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(raw)) return raw
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '))
  } catch {
    return raw
  }
}

/** 搜索卡 innerText 常把价格/销量拼进标题；截到首个价标前。 */
export function cleanEcommerceCardTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const t = decodeMaybeUriComponent(raw.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  const cut = t.search(/[¥￥]|正在秒杀|人付款|补贴后|优惠后/)
  const head = (cut > 0 ? t.slice(0, cut) : t).trim()
  return head.slice(0, 200) || undefined
}

export function parseEcommerceDomCards(
  platform: EcommercePlatform,
  raw: unknown,
  authContext: AuthContext,
  buildUrl: (id: string) => string,
): NormalizedItem[] {
  const root = coerceJson(raw)
  const list = Array.isArray(root) ? root : []
  const out: NormalizedItem[] = []
  for (const it of list) {
    const card = asRecord(it)
    if (!card) continue
    const id =
      strField(card, 'id', 'item_id', 'itemId', 'nid') ??
      extractTaobaoItemId(strField(card, 'url', 'href') ?? '')
    if (!id) continue
    const href = strField(card, 'url', 'href') ?? buildUrl(id)
    const title = cleanEcommerceCardTitle(strField(card, 'title', 'name'))
    const price = strField(card, 'price')
    const salesRaw = card.sales ?? card.sellCount ?? card.view_sales
    // DOM 文案常为「1.2万+人付款」——先抽出「数字+万」再 parseCount
    const sales =
      typeof salesRaw === 'string'
        ? parseCount(
            (() => {
              const m = salesRaw.match(/([\d.]+)\s*(万)/) ?? salesRaw.match(/([\d.]+)/)
              if (!m) return salesRaw
              return m[2] ? `${m[1]}万` : m[1]
            })(),
          )
        : parseCount(salesRaw)
    out.push(
      makeItem({
        platform,
        id,
        url: href.startsWith('http') ? href : buildUrl(id),
        title,
        // platformMetrics 仅数字；原文销量文案附在 body 供排查
        metrics: sales != null ? { comments: sales } : undefined,
        platformMetrics: sales != null ? { sales } : undefined,
        body:
          [price ? `价格: ${price}` : '', typeof salesRaw === 'string' ? salesRaw : '']
            .filter(Boolean)
            .join(' · ') || undefined,
        authContext,
      }),
    )
  }
  return out
}

/**
 * 详情页 DOM / title 兜底（live：新详情无 g_config / __ICE_APP_CONTEXT__ / ld+json）。
 * 输入形状：`{ id, title, price?, nick?, url? }`。
 */
export function parseEcommerceDetailDom(
  platform: EcommercePlatform,
  raw: unknown,
  signedUrl: string,
  authContext: AuthContext,
  buildUrl: (id: string) => string,
): NormalizedItem | null {
  const card = asRecord(coerceJson(raw))
  if (!card) return null
  const id =
    strField(card, 'id', 'item_id', 'itemId', 'nid') ??
    extractTaobaoItemId(signedUrl) ??
    extractTaobaoItemId(strField(card, 'url') ?? '')
  if (!id) return null
  const title = cleanEcommerceCardTitle(strField(card, 'title', 'name'))
    ?.replace(/\s*[-_|]\s*淘宝网\s*$/u, '')
    ?.replace(/\s*[-_|]\s*tmall\.com\s*天猫\s*$/iu, '')
    ?.replace(/\s*[-_|]\s*天猫\s*$/u, '')
  const price = strField(card, 'price')
  const nick = strField(card, 'nick', 'shopName', 'shop')
  return makeItem({
    platform,
    id,
    url: signedUrl || strField(card, 'url') || buildUrl(id),
    title,
    body: price ? `价格: ${price}` : undefined,
    author: nick ? { name: nick } : undefined,
    authContext,
  })
}

function mapProduct(
  platform: EcommercePlatform,
  raw: unknown,
  authContext: AuthContext,
  buildUrl: (id: string) => string,
): NormalizedItem | null {
  const card = asRecord(raw) ?? asRecord(asRecord(raw)?.item) ?? asRecord(asRecord(raw)?.product)
  if (!card) return null
  const id = strField(
    card,
    'item_id',
    'itemId',
    'nid',
    'num_iid',
    'skuId',
    'wareId',
    'wareid',
    'productId',
    'id',
  )
  if (!id) return null
  const titleRaw = strField(
    card,
    'title',
    'itemName',
    'wareName',
    'name',
    'raw_title',
    'w_title',
  )
  // 京东 wareName 常带高亮 HTML；DOM/wname 偶发 percent-encoding
  const title = titleRaw ? cleanEcommerceCardTitle(titleRaw) : undefined
  const shop = asRecord(card.shop) ?? asRecord(card.shopInfo) ?? {}
  const price = strField(
    card,
    'price',
    'priceShow',
    'priceWap',
    'reservePrice',
    'jdPrice',
    'priceWithRate',
    'view_price',
  )
  // 京东列表常无独立销量数字，评价数 commentCount 会随「销量」序一起出现；优先真实销量字段。
  const sales = parseCount(
    card.sales ??
      card.sellCount ??
      card.saleCount ??
      card.buyedCount ??
      card.saleQuantities ??
      card.volume ??
      card.realSales ??
      card.view_sales ??
      card.commentCount,
  )
  const comments = parseCount(card.commentCount ?? card.commentsCount)
  const pic = strField(
    card,
    'pic_url',
    'picUrl',
    'img',
    'image',
    'imgurl',
    'imageUrl',
    'pic_path',
  )
  const href = strField(card, 'detail_url', 'detailUrl', 'url', 'itemUrl', 'auctionURL') ?? buildUrl(id)
  const salesLabel =
    typeof card.saleInfo === 'string'
      ? card.saleInfo
      : typeof card.commentCountStr === 'string'
        ? card.commentCountStr
        : undefined

  return makeItem({
    platform,
    id,
    url: href.startsWith('http') ? href : buildUrl(id),
    title,
    body: [price ? `价格: ${price}` : '', salesLabel ? `销量/评价: ${salesLabel}` : '']
      .filter(Boolean)
      .join(' · ') || undefined,
    author: {
      id: strField(shop, 'shopId', 'userId', 'venderId'),
      name: strField(card, 'nick', 'shopName', 'shop') ?? strField(shop, 'name', 'shopName'),
    },
    metrics: {
      comments: comments ?? (platform === 'jd' ? sales : undefined),
    },
    // 销量/评价类计数白名单透传（价格已入 body，非计数指标不塞这里）。
    platformMetrics: {
      ...numericBag(card, [
        'sales',
        'sellCount',
        'saleCount',
        'buyedCount',
        'volume',
        'commentCount',
        'monthSales',
        'totalCount',
        'goodRate',
      ]),
      ...(sales != null ? { sales } : {}),
    },
    media: pic
      ? [{ type: 'image', url: pic.startsWith('//') ? `https:${pic}` : pic }]
      : undefined,
    authContext,
  })
}

export function parseEcommerceSearch(
  platform: EcommercePlatform,
  raw: unknown,
  authContext: AuthContext,
  buildUrl: (id: string) => string,
): NormalizedItem[] {
  const root = coerceJson(raw)
  const paths =
    platform === 'jd'
      ? // live: api.m.jd.com functionId=pc_search_searchWare → data.wareList
        ['data.wareList', 'data.searchm.Paragraph', 'data.items', 'data.list', 'items', 'list']
      : [
          // live: mtop.taobao.wsearch.h5search
          'data.itemsArray',
          'data.data.itemsArray',
          'data.items',
          'data.resultList',
          'data.list',
          'mods.itemlist.data.auctions',
          'itemsArray',
          'items',
          'auctions',
        ]
  const out: NormalizedItem[] = []
  for (const it of pickItemsArray(root, paths)) {
    const parsed = mapProduct(platform, it, authContext, buildUrl)
    if (parsed) out.push(parsed)
  }
  return out
}

export function parseEcommerceDetail(
  platform: EcommercePlatform,
  raw: unknown,
  signedUrl: string,
  authContext: AuthContext,
  buildUrl: (id: string) => string,
): NormalizedItem | null {
  const root = coerceJson(raw)
  const data =
    asRecord(asRecord(root)?.data) ??
    asRecord(asRecord(root)?.item) ??
    asRecord(asRecord(root)?.product) ??
    asRecord(root)
  const parsed = mapProduct(platform, data, authContext, buildUrl)
  if (!parsed) return null
  return { ...parsed, url: signedUrl || parsed.url }
}
