/**
 * FieldValueEditor — 统一的字段值编辑器
 *
 * 从 RecordFormDialog.renderFieldInput 提取而来，供记录表单和表单视图共用。
 * 纯受控组件：value + onChange，不持有内部表单状态。
 */

import * as React from 'react'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { Button } from '../button'
import { Input } from '../input'
import { Label } from '../label'
import { Checkbox } from '../checkbox'
import { Popover, PopoverTrigger, PopoverContent } from '../popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '../command'
import { Textarea } from '../textarea'
import { DatePicker } from '../date/DatePicker'
import { UserSelector, type UserOption } from '../user/UserSelector'
import { UserAvatar } from '../common/user-avatar'
import { cn } from '../../utils/cn'
import {
  getChoiceValue,
  getChoiceLabel,
  resolveChoiceTagColors,
  type ChoiceItem,
} from '../../utils/choice-colors'
import { t } from '../../i18n'
import { LinkedRecordsTable } from './LinkedRecordsTable'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FieldChoiceOption {
  value?: string
  label?: string
  name?: string
  color?: string
}

export interface FieldValueEditorField {
  id: string
  name: string
  displayName?: string
  field_type: string
  description?: string
  displayDescription?: string
  is_primary?: boolean
  options?: Record<string, unknown>
  cellValueType?: string
  config?: Record<string, unknown>
}

export interface AttachmentRenderProps {
  field: FieldValueEditorField
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
  tableId?: string
  recordId?: string
}

export interface FieldValueEditorProps {
  field: FieldValueEditorField
  value: unknown
  onChange: (value: unknown) => void
  error?: string
  disabled?: boolean
  mode?: 'create' | 'edit'
  tableId?: string
  recordId?: string

  organizationMembers?: UserOption[]
  renderAttachment?: (props: AttachmentRenderProps) => React.ReactNode
  onLinkEdit?: (fieldId: string, fieldName: string, currentValue: unknown) => void
  /** 打开关联记录完整详情（复用主字段展开 → 编辑记录侧栏） */
  onOpenLinkedRecord?: (payload: {
    fieldId: string
    foreignTableId: string
    recordId: string
    title?: string
  }) => void
  getFieldExtra?: (key: string) => unknown
}

function getFieldDisplayName(field: FieldValueEditorField): string {
  return field.displayName || field.name
}

function getFieldDescription(field: FieldValueEditorField): string | undefined {
  return field.displayDescription ?? field.description
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const val = bytes / Math.pow(k, i)
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${sizes[i]}`
}

const stringifyFieldValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 可搜索单选：与 multi_select 同构的 Popover + Command，选中后关层 */
const SelectChoiceCombobox: React.FC<{
  value: string
  choices: ChoiceItem[]
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
  error?: boolean
}> = ({ value, choices, onChange, placeholder, disabled, error }) => {
  const [open, setOpen] = React.useState(false)
  const selected = choices.find((c) => getChoiceValue(c) === value)
  const selectedLabel = selected ? getChoiceLabel(selected) : value
  const selectedColors =
    value && selected
      ? resolveChoiceTagColors({
          value,
          label: selectedLabel,
          color:
            typeof selected === 'object'
              ? ((selected as Record<string, unknown>).color as string | undefined)
              : undefined,
        })
      : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'flex w-full min-h-[36px] items-center justify-between rounded-md bg-muted px-3 py-2 text-body ring-offset-background',
            'focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-50',
            error && 'border-destructive',
          )}
          disabled={disabled}
        >
          {value ? (
            <span className="inline-flex items-center gap-1.5 truncate min-w-0">
              {selectedColors && (
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: selectedColors.backgroundColor }}
                />
              )}
              <span className="truncate">{selectedLabel || value}</span>
            </span>
          ) : (
            <span className="text-muted-foreground truncate">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder={t('recordFormDialog.multiSelect.search')} />
          <CommandList>
            <CommandEmpty>{t('recordFormDialog.multiSelect.noResults')}</CommandEmpty>
            <CommandGroup>
              {choices.map((choice) => {
                const cv = getChoiceValue(choice)
                const cl = getChoiceLabel(choice)
                const isSelected = value === cv
                const itemColors = resolveChoiceTagColors({
                  value: cv,
                  label: cl,
                  color:
                    typeof choice === 'object'
                      ? ((choice as Record<string, unknown>).color as string | undefined)
                      : undefined,
                })
                return (
                  <CommandItem
                    key={cv}
                    value={cl}
                    onSelect={() => {
                      onChange(cv)
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn(
                        'h-4 w-4',
                        isSelected ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: itemColors.backgroundColor }}
                    />
                    {cl}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const formatSystemDateTime = (
  value: unknown,
  fieldOptions?: Record<string, unknown>,
): string => {
  if (value == null || value === '') return '-'
  const date = new Date(typeof value === 'number' ? value : String(value))
  if (Number.isNaN(date.getTime())) return '-'

  const dateFormat = fieldOptions?.date_format ?? (fieldOptions?.formatting as Record<string, unknown>)?.date
  const timeFormat = fieldOptions?.time_format ?? (fieldOptions?.formatting as Record<string, unknown>)?.time

  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }

  if (typeof dateFormat === 'string') {
    if (/MMMM/.test(dateFormat)) opts.month = 'long'
    else if (/MMM/.test(dateFormat)) opts.month = 'short'
  }

  if (typeof timeFormat === 'string' && timeFormat !== 'None') {
    opts.hour = '2-digit'
    opts.minute = '2-digit'
    if (/[sS]{2}/.test(timeFormat)) opts.second = '2-digit'
    opts.hour12 = !/^HH/.test(timeFormat)
  } else if (timeFormat === undefined || timeFormat === null) {
    opts.hour = '2-digit'
    opts.minute = '2-digit'
  }

  return new Intl.DateTimeFormat(undefined, opts).format(date)
}

// ---------------------------------------------------------------------------
// NestedListEditor (stateful sub-component)
// ---------------------------------------------------------------------------

const NestedListEditor: React.FC<{
  field: FieldValueEditorField
  value: unknown
  onChange: (parsed: unknown) => void
  error?: string
  readOnly?: boolean
}> = ({ field, value, onChange, error, readOnly }) => {
  const [rawText, setRawText] = React.useState(() =>
    value ? JSON.stringify(value, null, 2) : '',
  )
  const [parseError, setParseError] = React.useState(false)

  const prevValueRef = React.useRef(value)
  React.useEffect(() => {
    if (prevValueRef.current !== value) {
      prevValueRef.current = value
      if (!parseError) {
        setRawText(value ? JSON.stringify(value, null, 2) : '')
      }
    }
  }, [value, parseError])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setRawText(text)
    if (!text.trim()) {
      setParseError(false)
      onChange(null)
      return
    }
    try {
      const parsed = JSON.parse(text)
      setParseError(false)
      onChange(parsed)
    } catch {
      setParseError(true)
    }
  }

  const handleBlur = () => {
    const trimmed = rawText.trim()
    if (!trimmed) { onChange(null); return }
    try {
      onChange(JSON.parse(trimmed))
    } catch {
      /* leave parseError visible */
    }
  }

  return (
    <div>
      <Textarea
        value={rawText}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder="[{...}, {...}]"
        rows={4}
        className={cn(
          'font-mono text-caption',
          (error || parseError) && 'border-destructive',
        )}
        readOnly={readOnly}
      />
      {parseError && (
        <p className="text-body text-destructive mt-1">
          {t('recordFormDialog.errors.invalidJson')}
        </p>
      )}
      {getFieldDescription(field) && (
        <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
      )}
      {error && <p className="text-body text-destructive mt-1">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// FieldValueEditor
// ---------------------------------------------------------------------------

export const FieldValueEditor: React.FC<FieldValueEditorProps> = ({
  field,
  value: rawValue,
  onChange,
  error,
  disabled = false,
  mode = 'edit',
  tableId,
  recordId,
  organizationMembers,
  renderAttachment,
  onLinkEdit,
  onOpenLinkedRecord,
  getFieldExtra,
}) => {
  const value = rawValue ?? ''
  const options = field.options ?? field.config ?? {}

  // ── User resolution helpers ──
  const memberMap = React.useMemo(() => {
    const map = new Map<string, UserOption>()
    if (organizationMembers) {
      for (const m of organizationMembers) map.set(m.id, m)
    }
    return map
  }, [organizationMembers])

  const resolveUserDisplay = React.useCallback(
    (val: unknown): { userId?: string; displayName: string; avatarUrl?: string } => {
      if (!val) return { displayName: '-' }
      let userId: string | undefined
      let fallbackName: string | undefined
      if (typeof val === 'object' && val !== null) {
        const obj = val as Record<string, unknown>
        userId = obj.id != null ? String(obj.id) : undefined
        fallbackName = String(obj.name ?? obj.display_name ?? obj.id ?? '-')
      } else {
        userId = String(val)
        fallbackName = String(val)
      }
      if (userId && memberMap.has(userId)) {
        const member = memberMap.get(userId)!
        return { userId, displayName: member.name, avatarUrl: member.avatarUrl }
      }
      return { userId, displayName: fallbackName || '-' }
    },
    [memberMap],
  )

  // ── Render by field type ──
  switch (field.field_type) {
    // ── Text family ──
    case 'text':
    case 'email':
    case 'url':
    case 'phone':
      return (
        <div>
          <Input
            type={
              field.field_type === 'email'
                ? 'email'
                : field.field_type === 'url'
                  ? 'url'
                  : field.field_type === 'phone'
                    ? 'tel'
                    : 'text'
            }
            value={value as string}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t('recordFormDialog.placeholder.input', { name: getFieldDisplayName(field) })}
            className={error ? 'border-destructive' : ''}
            disabled={disabled}
          />
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
          {error && <p className="text-body text-destructive mt-1">{error}</p>}
        </div>
      )

    case 'long_text':
      return (
        <div>
          <Textarea
            value={value as string}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t('recordFormDialog.placeholder.input', { name: getFieldDisplayName(field) })}
            className={error ? 'border-destructive' : ''}
            rows={4}
            disabled={disabled}
          />
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
          {error && <p className="text-body text-destructive mt-1">{error}</p>}
        </div>
      )

    // ── Number family ──
    case 'number':
      return (
        <div>
          <Input
            type="number"
            value={value != null && value !== '' ? String(value) : ''}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}
            placeholder={t('recordFormDialog.placeholder.input', { name: getFieldDisplayName(field) })}
            className={error ? 'border-destructive' : ''}
            step="any"
            disabled={disabled}
          />
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
          {error && <p className="text-body text-destructive mt-1">{error}</p>}
        </div>
      )

    case 'percent': {
      const numVal = value !== '' && value != null ? Number(value) : NaN
      const pctDisplay = !Number.isNaN(numVal) ? numVal * 100 : value
      return (
        <div>
          <div className="relative">
            <Input
              type="number"
              value={pctDisplay != null && pctDisplay !== '' ? String(pctDisplay) : ''}
              onChange={(e) => {
                const raw = e.target.value
                onChange(raw ? Number(raw) / 100 : '')
              }}
              placeholder={t('recordFormDialog.placeholder.input', { name: getFieldDisplayName(field) })}
              className={cn('pr-8', error ? 'border-destructive' : '')}
              step="any"
              disabled={disabled}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-body pointer-events-none">
              %
            </span>
          </div>
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
          {error && <p className="text-body text-destructive mt-1">{error}</p>}
        </div>
      )
    }

    case 'currency': {
      const symbol = String(options.currency_symbol ?? options.symbol ?? '¥')
      return (
        <div>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-body pointer-events-none">
              {symbol}
            </span>
            <Input
              type="number"
              value={value != null && value !== '' ? String(value) : ''}
              onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}
              placeholder={t('recordFormDialog.placeholder.input', { name: getFieldDisplayName(field) })}
              className={cn('pl-8', error ? 'border-destructive' : '')}
              step="any"
              disabled={disabled}
            />
          </div>
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
          {error && <p className="text-body text-destructive mt-1">{error}</p>}
        </div>
      )
    }

    // ── Date ──
    case 'date':
    {
      const formattingOpts = options.formatting as Record<string, unknown> | undefined
      return (
        <div>
          <DatePicker
            value={(value as string) || null}
            onChange={(nextValue) => onChange(nextValue)}
            options={{ formatting: formattingOpts }}
            disableTimePicker
            error={!!error}
            disabled={disabled}
          />
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
          {error && <p className="text-body text-destructive mt-1">{error}</p>}
        </div>
      )
    }

    // ── Select ──
    case 'select': {
      const choices: ChoiceItem[] = (options.choices as ChoiceItem[]) ?? []
      const selectValue = typeof value === 'string' ? value : ''
      return (
        <div>
          <div className="flex items-center gap-1">
            <div className="flex-1 min-w-0">
              <SelectChoiceCombobox
                value={selectValue}
                choices={choices}
                onChange={(val) => onChange(val)}
                placeholder={t('recordFormDialog.placeholder.select', { name: getFieldDisplayName(field) })}
                disabled={disabled}
                error={!!error}
              />
            </div>
            {selectValue && !disabled && (
              <button
                type="button"
                className="inline-flex items-center justify-center h-8 w-8 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.08] transition-colors"
                onClick={() => onChange(null)}
                aria-label={t('recordFormDialog.select.none')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
          {error && <p className="text-body text-destructive mt-1">{error}</p>}
        </div>
      )
    }

    // ── Multi Select ──
    case 'multi_select': {
      const multiValue: string[] = Array.isArray(value) ? value : []
      const choices: ChoiceItem[] = (options.choices as ChoiceItem[]) ?? []
      return (
        <div>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                role="combobox"
                className={cn(
                  'flex w-full min-h-[36px] items-center justify-between rounded-md bg-muted px-3 py-2 text-body ring-offset-background',
                  'focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ring',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  error && 'border-destructive',
                )}
                disabled={disabled}
              >
                <div className="flex flex-wrap gap-1 flex-1">
                  {multiValue.length > 0 ? (
                    multiValue.map((v) => {
                      const choice = choices.find((c) => getChoiceValue(c) === v)
                      const label = choice ? getChoiceLabel(choice) : v
                      const tagColors = resolveChoiceTagColors({
                        value: v,
                        label,
                        color:
                          choice && typeof choice === 'object'
                            ? (choice as Record<string, unknown>).color as string | undefined
                            : undefined,
                      })
                      return (
                        <span
                          key={v}
                          className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-caption"
                          style={{ backgroundColor: tagColors.backgroundColor, color: tagColors.color }}
                        >
                          {label}
                          {!disabled && (
                            <span
                              role="button"
                              tabIndex={0}
                              className="ml-0.5 rounded-full cursor-pointer"
                              style={{ color: tagColors.color }}
                              onClick={(e) => {
                                e.stopPropagation()
                                onChange(multiValue.filter((x) => x !== v))
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.stopPropagation()
                                  onChange(multiValue.filter((x) => x !== v))
                                }
                              }}
                            >
                              <X className="h-3 w-3" />
                            </span>
                          )}
                        </span>
                      )
                    })
                  ) : (
                    <span className="text-muted-foreground">
                      {t('recordFormDialog.multiSelect.placeholder')}
                    </span>
                  )}
                </div>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
              <Command>
                <CommandInput placeholder={t('recordFormDialog.multiSelect.search')} />
                <CommandList>
                  <CommandEmpty>{t('recordFormDialog.multiSelect.noResults')}</CommandEmpty>
                  <CommandGroup>
                    {choices.map((choice) => {
                      const cv = getChoiceValue(choice)
                      const cl = getChoiceLabel(choice)
                      const isSelected = multiValue.includes(cv)
                      const itemColors = resolveChoiceTagColors({
                        value: cv,
                        label: cl,
                        color:
                          typeof choice === 'object'
                            ? (choice as Record<string, unknown>).color as string | undefined
                            : undefined,
                      })
                      return (
                        <CommandItem
                          key={cv}
                          value={cl}
                          onSelect={() => {
                            if (isSelected) {
                              onChange(multiValue.filter((x) => x !== cv))
                            } else {
                              onChange([...multiValue, cv])
                            }
                          }}
                        >
                          <Check
                            className={cn(
                              'h-4 w-4',
                              isSelected ? 'opacity-100' : 'opacity-0',
                            )}
                          />
                          <span
                            className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: itemColors.backgroundColor }}
                          />
                          {cl}
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
          {error && <p className="text-body text-destructive mt-1">{error}</p>}
        </div>
      )
    }

    // ── Checkbox ──
    case 'checkbox':
      return (
        <div className="space-y-2">
          <div className="flex items-center space-x-2">
            <Checkbox
              id={`fve-${field.id}`}
              checked={!!rawValue}
              onCheckedChange={(checked) => onChange(checked)}
              disabled={disabled}
            />
            {getFieldDescription(field) && (
              <Label htmlFor={`fve-${field.id}`} className="text-body font-normal cursor-pointer">
                {getFieldDescription(field)}
              </Label>
            )}
          </div>
          {error && <p className="text-body text-destructive mt-1">{error}</p>}
        </div>
      )

    // ── Rating ──
    case 'rating': {
      const max = Number(options.max ?? 5) || 5
      const currentRating = Number(rawValue) || 0
      return (
        <div>
          <div className="flex items-center gap-1">
            {Array.from({ length: max }, (_, i) => i + 1).map((star) => (
              <button
                key={star}
                type="button"
                aria-label={t('recordFormDialog.rating.starLabel', { star })}
                className={cn(
                  'text-title transition-colors',
                  star <= currentRating ? 'text-warning' : 'text-muted-foreground/30',
                  !disabled && 'cursor-pointer hover:text-warning',
                )}
                onClick={() => onChange(star === currentRating ? null : star)}
                disabled={disabled}
              >
                ★
              </button>
            ))}
          </div>
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
          {error && <p className="text-body text-destructive mt-1">{error}</p>}
        </div>
      )
    }

    // ── Attachment ──
    case 'attachment':
    {
      const attachments: unknown[] = Array.isArray(rawValue)
        ? rawValue
        : rawValue
          ? [rawValue]
          : []

      if (renderAttachment) {
        return (
          <div>
            {renderAttachment({
              field,
              value: attachments,
              onChange,
              disabled,
              tableId,
              recordId,
            })}
            {error && <p className="text-body text-destructive mt-1">{error}</p>}
          </div>
        )
      }

      return (
        <div className="space-y-3">
          <div className="space-y-2 rounded-md border border-dashed border-border/60 bg-muted/30 p-3">
            {attachments.length > 0 ? (
              attachments.map((rawItem, index) => {
                const item = (rawItem ?? {}) as Record<string, unknown>
                const displayName =
                  (item.name || item.filename || item.file_name ||
                  item.file_id ||
                  t('recordFormDialog.attachment.fallbackName', { index: index + 1 })) as string
                const fileSize =
                  typeof item.size === 'number' ? formatBytes(item.size) : undefined
                const href = (item.url || item.download_url || item.link) as string | undefined
                const mimeType = (String(item.mime_type ?? '')).toLowerCase()
                const isImage = mimeType.startsWith('image/')

                return (
                  <div
                    key={(item.reference_id ?? item.file_id ?? `${field.id}-${index}`) as string}
                    className="rounded bg-background px-3 py-2 text-body space-y-2"
                  >
                    {isImage && href && (
                      <img
                        src={href}
                        alt={displayName}
                        className="max-h-48 max-w-full rounded object-contain"
                        loading="lazy"
                        onError={(e) => { e.currentTarget.style.display = 'none' }}
                      />
                    )}
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col min-w-0">
                        <span className="font-medium truncate">{displayName}</span>
                        {fileSize && (
                          <span className="text-body text-muted-foreground">{fileSize}</span>
                        )}
                      </div>
                      {href && (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-body font-medium text-primary hover:underline shrink-0 ml-2"
                        >
                          {t('recordFormDialog.attachment.download')}
                        </a>
                      )}
                    </div>
                  </div>
                )
              })
            ) : (
              <p className="text-body text-muted-foreground">
                {t('recordFormDialog.attachment.empty')}
              </p>
            )}
          </div>
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground">{getFieldDescription(field)}</p>
          )}
          {error && <p className="text-body text-destructive">{error}</p>}
        </div>
      )
    }

    // ── Link ──
    case 'link': {
      const items: Array<{ id: string; title?: string; fields?: Record<string, unknown> }> = []
      if (rawValue) {
        if (Array.isArray(rawValue)) {
          for (const item of rawValue) {
            if (typeof item === 'string') items.push({ id: item, title: item })
            else if (typeof item === 'object' && item !== null && 'id' in item) {
              const obj = item as { id: string; title?: string; fields?: Record<string, unknown> }
              items.push({
                id: String(obj.id),
                title: obj.title ? String(obj.title) : undefined,
                fields: obj.fields,
              })
            }
          }
        } else if (typeof rawValue === 'string') {
          items.push({ id: rawValue, title: rawValue })
        } else if (typeof rawValue === 'object' && rawValue !== null && 'id' in rawValue) {
          const obj = rawValue as { id: string; title?: string; fields?: Record<string, unknown> }
          items.push({
            id: String(obj.id),
            title: obj.title ? String(obj.title) : undefined,
            fields: obj.fields,
          })
        }
      }

      const relationship = String(options.relationship ?? 'ManyMany')
      const isSingleSelect = relationship === 'OneOne' || relationship === 'ManyOne'
      const foreignTableId = String(options.foreignTableId ?? '')

      const handleUnlink = (id: string) => {
        const next = items.filter((item) => item.id !== id)
        if (isSingleSelect) {
          onChange(next.length > 0 ? next[0] : null)
        } else {
          onChange(next)
        }
      }

      return (
        <LinkedRecordsTable
          items={items}
          disabled={disabled}
          isSingleSelect={isSingleSelect}
          error={error}
          description={getFieldDescription(field)}
          onAdd={
            onLinkEdit && !disabled
              ? () => onLinkEdit(field.id, field.name, rawValue)
              : undefined
          }
          onUnlink={!disabled ? handleUnlink : undefined}
          onOpenRecord={
            onOpenLinkedRecord && foreignTableId
              ? (item) =>
                  onOpenLinkedRecord({
                    fieldId: field.id,
                    foreignTableId,
                    recordId: item.id,
                    title: item.title,
                  })
              : undefined
          }
        />
      )
    }

    // ── User ──
    case 'user': {
      const extractUserId = (v: unknown): string | null => {
        if (!v) return null
        if (typeof v === 'string') return v
        if (typeof v === 'object' && v !== null) {
          const obj = v as Record<string, unknown>
          return obj.id != null ? String(obj.id) : null
        }
        return null
      }
      const isMulti = options.multiple === true
      let normalizedValue: string | string[] | null
      if (isMulti) {
        const arr = Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : []
        const ids = arr.map(extractUserId).filter(Boolean) as string[]
        normalizedValue = ids.length > 0 ? ids : null
      } else {
        normalizedValue = extractUserId(rawValue)
      }
      return (
        <div>
          <UserSelector
            value={normalizedValue}
            onChange={(next) => onChange(next)}
            users={organizationMembers ?? []}
            multiple={isMulti}
            disabled={disabled}
            placeholder={t('userSelector.placeholder')}
          />
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
          {error && <p className="text-body text-destructive mt-1">{error}</p>}
        </div>
      )
    }

    // ── System time fields ──
    case 'created_time':
    case 'last_modified_time': {
      const formatted = formatSystemDateTime(rawValue, options)
      return (
        <div>
          <div className="px-3 py-2 text-body text-muted-foreground bg-muted/50 rounded-md border">
            {formatted}
          </div>
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
        </div>
      )
    }

    // ── System user fields ──
    case 'created_by':
    case 'last_modified_by': {
      const { userId, displayName, avatarUrl } = resolveUserDisplay(rawValue)
      return (
        <div>
          <div className="flex items-center gap-2 px-3 py-2 text-body text-muted-foreground bg-muted/50 rounded-md border">
            <UserAvatar
              name={displayName}
              seed={userId}
              avatarUrl={avatarUrl}
              size={24}
            />
            <span>{displayName}</span>
          </div>
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
        </div>
      )
    }

    // ── Default fallback ──
    default:
      return (
        <div>
          <Textarea
            value={value as string}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t('recordFormDialog.placeholder.input', { name: getFieldDisplayName(field) })}
            className={error ? 'border-destructive' : ''}
            rows={3}
            disabled={disabled}
          />
          {getFieldDescription(field) && (
            <p className="text-body text-muted-foreground mt-1">{getFieldDescription(field)}</p>
          )}
          {error && <p className="text-body text-destructive mt-1">{error}</p>}
        </div>
      )
  }
}
