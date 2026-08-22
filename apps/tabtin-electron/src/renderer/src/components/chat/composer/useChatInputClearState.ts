import { useCallback, type ChangeEvent, type RefObject } from 'react'
import { usePendingComposerAttachmentsStore } from '@/stores/usePendingComposerAttachmentsStore'
import { clearDraft } from './chatInputDraft'
import { revokeAttachmentPreview, type ChatAttachment } from '../types'

interface ClearInputStateParams {
  draftKey: string | null
  attachmentScopeId?: string | null
  discardAttachmentDraft?: () => void
  setInput: (value: string) => void
  inputRef: React.MutableRefObject<string>
  inputHistoryRef: React.MutableRefObject<string[]>
  historyIndexRef: React.MutableRefObject<number>
  lastHistoryCommitRef: React.MutableRefObject<number>
  cancelAllUploads: () => void
  attachments: ChatAttachment[]
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>
  onClearContextRefs?: () => void
  setMentionOpen: (open: boolean) => void
  closeSkillSlash: () => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
}

export function useChatInputClearState({
  draftKey,
  attachmentScopeId = null,
  discardAttachmentDraft,
  setInput,
  inputRef,
  inputHistoryRef,
  historyIndexRef,
  lastHistoryCommitRef,
  cancelAllUploads,
  attachments,
  setAttachments,
  onClearContextRefs,
  setMentionOpen,
  closeSkillSlash,
  textareaRef,
}: ClearInputStateParams) {
  return useCallback(() => {
    setInput('')
    inputRef.current = ''
    inputHistoryRef.current = ['']
    historyIndexRef.current = 0
    lastHistoryCommitRef.current = 0
    if (draftKey) clearDraft(draftKey)
    discardAttachmentDraft?.()
    cancelAllUploads()
    attachments.forEach(revokeAttachmentPreview)
    setAttachments([])
    // ：发送/清空后清掉 pending stash，避免卸载 cleanup 又把已发送附件 enqueue 回来
    if (attachmentScopeId) {
      usePendingComposerAttachmentsStore.getState().clearScope(attachmentScopeId)
    }
    onClearContextRefs?.()
    setMentionOpen(false)
    closeSkillSlash()
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [
    attachmentScopeId,
    attachments,
    cancelAllUploads,
    closeSkillSlash,
    discardAttachmentDraft,
    draftKey,
    historyIndexRef,
    inputHistoryRef,
    inputRef,
    lastHistoryCommitRef,
    onClearContextRefs,
    setAttachments,
    setInput,
    setMentionOpen,
    textareaRef,
  ])
}

export function useChatInputFileHandlers(
  fileInputRef: RefObject<HTMLInputElement | null>,
  addFiles: (files: FileList | File[]) => void,
  onStop?: () => void,
) {
  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click()
  }, [fileInputRef])

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (files && files.length > 0) {
        addFiles(files)
      }
      event.target.value = ''
    },
    [addFiles],
  )

  const handleStop = useCallback(() => {
    onStop?.()
  }, [onStop])

  return {
    handleFileSelect,
    handleFileInputChange,
    handleStop,
  }
}
