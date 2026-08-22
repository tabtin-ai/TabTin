import { Check, Trash } from 'lucide-react'
import { useEditor } from 'novel'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@tabtin/smartsheet-ui'
import { cn } from '@tabtin/smartsheet-ui'
import { BubbleToolbarTooltip } from './bubble-toolbar-tooltip'
import { TABDOC_FLOATING_MENU_SURFACE_CLASS } from '../floating-menu-surface'

export function isValidUrl(url: string) {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

export function getUrlFromString(str: string) {
  if (isValidUrl(str)) return str
  try {
    if (str.includes('.') && !str.includes(' ')) {
      return new URL(`https://${str}`).toString()
    }
  } catch {
    return null
  }
}

interface LinkSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const LinkSelector = ({ open, onOpenChange }: LinkSelectorProps) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [inputValue, setInputValue] = useState('')
  const { editor } = useEditor()
  const { t } = useTranslation('tabdoc')

  // Sync editor link href to input when popover opens
  useEffect(() => {
    if (open && editor) {
      setInputValue(editor.getAttributes('link').href || '')
    }
  }, [open, editor])

  // Autofocus on input when popover opens
  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
    }
  }, [open])

  if (!editor) return null
  const tooltipLabel = t('link.label')

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <BubbleToolbarTooltip label={tooltipLabel}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="gap-2 rounded-none border-none"
            aria-label={tooltipLabel}
          >
            <p className="text-subtitle">{'\u2197'}</p>
            <p
              className={cn('underline decoration-stone-400 underline-offset-4', {
                'text-info': editor.isActive('link'),
              })}
            >
              {tooltipLabel}
            </p>
          </Button>
        </PopoverTrigger>
      </BubbleToolbarTooltip>
      <PopoverContent
        align="start"
        className={`${TABDOC_FLOATING_MENU_SURFACE_CLASS} z-dropdown data-[side=bottom]:!slide-in-from-top-0 data-[side=top]:!slide-in-from-bottom-0 w-60 p-0`}
        sideOffset={10}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const url = getUrlFromString(inputValue)
            if (url) {
              if (editor.isActive('link')) {
                editor.chain().extendMarkRange('link').setLink({ href: url }).run()
              } else {
                editor.chain().setLink({ href: url }).run()
              }
              onOpenChange(false)
            }
          }}
          className="flex p-1"
        >
          <input
            ref={inputRef}
            type="text"
            placeholder={t('link.placeholder')}
            className="bg-background flex-1 p-1 text-body outline-none"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
          />
          {editor.getAttributes('link').href ? (
            <Button
              size="icon"
              variant="outline"
              type="button"
              className="flex h-8 items-center rounded-sm p-1 text-destructive transition-all hover:bg-destructive/10"
              onClick={() => {
                editor.chain().extendMarkRange('link').unsetLink().run()
                setInputValue('')
                onOpenChange(false)
              }}
            >
              <Trash className="h-4 w-4" />
            </Button>
          ) : (
            <Button type="submit" size="icon" className="h-8">
              <Check className="h-4 w-4" />
            </Button>
          )}
        </form>
      </PopoverContent>
    </Popover>
  )
}
