import type { DocumentCommentMentionCandidate } from '../DocumentCommentsSection'

const MAX_MENTION_RESULTS = 8
const MAX_MENTION_QUERY_LENGTH = 20
const MENTION_QUERY_RE = new RegExp(`@([^\\s@]{0,${MAX_MENTION_QUERY_LENGTH}})$`)

export interface CommentComposerMentionState {
  query: string
  startIndex: number
}

export function detectComposerMention(
  value: string,
  cursorPosition: number | null,
): CommentComposerMentionState | null {
  if (cursorPosition == null) return null
  const before = value.slice(0, cursorPosition)
  const match = before.match(MENTION_QUERY_RE)
  if (!match) return null
  return {
    query: match[1] ?? '',
    startIndex: cursorPosition - match[0].length,
  }
}

export function filterComposerMentionCandidates(
  candidates: readonly DocumentCommentMentionCandidate[],
  query: string,
): DocumentCommentMentionCandidate[] {
  const normalized = query.trim().toLowerCase()
  return candidates
    .filter((candidate) => {
      if (!candidate.userId) return false
      if (!normalized) return true
      const haystack = [
        candidate.displayName,
        candidate.accountName,
        candidate.email,
        candidate.userId,
        ...(candidate.labels ?? []),
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
      return haystack.includes(normalized)
    })
    .slice(0, MAX_MENTION_RESULTS)
}

export function applyComposerMention(input: {
  value: string
  mention: CommentComposerMentionState
  candidate: DocumentCommentMentionCandidate
  maxLength: number
}): { value: string; cursor: number; userId: string } {
  const displayName = input.candidate.displayName.trim()
    || input.candidate.accountName?.trim()
    || input.candidate.userId.slice(0, 8)
  const token = `@${displayName} `
  const before = input.value.slice(0, input.mention.startIndex)
  const after = input.value.slice(
    input.mention.startIndex + 1 + input.mention.query.length,
  )
  const next = `${before}${token}${after}`.slice(0, input.maxLength)
  return {
    value: next,
    cursor: Math.min(input.maxLength, before.length + token.length),
    userId: input.candidate.userId,
  }
}

export function mergeMentionUserIds(
  current: readonly string[],
  userId: string,
): string[] {
  if (!userId || current.includes(userId)) return [...current]
  return [...current, userId]
}
