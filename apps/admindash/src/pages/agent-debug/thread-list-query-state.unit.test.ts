import { describe, expect, it } from 'vitest'

import {
  parseThreadListQuery,
  serializeThreadListQuery,
  threadDetailHref,
} from './thread-list-query-state'

describe('Agent 会话列表 URL 状态 ', () => {
  it('从 URL 恢复筛选、状态和分页', () => {
    expect(
      parseThreadListQuery(
        new URLSearchParams(
          'keyword=session-1&title=经营周报&user=13800138000&organization=示例组织&status=error&page=3&page_size=50'
        )
      )
    ).toEqual({
      keyword: 'session-1',
      sessionTitle: '经营周报',
      user: '13800138000',
      organization: '示例组织',
      status: 'error',
      page: 3,
      pageSize: 50,
    })
  })

  it('忽略非法分页与状态并使用安全默认值', () => {
    expect(
      parseThreadListQuery(new URLSearchParams('status=unknown&page=-1&page_size=999'))
    ).toEqual({
      keyword: '',
      sessionTitle: '',
      user: '',
      organization: '',
      status: 'all',
      page: 1,
      pageSize: 20,
    })
  })

  it('详情链接与返回列表都携带同一查询串', () => {
    const params = serializeThreadListQuery({
      keyword: '',
      sessionTitle: '经营周报',
      user: '13800138000',
      organization: '',
      status: 'running',
      page: 2,
      pageSize: 20,
    })

    expect(params.toString()).toBe(
      'title=%E7%BB%8F%E8%90%A5%E5%91%A8%E6%8A%A5&user=13800138000&status=running&page=2'
    )
    expect(threadDetailHref('chat-session-1', params)).toBe(
      '/threads/chat-session-1?title=%E7%BB%8F%E8%90%A5%E5%91%A8%E6%8A%A5&user=13800138000&status=running&page=2'
    )
  })
})
