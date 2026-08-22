import { create } from 'zustand'

export interface TabDocPendingReveal {
  kind: 'doc_selection'
  blockIds?: string[]
  fullText?: string
  requestId: number
}

interface TabDocRevealState {
  pendingRevealByDocId: Record<string, TabDocPendingReveal>
  setPendingReveal: (
    docId: string,
    reveal: Omit<TabDocPendingReveal, 'requestId'>,
  ) => void
  consumePendingReveal: (docId: string, requestId?: number) => TabDocPendingReveal | null
}

let nextRevealRequestId = 1

function normalizeReveal(reveal: Omit<TabDocPendingReveal, 'requestId'>): Omit<TabDocPendingReveal, 'requestId'> {
  const blockIds = reveal.blockIds
    ?.map(id => id.trim())
    .filter(Boolean)
  const fullText = reveal.fullText?.trim()
  return {
    kind: 'doc_selection',
    ...(blockIds && blockIds.length > 0 ? { blockIds } : {}),
    ...(fullText ? { fullText } : {}),
  }
}

export const useTabDocRevealStore = create<TabDocRevealState>()((set, get) => ({
  pendingRevealByDocId: {},

  setPendingReveal: (docId, reveal) => {
    const normalized = normalizeReveal(reveal)
    if (!docId || (!normalized.blockIds?.length && !normalized.fullText)) return
    set(state => ({
      pendingRevealByDocId: {
        ...state.pendingRevealByDocId,
        [docId]: {
          ...normalized,
          requestId: nextRevealRequestId++,
        },
      },
    }))
  },

  consumePendingReveal: (docId, requestId) => {
    const current = get().pendingRevealByDocId[docId]
    if (!current) return null
    if (requestId !== undefined && current.requestId !== requestId) return null
    set(state => {
      const next = { ...state.pendingRevealByDocId }
      delete next[docId]
      return { pendingRevealByDocId: next }
    })
    return current
  },
}))
