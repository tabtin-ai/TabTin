import { useCallback, type ChangeEvent, type MutableRefObject, type RefObject } from 'react'
import { UNDO_MERGE_MS, MAX_UNDO_STACK } from './chatInputConstants'
import { syncSlashMentionFromInput } from './useChatInputSlashMentionState'

interface TextareaInputParams {
  setInput: (value: string | ((prev: string) => string)) => void
  inputHistoryRef: MutableRefObject<string[]>
  historyIndexRef: MutableRefObject<number>
  lastHistoryCommitRef: MutableRefObject<number>
  mentionOpen: boolean
  slashOpen: boolean
  setMentionOpen: (open: boolean) => void
  setMentionQuery: (query: string) => void
  setMentionAnchorPos: (pos: number) => void
  setSlashOpen: (open: boolean) => void
  setSlashQuery: (query: string) => void
  setSlashAnchorPos: (pos: number) => void
  setSlashActiveIndex: (index: number) => void
  closeSkillSlash: () => void
}

export function useChatInputTextareaInput({
  setInput,
  inputHistoryRef,
  historyIndexRef,
  lastHistoryCommitRef,
  mentionOpen,
  slashOpen,
  setMentionOpen,
  setMentionQuery,
  setMentionAnchorPos,
  setSlashOpen,
  setSlashQuery,
  setSlashAnchorPos,
  setSlashActiveIndex,
  closeSkillSlash,
}: TextareaInputParams) {
  const handleInput = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value
    setInput(value)

    const stack = inputHistoryRef.current
    const now = Date.now()
    const elapsed = now - lastHistoryCommitRef.current
    const prevValue = stack[historyIndexRef.current] ?? ''
    const isLargeChange = Math.abs(value.length - prevValue.length) > 10

    stack.length = historyIndexRef.current + 1
    if (!isLargeChange && elapsed < UNDO_MERGE_MS && stack.length > 1) {
      stack[stack.length - 1] = value
    } else {
      stack.push(value)
      if (stack.length > MAX_UNDO_STACK) stack.shift()
      historyIndexRef.current = stack.length - 1
    }
    lastHistoryCommitRef.current = now

    const textarea = event.target
    textarea.style.height = 'auto'
    textarea.style.height = Math.min(textarea.scrollHeight, 260) + 'px'

    syncSlashMentionFromInput({
      value,
      cursorPos: textarea.selectionStart,
      mentionOpen,
      slashOpen,
      setMentionOpen,
      setMentionQuery,
      setMentionAnchorPos,
      setSlashOpen,
      setSlashQuery,
      setSlashAnchorPos,
      setSlashActiveIndex,
      closeSkillSlash,
    })
  }, [
    closeSkillSlash,
    historyIndexRef,
    inputHistoryRef,
    lastHistoryCommitRef,
    mentionOpen,
    setInput,
    setMentionAnchorPos,
    setMentionOpen,
    setMentionQuery,
    setSlashActiveIndex,
    setSlashAnchorPos,
    setSlashOpen,
    setSlashQuery,
    slashOpen,
  ])

  return { handleInput }
}

export type TextareaRef = RefObject<HTMLTextAreaElement | null>
