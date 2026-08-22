/**
 * StartCommentButton — 浮动工具条「添加评论」入口
 *
 * 由宿主注入 onStartComment；在 EditorContent 内渲染以使用 novel useEditor。
 */
import { MessageSquarePlus } from 'lucide-react'
import { useEditor } from 'novel'
import { useTranslation } from 'react-i18next'
import { Button } from '@tabtin/smartsheet-ui'
import { BubbleToolbarTooltip } from './bubble-toolbar-tooltip'

export interface StartCommentButtonProps {
  onStartComment?: () => void
  disabled?: boolean
}

export function StartCommentButton({
  onStartComment,
  disabled = false,
}: StartCommentButtonProps) {
  const { t } = useTranslation('tabdoc')
  const { editor } = useEditor()

  if (!editor || !onStartComment) return null

  const label = t('comments.startComment', { defaultValue: '添加评论' })

  return (
    <BubbleToolbarTooltip label={label}>
      <Button
        size="icon"
        variant="ghost"
        className="rounded-none h-8 w-8"
        disabled={disabled}
        data-testid="start-comment-button"
        onClick={() => onStartComment()}
        aria-label={label}
      >
        <MessageSquarePlus className="h-3.5 w-3.5" />
      </Button>
    </BubbleToolbarTooltip>
  )
}
