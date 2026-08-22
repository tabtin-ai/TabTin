import { useCallback, type ClipboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { parseConversationReferenceMessage } from '@utils/chat/conversationReference'
import type { ContextRef } from '../types'

export interface UseChatInputPasteInput {
  input: string
  setInput: React.Dispatch<React.SetStateAction<string>>
  inputRef: React.MutableRefObject<string>
  allContextRefs: ContextRef[]
  onAddContextRef?: (
    type: ContextRef['type'],
    resourceId: string,
    label: string,
    extra?: Partial<ContextRef>,
  ) => void
  onRemoveContextRef?: (id: string) => void
  addFiles: (files: File[]) => void
}

export function useChatInputPaste({
  input,
  setInput,
  inputRef,
  allContextRefs,
  onAddContextRef,
  onRemoveContextRef,
  addFiles,
}: UseChatInputPasteInput) {
  const { t } = useTranslation('chat')

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = event.clipboardData
    if (!clipboard) return

    const plainText = clipboard.getData('text/plain')
    const parsedReference = plainText ? parseConversationReferenceMessage(plainText) : null

    if (parsedReference && onAddContextRef) {
      event.preventDefault()
      const { reference, remainderText, rawBlock } = parsedReference
      const sessionIdForRef = reference.sessionId?.trim() || `ref-${Date.now()}`
      const label = reference.title?.trim()
        || t('session.conversationReference.untitled', { defaultValue: '未命名对话' })

      const existing = allContextRefs.find(
        ref => ref.type === 'conversation_reference' && ref.resourceId === sessionIdForRef,
      )
      if (existing && onRemoveContextRef) {
        onRemoveContextRef(existing.id)
      }

      onAddContextRef('conversation_reference', sessionIdForRef, label, {
        spaceId: reference.spaceId,
        meta: {
          rawBlock,
          preview: reference.preview,
          messageCount: reference.messageCount,
          lastActivityLabel: reference.lastActivityLabel,
          organizationId: reference.organizationId,
        },
      })

      if (remainderText) {
        const textarea = event.currentTarget
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const next = `${input.slice(0, start)}${remainderText}${input.slice(end)}`
        setInput(next)
        inputRef.current = next
        requestAnimationFrame(() => {
          const pos = start + remainderText.length
          textarea.setSelectionRange(pos, pos)
          textarea.style.height = 'auto'
          textarea.style.height = Math.min(textarea.scrollHeight, 260) + 'px'
        })
      }

      const files: File[] = []
      for (const item of Array.from(clipboard.items ?? [])) {
        if (item.kind === 'file') {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (files.length > 0) addFiles(files)
      return
    }

    const files: File[] = []
    for (const item of Array.from(clipboard.items ?? [])) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      event.preventDefault()
      addFiles(files)
    }
  }, [addFiles, allContextRefs, input, inputRef, onAddContextRef, onRemoveContextRef, setInput, t])

  return { handlePaste }
}
