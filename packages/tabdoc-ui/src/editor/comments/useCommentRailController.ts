import { useCallback, useState } from 'react'

export interface CommentRailController {
  railOpen: boolean
  activeThreadId: string | null
  setRailOpen: (open: boolean) => void
  setActiveThreadId: (threadId: string | null) => void
  openThread: (threadId: string | null) => void
  clearActiveThreadUnlessCommentTarget: (target: EventTarget | null) => void
}

export function useCommentRailController(): CommentRailController {
  const [railOpen, setRailOpenState] = useState(false)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)

  const setRailOpen = useCallback((open: boolean) => {
    setRailOpenState(open)
    if (!open) setActiveThreadId(null)
  }, [])

  const openThread = useCallback((threadId: string | null) => {
    setActiveThreadId(threadId)
    setRailOpenState(true)
  }, [])

  const clearActiveThreadUnlessCommentTarget = useCallback((target: EventTarget | null) => {
    if (target instanceof Element && target.closest('[data-comment-thread-id]')) return
    setActiveThreadId(null)
  }, [])

  return {
    railOpen,
    activeThreadId,
    setRailOpen,
    setActiveThreadId,
    openThread,
    clearActiveThreadUnlessCommentTarget,
  }
}
