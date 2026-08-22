import { Check, ChevronDown } from 'lucide-react'
import { EditorBubbleItem, useEditor } from 'novel'
import { useTranslation } from 'react-i18next'
import { Button, Popover, PopoverContent, PopoverTrigger, ScrollArea } from '@tabtin/smartsheet-ui'
import { BubbleToolbarTooltip } from './bubble-toolbar-tooltip'
import { TABDOC_FLOATING_MENU_SURFACE_CLASS } from '../floating-menu-surface'

export interface BubbleColorMenuItem {
  nameKey: string
  color: string
}

const TEXT_COLORS: BubbleColorMenuItem[] = [
  { nameKey: 'color.default', color: 'var(--novel-black, )' },
  { nameKey: 'color.purple', color: '#9333EA' },
  { nameKey: 'color.red', color: '#E00000' },
  { nameKey: 'color.yellow', color: '#EAB308' },
  { nameKey: 'color.blue', color: '#2563EB' },
  { nameKey: 'color.green', color: '#008A00' },
  { nameKey: 'color.orange', color: '#FFA500' },
  { nameKey: 'color.pink', color: '#BA4081' },
  { nameKey: 'color.gray', color: '#A8A29E' },
]

const HIGHLIGHT_COLORS: BubbleColorMenuItem[] = [
  { nameKey: 'color.default', color: 'var(--novel-highlight-default, transparent)' },
  { nameKey: 'color.purple', color: 'var(--novel-highlight-purple, #f3e8ff)' },
  { nameKey: 'color.red', color: 'var(--novel-highlight-red, #fee2e2)' },
  { nameKey: 'color.yellow', color: 'var(--novel-highlight-yellow, #fef9c3)' },
  { nameKey: 'color.blue', color: 'var(--novel-highlight-blue, #dbeafe)' },
  { nameKey: 'color.green', color: 'var(--novel-highlight-green, #dcfce7)' },
  { nameKey: 'color.orange', color: 'var(--novel-highlight-orange, #ffedd5)' },
  { nameKey: 'color.pink', color: 'var(--novel-highlight-pink, #fce7f3)' },
  { nameKey: 'color.gray', color: 'var(--novel-highlight-gray, #f3f4f6)' },
]

interface ColorSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const ColorSelector = ({ open, onOpenChange }: ColorSelectorProps) => {
  const { editor } = useEditor()
  const { t } = useTranslation('tabdoc')

  if (!editor) return null
  const activeColorItem = TEXT_COLORS.find(({ color }) =>
    editor.isActive('textStyle', { color }),
  )

  const activeHighlightItem = HIGHLIGHT_COLORS.find(({ color }) =>
    editor.isActive('highlight', { color }),
  )
  const tooltipLabel = `${t('color.textColor')} / ${t('color.background')}`

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <BubbleToolbarTooltip label={tooltipLabel}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            className="gap-2 rounded-none"
            variant="ghost"
            aria-label={tooltipLabel}
          >
            <span
              className="rounded-sm px-1"
              style={{
                color: activeColorItem?.color,
                backgroundColor: activeHighlightItem?.color,
              }}
            >
              A
            </span>
            <ChevronDown className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
      </BubbleToolbarTooltip>

      <PopoverContent
        sideOffset={5}
        className={`${TABDOC_FLOATING_MENU_SURFACE_CLASS} z-dropdown data-[side=bottom]:!slide-in-from-top-0 data-[side=top]:!slide-in-from-bottom-0 my-1 flex max-h-80 w-48 flex-col overflow-hidden rounded p-1`}
        align="start"
      >
        <ScrollArea className="flex-1">
        <div className="flex flex-col">
          <div className="text-muted-foreground my-1 px-2 text-body font-semibold">
            {t('color.textColor')}
          </div>
          {TEXT_COLORS.map(({ nameKey, color }) => (
            <EditorBubbleItem
              key={`text-${nameKey}`}
              onSelect={() => {
                editor.commands.unsetColor()
                nameKey !== 'color.default' &&
                  editor
                    .chain()
                    .focus()
                    .setColor(color || '')
                    .run()
                onOpenChange(false)
              }}
              className="hover:bg-accent flex cursor-pointer items-center justify-between px-2 py-1 text-body"
            >
              <div className="flex items-center gap-2">
                <div
                  className="rounded-sm border px-2 py-px font-medium"
                  style={{ color }}
                >
                  A
                </div>
                <span>{t(nameKey)}</span>
              </div>
              {editor.isActive('textStyle', { color }) && (
                <Check className="h-4 w-4" />
              )}
            </EditorBubbleItem>
          ))}
        </div>
        <div>
          <div className="text-muted-foreground my-1 px-2 text-body font-semibold">
            {t('color.background')}
          </div>
          {HIGHLIGHT_COLORS.map(({ nameKey, color }) => (
            <EditorBubbleItem
              key={`bg-${nameKey}`}
              onSelect={() => {
                editor.commands.unsetHighlight()
                nameKey !== 'color.default' &&
                  editor.chain().focus().setHighlight({ color }).run()
                onOpenChange(false)
              }}
              className="hover:bg-accent flex cursor-pointer items-center justify-between px-2 py-1 text-body"
            >
              <div className="flex items-center gap-2">
                <div
                  className="rounded-sm border px-2 py-px font-medium"
                  style={{ backgroundColor: color }}
                >
                  A
                </div>
                <span>{t(nameKey)}</span>
              </div>
              {editor.isActive('highlight', { color }) && (
                <Check className="h-4 w-4" />
              )}
            </EditorBubbleItem>
          ))}
        </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
