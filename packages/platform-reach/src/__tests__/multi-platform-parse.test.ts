import { describe, expect, it } from 'vitest'
import { parseBilibiliSearch, parseBilibiliView, extractBvid } from '../adapters/bilibili-parse'
import {
  parseDouyinSearch,
  parseDouyinDetail,
  parseDouyinComments,
  parseDouyinDomCards,
  detectDouyinSearchNil,
  splitDouyinStreamFrames,
} from '../adapters/douyin-parse'
import {
  cleanEcommerceCardTitle,
  normalizeSearchQuery,
  parseEcommerceDetailDom,
  parseEcommerceDomCards,
  parseEcommerceSearch,
} from '../adapters/ecommerce-parse'
import {
  parseFinanceSearch,
  parseTonghuashunIwencai,
} from '../adapters/finance-parse'
import { createDefaultRegistry, BUILTIN_PLATFORM_IDS } from '../index'

describe('createDefaultRegistry', () => {
  it('registers all builtin platforms', () => {
    const r = createDefaultRegistry()
    expect(r.list().map((a) => a.id).sort()).toEqual([...BUILTIN_PLATFORM_IDS].sort())
    expect(r.resolveByUrl('https://www.bilibili.com/video/BV1xx')?.id).toBe('bilibili')
    expect(r.resolveByUrl('https://item.jd.com/1001.html')?.id).toBe('jd')
    expect(r.resolveByUrl('https://so.eastmoney.com/news/s?keyword=a')?.id).toBe('eastmoney')
  })
})

describe('bilibili-parse', () => {
  it('extracts BV id', () => {
    expect(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD')
  })

  it('parses flat search result', () => {
    const items = parseBilibiliSearch(
      {
        data: {
          result: [
            {
              bvid: 'BV1xx411c7mD',
              title: 'Agent <em class="keyword">浏览器</em>',
              author: 'UP主',
              mid: 1,
              play: 1000,
              video_review: 12,
              arcurl: 'https://www.bilibili.com/video/BV1xx411c7mD',
            },
          ],
        },
      },
      'anonymous',
    )
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Agent 浏览器')
    expect(items[0].id).toBe('BV1xx411c7mD')
    // 播放量走 platformMetrics（未升进通用层），保留平台字段名 play。
    expect(items[0].platformMetrics?.play).toBe(1000)
  })

  it('parses view detail + passes platform-native metrics through', () => {
    const item = parseBilibiliView(
      {
        data: {
          bvid: 'BV1xx411c7mD',
          title: '详解',
          desc: '正文',
          owner: { mid: 2, name: 'UP' },
          stat: { view: 316874, like: 9, reply: 3, favorite: 1, share: 0, coin: 12, danmaku: 7 },
        },
      },
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'anonymous',
    )
    expect(item?.title).toBe('详解')
    // 通用层：只收跨平台可比的核心维度。
    expect(item?.metrics?.likes).toBe(9)
    // 透传层：平台私有指标原样带上（播放量/投币/弹幕），不进 metrics 契约。
    expect(item?.platformMetrics?.view).toBe(316874)
    expect(item?.platformMetrics?.coin).toBe(12)
    expect(item?.platformMetrics?.danmaku).toBe(7)
    expect(item?.metrics).not.toHaveProperty('coin')
  })
})

describe('douyin-parse', () => {
  it('parses aweme search list', () => {
    const items = parseDouyinSearch(
      {
        data: [
          {
            aweme_info: {
              aweme_id: '7123',
              desc: '一条抖音',
              author: { uid: 'u', nickname: '作者' },
              statistics: { digg_count: 10, comment_count: 2 },
            },
          },
        ],
      },
      'anonymous',
    )
    expect(items[0].id).toBe('7123')
    expect(items[0].metrics?.likes).toBe(10)
    // 抖音 statistics 整袋透传（原始字段名）。
    expect(items[0].platformMetrics?.digg_count).toBe(10)
    expect(items[0].platformMetrics?.comment_count).toBe(2)
  })

  it('parses live-shaped feed statistics (2026-07)', () => {
    const items = parseDouyinSearch(
      {
        status_code: 0,
        data: [
          {
            aweme_info: {
              aweme_id: '7666017665584397925',
              desc: '采访与邀请',
              author: { uid: '111', nickname: '作者A' },
              statistics: {
                digg_count: 89054,
                comment_count: 2983,
                share_count: 12984,
                collect_count: 8278,
                play_count: 0,
                // live 详情里 statistics 偶发带 aweme_id；大整数进 number 会丢精度，必须剔除。
                aweme_id: 7666017665584398000,
              },
              share_url: 'https://www.douyin.com/video/7666017665584397925',
            },
          },
        ],
      },
      'anonymous',
    )
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('7666017665584397925')
    expect(items[0].url).toBe('https://www.douyin.com/video/7666017665584397925')
    expect(items[0].metrics?.likes).toBe(89054)
    expect(items[0].metrics?.shares).toBe(12984)
    expect(items[0].platformMetrics?.play_count).toBe(0)
    expect(items[0].platformMetrics?.collect_count).toBe(8278)
    expect(items[0].platformMetrics?.aweme_id).toBeUndefined()
  })

  it('parses search/stream length-prefixed frame + detect verify_check', () => {
    const inner = JSON.stringify({
      status_code: 0,
      data: [],
      has_more: 0,
      search_nil_info: { search_nil_type: 'verify_check', search_nil_item: 'verify_check' },
    })
    const framed = `${inner.length.toString(16)}\r\n${inner}\r\n0\r\n`
    expect(detectDouyinSearchNil(framed)).toBe('verify_check')
    expect(parseDouyinSearch(framed, 'anonymous')).toEqual([])
    expect(splitDouyinStreamFrames(framed).length).toBeGreaterThanOrEqual(1)
  })

  it('parses URI-encoded RENDER_DATA detail', () => {
    const inner = JSON.stringify({
      aweme_detail: {
        aweme_id: '99',
        desc: '详情文案',
        author: { nickname: 'B' },
        statistics: { digg_count: 3 },
      },
    })
    const item = parseDouyinDetail(encodeURIComponent(inner), 'https://www.douyin.com/video/99', 'anonymous')
    expect(item?.id).toBe('99')
    expect(item?.title).toBe('详情文案')
    expect(item?.metrics?.likes).toBe(3)
  })

  it('parses DOM video cards', () => {
    const items = parseDouyinDomCards(
      JSON.stringify([
        { id: '1', url: 'https://www.douyin.com/video/1', title: '卡1' },
        { id: '2', url: 'https://www.douyin.com/video/2' },
      ]),
      'anonymous',
    )
    expect(items.map((i) => i.id)).toEqual(['1', '2'])
    expect(items[0].title).toBe('卡1')
  })

  it('parses comments', () => {
    const comments = parseDouyinComments({
      comments: [{ cid: 'c1', text: '好', user: { nickname: 'A' }, digg_count: 1 }],
    })
    expect(comments[0].body).toBe('好')
  })
})

describe('ecommerce-parse', () => {
  it('parses taobao-like auctions', () => {
    const items = parseEcommerceSearch(
      'taobao',
      { data: { items: [{ nid: '99', title: '键盘', price: '99.00', nick: '店' }] } },
      'anonymous',
      (id) => `https://item.taobao.com/item.htm?id=${id}`,
    )
    expect(items[0].id).toBe('99')
    expect(items[0].url).toContain('id=99')
  })

  it('parses mtop.taobao.wsearch.h5search itemsArray (live shape)', () => {
    const items = parseEcommerceSearch(
      'taobao',
      {
        api: 'mtop.taobao.wsearch.h5search',
        data: {
          itemsArray: [
            {
              item_id: '8411223344',
              title: '露营折叠椅',
              price: '129.00',
              nick: '户外旗舰店',
              pic_url: '//img.alicdn.com/imgextra/i1/xxx.jpg',
              realSales: '2000+',
            },
          ],
        },
        ret: ['SUCCESS::调用成功'],
      },
      'cookie',
      (id) => `https://item.taobao.com/item.htm?id=${id}`,
    )
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('8411223344')
    expect(items[0].title).toBe('露营折叠椅')
    expect(items[0].body).toBe('价格: 129.00')
    expect(items[0].author?.name).toBe('户外旗舰店')
    expect(items[0].media?.[0]?.url).toBe('https://img.alicdn.com/imgextra/i1/xxx.jpg')
  })

  it('parses DOM product cards', () => {
    const items = parseEcommerceDomCards(
      'taobao',
      [
        {
          id: '12',
          url: 'https://item.taobao.com/item.htm?id=12',
          title: '帐篷',
          price: '88',
        },
      ],
      'cookie',
      (id) => `https://item.taobao.com/item.htm?id=${id}`,
    )
    expect(items[0].title).toBe('帐篷')
    expect(items[0].body).toBe('价格: 88')
  })

  it('cleans polluted DOM card titles and parses detail DOM', () => {
    expect(
      cleanEcommerceCardTitle(
        '户外折叠椅 正在秒杀 ¥ 32 .55 补贴后 7000+人付款 河北',
      ),
    ).toBe('户外折叠椅')
    const item = parseEcommerceDetailDom(
      'taobao',
      {
        id: '1046666956501',
        title: '德国户外折叠椅月亮椅露营椅子便携板凳钓鱼靠背野餐凳桌椅装备-淘宝网',
        price: '13.48',
        nick: '汉塞精品店铺4.3好评率86%',
      },
      'https://item.taobao.com/item.htm?id=1046666956501',
      'cookie',
      (id) => `https://item.taobao.com/item.htm?id=${id}`,
    )
    expect(item?.id).toBe('1046666956501')
    expect(item?.title).toBe('德国户外折叠椅月亮椅露营椅子便携板凳钓鱼靠背野餐凳桌椅装备')
    expect(item?.body).toBe('价格: 13.48')
    expect(item?.author?.name).toContain('汉塞')

    const tmall = parseEcommerceDetailDom(
      'taobao',
      {
        id: '1',
        title: '户外折叠椅-tmall.com天猫',
        price: '32.55',
        nick: '源善家具旗舰店',
      },
      'https://detail.tmall.com/item.htm?id=1',
      'cookie',
      (id) => `https://detail.tmall.com/item.htm?id=${id}`,
    )
    expect(tmall?.title).toBe('户外折叠椅')
  })

  it('normalizes double-encoded search query', () => {
    expect(normalizeSearchQuery('%E9%9C%B2%E8%90%A5%E6%A4%85')).toBe('露营椅')
    expect(normalizeSearchQuery('%25E9%259C%25B2%25E8%2590%25A5%25E6%25A4%2585')).toBe(
      '露营椅',
    )
    expect(normalizeSearchQuery('iphone')).toBe('iphone')
  })

  it('parses jd ware list', () => {
    const items = parseEcommerceSearch(
      'jd',
      { data: { wareList: [{ wareId: '100', wareName: '耳机' }] } },
      'anonymous',
      (id) => `https://item.jd.com/${id}.html`,
    )
    expect(items[0].title).toBe('耳机')
  })

  it('parses jd pc_search_searchWare live shape and strips highlight HTML', () => {
    const items = parseEcommerceSearch(
      'jd',
      {
        code: 0,
        data: {
          wareList: [
            {
              wareId: '100078233160',
              skuId: '100078233160',
              wareName: '<font class="skcolor_ljg">露营</font>椅便携',
              jdPrice: '145.00',
            },
          ],
        },
      },
      'cookie',
      (id) => `https://item.jd.com/${id}.html`,
    )
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('100078233160')
    expect(items[0].title).toBe('露营椅便携')
    expect(items[0].url).toBe('https://item.jd.com/100078233160.html')
    expect(items[0].body).toBe('价格: 145.00')
  })

  it('decodes percent-encoded jd DOM/wname titles', () => {
    const items = parseEcommerceDomCards(
      'jd',
      [
        {
          id: '100130520460',
          url: 'https://item.jd.com/100130520460.html',
          title: '%E9%AA%86%E9%A9%BC%E6%88%B7%E5%A4%96%E9%9C%B2%E8%90%A5%E6%8A%98%E5%8F%A0%E6%A4%85',
        },
      ],
      'cookie',
      (id) => `https://item.jd.com/${id}.html`,
    )
    expect(items[0].title).toBe('骆驼户外露营折叠椅')
  })
})

describe('finance-parse', () => {
  it('parses eastmoney cmsArticleWebOld JSONP (live shape)', () => {
    const jsonp =
      'jQuery351_test({"code":0,"msg":"OK","result":{"cmsArticleWebOld":[{' +
      '"date":"2026-07-24 14:59:00","code":"202607243820422690",' +
      '"title":"<em>宁德时代</em>入股屹艮科技",' +
      '"content":"新增<em>宁德时代</em>为股东",' +
      '"mediaName":"界面新闻",' +
      '"url":"http://finance.eastmoney.com/a/202607243820422690.html"' +
      '}]},"searchId":"x"})'
    const items = parseFinanceSearch('eastmoney', jsonp, 'anonymous')
    expect(items).toHaveLength(1)
    expect(items[0].platform).toBe('eastmoney')
    expect(items[0].id).toBe('202607243820422690')
    expect(items[0].title).toBe('宁德时代入股屹艮科技')
    expect(items[0].body).toBe('新增宁德时代为股东')
    expect(items[0].author?.name).toBe('界面新闻')
    expect(items[0].publishedAt).toBe('2026-07-24 14:59:00')
    // JSONP 原文是 http，产物必须升 https（否则 read 撞导航守卫）
    expect(items[0].url).toBe(
      'https://finance.eastmoney.com/a/202607243820422690.html',
    )
    // 文章 code 不是个股代码，不应进 tags
    expect(items[0].tags).toBeUndefined()
  })

  it('still parses legacy eastmoney data.result list', () => {
    const items = parseFinanceSearch(
      'eastmoney',
      { data: { result: [{ newsId: 'n1', title: '行情速递', url: 'https://finance.eastmoney.com/a/1.html' }] } },
      'anonymous',
    )
    expect(items[0].platform).toBe('eastmoney')
    expect(items[0].title).toBe('行情速递')
  })

  it('parses eastmoney DOM fallback array', () => {
    const items = parseFinanceSearch(
      'eastmoney',
      JSON.stringify([
        {
          code: '202607243820422690',
          title: '宁德时代入股屹艮科技',
          url: 'http://finance.eastmoney.com/a/202607243820422690.html',
          date: '2026-07-24 14:59:00',
          content: '新增宁德时代为股东',
        },
      ]),
      'anonymous',
    )
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('宁德时代入股屹艮科技')
    expect(items[0].id).toBe('202607243820422690')
  })

  it('parses tonghuashun legacy news list fallback', () => {
    const items = parseFinanceSearch(
      'tonghuashun',
      { data: { list: [{ id: 't1', title: '研报', url: 'https://news.10jqka.com.cn/1' }] } },
      'anonymous',
    )
    expect(items[0].id).toBe('t1')
  })

  it('parses tonghuashun iwencai SSE into stock card + summary', () => {
    const sse = [
      'data:{"type":"base_info","base_info":{"question":"宁德时代","raw_question":"宁德时代"}}',
      '',
      'data:' +
        JSON.stringify({
          answer_path: 'other/openAnswer',
          section: {
            show_type: 'result_page',
            voice_txt: '宁德时代简介与看点摘要。',
            result_page: {
              components: [
                {
                  show_type: 'txt1',
                  data: {
                    content:
                      '<p>宁德时代新能源科技股份有限公司的主营业务是动力电池。</p>',
                  },
                },
                {
                  show_type: 'impressionLabel',
                  data: {
                    datas: [
                      { 看点: '近5年ROE均超过15%', 类型: '盈利能力', 影响: '利好' },
                    ],
                  },
                },
              ],
              global: {
                subjects: {
                  '300750': {
                    code: '300750',
                    name: '宁德时代',
                    stock_code: '300750.SZ',
                    latest_price: 383.01,
                    rise_fall: -2.98,
                    rise_fall_rate: -0.772,
                  },
                },
              },
            },
          },
        }),
    ].join('\n')

    const items = parseTonghuashunIwencai(sse, 'anonymous', {
      query: '宁德时代',
    })
    expect(items).toHaveLength(1)
    expect(items[0].platform).toBe('tonghuashun')
    expect(items[0].id).toBe('300750')
    expect(items[0].title).toBe('宁德时代')
    expect(items[0].author?.name).toBe('同花顺问财')
    expect(items[0].url).toContain('search.10jqka.com.cn')
    expect(items[0].url).toContain('%E5%AE%81%E5%BE%B7%E6%97%B6%E4%BB%A3')
    expect(items[0].body).toContain('动力电池')
    expect(items[0].body).toContain('近5年ROE均超过15%')
    expect(items[0].platformMetrics?.latest_price).toBe(383.01)
    expect(items[0].tags).toContain('300750.SZ')

    // parseFinanceSearch 应走问财分支
    const viaSearch = parseFinanceSearch('tonghuashun', sse, 'anonymous', {
      query: '宁德时代',
    })
    expect(viaSearch[0]?.id).toBe('300750')
  })

  it('parses tonghuashun voice_txt without subjects (partial SSE)', () => {
    const partial =
      'data:{"section":{"voice_txt":"宁德时代(300750)压力位为386。主营业务是动力电池。"}}'
    const items = parseTonghuashunIwencai(partial, 'anonymous', {
      query: '宁德时代',
    })
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('300750')
    expect(items[0].title).toBe('宁德时代')
    expect(items[0].body).toContain('动力电池')
  })
})
