import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { cn } from '@utils/cn'
import { CHAT_MESSAGE_TEXT_BODY } from '../../../registry/chatDesignTokens'
import type { ChatMessage } from '@tabtin/chat-client'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, FileText, Mic, Paperclip, RotateCcw, Send, X } from 'lucide-react'
import { Button, toast } from '@components/ui'
import { ChatIconTooltip } from '../../../panel/ChatIconTooltip'
import { AgentModeSelector } from '../../../model/AgentModeSelector'
import { useChatStore } from '../../../../../stores/chat/useChatStore'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { useAgentGatewayStatus } from '@/hooks/useAgentGatewayStatus'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useVoiceSettingsStore, matchesShortcut, formatShortcut } from '@/stores/useVoiceSettingsStore'
import { resolveAgentModeName, type AgentModeName } from '@/stores/chat/shared/types'
import { validateUploadFile, isImageMime, isMediaMime } from '@/constants/upload'
import { getChatClient } from '@/services/chatApi'
import { ASRStreamClient, buildDialogContext } from '../../../voice/ASRStreamClient'
import { extractAppHotwords } from '../../../voice/extractAppHotwords'
import { useVoiceRecording } from '../../../voice/useVoiceRecording'
import { useMicrophonePermissionGate } from '../../../voice/useMicrophonePermissionGate'
import { VoiceRecordingCapsule } from '../../../voice/VoiceRecordingCapsule'
import { useComposerAttachmentPreview } from '../../../composer/useComposerAttachmentPreview'
import { useComposerAttachmentUploads } from '../../../composer/useComposerAttachmentUploads'
import { buildEditResendMaterial } from '@/stores/chat/presentation/messageBubble/messageResendContext'
import { computeComposerAcceptTypes } from '../../../composer/modelAttachmentCapabilities'
import {
  type ChatAttachment,
  createAttachment,
  revokeAttachmentPreview,
  formatFileSize,
  FILE_LIMITS,
} from '../../../types'

const EDIT_TEXTAREA_MAX_HEIGHT = 260

const EditAttachmentPreview: React.FC<{
  attachment: ChatAttachment
  onRemove: (id: string) => void
}> = ({ attachment, onRemove }) => {
  const { t } = useTranslation('chat')
  const isImage = attachment.type === 'image'
  // ：与 Composer AttachmentPreview 同口径——pending 态非图片用原始 File
  // 建本地 blob URL 预览，上传完成后用 remoteUrl。
  const { canPreview, handlePreview } = useComposerAttachmentPreview(attachment)

  return (
    <div className="group/att relative flex items-center gap-2 rounded-lg border border-border/20 bg-muted/10 px-2.5 py-2 text-body">
      {isImage && attachment.previewUrl ? (
        <button
          type="button"
          onClick={handlePreview}
          className="h-10 w-10 overflow-hidden rounded-md border border-border/30 transition-colors hover:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
          aria-label={t('preview.openImage', { defaultValue: '查看图片' })}
        >
          <img
            src={attachment.previewUrl}
            alt={attachment.filename}
            className="h-full w-full object-cover"
          />
        </button>
      ) : (
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-md bg-muted/40',
            canPreview && 'cursor-pointer hover:bg-muted/60 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/30',
          )}
          onClick={canPreview ? handlePreview : undefined}
          role={canPreview ? 'button' : undefined}
          tabIndex={canPreview ? 0 : undefined}
          aria-label={canPreview ? t('preview.openFile', { defaultValue: '预览文件' }) : undefined}
          onKeyDown={canPreview ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handlePreview()
            }
          } : undefined}
        >
          <FileText className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
      <button
        type="button"
        onClick={handlePreview}
        disabled={!canPreview}
        className={cn(
          'min-w-0 flex-1 text-left',
          canPreview && 'rounded-sm focus:outline-none focus:ring-2 focus:ring-primary/30',
          !canPreview && 'cursor-default',
        )}
      >
        <div className="truncate font-medium text-foreground">{attachment.filename}</div>
        <div className="text-caption text-muted-foreground/60">{formatFileSize(attachment.size)}</div>
      </button>
      {attachment.status === 'error' ? (
        <span className="text-caption text-destructive">{attachment.error || t('input.uploadFailed')}</span>
      ) : null}
      <ChatIconTooltip content={t('input.remove')}>
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          className="flex h-5 w-5 items-center justify-center rounded-full bg-muted/60 text-muted-foreground hover:bg-destructive/5 hover:text-destructive transition-colors"
          aria-label={t('input.remove')}
        >
          <X className="h-3 w-3" />
        </button>
      </ChatIconTooltip>
    </div>
  )
}

export const UserMessageEditMode: React.FC<{
  message: ChatMessage
  sessionId?: string | null
  onCancel: () => void
// eslint-disable-next-line complexity -- 编辑态整合文本、附件、语音、模型能力和重发回滚，后续可按交互区继续拆分。
}> = ({ message, sessionId, onCancel }) => {
  const { t } = useTranslation('chat')
  const [editText, setEditText] = useState(() => message.content ?? '')
  const [newAttachments, setNewAttachments] = useState<ChatAttachment[]>([])
  const { attachmentsUploading, cancelUpload } = useComposerAttachmentUploads(
    newAttachments,
    setNewAttachments,
  )
  const hasAttachmentUploadError = newAttachments.some(attachment => attachment.status === 'error')
  const newAttachmentsReady = !attachmentsUploading && newAttachments.every(attachment => (
    attachment.status === 'ready' && Boolean(attachment.fileId?.trim())
  ))
  const [removedOriginalAttachmentKeys, setRemovedOriginalAttachmentKeys] = useState<Set<string>>(() => new Set())
  const [removedOriginalBlockIndices, setRemovedOriginalBlockIndices] = useState<Set<number>>(() => new Set())
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const newAttachmentsRef = useRef(newAttachments)
  newAttachmentsRef.current = newAttachments

  const currentSessionId = useChatStore(s => s.currentSessionId)
  const effectiveSessionId = sessionId ?? currentSessionId
  const fallbackAgentMode = useChatStore(s => s.agentMode)
  const setAgentMode = useChatStore(s => s.setAgentMode)
  const requestRewindPreview = useChatStore(s => s.requestRewindPreview)
  const chatMessages = useChatStore(
    useCallback(
      (s) => (effectiveSessionId ? s.messagesBySessionId[effectiveSessionId] ?? [] : []),
      [effectiveSessionId],
    ),
  )
  const sessionAgentMode = useChatRuntimeStore(
    useCallback(
      (s) => (effectiveSessionId ? s.agentModeBySessionId[effectiveSessionId] : undefined),
      [effectiveSessionId],
    ),
  )
  const agentMode = resolveAgentModeName(sessionAgentMode, fallbackAgentMode)

  const agentGatewayStatus = useAgentGatewayStatus()
  const wsDisconnected = agentGatewayStatus !== 'ready'
  const voiceShortcut = useVoiceSettingsStore(s => s.voiceShortcut)
  const voiceEnabled = useVoiceSettingsStore(s => s.enabled)

  const isRestoring = useChatStore(
    useCallback(
      (s) => {
        const sid = sessionId ?? s.currentSessionId
        return sid ? s.restoringSessionId === sid : s.restoringSessionId != null
      },
      [sessionId],
    ),
  )

  const originalAttachments = useMemo(() => message.attachments_json || [], [message.attachments_json])
  const originalBlocks = useMemo(() => message.content_blocks_json || [], [message.content_blocks_json])
  const editResendMaterial = useMemo(() => buildEditResendMaterial(
    message,
    removedOriginalAttachmentKeys,
    removedOriginalBlockIndices,
    newAttachments,
  ), [message, newAttachments, removedOriginalAttachmentKeys, removedOriginalBlockIndices])
  const hasOriginalAttachmentResourceError = editResendMaterial.missingResourceNames.length > 0
  const editAttachmentsReady = newAttachmentsReady && !hasOriginalAttachmentResourceError
  const visibleOriginalBlocks = originalBlocks
    .map((block, index) => ({ block, index }))
    .filter(({ block, index }) => block.type !== 'text' && !removedOriginalBlockIndices.has(index))
  const hasOriginalAttachments = originalAttachments.some((att, index) => {
    const key = att.file_id ?? `att-${index}-${att.filename}`
    return !removedOriginalAttachmentKeys.has(key)
  })
  const hasPreviewMedia = hasOriginalAttachments
    || visibleOriginalBlocks.length > 0
    || newAttachments.length > 0

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.focus()
    ta.selectionStart = ta.value.length
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, EDIT_TEXTAREA_MAX_HEIGHT) + 'px'
  }, [])

  useEffect(() => () => {
    newAttachmentsRef.current.forEach(revokeAttachmentPreview)
  }, [])

  const voiceDraftStartRef = useRef<number>(-1)

  const handleVoiceTranscript = useCallback((text: string, isFinal: boolean) => {
    const start = voiceDraftStartRef.current
    setEditText(prev => {
      if (start < 0) {
        voiceDraftStartRef.current = prev.length
        return prev + text
      }
      return prev.slice(0, start) + text
    })
    if (isFinal) {
      voiceDraftStartRef.current = -1
    }
    queueMicrotask(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, EDIT_TEXTAREA_MAX_HEIGHT) + 'px'
      }
    })
  }, [])

  const handleRecordingEnd = useCallback(() => {
    voiceDraftStartRef.current = -1
    queueMicrotask(() => textareaRef.current?.focus())
  }, [])

  const voice = useVoiceRecording({
    messages: chatMessages,
    onTranscript: handleVoiceTranscript,
    onRecordingEnd: handleRecordingEnd,
  })

  const { state: voiceState, startRecording: voiceStart, stopRecording: voiceStop, cancelRecording: voiceCancel } = voice
  const isVoiceActive = voiceState !== 'idle'
  const voiceErrorMessage = voice.errorMessage || t('voice.capsuleError')
  const lastVoiceErrorRef = useRef<string | null>(null)

  useEffect(() => {
    if (voiceState !== 'error') {
      lastVoiceErrorRef.current = null
      return
    }
    if (lastVoiceErrorRef.current === voiceErrorMessage) return
    lastVoiceErrorRef.current = voiceErrorMessage
    toast({
      title: voiceErrorMessage,
      variant: 'destructive',
    })
  }, [voiceErrorMessage, voiceState])

  const micGate = useMicrophonePermissionGate(voiceEnabled)
  const micBlocked = micGate.isDenied || micGate.isUnsupported

  const handleMicPreconnect = useCallback(() => {
    if (isVoiceActive) return
    const gateway = getChatClient().getGateway()
    const organizationId = useOrganizationStore.getState().getEffectiveOrganizationId() ?? undefined
    const vs = useVoiceSettingsStore.getState()
    const appHotwords = extractAppHotwords()
    const hotwords = vs.mergedHotwords(appHotwords)
    const context = vs.enableDialogContext
      ? buildDialogContext(chatMessages)
      : undefined
    void ASRStreamClient.preconnect(gateway, { hotwords, context }, organizationId)
  }, [isVoiceActive, chatMessages])

  const handleMicClick = useCallback(() => {
    if (isVoiceActive) return
    voiceDraftStartRef.current = editText.length
    voiceStart()
  }, [isVoiceActive, editText.length, voiceStart])

  const editTextLengthRef = useRef(editText.length)
  editTextLengthRef.current = editText.length

  useEffect(() => {
    if (!voiceEnabled) return
    const handleVoiceShortcut = (e: globalThis.KeyboardEvent) => {
      if (matchesShortcut(e, voiceShortcut)) {
        if (!isRestoring && !wsDisconnected && !isVoiceActive && !micBlocked) {
          e.preventDefault()
          voiceDraftStartRef.current = editTextLengthRef.current
          voiceStart()
        }
      }
    }
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 编辑框打开期间的录音快捷键监听，effect 已由 voiceEnabled 和组件卸载精确收口。
    window.addEventListener('keydown', handleVoiceShortcut)
    return () => window.removeEventListener('keydown', handleVoiceShortcut)
  }, [isRestoring, wsDisconnected, isVoiceActive, voiceShortcut, voiceStart, voiceEnabled, micBlocked])

  const handleAgentModeChange = useCallback((mode: AgentModeName) => {
    const sid = effectiveSessionId
    if (!sid) return
    if (sid === useChatStore.getState().currentSessionId) {
      setAgentMode(mode)
      return
    }
    useChatRuntimeStore.setState(rs => ({
      agentModeBySessionId: { ...rs.agentModeBySessionId, [sid]: mode },
    }))
  }, [effectiveSessionId, setAgentMode])

  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(f => !(f.size === 0 && f.type === ''))
    if (fileArray.length === 0) return

    setNewAttachments(prev => {
      const remaining = FILE_LIMITS.MAX_ATTACHMENTS - prev.length
      if (remaining <= 0) return prev

      const rejected: Array<{ name: string; reason: string }> = []
      const added: ChatAttachment[] = []
      const selectedFiles = fileArray.slice(0, remaining)
      for (const file of selectedFiles) {
        const preset = isImageMime(file.type) ? 'IMAGE' as const : isMediaMime(file.type) ? 'MEDIA' as const : 'FILE' as const
        const validation = validateUploadFile(file, preset)
        if (!validation.valid) {
          const reason = validation.reason?.startsWith('fileTooLarge:')
            ? t('input.fileTooLarge', { limit: validation.reason.split(':')[1], defaultValue: '超过 {{limit}}MB 大小限制' })
            : t('input.fileTypeNotAllowed', { defaultValue: '不支持的文件类型' })
          rejected.push({ name: file.name, reason })
          continue
        }
        const attachment = createAttachment(file)
        added.push(attachment)
      }

      if (rejected.length > 0) {
        queueMicrotask(() => {
          const summary = rejected.length === 1
            ? t('input.fileRejectedSingle', {
                name: rejected[0].name,
                reason: rejected[0].reason,
                defaultValue: '文件 {{name}} 被跳过：{{reason}}',
              })
            : t('input.fileRejectedMultiple', {
                count: rejected.length,
                defaultValue: '{{count}} 个文件被跳过',
              })
          const description = rejected.length > 1
            ? rejected.map(r => `${r.name}：${r.reason}`).join('\n')
            : undefined
          toast.warning(summary, description ? { description } : undefined)
        })
      }

      return [...prev, ...added]
    })
  }, [t])

  const removeNewAttachment = useCallback((id: string) => {
    cancelUpload(id)
    setNewAttachments(prev => {
      const target = prev.find(a => a.id === id)
      if (target) revokeAttachmentPreview(target)
      return prev.filter(a => a.id !== id)
    })
  }, [cancelUpload])

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (files && files.length > 0) {
        addFiles(files)
      }
      event.target.value = ''
    },
    [addFiles],
  )

  const removeOriginalAttachment = useCallback((key: string) => {
    setRemovedOriginalAttachmentKeys(prev => new Set(prev).add(key))
  }, [])

  const removeOriginalBlock = useCallback((index: number) => {
    setRemovedOriginalBlockIndices(prev => new Set(prev).add(index))
  }, [])

  const doSubmit = useCallback(() => {
    requestRewindPreview(
      sessionId ?? null,
      message.id,
      'editAndResend',
      editText.trim(),
      editResendMaterial.attachments,
      editResendMaterial.contextBlocks,
      'edit',
    )
  }, [
    editText,
    editResendMaterial,
    message.id,
    sessionId,
    requestRewindPreview,
  ])

  const handleSubmit = useCallback(() => {
    if (!editText.trim() || isRestoring) return
    if (!editAttachmentsReady) {
      toast.warning(hasOriginalAttachmentResourceError
        ? t('input.attachmentResourceMissing', { defaultValue: '原附件缺少资源引用，请移除后重试' })
        : hasAttachmentUploadError
          ? t('input.attachmentUploadFailed', { defaultValue: '有附件上传失败，请移除后重试' })
          : t('input.attachmentUploading', { defaultValue: '附件上传中，请稍候' }))
      return
    }
    if (isVoiceActive) {
      voiceDraftStartRef.current = -1
      voiceCancel()
    }
    doSubmit()
  }, [doSubmit, editAttachmentsReady, editText, hasAttachmentUploadError, hasOriginalAttachmentResourceError, isRestoring, isVoiceActive, t, voiceCancel])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [onCancel, handleSubmit],
  )

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditText(e.target.value)
    const ta = e.target
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, EDIT_TEXTAREA_MAX_HEIGHT) + 'px'
  }, [])

  const canSubmit = !!editText.trim()
    && !isRestoring
    && editAttachmentsReady
  const acceptTypes = computeComposerAcceptTypes()
  const attachDisabled = isRestoring || newAttachments.length >= FILE_LIMITS.MAX_ATTACHMENTS
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '')
  const sendShortcutLabel = `${isMac ? '⌘' : 'Ctrl'}+Enter`
  const cancelTooltip = `${t('common.cancel')} (Esc)`
  const sendTooltip = isRestoring
    ? t('checkpoint.restoring')
    : hasOriginalAttachmentResourceError
      ? t('input.attachmentResourceMissing', { defaultValue: '原附件缺少资源引用，请移除后重试' })
    : hasAttachmentUploadError
      ? t('input.attachmentUploadFailed', { defaultValue: '有附件上传失败，请移除后重试' })
    : attachmentsUploading
      ? t('input.attachmentUploading', { defaultValue: '附件上传中，请稍候' })
    : `${t('checkpoint.restoreAndSend')} (${sendShortcutLabel})`

  return (
    <div className="w-full max-w-full ml-auto">
      <div
        className={cn(
          'overflow-hidden rounded-2xl rounded-br-md bg-background/95 transition-[box-shadow,background-color] duration-200',
          isRestoring && 'opacity-50 pointer-events-none',
        )}
      >
        {hasPreviewMedia && (
          <div className="flex flex-wrap gap-2 px-2.5 pt-2.5 pb-1">
            {originalAttachments.map((att, index) => {
              const key = att.file_id ?? `att-${index}-${att.filename}`
              if (removedOriginalAttachmentKeys.has(key)) return null
              return (
                <span
                  key={key}
                  className="inline-flex items-center gap-1 rounded-lg border border-border/20 bg-muted/10 px-2.5 py-2 text-body text-muted-foreground"
                >
                  {att.type === 'image' ? '🖼' : <FileText className="h-3 w-3" />}
                  <span className="max-w-[120px] truncate">{att.filename}</span>
                  <ChatIconTooltip content={t('input.remove')}>
                    <button
                      type="button"
                      onClick={() => removeOriginalAttachment(key)}
                      className="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/60 hover:bg-destructive/5 hover:text-destructive"
                      aria-label={t('input.remove')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </ChatIconTooltip>
                </span>
              )
            })}
            {visibleOriginalBlocks.map(({ block, index }) => (
              <span
                key={`b-${index}`}
                className="inline-flex items-center gap-1 rounded-lg border border-border/20 bg-muted/10 px-2.5 py-2 text-body text-muted-foreground"
              >
                {block.type === 'doc_selection' ? '📄' : block.type === 'table_selection' ? '📊' : '📎'}
                <span className="max-w-[120px] truncate">{block.preview || block.type}</span>
                <ChatIconTooltip content={t('input.remove')}>
                  <button
                    type="button"
                    onClick={() => removeOriginalBlock(index)}
                    className="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/60 hover:bg-destructive/5 hover:text-destructive"
                    aria-label={t('input.remove')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </ChatIconTooltip>
              </span>
            ))}
            {newAttachments.map(att => (
              <EditAttachmentPreview
                key={att.id}
                attachment={att}
                onRemove={removeNewAttachment}
              />
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={editText}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          className={cn(
            'w-full resize-none bg-transparent py-2.5 px-3',
            CHAT_MESSAGE_TEXT_BODY,
            'appearance-none focus:outline-none focus-visible:outline-none',
            'min-h-[44px] max-h-[260px]',
            'border-0 focus:border-0 focus:ring-0 focus:shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-none',
          )}
          disabled={isRestoring}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={acceptTypes}
          onChange={handleFileInputChange}
          className="hidden"
        />
        <div className="flex min-w-0 items-center justify-between gap-2 border-t border-border/[0.06] px-2 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            <AgentModeSelector
              currentMode={agentMode}
              onModeChange={handleAgentModeChange}
              disabled={isRestoring}
            />
            <ChatIconTooltip content={t('input.attachFile')} align="start" collisionPadding={12}>
              <button
                type="button"
                onClick={handleFileSelect}
                disabled={attachDisabled}
                className={cn(
                  'flex items-center justify-center h-7 w-7 rounded-lg transition-colors',
                  'text-muted-foreground hover:text-foreground hover:bg-muted/25',
                  attachDisabled && 'opacity-40 cursor-not-allowed',
                )}
                aria-label={t('input.attachFile')}
              >
                <Paperclip className="h-3.5 w-3.5" strokeWidth={2.5} />
              </button>
            </ChatIconTooltip>
            {voiceEnabled && (
              voiceState === 'error' ? (
                <ChatIconTooltip content={voiceErrorMessage} align="start" collisionPadding={12}>
                  <button
                    type="button"
                    onClick={voiceCancel}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-destructive transition-colors hover:bg-muted/25"
                    aria-label={voiceErrorMessage}
                  >
                    <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2.5} />
                  </button>
                </ChatIconTooltip>
              ) : isVoiceActive ? (
                <VoiceRecordingCapsule
                  state={voiceState}
                  audioLevels={voice.audioLevels}
                  duration={voice.duration}
                  onStop={voiceStop}
                  onCancel={voiceCancel}
                />
              ) : (
                <ChatIconTooltip
                  content={
                    micGate.isUnsupported
                      ? t('voice.micUnsupported', { defaultValue: '语音输入需在 Electron 客户端中使用' })
                      : micGate.isDenied
                        ? t('voice.micPermission')
                        : `${t('voice.inputTitle')} (${formatShortcut(voiceShortcut)})`
                  }
                  align="start"
                  collisionPadding={12}
                >
                  <button
                    type="button"
                    onClick={handleMicClick}
                    onMouseEnter={handleMicPreconnect}
                    onFocus={handleMicPreconnect}
                    disabled={isRestoring || wsDisconnected || micBlocked}
                    className={cn(
                      'flex items-center justify-center h-7 w-7 rounded-lg transition-colors',
                      'text-muted-foreground hover:text-foreground hover:bg-muted/25',
                      (isRestoring || wsDisconnected || micBlocked) && 'opacity-40 cursor-not-allowed',
                    )}
                    aria-label={`${t('voice.inputTitle')} (${formatShortcut(voiceShortcut)})`}
                  >
                    <Mic className="h-3.5 w-3.5" strokeWidth={2.5} />
                  </button>
                </ChatIconTooltip>
              )
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <ChatIconTooltip content={cancelTooltip}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onCancel}
                className="h-7 w-7 p-0 rounded-lg text-muted-foreground hover:bg-muted/25 hover:text-foreground"
                aria-label={cancelTooltip}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </ChatIconTooltip>
            <ChatIconTooltip content={sendTooltip}>
              <Button
                type="button"
                size="sm"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className={cn(
                  'h-7 w-7 p-0 rounded-lg transition-all duration-200',
                  canSubmit
                    ? 'bg-accent text-accent-foreground hover:bg-accent/85 shadow-sm'
                    : 'cursor-default bg-muted/30 text-muted-foreground/30 shadow-none',
                )}
                aria-label={sendTooltip}
              >
                {isRestoring
                  ? <RotateCcw className="h-3.5 w-3.5 animate-spin" />
                  : <Send className="h-3.5 w-3.5" />}
              </Button>
            </ChatIconTooltip>
          </div>
        </div>
      </div>
    </div>
  )
}
