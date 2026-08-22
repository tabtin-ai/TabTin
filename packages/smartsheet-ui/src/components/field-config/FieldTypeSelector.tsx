/**
 * FieldTypeSelector - 字段类型选择器
 *
 * Popover + Command 搜索网格，分组展示所有字段类型。
 * 平台无关版本，使用 smartsheet-ui 的 getFieldTypeIcon。
 */

import React, { useRef, useState, useSyncExternalStore } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '../command'
import { Button } from '../button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../sheet'
import { cn } from '../../utils/cn'
import { Check, ChevronDown } from 'lucide-react'
import { getFieldTypeIcon } from '../common/field-type-icon'
import { useTranslation } from 'react-i18next'
import { isPrimaryFieldAllowedType } from '@tabtin/table-core'
import type { FieldType } from '../../hooks/useFieldConfigForm'

interface FieldTypeMeta {
  value: FieldType
  group: 'standard' | 'advanced'
}

const MOBILE_FIELD_TYPE_QUERY = '(max-width: 639px)'

const subscribeToMobileViewport = (onChange: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const mediaQuery = window.matchMedia(MOBILE_FIELD_TYPE_QUERY)
  mediaQuery.addEventListener?.('change', onChange)
  return () => mediaQuery.removeEventListener?.('change', onChange)
}

const getMobileViewportSnapshot = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(MOBILE_FIELD_TYPE_QUERY).matches

const FIELD_TYPE_META: FieldTypeMeta[] = [
  { value: 'text', group: 'standard' },
  { value: 'long_text', group: 'standard' },
  { value: 'number', group: 'standard' },
  { value: 'percent', group: 'standard' },
  { value: 'currency', group: 'standard' },
  { value: 'rating', group: 'standard' },
  { value: 'select', group: 'standard' },
  { value: 'multi_select', group: 'standard' },
  { value: 'date', group: 'standard' },
  { value: 'checkbox', group: 'standard' },
  { value: 'user', group: 'standard' },
  { value: 'url', group: 'standard' },
  { value: 'email', group: 'standard' },
  { value: 'phone', group: 'standard' },
  { value: 'attachment', group: 'standard' },
  // 关联：配置面板与后端链路已可用，开放创建入口。
  { value: 'link', group: 'advanced' },
]

export interface FieldTypeSelectorProps {
  value: FieldType
  onChange: (value: FieldType) => void
  disabled?: boolean
  isPrimary?: boolean
  currentFieldType?: FieldType
  isOptionDisabled?: (type: FieldType) => boolean
}

export const FieldTypeSelector: React.FC<FieldTypeSelectorProps> = ({
  value,
  onChange,
  disabled,
  isPrimary,
  currentFieldType,
  isOptionDisabled,
}) => {
  const { t } = useTranslation('field')
  const [open, setOpen] = useState(false)
  const mobileSheetRef = useRef<HTMLDivElement>(null)
  const isMobileViewport = useSyncExternalStore(
    subscribeToMobileViewport,
    getMobileViewportSnapshot,
    () => false,
  )

  const isTypeAllowed = (type: FieldType): boolean => {
    // 主字段改类型：与后端 / table-core 白名单对齐，当前类型始终可选
    if (isPrimary && type !== currentFieldType && !isPrimaryFieldAllowedType(type)) {
      return false
    }
    if (isOptionDisabled?.(type)) return false
    return true
  }

  const visibleTypes = FIELD_TYPE_META
  const standardTypes = visibleTypes.filter((m) => m.group === 'standard')
  const advancedTypes = visibleTypes.filter((m) => m.group === 'advanced')

  const SelectedIcon = getFieldTypeIcon(value)

  const renderTrigger = () => (
    <Button
      variant="outline"
      role="combobox"
      aria-expanded={open}
      disabled={disabled}
      className="w-full justify-between font-normal"
    >
      <span className="flex items-center gap-2">
        <SelectedIcon className="h-3.5 w-3.5 opacity-70" />
        {t(`types.${value}`, { defaultValue: value })}
      </span>
      <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
    </Button>
  )

  const renderTypeCommand = (mobile: boolean) => (
    <Command
      className={cn(mobile && 'min-h-0 flex-1')}
      filter={(val, search) => {
        if (!search) return 1
        const label = t(`types.${val}`, { defaultValue: val })
        return label.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
      }}
    >
      <CommandInput
        placeholder={t('fieldSettingPanel.searchType', { defaultValue: '搜索字段类型...' })}
        containerClassName="focus-within:!outline-none focus-within:!ring-0 focus-within:!ring-offset-0"
        className="!outline-none !ring-0 !ring-offset-0 focus:!outline-none focus:!ring-0 focus:!ring-offset-0 focus-visible:!outline-none focus-visible:!ring-0 focus-visible:!ring-offset-0"
      />
      <CommandList className={cn(mobile ? 'min-h-0 flex-1 max-h-none' : 'max-h-[300px]')}>
        <CommandEmpty>{t('fieldSettingPanel.noTypeFound', { defaultValue: '没有匹配的类型' })}</CommandEmpty>

        <CommandGroup heading={t('fieldSettingPanel.standardTypes', { defaultValue: '基础字段' })}>
          <div className="grid grid-cols-2 gap-0.5 p-1">
            {standardTypes.map((meta) => {
              const Icon = getFieldTypeIcon(meta.value)
              const allowed = isTypeAllowed(meta.value)
              return (
                <CommandItem
                  key={meta.value}
                  value={meta.value}
                  disabled={!allowed}
                  onSelect={() => {
                    if (allowed) {
                      onChange(meta.value)
                      setOpen(false)
                    }
                  }}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5',
                    !allowed && 'opacity-40 cursor-not-allowed',
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="flex-1 truncate text-body">
                    {t(`types.${meta.value}`, { defaultValue: meta.value })}
                  </span>
                  {value === meta.value && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  )}
                </CommandItem>
              )
            })}
          </div>
        </CommandGroup>

        {advancedTypes.length > 0 && (
          <CommandGroup heading={t('fieldSettingPanel.advancedTypes', { defaultValue: '高级字段' })}>
            <div className="grid grid-cols-2 gap-0.5 p-1">
              {advancedTypes.map((meta) => {
                const Icon = getFieldTypeIcon(meta.value)
                const allowed = isTypeAllowed(meta.value)
                return (
                  <CommandItem
                    key={meta.value}
                    value={meta.value}
                    disabled={!allowed}
                    onSelect={() => {
                      if (allowed) {
                        onChange(meta.value)
                        setOpen(false)
                      }
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5',
                      !allowed && 'opacity-40 cursor-not-allowed',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <span className="flex-1 truncate text-body">
                      {t(`types.${meta.value}`, { defaultValue: meta.value })}
                    </span>
                    {value === meta.value && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                    )}
                  </CommandItem>
                )
              })}
            </div>
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  )

  if (isMobileViewport) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{renderTrigger()}</SheetTrigger>
        <SheetContent
          ref={mobileSheetRef}
          side="bottom"
          tabIndex={-1}
          className="flex h-[min(70dvh,32rem)] max-h-[calc(100dvh-1rem)] flex-col gap-0 overflow-hidden rounded-t-xl p-0 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            mobileSheetRef.current?.focus()
          }}
        >
          <SheetHeader className="shrink-0 px-4 pb-2 pt-4 text-left">
            <SheetTitle>{t('fieldSettingPanel.fieldType', { defaultValue: '字段类型' })}</SheetTitle>
            <SheetDescription>
              {t('createFieldDialog.description.step1', { defaultValue: '选择要创建的字段类型' })}
            </SheetDescription>
          </SheetHeader>
          {renderTypeCommand(true)}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{renderTrigger()}</PopoverTrigger>
      <PopoverContent
        className="w-[min(320px,var(--radix-popover-content-available-width))] max-w-[calc(100vw-1rem)] p-0"
        align="start"
        collisionPadding={8}
      >
        {renderTypeCommand(false)}
      </PopoverContent>
    </Popover>
  )
}
