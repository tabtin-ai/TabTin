/**
 * SendToChatButton — 文档 bubble menu 中的"发送到对话"按钮
 *
 * 获取当前选中文本并通过回调注入到对话输入框。
 * 回调由宿主通过 props 注入，不直接依赖任何宿主模块。
 */

import { MessageSquare } from 'lucide-react'
import { useEditor } from 'novel'
import { useTranslation } from 'react-i18next'
import { Button } from '@tabtin/smartsheet-ui'
import { collectTopLevelBlockIdsInRange } from '../doc-selection-blocks'
import { BubbleToolbarTooltip } from './bubble-toolbar-tooltip'

export interface SendToChatPayload {
  type: 'doc_selection'
  resourceId: string
  label: string
  spaceId?: string
  preview: string
  meta: { full_text: string; block_ids?: string[] }
}

interface SendToChatButtonProps {
  documentId: string
  documentTitle: string
  spaceId?: string
  onSendToChat?: (payload: SendToChatPayload) => void
}

export const SendToChatButton = ({
  documentId,
  documentTitle,
  spaceId,
  onSendToChat,
}: SendToChatButtonProps) => {
  const { t } = useTranslation('tabdoc')
  const { editor } = useEditor()

  if (!editor || !onSendToChat) return null

  const handleClick = () => {
    const { from, to, empty } = editor.state.selection
    if (empty) return

    const selectedText = editor.state.doc.textBetween(from, to, '\n')
    if (!selectedText.trim()) return

    const preview = selectedText.length > 200
      ? selectedText.slice(0, 200) + '...'
      : selectedText
    const blockIds = collectTopLevelBlockIdsInRange(editor.state.doc, from, to)

    onSendToChat({
      type: 'doc_selection',
      resourceId: documentId,
      label: `${documentTitle} · ${t('selectionLabelSuffix')}`,
      spaceId,
      preview,
      meta: {
        ...(blockIds.length > 0 ? { block_ids: blockIds } : {}),
        full_text: selectedText,
      },
    })
  }

  const label = t('sendToChat')

  return (
    <BubbleToolbarTooltip label={label}>
      <Button
        size="icon"
        variant="ghost"
        className="rounded-none h-8 w-8"
        onClick={handleClick}
        aria-label={label}
      >
        <MessageSquare className="h-3.5 w-3.5" />
      </Button>
    </BubbleToolbarTooltip>
  )
}
