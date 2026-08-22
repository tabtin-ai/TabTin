import {
  Check,
  CheckSquare,
  ChevronDown,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  type LucideIcon,
  TextIcon,
  TextQuote,
} from 'lucide-react'
import { EditorBubbleItem, useEditor } from 'novel'
import { useTranslation } from 'react-i18next'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@tabtin/smartsheet-ui'
import { BubbleToolbarTooltip } from './bubble-toolbar-tooltip'
import { TABDOC_FLOATING_MENU_SURFACE_CLASS } from '../floating-menu-surface'
import { turnSelectionIntoList } from '../list-conversion'

export type SelectorItem = {
  nameKey: string
  icon: LucideIcon
  command: (
    editor: NonNullable<ReturnType<typeof useEditor>['editor']>,
  ) => void
  isActive: (
    editor: NonNullable<ReturnType<typeof useEditor>['editor']>,
  ) => boolean
}

const items: SelectorItem[] = [
  {
    nameKey: 'node.text',
    icon: TextIcon,
    command: (editor) => editor.chain().focus().clearNodes().run(),
    isActive: (editor) =>
      editor.isActive('paragraph') &&
      !editor.isActive('bulletList') &&
      !editor.isActive('orderedList'),
  },
  {
    nameKey: 'node.heading1',
    icon: Heading1,
    command: (editor) =>
      editor.chain().focus().clearNodes().toggleHeading({ level: 1 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 1 }),
  },
  {
    nameKey: 'node.heading2',
    icon: Heading2,
    command: (editor) =>
      editor.chain().focus().clearNodes().toggleHeading({ level: 2 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 2 }),
  },
  {
    nameKey: 'node.heading3',
    icon: Heading3,
    command: (editor) =>
      editor.chain().focus().clearNodes().toggleHeading({ level: 3 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 3 }),
  },
  {
    nameKey: 'node.todoList',
    icon: CheckSquare,
    command: (editor) => turnSelectionIntoList(editor, 'taskList'),
    isActive: (editor) => editor.isActive('taskItem'),
  },
  {
    nameKey: 'node.bulletList',
    icon: List,
    command: (editor) => turnSelectionIntoList(editor, 'bulletList'),
    isActive: (editor) => editor.isActive('bulletList'),
  },
  {
    nameKey: 'node.numberedList',
    icon: ListOrdered,
    command: (editor) => turnSelectionIntoList(editor, 'orderedList'),
    isActive: (editor) => editor.isActive('orderedList'),
  },
  {
    nameKey: 'node.quote',
    icon: TextQuote,
    command: (editor) =>
      editor.chain().focus().clearNodes().toggleBlockquote().run(),
    isActive: (editor) => editor.isActive('blockquote'),
  },
  {
    nameKey: 'node.code',
    icon: Code,
    command: (editor) =>
      editor.chain().focus().clearNodes().toggleCodeBlock().run(),
    isActive: (editor) => editor.isActive('codeBlock'),
  },
]

interface NodeSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const NodeSelector = ({ open, onOpenChange }: NodeSelectorProps) => {
  const { editor } = useEditor()
  const { t } = useTranslation('tabdoc')
  if (!editor) return null
  const activeItem = items.filter((item) => item.isActive(editor)).pop() ?? {
    nameKey: 'node.multiple',
  }
  const tooltipLabel = t('blockAction.turnInto')

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <BubbleToolbarTooltip label={tooltipLabel}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="gap-2 rounded-none"
            aria-label={tooltipLabel}
          >
            <span className="text-body whitespace-nowrap">{t(activeItem.nameKey)}</span>
            <ChevronDown className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
      </BubbleToolbarTooltip>
      <PopoverContent
        sideOffset={5}
        align="start"
        className={`${TABDOC_FLOATING_MENU_SURFACE_CLASS} z-dropdown data-[side=bottom]:!slide-in-from-top-0 data-[side=top]:!slide-in-from-bottom-0 w-48 p-1`}
      >
        {items.map((item) => (
          <EditorBubbleItem
            key={item.nameKey}
            onSelect={(editor) => {
              item.command(editor)
              onOpenChange(false)
            }}
            className="hover:bg-accent flex cursor-pointer items-center justify-between rounded-sm px-2 py-1 text-body"
          >
            <div className="flex items-center space-x-2">
              <div className="rounded-sm border p-1">
                <item.icon className="h-3 w-3" />
              </div>
              <span>{t(item.nameKey)}</span>
            </div>
            {activeItem.nameKey === item.nameKey && <Check className="h-4 w-4" />}
          </EditorBubbleItem>
        ))}
      </PopoverContent>
    </Popover>
  )
}
