/**
 * ComboboxSelect — 可搜索下拉选择组件
 *
 * 从 table-ui ViewFilter/Sort/GroupRulesEditor 中提炼。
 * 基于 Popover + Command（cmdk），支持搜索、选中高亮。
 *
 * @example
 * <ComboboxSelect
 *   value={selectedId}
 *   options={[{ value: 'a', label: 'Option A' }]}
 *   onSelect={setSelectedId}
 *   placeholder="Select..."
 * />
 */

import * as React from 'react'
import { Button } from './button'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from './popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from './command'
import { cn } from '../utils/cn'
import { Check, ChevronDown } from 'lucide-react'

export interface ComboboxSelectOption {
  value: string
  label: string
}

export interface ComboboxSelectProps {
  /** 当前选中值 */
  value: string
  /** 选项列表 */
  options: ComboboxSelectOption[]
  /** 选中回调 */
  onSelect: (value: string) => void
  /** 未选择时的占位文本 */
  placeholder?: string
  /** 搜索框占位文本 */
  searchPlaceholder?: string
  /** 搜索无结果文本 */
  noResults?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 弹出宽度（默认 200px） */
  popoverWidth?: number | string
  /** 弹出对齐方式 */
  popoverAlign?: 'start' | 'center' | 'end'
  /** 按钮额外 className */
  className?: string
}

export const ComboboxSelect: React.FC<ComboboxSelectProps> = ({
  value,
  options,
  onSelect,
  placeholder = '',
  searchPlaceholder = 'Search...',
  noResults = 'No results',
  disabled,
  popoverWidth = 200,
  popoverAlign = 'start',
  className,
}) => {
  const [open, setOpen] = React.useState(false)
  const selected = options.find((o) => o.value === value)
  const label = selected ? selected.label : placeholder

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'h-8 justify-between gap-1 px-2 text-body font-normal',
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        style={{ width: typeof popoverWidth === 'number' ? `${popoverWidth}px` : popoverWidth }}
        align={popoverAlign}
      >
        <Command>
          <CommandInput
            placeholder={searchPlaceholder}
            containerClassName="h-9 focus-within:!outline-none focus-within:!ring-0 focus-within:!ring-offset-0"
            className="!outline-none !ring-0 !ring-offset-0 focus:!outline-none focus:!ring-0 focus:!ring-offset-0 focus-visible:!outline-none focus-visible:!ring-0 focus-visible:!ring-offset-0"
          />
          <CommandList>
            <CommandEmpty>{noResults}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => {
                    onSelect(option.value)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'h-3.5 w-3.5',
                      value === option.value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

ComboboxSelect.displayName = 'ComboboxSelect'
