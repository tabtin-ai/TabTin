import { useCallback, type KeyboardEvent } from 'react'
import { MAX_UNDO_STACK } from './chatInputConstants'
import {
  resolveComposerSkillTokenAtomicDeletion,
  type SlashCommandOption,
} from '../skill/skillSlashCommand'

export interface UseChatInputKeyboardInput {
  slashOpen: boolean
  mentionOpen: boolean
  slashOptions: SlashCommandOption[]
  /** 完整斜杠目录：Skill pill 整块删除用（不受弹层 query 过滤） */
  slashCatalog: SlashCommandOption[]
  slashActiveIndex: number
  setSlashActiveIndex: React.Dispatch<React.SetStateAction<number>>
  closeSkillSlash: () => void
  handleSkillSlashSelect: (option: SlashCommandOption) => void
  handleSend: () => void
  /** 空输入 + 有 Host 排队时 Enter 插队最新 */
  handleInterruptLatest?: () => void
  queueCount?: number
  isStreaming: boolean
  input: string
  inputHistoryRef: React.MutableRefObject<string[]>
  historyIndexRef: React.MutableRefObject<number>
  setInput: React.Dispatch<React.SetStateAction<string>>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

function handleSlashKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  input: UseChatInputKeyboardInput,
): boolean {
  if (!input.slashOpen) return false

  if (event.key === 'Escape') {
    event.preventDefault()
    input.closeSkillSlash()
    return true
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    input.setSlashActiveIndex(prev => input.slashOptions.length > 0 ? (prev + 1) % input.slashOptions.length : 0)
    return true
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    input.setSlashActiveIndex(prev => input.slashOptions.length > 0 ? (prev - 1 + input.slashOptions.length) % input.slashOptions.length : 0)
    return true
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    const selected = input.slashOptions[input.slashActiveIndex] ?? input.slashOptions[0]
    if (selected) input.handleSkillSlashSelect(selected)
    return true
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
    const selected = input.slashOptions[input.slashActiveIndex] ?? input.slashOptions[0]
    if (selected) {
      event.preventDefault()
      input.handleSkillSlashSelect(selected)
      return true
    }
  }
  return false
}

function resizeTextarea(textareaRef: React.RefObject<HTMLTextAreaElement | null>) {
  requestAnimationFrame(() => {
    if (!textareaRef.current) return
    textareaRef.current.style.height = 'auto'
    textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 260) + 'px'
  })
}

function applyHistoryStep(
  direction: 'undo' | 'redo',
  input: UseChatInputKeyboardInput,
) {
  const stack = input.inputHistoryRef.current
  if (direction === 'undo') {
    if (stack[input.historyIndexRef.current] !== input.input) {
      stack.length = input.historyIndexRef.current + 1
      stack.push(input.input)
      if (stack.length > MAX_UNDO_STACK) stack.shift()
      input.historyIndexRef.current = stack.length - 1
    }
    if (input.historyIndexRef.current <= 0) return
    input.historyIndexRef.current -= 1
  } else {
    if (input.historyIndexRef.current >= stack.length - 1) return
    input.historyIndexRef.current += 1
  }
  input.setInput(stack[input.historyIndexRef.current])
  resizeTextarea(input.textareaRef)
}

function handleSkillTokenAtomicDelete(
  event: KeyboardEvent<HTMLTextAreaElement>,
  input: UseChatInputKeyboardInput,
): boolean {
  if (event.key !== 'Backspace' && event.key !== 'Delete') return false
  if (event.nativeEvent.isComposing) return false
  if (event.metaKey || event.ctrlKey || event.altKey) return false

  const textarea = event.currentTarget
  const next = resolveComposerSkillTokenAtomicDeletion({
    value: input.input,
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
    key: event.key,
    options: input.slashCatalog,
  })
  if (!next) return false

  event.preventDefault()
  input.setInput(next.value)
  requestAnimationFrame(() => {
    const el = input.textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(next.cursorPos, next.cursorPos)
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
  })
  return true
}

export function useChatInputKeyboard(input: UseChatInputKeyboardInput) {
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleSlashKeyDown(event, input)) return
    if (input.mentionOpen) return

    if (handleSkillTokenAtomicDelete(event, input)) return

    const isMod = event.metaKey || event.ctrlKey

    if (isMod && event.key === 'z' && !event.shiftKey) {
      event.preventDefault()
      applyHistoryStep('undo', input)
      return
    }

    if ((isMod && event.key === 'z' && event.shiftKey) || (event.ctrlKey && event.key === 'y')) {
      event.preventDefault()
      applyHistoryStep('redo', input)
      return
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      const canInterruptLatest = Boolean(
        input.handleInterruptLatest
        && input.isStreaming
        && (input.queueCount ?? 0) > 0
        && !input.input.trim(),
      )
      if (canInterruptLatest) {
        input.handleInterruptLatest!()
        return
      }
      input.handleSend()
    }
  }, [input])

  return { handleKeyDown }
}
