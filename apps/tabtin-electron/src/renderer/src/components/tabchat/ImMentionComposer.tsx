import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react'
import { cn } from '@utils/cn'
import {
  getMentionComposerMarkdownSelection,
  mentionComposerClipboardFromSelection,
  readMentionComposerClipboard,
  renderMentionComposerValue,
  serializeMentionComposerElement,
  setMentionComposerCaret,
  writeMentionComposerClipboard,
} from './imMentionComposerModel'
import { MENTION_COMPOSER_CLIPBOARD_MIME } from './mentionMarkdown'
import {
  IM_COMPOSER_TEXT,
  IM_COMPOSER_TEXTAREA_MAX_HEIGHT,
  IM_COMPOSER_TEXTAREA_MAX_HEIGHT_PX,
  IM_COMPOSER_TEXTAREA_MIN_HEIGHT,
  IM_MENTION_COMPOSER_EMPTY_PLACEHOLDER_CLASS,
} from './tabchatUi'

export const IM_MENTION_COMPOSER_VISUAL_TEST_ID = 'im-mention-composer-visual'

export type ImMentionComposerHandle = {
  focus: () => void
  syncHeight: () => void
  syncSelectionToTextarea: () => void
  restoreCaretFromTextarea: () => void
}

interface Props {
  value: string
  onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (event: React.KeyboardEvent) => void
  onPaste: (event: React.ClipboardEvent) => void
  placeholder: string
  disabled?: boolean
  composerRef?: React.Ref<ImMentionComposerHandle>
  className?: string
}

export const ImMentionComposer = forwardRef<HTMLTextAreaElement, Props>(function ImMentionComposer(
  {
    value,
    onChange,
    onKeyDown,
    onPaste,
    placeholder,
    disabled = false,
    composerRef,
    className,
  },
  forwardedRef,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const visualRef = useRef<HTMLDivElement>(null)

  const assignTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node
    if (typeof forwardedRef === 'function') {
      forwardedRef(node)
    } else if (forwardedRef) {
      forwardedRef.current = node
    }
  }, [forwardedRef])

  const syncHeight = useCallback(() => {
    const visual = visualRef.current
    if (!visual) return
    visual.style.height = 'auto'
    visual.style.height = `${Math.min(visual.scrollHeight, IM_COMPOSER_TEXTAREA_MAX_HEIGHT_PX)}px`
  }, [])

  const emitChange = useCallback((next: string, caret: number) => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.setSelectionRange(caret, caret)
    onChange({
      target: {
        value: next,
        selectionStart: caret,
        selectionEnd: caret,
        style: textarea.style,
      },
    } as React.ChangeEvent<HTMLTextAreaElement>)
  }, [onChange])

  const syncSelectionToTextarea = useCallback(() => {
    const visual = visualRef.current
    const textarea = textareaRef.current
    if (!visual || !textarea || document.activeElement !== visual) return
    const selection = getMentionComposerMarkdownSelection(visual)
    textarea.setSelectionRange(selection.start, selection.end)
  }, [])

  const restoreCaretFromTextarea = useCallback(() => {
    const visual = visualRef.current
    const textarea = textareaRef.current
    if (!visual || !textarea) return
    setMentionComposerCaret(
      visual,
      textarea.selectionStart ?? value.length,
      textarea.selectionEnd ?? value.length,
    )
  }, [value.length])

  const focusVisual = useCallback(() => {
    visualRef.current?.focus()
  }, [])

  useImperativeHandle(composerRef, () => ({
    focus: focusVisual,
    syncHeight,
    syncSelectionToTextarea,
    restoreCaretFromTextarea,
  }), [focusVisual, restoreCaretFromTextarea, syncHeight, syncSelectionToTextarea])

  useLayoutEffect(() => {
    const visual = visualRef.current
    if (!visual) return
    const current = serializeMentionComposerElement(visual)
    if (current === value) {
      syncHeight()
      return
    }
    renderMentionComposerValue(visual, value)
    restoreCaretFromTextarea()
    syncHeight()
  }, [restoreCaretFromTextarea, syncHeight, value])

  const handleVisualInput = useCallback(() => {
    const visual = visualRef.current
    if (!visual || disabled) return
    const next = serializeMentionComposerElement(visual)
    const caret = getMentionComposerMarkdownSelection(visual).end
    emitChange(next, caret)
    syncHeight()
  }, [disabled, emitChange, syncHeight])

  const handleVisualKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown(event)
  }, [onKeyDown])

  const insertAtMarkdownSelection = useCallback((pasted: string) => {
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? value.length
    const end = textarea?.selectionEnd ?? start
    const next = `${value.slice(0, start)}${pasted}${value.slice(end)}`
    emitChange(next, start + pasted.length)
  }, [emitChange, value])

  const handleVisualCopy = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    const visual = visualRef.current
    if (!visual) return
    const payload = mentionComposerClipboardFromSelection(visual)
    if (!payload) return
    event.preventDefault()
    writeMentionComposerClipboard(event.clipboardData, payload)
  }, [])

  const handleVisualCut = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    const visual = visualRef.current
    if (!visual || disabled) return
    const payload = mentionComposerClipboardFromSelection(visual)
    if (!payload) return
    event.preventDefault()
    writeMentionComposerClipboard(event.clipboardData, payload)
    const { start, end } = getMentionComposerMarkdownSelection(visual)
    const next = `${value.slice(0, start)}${value.slice(end)}`
    emitChange(next, start)
  }, [disabled, emitChange, value])

  const handleVisualPaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    syncSelectionToTextarea()
    const mentionMarkdown = event.clipboardData?.getData(MENTION_COMPOSER_CLIPBOARD_MIME)
    if (mentionMarkdown) {
      event.preventDefault()
      insertAtMarkdownSelection(mentionMarkdown)
      return
    }
    onPaste(event)
    if (event.defaultPrevented) return
    const pasted = readMentionComposerClipboard(event.clipboardData)
    if (!pasted) return
    event.preventDefault()
    insertAtMarkdownSelection(pasted)
  }, [insertAtMarkdownSelection, onPaste, syncSelectionToTextarea])

  return (
    <div className={cn('relative min-w-0 flex-1', className)}>
      <div
        ref={visualRef}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        aria-disabled={disabled || undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-testid={IM_MENTION_COMPOSER_VISUAL_TEST_ID}
        data-placeholder={placeholder}
        data-empty={value ? 'false' : 'true'}
        onInput={handleVisualInput}
        onKeyDown={handleVisualKeyDown}
        onCopy={handleVisualCopy}
        onCut={handleVisualCut}
        onPaste={handleVisualPaste}
        onMouseUp={syncSelectionToTextarea}
        onKeyUp={syncSelectionToTextarea}
        className={cn(
          'min-w-0 overflow-y-auto whitespace-pre-wrap break-words appearance-none border-0 bg-transparent px-0.5 py-0 focus:outline-none focus:ring-0 focus:shadow-none focus-visible:outline-none focus-visible:ring-0',
          IM_COMPOSER_TEXTAREA_MIN_HEIGHT,
          IM_COMPOSER_TEXTAREA_MAX_HEIGHT,
          IM_COMPOSER_TEXT,
          value ? null : IM_MENTION_COMPOSER_EMPTY_PLACEHOLDER_CLASS,
          disabled && 'text-muted-foreground',
        )}
      />
      <textarea
        ref={assignTextareaRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        rows={1}
        className="sr-only"
      />
    </div>
  )
})
