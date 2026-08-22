import assert from 'node:assert/strict'
import test from 'node:test'
import { createInternalRecordCommentsClient, type InternalRecordCommentsGateway } from './record-comments-client.ts'

test('authenticated adapter preserves paging, anchor, create idempotency, search, and delete contracts', async () => {
  const calls: Array<{ name: string; args: unknown[] }> = []
  const gateway: InternalRecordCommentsGateway = {
    async listComments(...args) {
      calls.push({ name: 'list', args })
      return { comments: [], total: 0, has_more: false, next_cursor: null }
    },
    async createComment(...args) {
      calls.push({ name: 'create', args })
      return {
        comment: {
          id: 'comment-1',
          record_id: 'record-1',
          content: 'hello',
          mentions: [],
          actor: { type: 'human', id: 'user-1', name: 'User One' },
          authorization_subject: { type: 'user', id: 'user-1', name: 'User One' },
          is_deleted: false,
          created_at: '2026-08-10T00:00:00Z',
          updated_at: '2026-08-10T00:00:00Z',
          capabilities: { can_delete: true },
        },
        created: false,
      }
    },
    async listMentionCandidates(...args) {
      calls.push({ name: 'candidates', args })
      return [{ user_id: 'user-1', display_name: 'User One' }]
    },
    async deleteComment(...args) {
      calls.push({ name: 'delete', args })
      return { deleted: true, comment_id: args[1] }
    },
  }
  const client = createInternalRecordCommentsClient(gateway)

  await client.list('record-1', { before: 'ignored-cursor', anchor: 'comment-1', limit: 20 })
  await client.list('record-1', { before: 'cursor-1', limit: 20 })
  const created = await client.create('record-1', {
    content: 'hello',
    mentionUserIds: ['user-1'],
    clientRequestId: 'request-1',
    replyToCommentId: 'comment-parent',
  })
  await client.listMentionCandidates('record-1', 'user')
  await client.remove('record-1', 'comment-1')

  assert.deepEqual(calls, [
    { name: 'list', args: ['record-1', { limit: 20, anchor: 'comment-1' }] },
    { name: 'list', args: ['record-1', { limit: 20, before: 'cursor-1' }] },
    { name: 'create', args: ['record-1', { content: 'hello', mention_user_ids: ['user-1'], client_request_id: 'request-1', reply_to_comment_id: 'comment-parent' }] },
    { name: 'candidates', args: ['record-1', 'user', 50] },
    { name: 'delete', args: ['record-1', 'comment-1'] },
  ])
  assert.equal(created.created, false)
})

test('authenticated adapter never exposes soft-deleted comments', async () => {
  const gateway = {
    async listComments() {
      const base = {
        record_id: 'record-1',
        content: 'content',
        mentions: [],
        actor: { type: 'human' as const, id: 'user-1', name: 'User One' },
        authorization_subject: { type: 'user' as const, id: 'user-1', name: 'User One' },
        created_at: '2026-08-10T00:00:00Z',
        updated_at: '2026-08-10T00:00:00Z',
        capabilities: { can_delete: false },
      }
      return {
        comments: [
          { ...base, id: 'visible', is_deleted: false },
          { ...base, id: 'deleted', is_deleted: true },
        ],
        total: 2,
        has_more: false,
      }
    },
    async createComment() { throw new Error('not used') },
    async listMentionCandidates() { return [] },
    async deleteComment() { throw new Error('not used') },
  } satisfies InternalRecordCommentsGateway

  const result = await createInternalRecordCommentsClient(gateway).list('record-1')
  assert.deepEqual(result.comments.map((comment) => comment.id), ['visible'])
  assert.equal(result.total, 1)
})
