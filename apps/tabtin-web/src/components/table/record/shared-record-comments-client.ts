export interface SharedRecordCommentDto {
  id: string
  content?: string
  body?: string
  is_deleted?: boolean
  created_at?: string | null
  mentions?: string[]
  mention_user_ids?: string[]
  actor?: {
    type?: string
    id?: string
    name?: string
    display_name?: string
    avatar?: string | null
  }
  authorization_subject?: {
    id?: string
    name?: string
  }
  capabilities?: {
    can_delete?: boolean
  }
  audit?: {
    agent_run_id?: string | null
  }
  author_name?: string
  author_user_id?: string | null
  author_avatar?: string | null
  author_account_name?: string | null
  can_delete?: boolean
  reply_to?: {
    id?: string
    author_name?: string
    content?: string
    is_deleted?: boolean
  } | null
}

export interface SharedRecordCommentsPage {
  comments: SharedRecordCommentDto[]
  total: number
  has_more: boolean
  next_cursor: string | null
}

export interface SharedRecordCommentsListOptions {
  before?: string | null
  anchor?: string | null
  limit?: number
}

export interface SharedRecordCommentsClientOptions {
  apiBaseUrl: string
  shareId: string
  password?: string
  getAuthHeaders?: () => Record<string, string>
  fetchImpl?: typeof globalThis.fetch
}

export interface CreateSharedRecordCommentInput {
  content: string
  mentionUserIds: string[]
  clientRequestId: string
  replyToCommentId?: string
}

export interface CreateSharedRecordCommentResult {
  comment: SharedRecordCommentDto
  created: boolean
}

export interface SharedRecordCommentMentionCandidateDto {
  user_id: string
  display_name: string
  account_name?: string | null
  avatar?: string | null
  email?: string | null
}

export interface SharedCommentItem {
  id: string
  author_name: string
  author_type: 'human' | 'agent'
  authorization_subject_name: string | null
  agent_run_id: string | null
  author_user_id: string | null
  author_avatar: string | null
  author_account_name: string | null
  body: string
  created_at: string | null
  mention_user_ids: string[]
  can_delete: boolean
  reply_to?: {
    id: string
    author_name: string
    body: string
    is_deleted: boolean
  } | null
}

export interface SharedMentionCandidate {
  userId: string
  displayName: string
  accountName: string | null
  avatar: string | null
  email: string | null
  labels: string[]
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 把共享 API 的审计模型适配为 CommentsSection 的展示模型。 */
export function toCommentItem(
  comment: SharedRecordCommentDto,
): SharedCommentItem {
  const actorType = normalizedString(comment.actor?.type) || 'human'
  const actorName = normalizedString(comment.actor?.name)
    || normalizedString(comment.actor?.display_name)
  const subjectId = normalizedString(comment.authorization_subject?.id)
    || normalizedString(comment.author_user_id)
  const canDelete = comment.capabilities?.can_delete === true || comment.can_delete === true
  const isAgent = actorType === 'agent'
  const authorUserId = isAgent
    ? null
    : normalizedString(comment.actor?.id) || subjectId || null

  return {
    id: String(comment.id),
    author_name: actorName
      || normalizedString(comment.author_name)
      || normalizedString(comment.authorization_subject?.name)
      || '用户',
    author_type: isAgent ? 'agent' : 'human',
    authorization_subject_name: normalizedString(comment.authorization_subject?.name) || null,
    agent_run_id: comment.audit?.agent_run_id ?? null,
    author_user_id: authorUserId,
    author_avatar: comment.actor?.avatar ?? comment.author_avatar ?? null,
    author_account_name: comment.author_account_name ?? null,
    body: normalizedString(comment.content) || normalizedString(comment.body),
    created_at: comment.created_at ?? null,
    mention_user_ids: comment.mentions ?? comment.mention_user_ids ?? [],
    can_delete: canDelete,
    ...(comment.reply_to?.id ? {
      reply_to: {
        id: String(comment.reply_to.id),
        author_name: normalizedString(comment.reply_to.author_name) || '用户',
        body: normalizedString(comment.reply_to.content),
        is_deleted: comment.reply_to.is_deleted === true,
      },
    } : {}),
  }
}

export function toMentionCandidate(
  candidate: SharedRecordCommentMentionCandidateDto,
): SharedMentionCandidate {
  const userId = normalizedString(candidate.user_id)
  const accountName = normalizedString(candidate.account_name)
  const email = normalizedString(candidate.email)
  const displayName = normalizedString(candidate.display_name)
    || accountName
    || userId.slice(0, 8)
  return {
    userId,
    displayName,
    accountName: accountName || null,
    avatar: candidate.avatar ?? null,
    email: email || null,
    labels: [candidate.display_name, candidate.account_name, candidate.email, userId]
      .map(normalizedString)
      .filter(Boolean),
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const json = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const message = typeof json.message === 'string'
      ? json.message
      : typeof json.detail === 'string'
        ? json.detail
        : `HTTP ${response.status}`
    throw new Error(message)
  }
  const data = json.data
  return data && typeof data === 'object' ? data as Record<string, unknown> : json
}

export function createSharedRecordCommentsClient({
  apiBaseUrl,
  shareId,
  password,
  getAuthHeaders = () => ({}),
  fetchImpl = globalThis.fetch,
}: SharedRecordCommentsClientOptions) {
  const recordBaseUrl = `${trimTrailingSlash(apiBaseUrl)}/tabdata/shared/${encodeURIComponent(shareId)}/records`
  const headers = (): Record<string, string> => ({
    ...getAuthHeaders(),
    ...(password ? { 'X-Table-Share-Password': password } : {}),
  })

  return {
    async list(
      recordId: string,
      options: SharedRecordCommentsListOptions = {},
    ): Promise<SharedRecordCommentsPage> {
      const query = new URLSearchParams()
      if (options.anchor) query.set('anchor', options.anchor)
      else if (options.before) query.set('before', options.before)
      if (options.limit != null) query.set('limit', String(options.limit))
      const queryString = query.toString()
      const response = await fetchImpl(
        `${recordBaseUrl}/${encodeURIComponent(recordId)}/comments${queryString ? `?${queryString}` : ''}`,
        { method: 'GET', headers: headers() },
      )
      const data = await readJsonResponse(response)
      const rawComments = Array.isArray(data.comments)
        ? data.comments as SharedRecordCommentDto[]
        : []
      const comments = rawComments.filter((comment) => comment.is_deleted !== true)
      return {
        comments,
        total: typeof data.total === 'number'
          ? Math.max(0, data.total - (rawComments.length - comments.length))
          : comments.length,
        has_more: data.has_more === true,
        next_cursor: typeof data.next_cursor === 'string' ? data.next_cursor : null,
      }
    },

    async create(
      recordId: string,
      input: CreateSharedRecordCommentInput,
    ): Promise<CreateSharedRecordCommentResult> {
      const response = await fetchImpl(
        `${recordBaseUrl}/${encodeURIComponent(recordId)}/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers() },
          body: JSON.stringify({
            content: input.content,
            mention_user_ids: input.mentionUserIds,
            client_request_id: input.clientRequestId,
            ...(input.replyToCommentId ? { reply_to_comment_id: input.replyToCommentId } : {}),
          }),
        },
      )
      const data = await readJsonResponse(response)
      const comment = data.comment
      if (!comment || typeof comment !== 'object') {
        throw new Error('评论响应缺少 comment')
      }
      return {
        comment: comment as SharedRecordCommentDto,
        created: data.created !== false,
      }
    },

    async listMentionCandidates(
      recordId: string,
      search = '',
    ): Promise<SharedRecordCommentMentionCandidateDto[]> {
      const query = new URLSearchParams()
      if (search.trim()) query.set('q', search.trim())
      query.set('limit', '50')
      const response = await fetchImpl(
        `${recordBaseUrl}/${encodeURIComponent(recordId)}/comment-mention-candidates?${query.toString()}`,
        { method: 'GET', headers: headers() },
      )
      const data = await readJsonResponse(response)
      return Array.isArray(data.candidates)
        ? data.candidates as SharedRecordCommentMentionCandidateDto[]
        : []
    },

    async remove(recordId: string, commentId: string): Promise<void> {
      const response = await fetchImpl(
        `${recordBaseUrl}/${encodeURIComponent(recordId)}/comments/${encodeURIComponent(commentId)}`,
        { method: 'DELETE', headers: headers() },
      )
      await readJsonResponse(response)
    },
  }
}
