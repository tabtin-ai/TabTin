import type {
  CreateRecordCommentRequest,
  CreateRecordCommentResponse,
  DeleteRecordCommentResponse,
  RecordCommentListParams,
  RecordCommentListResponse,
  RecordCommentMentionCandidate,
} from '@tabtin/table-core'
import type {
  CreateSharedRecordCommentInput,
  CreateSharedRecordCommentResult,
  SharedRecordCommentMentionCandidateDto,
  SharedRecordCommentsListOptions,
  SharedRecordCommentsPage,
} from './shared-record-comments-client'

export interface RecordCommentsClient {
  list: (recordId: string, options?: SharedRecordCommentsListOptions) => Promise<SharedRecordCommentsPage>
  create: (recordId: string, input: CreateSharedRecordCommentInput) => Promise<CreateSharedRecordCommentResult>
  listMentionCandidates: (recordId: string, search?: string) => Promise<SharedRecordCommentMentionCandidateDto[]>
  remove: (recordId: string, commentId: string) => Promise<void>
}

export interface InternalRecordCommentsGateway {
  listComments: (recordId: string, params?: RecordCommentListParams) => Promise<RecordCommentListResponse>
  createComment: (recordId: string, data: CreateRecordCommentRequest) => Promise<CreateRecordCommentResponse>
  listMentionCandidates: (
    recordId: string,
    search?: string,
    limit?: number,
  ) => Promise<RecordCommentMentionCandidate[]>
  deleteComment: (recordId: string, commentId: string) => Promise<DeleteRecordCommentResponse>
}

/** Adapts the authenticated canonical API to the same state-machine contract as shared comments. */
export function createInternalRecordCommentsClient(
  gateway: InternalRecordCommentsGateway,
): RecordCommentsClient {
  return {
    async list(recordId, options = {}) {
      const result = await gateway.listComments(recordId, {
        limit: options.limit,
        ...(options.anchor
          ? { anchor: options.anchor }
          : options.before
            ? { before: options.before }
            : {}),
      })
      const comments = result.comments.filter((comment) => comment.is_deleted !== true)
      return {
        comments,
        total: Math.max(0, result.total - (result.comments.length - comments.length)),
        has_more: result.has_more,
        next_cursor: result.next_cursor ?? null,
      }
    },

    async create(recordId, input) {
      const result = await gateway.createComment(recordId, {
        content: input.content,
        mention_user_ids: input.mentionUserIds,
        client_request_id: input.clientRequestId,
        ...(input.replyToCommentId ? { reply_to_comment_id: input.replyToCommentId } : {}),
      })
      return {
        comment: result.comment,
        created: result.created !== false,
      }
    },

    async listMentionCandidates(recordId, search = '') {
      return gateway.listMentionCandidates(recordId, search, 50)
    },

    async remove(recordId, commentId) {
      await gateway.deleteComment(recordId, commentId)
    },
  }
}
