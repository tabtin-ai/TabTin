import { getTableDataClientConfig } from '../config'
import { requestJsonApi, translate } from '../http'
import type {
  CreateRecordCommentRequest,
  CreateRecordCommentResponse,
  DeleteRecordCommentResponse,
  RecordCommentListParams,
  RecordCommentListResponse,
  RecordCommentMentionCandidate,
  RecordCommentCountsResponse,
  RecordCommentStatus,
  RecordCommentStatusFilter,
  UpdateRecordCommentThreadStatusResponse,
} from '../types/record-comment'

const commentMessage = (key: string, fallback: string) => translate(key, fallback)

const recordCommentsEndpoint = (recordId: string): string => {
  const { endpoints } = getTableDataClientConfig()
  return `${endpoints.RECORD.DETAIL(recordId)}/comments`
}

export class RecordCommentApiService {
  static async listComments(
    recordId: string,
    params: RecordCommentListParams = {},
  ): Promise<RecordCommentListResponse> {
    const query = new URLSearchParams()
    if (params.status) query.set('status', params.status)
    if (params.limit != null) query.set('limit', String(params.limit))
    if (params.anchor) {
      query.set('anchor', params.anchor)
    } else {
      const before = params.before ?? params.cursor
      if (before) query.set('before', before)
    }
    const queryString = query.toString()
    const suffix = queryString ? `?${queryString}` : ''

    return requestJsonApi<RecordCommentListResponse>({
      method: 'GET',
      endpoint: `${recordCommentsEndpoint(recordId)}${suffix}`,
      fallbackError: commentMessage('record:comments.loadFailed', '加载评论失败'),
    })
  }

  static async createComment(
    recordId: string,
    data: CreateRecordCommentRequest,
  ): Promise<CreateRecordCommentResponse> {
    return requestJsonApi<CreateRecordCommentResponse>({
      method: 'POST',
      endpoint: recordCommentsEndpoint(recordId),
      body: data,
      expectedStatus: [200, 201],
      fallbackError: commentMessage('record:comments.createFailed', '发送评论失败'),
    })
  }

  static async deleteComment(
    recordId: string,
    commentId: string,
  ): Promise<DeleteRecordCommentResponse> {
    return requestJsonApi<DeleteRecordCommentResponse>({
      method: 'DELETE',
      endpoint: `${recordCommentsEndpoint(recordId)}/${commentId}`,
      fallbackError: commentMessage('record:comments.deleteFailed', '删除评论失败'),
    })
  }

  static async updateThreadStatus(
    recordId: string,
    threadId: string,
    status: RecordCommentStatus,
  ): Promise<UpdateRecordCommentThreadStatusResponse> {
    return requestJsonApi<UpdateRecordCommentThreadStatusResponse>({
      method: 'PATCH',
      endpoint: `${recordCommentsEndpoint(recordId).replace(/\/comments$/, '')}/comment-threads/${threadId}/status`,
      body: { status },
      fallbackError: commentMessage('record:comments.statusFailed', '更新评论状态失败'),
    })
  }

  static async listMentionCandidates(
    recordId: string,
    search = '',
    limit = 50,
  ): Promise<RecordCommentMentionCandidate[]> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (search.trim()) query.set('q', search.trim())
    const result = await requestJsonApi<{ candidates: RecordCommentMentionCandidate[] }>({
      method: 'GET',
      endpoint: `${recordCommentsEndpoint(recordId).replace(/\/comments$/, '')}/comment-mention-candidates?${query.toString()}`,
      fallbackError: commentMessage('record:comments.membersFailed', '加载可提及成员失败'),
    })
    return result.candidates
  }

  static async listCounts(
    tableId: string,
    recordIds: string[],
    status?: RecordCommentStatusFilter,
  ): Promise<RecordCommentCountsResponse> {
    const { endpoints } = getTableDataClientConfig()
    const query = new URLSearchParams({ record_ids: recordIds.join(',') })
    if (status) query.set('status', status)
    return requestJsonApi<RecordCommentCountsResponse>({
      method: 'GET',
      endpoint: `${endpoints.TABLE.DETAIL(tableId)}/record-comment-counts?${query.toString()}`,
      fallbackError: commentMessage('record:comments.countsFailed', '加载评论数失败'),
    })
  }
}
