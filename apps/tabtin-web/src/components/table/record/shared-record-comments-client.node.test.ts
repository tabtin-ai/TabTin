import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSharedRecordCommentsClient,
  toCommentItem,
  toMentionCandidate,
} from './shared-record-comments-client.ts'
import { mergeOlderComments } from './shared-record-comments-state.ts'

test('list 使用 shared canonical 路径并同时携带登录态与分享密码', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = createSharedRecordCommentsClient({
    apiBaseUrl: '/api',
    shareId: 'share/1',
    password: 'secret',
    getAuthHeaders: () => ({ Authorization: 'Bearer access-token' }),
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init })
      return new Response(JSON.stringify({
        data: {
          comments: [{ id: 'comment-1', content: '请核对' }],
          total: 1,
          has_more: false,
          next_cursor: null,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  const result = await client.list('record/1')

  assert.equal(requests[0]?.url, '/api/tabdata/shared/share%2F1/records/record%2F1/comments')
  assert.equal(requests[0]?.init?.method, 'GET')
  const headers = new Headers(requests[0]?.init?.headers)
  assert.equal(headers.get('Authorization'), 'Bearer access-token')
  assert.equal(headers.get('X-Table-Share-Password'), 'secret')
  assert.equal(result.total, 1)
  assert.equal(result.comments[0]?.id, 'comment-1')
})

test('list 透传稳定游标分页参数', async () => {
  const requestedUrls: string[] = []
  const client = createSharedRecordCommentsClient({
    apiBaseUrl: '/api',
    shareId: 'share-1',
    fetchImpl: async (input) => {
      requestedUrls.push(String(input))
      return new Response(JSON.stringify({ data: { comments: [], total: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  await client.list('record-1', { before: 'ignored-cursor', anchor: 'comment/target', limit: 50 })
  await client.list('record-1', { before: 'cursor/next', limit: 50 })

  assert.deepEqual(requestedUrls, [
    '/api/tabdata/shared/share-1/records/record-1/comments?anchor=comment%2Ftarget&limit=50',
    '/api/tabdata/shared/share-1/records/record-1/comments?before=cursor%2Fnext&limit=50',
  ])
})

test('加载更早评论时前置且不重复已有项', () => {
  assert.deepEqual(
    mergeOlderComments(
      [{ id: 'comment-2' }, { id: 'comment-3' }],
      [{ id: 'comment-1' }, { id: 'comment-2' }],
    ),
    [{ id: 'comment-1' }, { id: 'comment-2' }, { id: 'comment-3' }],
  )
})

test('create 发送正文、真实 mention ids 与可复用的幂等键', async () => {
  let captured: { url: string; init?: RequestInit } | null = null
  const client = createSharedRecordCommentsClient({
    apiBaseUrl: '/api/',
    shareId: 'share-1',
    password: 'secret',
    fetchImpl: async (input, init) => {
      captured = { url: String(input), init }
      return new Response(JSON.stringify({
        data: { comment: { id: 'comment-2', content: '请 @小王 核对' }, created: true },
      }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    },
  })

  const result = await client.create('record-1', {
    content: '请 @小王 核对',
    mentionUserIds: ['user-2'],
    clientRequestId: 'request-1',
    replyToCommentId: 'comment-parent',
  })

  const createRequest = captured as { url: string; init?: RequestInit } | null
  assert.ok(createRequest)
  assert.equal(createRequest.url, '/api/tabdata/shared/share-1/records/record-1/comments')
  assert.equal(createRequest.init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(createRequest.init?.body)), {
    content: '请 @小王 核对',
    mention_user_ids: ['user-2'],
    client_request_id: 'request-1',
    reply_to_comment_id: 'comment-parent',
  })
  const headers = new Headers(createRequest.init?.headers)
  assert.equal(headers.get('Content-Type'), 'application/json')
  assert.equal(headers.get('X-Table-Share-Password'), 'secret')
  assert.equal(result.comment.id, 'comment-2')
  assert.equal(result.created, true)
})

test('mention candidates 使用记录级 shared canonical 路径', async () => {
  let requestedUrl = ''
  const client = createSharedRecordCommentsClient({
    apiBaseUrl: '/api',
    shareId: 'share-1',
    password: 'secret',
    fetchImpl: async (input) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({
        data: {
          candidates: [{ user_id: 'user-2', display_name: '小王' }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  const candidates = await client.listMentionCandidates('record-1', 'review')

  assert.equal(
    requestedUrl,
    '/api/tabdata/shared/share-1/records/record-1/comment-mention-candidates?q=review&limit=50',
  )
  assert.deepEqual(candidates, [{ user_id: 'user-2', display_name: '小王' }])
})

test('remove 只向当前记录下的目标评论发送 DELETE', async () => {
  let captured: { url: string; init?: RequestInit } | null = null
  const client = createSharedRecordCommentsClient({
    apiBaseUrl: '/api',
    shareId: 'share-1',
    password: 'secret',
    fetchImpl: async (input, init) => {
      captured = { url: String(input), init }
      return new Response(JSON.stringify({
        data: { deleted: true, comment_id: 'comment/1' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  await client.remove('record/1', 'comment/1')

  const deleteRequest = captured as { url: string; init?: RequestInit } | null
  assert.ok(deleteRequest)
  assert.equal(
    deleteRequest.url,
    '/api/tabdata/shared/share-1/records/record%2F1/comments/comment%2F1',
  )
  assert.equal(deleteRequest.init?.method, 'DELETE')
  assert.equal(deleteRequest.init?.body, undefined)
  assert.equal(
    new Headers(deleteRequest.init?.headers).get('X-Table-Share-Password'),
    'secret',
  )
})

test('把后端 actor/authorization_subject/capabilities 映射为共享评论组件模型', () => {
  assert.deepEqual(
    toCommentItem({
      id: 'comment-1',
      content: 'Agent 已处理 @小王',
      mentions: ['user-2'],
      actor: { type: 'agent', id: 'agent-1', name: '整理助手' },
      authorization_subject: { id: 'user-1', name: '张三' },
      audit: { agent_run_id: 'run-1' },
      capabilities: { can_delete: true },
      reply_to: {
        id: 'comment-parent',
        author_name: '李四',
        content: '原评论',
        is_deleted: false,
      },
      created_at: '2026-08-10T08:00:00Z',
    }),
    {
      id: 'comment-1',
      author_name: '整理助手',
      author_type: 'agent',
      authorization_subject_name: '张三',
      agent_run_id: 'run-1',
      author_user_id: null,
      author_avatar: null,
      author_account_name: null,
      body: 'Agent 已处理 @小王',
      mention_user_ids: ['user-2'],
      created_at: '2026-08-10T08:00:00Z',
      can_delete: true,
      reply_to: {
        id: 'comment-parent',
        author_name: '李四',
        body: '原评论',
        is_deleted: false,
      },
    },
  )
})

test('把 mention candidate 映射为共享评论组件需要的稳定字段', () => {
  assert.deepEqual(
    toMentionCandidate({
      user_id: 'user-2',
      display_name: '',
      account_name: 'xiaowang',
      email: 'wang@example.com',
      avatar: null,
    }),
    {
      userId: 'user-2',
      displayName: 'xiaowang',
      accountName: 'xiaowang',
      email: 'wang@example.com',
      avatar: null,
      labels: ['xiaowang', 'wang@example.com', 'user-2'],
    },
  )
})

test('shared adapter never exposes soft-deleted comments', async () => {
  const client = createSharedRecordCommentsClient({
    apiBaseUrl: '/api',
    shareId: 'share-1',
    fetchImpl: async () => new Response(JSON.stringify({
      data: {
        comments: [
          { id: 'visible', content: 'visible' },
          { id: 'deleted', content: 'deleted', is_deleted: true },
        ],
        total: 2,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })

  const result = await client.list('record-1')
  assert.deepEqual(result.comments.map((comment) => comment.id), ['visible'])
  assert.equal(result.total, 1)
})
