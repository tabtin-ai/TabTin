import { describe, expect, it } from 'vitest'
import {
  buildNoteUrl,
  coerceJson,
  extractNoteId,
  isSignedNoteUrl,
  parseCount,
  parseXhsComments,
  parseXhsSearchFeed,
} from '../adapters/xiaohongshu-parse'

describe('parseCount', () => {
  it('passes through numbers', () => {
    expect(parseCount(1234)).toBe(1234)
  })
  it('parses 万 / w / k suffixes', () => {
    expect(parseCount('1.2万')).toBe(12000)
    expect(parseCount('3w')).toBe(30000)
    expect(parseCount('3.4k')).toBe(3400)
  })
  it('parses plain numeric strings', () => {
    expect(parseCount('1,024')).toBe(1024)
  })
  it('returns undefined on junk', () => {
    expect(parseCount('赞')).toBeUndefined()
    expect(parseCount(null)).toBeUndefined()
  })
})

describe('signed URL helpers', () => {
  it('detects a signed note URL', () => {
    expect(isSignedNoteUrl('https://www.xiaohongshu.com/explore/64abc?xsec_token=XYZ')).toBe(true)
  })
  it('rejects a bare note URL without token', () => {
    expect(isSignedNoteUrl('https://www.xiaohongshu.com/explore/64abc')).toBe(false)
  })
  it('rejects non-xhs URLs', () => {
    expect(isSignedNoteUrl('https://reddit.com/r/foo?xsec_token=XYZ')).toBe(false)
  })
  it('extracts note id from signed URL', () => {
    expect(extractNoteId('https://www.xiaohongshu.com/explore/64abc?xsec_token=XYZ')).toBe('64abc')
  })
  it('buildNoteUrl embeds xsec_token', () => {
    const u = buildNoteUrl('64abc', 'TOK')
    expect(u).toContain('/explore/64abc')
    expect(u).toContain('xsec_token=TOK')
  })
})

describe('coerceJson', () => {
  it('parses JSON strings', () => {
    expect(coerceJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('returns objects as-is', () => {
    const o = { a: 1 }
    expect(coerceJson(o)).toBe(o)
  })
  it('returns undefined on invalid JSON', () => {
    expect(coerceJson('{not json')).toBeUndefined()
  })
})

describe('parseXhsSearchFeed', () => {
  // fixture 对齐 live 校准后的 note_card 结构；仅验解析逻辑。
  const feed = {
    data: {
      items: [
        {
          id: 'note1',
          xsec_token: 'TOKEN1',
          note_card: {
            display_title: 'AI 浏览器实测',
            user: { user_id: 'u1', nickname: '测评君' },
            interact_info: { liked_count: '1.2万', collected_count: '500', comment_count: '88' },
            cover: { url: 'https://img.xhs/cover1.jpg' },
          },
        },
        {
          id: 'note2',
          xsec_token: 'TOKEN2',
          note_card: {
            display_title: 'Agent 浏览器对比',
            user: { user_id: 'u2', nickname: '数码控' },
            interact_info: { liked_count: 342 },
          },
        },
        { id: '', note_card: {} }, // 脏数据：无 id，应被过滤
      ],
    },
  }

  it('parses items into NormalizedItem[] with signed URLs', () => {
    const items = parseXhsSearchFeed(feed, 'anonymous')
    expect(items).toHaveLength(2)
    expect(items[0].id).toBe('note1')
    expect(items[0].title).toBe('AI 浏览器实测')
    expect(items[0].url).toContain('xsec_token=TOKEN1')
    expect(items[0].metrics?.likes).toBe(12000)
    expect(items[0].author?.name).toBe('测评君')
    expect(items[0].media?.[0].url).toBe('https://img.xhs/cover1.jpg')
    expect(items[0].authContext).toBe('anonymous')
  })

  it('accepts a JSON string body', () => {
    const items = parseXhsSearchFeed(JSON.stringify(feed), 'logged-in')
    expect(items).toHaveLength(2)
    expect(items[1].authContext).toBe('logged-in')
  })

  it('returns [] on empty / malformed input', () => {
    expect(parseXhsSearchFeed('{bad', 'anonymous')).toEqual([])
    expect(parseXhsSearchFeed({}, 'anonymous')).toEqual([])
  })
})

describe('parseXhsComments', () => {
  it('parses comments with nested replies', () => {
    const raw = {
      data: {
        comments: [
          {
            id: 'c1',
            content: '很有用',
            like_count: '12',
            user_info: { user_id: 'u9', nickname: '路人' },
            sub_comments: [{ id: 'c1-1', content: '同感', user_info: { nickname: '楼中楼' } }],
          },
        ],
      },
    }
    const comments = parseXhsComments(raw)
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toBe('很有用')
    expect(comments[0].likes).toBe(12)
    expect(comments[0].replies?.[0].body).toBe('同感')
  })

  it('returns [] when no comments', () => {
    expect(parseXhsComments({})).toEqual([])
  })
})
