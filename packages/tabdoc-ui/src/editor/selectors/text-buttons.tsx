import {
  BoldIcon,
  CodeIcon,
  ItalicIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from 'lucide-react'
import { EditorBubbleItem, useEditor } from 'novel'
import { useTranslation } from 'react-i18next'
import { Button } from '@tabtin/smartsheet-ui'
import { cn } from '@tabtin/smartsheet-ui'
import { BubbleToolbarTooltip } from './bubble-toolbar-tooltip'
import type { SelectorItem } from './node-selector'

export const TextButtons = () => {
  const { editor } = useEditor()
  const { t } = useTranslation('tabdoc')
  if (!editor) return null
  const items: SelectorItem[] = [
    {
      nameKey: 'text.bold',
      isActive: (editor) => editor.isActive('bold'),
      command: (editor) => editor.chain().focus().toggleBold().run(),
      icon: BoldIcon,
    },
    {
      nameKey: 'text.italic',
      isActive: (editor) => editor.isActive('italic'),
      command: (editor) => editor.chain().focus().toggleItalic().run(),
      icon: ItalicIcon,
    },
    {
      nameKey: 'text.underline',
      isActive: (editor) => editor.isActive('underline'),
      command: (editor) => editor.chain().focus().toggleUnderline().run(),
      icon: UnderlineIcon,
    },
    {
      nameKey: 'text.strike',
      isActive: (editor) => editor.isActive('strike'),
      command: (editor) => editor.chain().focus().toggleStrike().run(),
      icon: StrikethroughIcon,
    },
    {
      nameKey: 'text.code',
      isActive: (editor) => editor.isActive('code'),
      command: (editor) => editor.chain().focus().toggleCode().run(),
      icon: CodeIcon,
    },
  ]
  return (
    <div className="flex">
      {items.map((item) => {
        const label = t(item.nameKey)
        const isActive = item.isActive(editor)

        return (
          <EditorBubbleItem
            key={item.nameKey}
            onSelect={(editor) => {
              item.command(editor)
            }}
          >
            <BubbleToolbarTooltip label={label}>
              <Button
                size="sm"
                className="rounded-none"
                variant="ghost"
                type="button"
                aria-label={label}
                aria-pressed={isActive}
              >
                <item.icon
                  className={cn('h-4 w-4', {
                    'text-info': isActive,
                  })}
                />
              </Button>
            </BubbleToolbarTooltip>
          </EditorBubbleItem>
        )
      })}
    </div>
  )
}
