export type RecordCommentActorType = 'human' | 'agent'
export type RecordCommentStatus = 'open' | 'resolved'
export type RecordCommentStatusFilter = RecordCommentStatus | 'all'

export interface RecordCommentThread {
  id: string
  status: RecordCommentStatus
  resolved_by_user_id?: string | null
  resolved_by_name?: string | null
  resolved_at?: string | null
  capabilities?: {
    can_resolve: boolean
    can_reopen: boolean
  }
}

export interface RecordCommentActor {
  type: RecordCommentActorType
  id: string
  name: string
}

export interface RecordCommentAuthorizationSubject {
  type: 'user'
  id: string
  name: string
}

export interface RecordCommentReplyTarget {
  id: string
  author_name: string
  content: string
  is_deleted: boolean
}

export interface RecordComment {
  id: string
  record_id: string
  content: string
  mentions: string[]
  actor: RecordCommentActor
  authorization_subject: RecordCommentAuthorizationSubject
  client_request_id?: string | null
  reply_to?: RecordCommentReplyTarget | null
  is_deleted: boolean
  created_at: string
  updated_at: string
  deleted_at?: string | null
  audit?: {
    agent_run_id?: string | null
    session_id?: string | null
  }
  capabilities: {
    can_delete: boolean
  }
  /** Added by status-aware servers; optional during rolling upgrades. */
  thread?: RecordCommentThread
}

export interface RecordCommentListParams {
  status?: RecordCommentStatusFilter
  limit?: number
  before?: string | null
  /** Load a page containing this comment (for notification deep links); takes precedence over `before`. */
  anchor?: string | null
  /** @deprecated Use `before`. Kept for older servers during rolling upgrades. */
  cursor?: string | null
}

export interface RecordCommentListResponse {
  comments: RecordComment[]
  total: number
  has_more: boolean
  next_cursor?: string | null
  thread_total?: number
  open_thread_total?: number
}

export interface UpdateRecordCommentThreadStatusResponse {
  thread: RecordCommentThread
}

export interface CreateRecordCommentRequest {
  content: string
  mention_user_ids?: string[]
  client_request_id: string
  reply_to_comment_id?: string
}

export interface CreateRecordCommentResponse {
  comment: RecordComment
  created?: boolean
}

export interface DeleteRecordCommentResponse {
  deleted: boolean
  comment_id: string
  comment?: RecordComment
}

export interface RecordCommentCountsResponse {
  counts: Record<string, number>
  thread_counts?: Record<string, number>
}

export interface RecordCommentMentionCandidate {
  user_id: string
  display_name: string
  account_name?: string | null
  avatar?: string | null
  email?: string | null
}
