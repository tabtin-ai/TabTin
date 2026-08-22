import { SigmaIcon } from 'lucide-react'
import { useEditor } from 'novel'
import { useTranslation } from 'react-i18next'
import { Button } from '@tabtin/smartsheet-ui'
import { cn } from '@tabtin/smartsheet-ui'
import { BubbleToolbarTooltip } from './bubble-toolbar-tooltip'

/**
 * Bubble-menu button that toggles selected text into a LaTeX math node.
 *
 * - If the selection is already a math node → removes the math wrapper.
 * - Otherwise → wraps the selected text as inline math (`$...$`).
 */
export const MathSelector = () => {
  const { editor } = useEditor()
  const { t } = useTranslation('tabdoc')

  if (!editor) return null
  const label = t('slash.math')
  const isActive =
    editor.isActive('mathematics')
    || editor.isActive('mathematicsBlock')
    || editor.isActive('math')

  return (
    <BubbleToolbarTooltip label={label}>
      <Button
        variant="ghost"
        size="sm"
        className="w-12 rounded-none"
        type="button"
        aria-label={label}
        aria-pressed={isActive}
        onClick={() => {
          if (isActive) {
            editor.chain().focus().unsetLatex().run()
          } else {
            const { from, to } = editor.state.selection
            const latex = editor.state.doc.textBetween(from, to)

            if (!latex) return

            editor.chain().focus().setLatex({ latex }).run()
          }
        }}
      >
        <SigmaIcon
          className={cn('size-4', { 'text-info': isActive })}
          strokeWidth={2.3}
        />
      </Button>
    </BubbleToolbarTooltip>
  )
}
