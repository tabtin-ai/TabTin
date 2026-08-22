import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import JSZip from 'jszip'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  Progress,
  toast,
} from '@components/ui'
import { uploadIMAttachment } from '@/services/tabchatAttachmentApi'
import { MESSAGE_TYPE_FILE } from '@/constants/tabchat'
import type { CodexSessionCardMetadata, IMMessage } from '@/services/im/contracts'
import { OpenAIIcon } from './OpenAIIcon'

interface Props {
  isOpen: boolean
  onClose: () => void
  conversationId: string
  onSend: (
    content: string,
    replyTo?: IMMessage,
    messageType?: number,
    metadata?: Record<string, unknown>,
  ) => void
}

type SendStage = 'idle' | 'locating' | 'compressing' | 'uploading' | 'sending' | 'failed'

export const CodexSessionShareDialog: React.FC<Props> = ({
  isOpen,
  onClose,
  conversationId,
  onSend,
}) => {
  const { t } = useTranslation('tabchat')
  const [sessionId, setSessionId] = useState('')
  const [suggestedWorkingDirectory, setSuggestedWorkingDirectory] = useState('')
  const [sending, setSending] = useState(false)
  const [stage, setStage] = useState<SendStage>('idle')
  const [progress, setProgress] = useState(0)

  const progressLabel = stage === 'locating'
    ? t('codexSessionShare.locating', { defaultValue: '正在定位本地会话文件…' })
    : stage === 'compressing'
      ? t('codexSessionShare.compressing', { defaultValue: '正在压缩会话文件…' })
      : stage === 'uploading'
        ? t('codexSessionShare.uploading', { defaultValue: '正在上传会话文件…' })
      : stage === 'sending'
        ? t('codexSessionShare.sendingCard', { defaultValue: '正在发送会话卡片…' })
        : t('codexSessionShare.failed', { defaultValue: '发送已取消，请检查 Session ID 后重试' })

  const handleSend = async () => {
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId || sending) return
    setSending(true)
    setStage('locating')
    setProgress(8)
    try {
      const source = await window.tabtin.codexSessionShare.read(normalizedSessionId)
      setStage('compressing')
      setProgress(10)
      const sourceBytes = new Uint8Array(source.buffer)
      const alreadyCompressed = source.fileName.toLowerCase().endsWith('.zip')
        && sourceBytes[0] === 0x50
        && sourceBytes[1] === 0x4b
      let archive = sourceBytes
      if (!alreadyCompressed) {
        const zip = new JSZip()
        zip.file(source.fileName.replace(/\.zip$/i, '.jsonl'), source.buffer)
        archive = await zip.generateAsync(
          { type: 'uint8array', compression: 'DEFLATE' },
          ({ percent }) => setProgress(10 + Math.round(percent / 10)),
        )
      }
      setProgress(20)
      setStage('uploading')
      const file = new File(
        [archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength)],
        source.fileName.replace(/\.(jsonl|zip)$/i, '.zip'),
        {
          type: 'application/zip',
        },
      )
      const upload = await uploadIMAttachment(
        file,
        (value) => setProgress(20 + Math.round(value * 70)),
        undefined,
        conversationId,
      )
      setStage('sending')
      setProgress(95)
      const card: CodexSessionCardMetadata = {
        type: 'codex_session',
        schema_version: 1,
        codex_session_id: source.sessionId,
        codex_session_name: source.title,
        ...(suggestedWorkingDirectory.trim()
          ? { suggested_working_directory: suggestedWorkingDirectory.trim() }
          : {}),
      }
      onSend(
        `[Codex 会话] ${source.title}`,
        undefined,
        MESSAGE_TYPE_FILE,
        {
          file_id: upload.file_id,
          file_name: upload.file_name,
          file_size: upload.file_size,
          file_type: upload.file_type,
          card,
        },
      )
      setProgress(100)
      toast({
        title: t('codexSessionShare.sent', { defaultValue: 'Codex 会话已发送' }),
      })
      setSessionId('')
      setSuggestedWorkingDirectory('')
      onClose()
    } catch (error) {
      setStage('failed')
      setProgress(0)
      toast({
        title: t('codexSessionShare.sendFailed', { defaultValue: '发送 Codex 会话失败' }),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !sending) onClose() }}>
      <DialogContent className="w-[520px] max-w-[calc(100vw-32px)] gap-0 overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <OpenAIIcon className="h-4 w-4 rounded-sm" />
          <DialogTitle className="text-body font-medium">
            {t('codexSessionShare.title', { defaultValue: '发送 Codex 会话' })}
          </DialogTitle>
        </div>

        <div className="space-y-3 px-4 py-4">
          <label htmlFor="codex-session-id" className="block space-y-1.5">
            <span className="text-caption font-medium text-foreground">
              {t('codexSessionShare.sessionId', { defaultValue: 'Session ID' })}
            </span>
            <input
              id="codex-session-id"
              autoFocus
              value={sessionId}
              onChange={(event) => {
                setSessionId(event.target.value)
                if (!sending) {
                  setStage('idle')
                  setProgress(0)
                }
              }}
              placeholder="019ff047-d01a-73e3-bea6-26d65f98d7a8"
              className="w-full rounded-interactive border border-border/60 bg-background px-3 py-2 text-body outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-accent"
            />
          </label>

          <div className="space-y-1.5">
            <span className="text-caption font-medium text-foreground">
              <label htmlFor="codex-suggested-working-directory">
                {t('codexSessionShare.suggestedWorkingDirectory', {
                  defaultValue: '建议工作目录（可选）',
                })}
              </label>
            </span>
            <input
              id="codex-suggested-working-directory"
              value={suggestedWorkingDirectory}
              onChange={(event) => setSuggestedWorkingDirectory(event.target.value)}
              placeholder="/absolute/path/to/project"
              className="w-full rounded-interactive border border-border/60 bg-background px-3 py-2 text-body outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-accent"
            />
            <span className="block text-caption text-muted-foreground">
              {t('codexSessionShare.suggestedWorkingDirectoryHint', {
                defaultValue: '建议填写绝对路径，仅供接收方参考。',
              })}
            </span>
          </div>

          {stage !== 'idle' && (
            <div className="space-y-1.5" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-caption text-muted-foreground">
                <span>{progressLabel}</span>
                {stage !== 'failed' && <span>{progress}%</span>}
              </div>
              <Progress
                aria-label={progressLabel}
                value={progress}
                className="h-1.5"
              />
            </div>
          )}

          <div className="flex gap-2 rounded-interactive bg-warning/8 px-3 py-2 text-caption text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
            <span>
              {t('codexSessionShare.warning', {
                defaultValue: '会话文件包含完整对话、工具输出和本机路径。发送后，对方可导入并继续该会话。',
              })}
            </span>
          </div>
        </div>

        <DialogFooter className="border-t border-border/60 px-4 py-3">
          <Button variant="ghost" disabled={sending} onClick={onClose}>
            {t('cancel', { defaultValue: '取消' })}
          </Button>
          <Button disabled={!sessionId.trim() || sending} onClick={() => { void handleSend() }}>
            {sending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
            {t('codexSessionShare.send', { defaultValue: '发送会话文件' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
