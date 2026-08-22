/**
 * CollectionIconPicker — 合集图标 + 颜色选择器
 *
 * 紧凑的弹窗：上半区 emoji 网格，下半区颜色圆点。
 * 点击 emoji 切换图标，点击颜色圆点切换颜色。
 */
import React, { useCallback, useState } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'

const COLLECTION_EMOJIS = [
  '📚', '📁', '📂', '📖', '📝', '📋', '📎', '🗂️',
  '🎯', '🎨', '🎬', '🎵', '💡', '🔬', '🧪', '🛠️',
  '🌟', '🏗️', '📊', '📈', '🗺️', '🧩', '💎', '🔖',
  '🏷️', '📐', '✏️', '🖊️', '🖌️', '📸', '🎭', '🎪',
]

const COLLECTION_COLORS: Array<{ value: string; bg: string; ring: string }> = [
  { value: '', bg: 'bg-muted-foreground/20', ring: 'ring-muted-foreground/40' },
  { value: 'red', bg: 'bg-red-500', ring: 'ring-red-400' },
  { value: 'orange', bg: 'bg-orange-500', ring: 'ring-orange-400' },
  { value: 'amber', bg: 'bg-amber-500', ring: 'ring-amber-400' },
  { value: 'green', bg: 'bg-green-500', ring: 'ring-green-400' },
  { value: 'teal', bg: 'bg-teal-500', ring: 'ring-teal-400' },
  { value: 'blue', bg: 'bg-blue-500', ring: 'ring-blue-400' },
  { value: 'indigo', bg: 'bg-indigo-500', ring: 'ring-indigo-400' },
  { value: 'violet', bg: 'bg-violet-500', ring: 'ring-violet-400' },
  { value: 'pink', bg: 'bg-pink-500', ring: 'ring-pink-400' },
]

export function getCollectionColorClass(color: string | undefined): string {
  if (!color) return ''
  const found = COLLECTION_COLORS.find(c => c.value === color)
  return found ? found.bg : ''
}

interface CollectionIconPickerProps {
  icon: string
  color: string
  onIconChange: (icon: string) => void
  onColorChange: (color: string) => void
  trigger: React.ReactNode
  side?: 'right' | 'left' | 'top' | 'bottom'
}

export const CollectionIconPicker: React.FC<CollectionIconPickerProps> = ({
  icon, color, onIconChange, onColorChange, trigger, side = 'right',
}) => {
  const [open, setOpen] = useState(false)

  const handleSelectEmoji = useCallback((emoji: string) => {
    onIconChange(emoji)
  }, [onIconChange])

  const handleSelectColor = useCallback((c: string) => {
    onColorChange(c)
  }, [onColorChange])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger}
      </PopoverTrigger>
      <PopoverContent side={side} align="start" className="w-[220px] p-2" sideOffset={8}>
        <div className="grid grid-cols-8 gap-0.5 mb-2">
          {COLLECTION_EMOJIS.map(emoji => (
            <button
              key={emoji}
              type="button"
              className={cn(
                'h-7 w-7 flex items-center justify-center rounded-md text-body hover:bg-muted/60 transition-colors',
                icon === emoji && 'bg-primary/10 ring-1 ring-primary/30',
              )}
              onClick={() => handleSelectEmoji(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
        <div className="border-t border-border/20 pt-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {COLLECTION_COLORS.map(c => (
              <button
                key={c.value || 'none'}
                type="button"
                className={cn(
                  'h-5 w-5 rounded-full transition-all',
                  c.bg,
                  color === c.value ? `ring-2 ${c.ring} ring-offset-1 ring-offset-background` : 'opacity-60 hover:opacity-100',
                )}
                title={c.value || '无颜色'}
                onClick={() => handleSelectColor(c.value)}
              />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

CollectionIconPicker.displayName = 'CollectionIconPicker'
