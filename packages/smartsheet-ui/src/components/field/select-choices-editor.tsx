/** Select/MultiSelect 结构化选项编辑器。 */

import * as React from 'react'
import { Check, Plus, X } from 'lucide-react'
import { Input } from '../input'
import { Button } from '../button'
import { Label } from '../label'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'
import {
  resolveChoiceTagColors,
  SELECT_CHOICE_PRESET_COLORS,
  type SelectChoiceOption,
} from '../../utils/choice-colors'

export interface SelectChoicesEditorProps {
  choices: SelectChoiceOption[]
  onChange: (choices: SelectChoiceOption[]) => void
  label?: string
}

export const SelectChoicesEditor: React.FC<SelectChoicesEditorProps> = ({
  choices,
  onChange,
  label,
}) => {
  const inputRefs = React.useRef<(HTMLInputElement | null)[]>([])
  const [openColorPickerIndex, setOpenColorPickerIndex] = React.useState<number | null>(null)

  const updateChoice = (index: number, value: string) => {
    const sanitized = value.replace(/\n/g, '')
    const next = [...choices]
    next[index] = { ...next[index], value: sanitized, label: sanitized }
    onChange(next)
  }

  const updateChoiceColor = (index: number, color: string) => {
    const next = [...choices]
    next[index] = { ...next[index], color }
    onChange(next)
    setOpenColorPickerIndex(null)
  }

  const removeChoice = (index: number) => {
    onChange(choices.filter((_, itemIndex) => itemIndex !== index))
  }

  const addChoice = () => {
    const next = [
      ...choices,
      {
        value: '',
        label: '',
        color: SELECT_CHOICE_PRESET_COLORS[choices.length % SELECT_CHOICE_PRESET_COLORS.length],
      },
    ]
    onChange(next)
    requestAnimationFrame(() => inputRefs.current[next.length - 1]?.focus())
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      addChoice()
    } else if (event.key === 'Backspace' && choices[index]?.value === '' && choices.length > 1) {
      event.preventDefault()
      removeChoice(index)
      requestAnimationFrame(() => inputRefs.current[Math.max(0, index - 1)]?.focus())
    }
  }

  return (
    <div className="space-y-2">
      <Label>{label || t('editFieldDialog.choicesLabel')}</Label>
      <div className="space-y-1">
        {choices.map((choice, index) => {
          const displayColors = resolveChoiceTagColors(choice)
          return (
            <div key={index} className="flex items-center gap-1.5 group">
              <Popover
                open={openColorPickerIndex === index}
                onOpenChange={(open) => setOpenColorPickerIndex(open ? index : null)}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="size-4 shrink-0 rounded-full border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    style={{ backgroundColor: displayColors.backgroundColor }}
                    aria-label={t('editFieldDialog.choiceColor', {
                      name: choice.label || choice.value || `#${index + 1}`,
                    })}
                  />
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="start">
                  <div
                    className="grid grid-cols-6 gap-1.5"
                    role="listbox"
                    aria-label={t('editFieldDialog.choiceColorPalette')}
                  >
                    {SELECT_CHOICE_PRESET_COLORS.map((color) => {
                      const selected = choice.color.toUpperCase() === color
                      const foreground = resolveChoiceTagColors({ ...choice, color }).color
                      return (
                        <button
                          key={color}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          aria-label={color}
                          className="flex size-6 items-center justify-center rounded-full border border-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          style={{ backgroundColor: color, color: foreground }}
                          onClick={() => updateChoiceColor(index, color)}
                        >
                          {selected && <Check className="size-3.5" aria-hidden="true" />}
                        </button>
                      )
                    })}
                  </div>
                </PopoverContent>
              </Popover>
              <Input
                ref={(element) => { inputRefs.current[index] = element }}
                value={choice.value}
                onChange={(event) => updateChoice(index, event.target.value)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                placeholder={t('editFieldDialog.choicePlaceholder', { defaultValue: '输入选项名称' })}
                className="h-7 text-body"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'size-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity',
                  choices.length <= 1 && 'invisible',
                )}
                onClick={() => removeChoice(index)}
                aria-label={t('editFieldDialog.removeChoice')}
              >
                <X className="size-3" />
              </Button>
            </div>
          )
        })}
      </div>
      <Button type="button" variant="outline" size="sm" className="w-full" onClick={addChoice}>
        <Plus className="size-3 mr-1" />
        {t('editFieldDialog.addChoice', { defaultValue: '添加选项' })}
      </Button>
    </div>
  )
}
