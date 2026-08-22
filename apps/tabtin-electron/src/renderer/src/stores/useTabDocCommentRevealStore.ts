import { create } from 'zustand'

export interface TabDocCommentRevealRequest {
  threadId: string
  commentId?: string
  requestId: number
}

interface TabDocCommentRevealState {
  pendingByDocumentId: Record<string, TabDocCommentRevealRequest>
  requestCommentReveal: (
    documentId: string,
    target: Omit<TabDocCommentRevealRequest, 'requestId'>,
  ) => void
  consumeCommentReveal: (documentId: string, requestId: number) => void
}

let nextRequestId = 1

export const useTabDocCommentRevealStore = create<TabDocCommentRevealState>()((set, get) => ({
  pendingByDocumentId: {},

  requestCommentReveal: (documentId, target) => {
    const normalizedDocumentId = documentId.trim()
    const normalizedThreadId = target.threadId.trim()
    const normalizedCommentId = target.commentId?.trim()
    if (!normalizedDocumentId || !normalizedThreadId) return

    set(state => ({
      pendingByDocumentId: {
        ...state.pendingByDocumentId,
        [normalizedDocumentId]: {
          threadId: normalizedThreadId,
          ...(normalizedCommentId ? { commentId: normalizedCommentId } : {}),
          requestId: nextRequestId++,
        },
      },
    }))
  },

  consumeCommentReveal: (documentId, requestId) => {
    const current = get().pendingByDocumentId[documentId]
    if (!current || current.requestId !== requestId) return

    set(state => {
      const pendingByDocumentId = { ...state.pendingByDocumentId }
      delete pendingByDocumentId[documentId]
      return { pendingByDocumentId }
    })
  },
}))
