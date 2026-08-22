import { useState, useRef, useEffect, useMemo, type RefObject } from 'react'
import {
  resolveDraftKey,
  saveDraft,
  loadDraft,
  clearDraft,
  COMPOSER_DRAFT_EXTERNAL_SET_EVENT,
  emitComposerDraftPresence,
} from './chatInputDraft'

export function useChatInputDraftLifecycle(
  sessionId: string | null | undefined,
  spaceId: string | null | undefined,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
) {
  const draftKey = useMemo(() => resolveDraftKey(sessionId, spaceId), [sessionId, spaceId])
  const [input, setInput] = useState(() => {
    const key = resolveDraftKey(sessionId, spaceId)
    return key ? loadDraft(key) : ''
  })

  const inputHistoryRef = useRef([input])
  const historyIndexRef = useRef(0)
  const lastHistoryCommitRef = useRef(0)
  const inputRef = useRef(input)
  const draftKeyRef = useRef(draftKey)
  inputRef.current = input
  draftKeyRef.current = draftKey

  const applyDraftValue = (draft: string) => {
    setInput(draft)
    inputRef.current = draft
    inputHistoryRef.current = [draft]
    historyIndexRef.current = 0
    lastHistoryCommitRef.current = 0
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      if (draft) {
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 260) + 'px'
      }
    }
  }

  const prevDraftKeyRef = useRef(draftKey)
  useEffect(() => {
    if (draftKey === prevDraftKeyRef.current) return

    const prevKey = prevDraftKeyRef.current
    if (prevKey) {
      const outgoing = inputRef.current
      if (outgoing) saveDraft(prevKey, outgoing)
      else clearDraft(prevKey)
    }

    applyDraftValue(draftKey ? loadDraft(draftKey) : '')
    prevDraftKeyRef.current = draftKey
  }, [draftKey])

  useEffect(() => {
    if (!draftKey) return
    const timer = setTimeout(() => {
      const latestInput = inputRef.current
      if (latestInput) saveDraft(draftKey, latestInput)
      else clearDraft(draftKey)
    }, 500)
    return () => clearTimeout(timer)
  }, [input, draftKey])

  const prevHasTextRef = useRef(Boolean(input.trim()))
  useEffect(() => {
    if (!draftKey) return
    const hasText = Boolean(input.trim())
    if (hasText === prevHasTextRef.current) return
    prevHasTextRef.current = hasText
    emitComposerDraftPresence(draftKey, hasText)
  }, [draftKey, input])

  useEffect(() => {
    const onExternalSet = (event: Event) => {
      const detail = (event as CustomEvent<{ draftKey?: string; value?: string }>).detail
      if (!detail?.draftKey || detail.draftKey !== draftKeyRef.current) return
      if (typeof detail.value !== 'string') return
      applyDraftValue(detail.value)
    }
    window.addEventListener(COMPOSER_DRAFT_EXTERNAL_SET_EVENT, onExternalSet)
    return () => window.removeEventListener(COMPOSER_DRAFT_EXTERNAL_SET_EVENT, onExternalSet)
  }, [])

  useEffect(() => {
    return () => {
      const key = draftKeyRef.current
      if (!key) return
      const value = inputRef.current
      if (value) saveDraft(key, value)
      else clearDraft(key)
    }
  }, [])

  return {
    draftKey,
    input,
    setInput,
    inputRef,
    inputHistoryRef,
    historyIndexRef,
    lastHistoryCommitRef,
  }
}
