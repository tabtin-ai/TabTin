/**
 * ConversationReferenceViewerDialog — 点击「引用对话」卡片时弹出的只读对话历史查看器。
 *
 * 用于交接场景：被交接人无权跳转到发起人的源 session，改为弹窗展示
 * rawBlock 中的冻结对话内容（Markdown 渲染）。
 * 附件行（`附件：📎 名字（大小）[file_id: …]`）解析成可点击文件卡：
 * 点击按 file_id 换新鲜 access_url 后走应用内预览（PDF/图片等）。
 */

import React, { useMemo, useState } from 'react'
import { FileText, Loader2, MessagesSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@tabtin/smartsheet-ui'
import { markdownComponents } from '@components/tabchat/IMMessageBubble'
import { openOssFilePreviewById } from '../preview/openOssFilePreview'
import type { ConversationReferenceDisplay } from '@utils/chat/conversationReference'

export interface ConversationReferenceViewerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  reference: ConversationReferenceDisplay
  rawBlock: string
}

interface ParsedAttachment {
  filename: string
  sizeLabel?: string
  fileId?: string
}

interface ParsedTurn {
  role: string
  text: string
  attachments: ParsedAttachment[]
}

const ATTACHMENT_LINE_PREFIX = '附件：'
const ATTACHMENT_SEGMENT_RE =
  /^📎\s*(.+?)(?:（([^）]+)）)?\s*(?:\[file_id:\s*([0-9a-f-]{36})\])?$/i

function parseAttachmentLine(line: string): ParsedAttachment[] {
  const body = line.slice(ATTACHMENT_LINE_PREFIX.length)
  return body
    .split('、')
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      const m = seg.match(ATTACHMENT_SEGMENT_RE)
      if (!m) return { filename: seg }
      return {
        filename: (m[1] ?? seg).trim(),
        sizeLabel: m[2]?.trim() || undefined,
        fileId: m[3] || undefined,
      }
    })
}

/** 导出仅供单测：从 rawBlock 解析标题、回合与附件卡数据。 */
export function parseRawBlockTurns(rawBlock: string): { title: string; turns: ParsedTurn[] } {
  const lines = rawBlock.split('\n')
  let title = ''
  const turns: ParsedTurn[] = []
  let currentRole = ''
  let currentLines: string[] = []
  let currentAttachments: ParsedAttachment[] = []
  let inConversation = false

  const flushTurn = () => {
    if (currentRole && (currentLines.length > 0 || currentAttachments.length > 0)) {
      turns.push({
        role: currentRole,
        text: currentLines.join('\n').trim(),
        attachments: currentAttachments,
      })
    }
  }

  for (const line of lines) {
    const titleMatch = line.match(/^标题[：:]\s*(.+)$/)
    if (titleMatch && !title) {
      title = titleMatch[1].trim()
      continue
    }

    if (/^##\s+冻结对话内容/.test(line.trim())) {
      inConversation = true
      continue
    }

    if (!inConversation) continue

    const turnMatch = line.match(/^###\s+(.+)$/)
    if (turnMatch) {
      flushTurn()
      currentRole = turnMatch[1].trim()
      currentLines = []
      currentAttachments = []
      continue
    }

    if (!currentRole) continue

    if (line.trim().startsWith(ATTACHMENT_LINE_PREFIX)) {
      currentAttachments.push(...parseAttachmentLine(line.trim()))
      continue
    }
    currentLines.push(line)
  }

  flushTurn()

  return { title, turns }
}

const FrozenAttachmentCard: React.FC<{ attachment: ParsedAttachment }> = ({ attachment }) => {
  const { t } = useTranslation('chat')
  const [opening, setOpening] = useState(false)
  const clickable = Boolean(attachment.fileId)

  const handleOpen = async () => {
    if (!attachment.fileId || opening) return
    setOpening(true)
    try {
      await openOssFilePreviewById(attachment.fileId, {
        unsupported: t('preview.typeUnsupported', { defaultValue: '暂不支持预览此类型文件' }),
        unavailable: t('session.conversationReference.attachmentUnavailable', {
          defaultValue: '附件暂时无法访问',
        }),
      })
    } finally {
      setOpening(false)
    }
  }

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border border-border/40 bg-muted/15 px-2.5 py-1.5 ${
        clickable ? 'cursor-pointer hover:bg-muted/30 transition-colors' : ''
      }`}
      onClick={clickable ? handleOpen : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          void handleOpen()
        }
      } : undefined}
    >
      {opening
        ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-caption font-medium text-foreground/85">
          {attachment.filename}
        </div>
        {attachment.sizeLabel && (
          <div className="text-[11px] text-muted-foreground/70">{attachment.sizeLabel}</div>
        )}
      </div>
    </div>
  )
}

export const ConversationReferenceViewerDialog: React.FC<ConversationReferenceViewerDialogProps> = ({
  open,
  onOpenChange,
  reference,
  rawBlock,
}) => {
  const { t } = useTranslation('chat')

  const { title, turns } = useMemo(() => parseRawBlockTurns(rawBlock), [rawBlock])
  const displayTitle = reference.title?.trim() || title || t('session.conversationReference.untitled', { defaultValue: '未命名对话' })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[520px] max-w-[calc(100vw-32px)] p-0 gap-0 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <MessagesSquare className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          <DialogTitle className="text-body font-medium truncate">
            {displayTitle}
          </DialogTitle>
        </div>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto px-4 py-4">
          {turns.length === 0 ? (
            <div className="text-body text-foreground/90 prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {rawBlock}
              </ReactMarkdown>
            </div>
          ) : (
            turns.map((turn, i) => (
              <div key={i} className="space-y-1">
                <div className="text-caption font-medium text-muted-foreground">
                  {turn.role === '用户' || turn.role === 'user' ? '我' : 'AI'}
                </div>
                {turn.text ? (
                  <div className="text-body text-foreground/90 prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {turn.text}
                    </ReactMarkdown>
                  </div>
                ) : null}
                {turn.attachments.length > 0 && (
                  <div className="space-y-1 pt-0.5">
                    {turn.attachments.map((att, j) => (
                      <FrozenAttachmentCard key={j} attachment={att} />
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
