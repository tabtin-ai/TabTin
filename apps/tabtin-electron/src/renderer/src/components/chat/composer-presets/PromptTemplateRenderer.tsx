/**
 * PromptTemplateRenderer — 文本模板模式的渲染器
 *
 * 将 "Create a {{duration}} promo video for {{url}}" 这样的模板
 * 渲染为自然语言段落，其中 {{key}} 变量显示为可点击/编辑的内联高亮槽。
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { cn } from '@utils/cn'
import type { PromptVariable } from './registry/types'
import type { ChatAttachment } from '../types'
import {
  COMPOSER_TEXT_META_BASE,
  COMPOSER_TEXT_MICRO,
  TEXT,
  TEXT_COLOR,
  CARD_RADIUS,
} from '../registry/chatDesignTokens'

interface PromptTemplateRendererProps {
  template: string
  variables: PromptVariable[]
  state: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  disabled?: boolean
  slotAttachments?: Record<string, ChatAttachment[]>
  onAddSlotAttachment?: (slotKey: string, file: File) => void
  onRemoveSlotAttachment?: (slotKey: string, attachmentId: string) => void
}

interface TemplatePart {
  type: 'text' | 'variable'
  content: string
  variableKey?: string
}

function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = []
  const regex = /\{\{(\w+)\}\}/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(template)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: template.slice(lastIndex, match.index) })
    }
    const key = match[1]
    parts.push({ type: 'variable', content: key, variableKey: key })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < template.length) {
    parts.push({ type: 'text', content: template.slice(lastIndex) })
  }

  return parts
}

const InlineUploadSlot: React.FC<{
  variable: PromptVariable
  attachments: ChatAttachment[]
  onAdd: ((file: File) => void) | undefined
  onRemove: ((attachmentId: string) => void) | undefined
  disabled?: boolean
}> = ({ variable, attachments, onAdd, onRemove, disabled }) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const accept = (variable.config?.accept as string) ?? 'image/*'
  const maxCount = (variable.config?.maxCount as number) ?? 1
  const canAddMore = attachments.length < maxCount

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {attachments.map(att => (
        <span key={att.id} className={`${CARD_RADIUS} inline-flex items-center gap-1 bg-accent/8 px-1.5 py-0.5`}>
          {att.previewUrl ? (
            <img src={att.previewUrl} alt="" className="h-5 w-5 rounded object-cover" />
          ) : (
            <span className={`${COMPOSER_TEXT_META_BASE} text-accent`}>📎</span>
          )}
          <span className={`${COMPOSER_TEXT_META_BASE} text-accent max-w-[12ch] truncate`}>{att.filename}</span>
          {onRemove && (
            <button type="button" onClick={() => onRemove(att.id)} disabled={disabled}
              className={cn('text-muted-foreground/60 hover:text-destructive ml-0.5', COMPOSER_TEXT_MICRO)}>✕</button>
          )}
        </span>
      ))}
      {canAddMore && (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
            className={`${TEXT.body} inline ${CARD_RADIUS} bg-accent/8 px-1.5 py-0.5 text-accent transition-colors hover:bg-accent/15 cursor-pointer`}
          >
            + {attachments.length > 0 ? '添加' : (variable.placeholder ?? variable.label ?? '上传')}
          </button>
          <input ref={inputRef} type="file" accept={accept} className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f && onAdd) onAdd(f); if (inputRef.current) inputRef.current.value = '' }}
          />
        </>
      )}
    </span>
  )
}

const InlineToggleSlot: React.FC<{
  variable: PromptVariable
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
}> = ({ variable, value, onChange, disabled }) => {
  const isOn = !!value
  const onLabel = (variable.config?.onLabel as string) ?? '开'
  const offLabel = (variable.config?.offLabel as string) ?? '关'
  return (
    <button
      type="button"
      onClick={() => onChange(!isOn)}
      disabled={disabled}
      className={`${COMPOSER_TEXT_META_BASE} inline ${CARD_RADIUS} px-1.5 py-0.5 transition-colors ${
        isOn ? 'bg-accent/15 text-accent' : 'bg-muted/20 text-muted-foreground/60 line-through'
      } hover:bg-accent/20 cursor-pointer`}
    >
      {isOn ? onLabel : offLabel}
    </button>
  )
}

const InlineMultiselectSlot: React.FC<{
  variable: PromptVariable
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
}> = ({ variable, value, onChange, disabled }) => {
  const options = variable.options ?? []
  const selected = Array.isArray(value) ? (value as string[]) : []

  return (
    <span className="inline-flex flex-wrap gap-0.5">
      {options.map(opt => {
        const isSelected = selected.includes(opt.value)
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              const next = isSelected
                ? selected.filter(v => v !== opt.value)
                : [...selected, opt.value]
              onChange(next)
            }}
            disabled={disabled}
            className={`${COMPOSER_TEXT_META_BASE} ${CARD_RADIUS} px-1.5 py-0.5 transition-colors ${
              isSelected ? 'bg-accent/15 text-accent' : 'bg-muted/15 text-muted-foreground/60'
            } hover:bg-accent/20 cursor-pointer`}
          >
            {opt.label}
          </button>
        )
      })}
    </span>
  )
}

const InlineSliderSlot: React.FC<{
  variable: PromptVariable
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
}> = ({ variable, value, onChange, disabled }) => {
  const min = (variable.config?.min as number) ?? 0
  const max = (variable.config?.max as number) ?? 100
  const numValue = typeof value === 'number' ? value : (variable.defaultValue as number) ?? min

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="range"
        min={min} max={max}
        value={numValue}
        onChange={e => onChange(Number(e.target.value))}
        disabled={disabled}
        className="h-1 w-16 cursor-pointer appearance-none rounded-full bg-muted/30 accent-accent align-middle"
      />
      <span className={`${COMPOSER_TEXT_META_BASE} text-accent tabular-nums`}>{numValue}</span>
    </span>
  )
}

const VariableSlot: React.FC<{
  variable: PromptVariable
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
  attachments?: ChatAttachment[]
  onAddAttachment?: (file: File) => void
  onRemoveAttachment?: (attachmentId: string) => void
}> = ({ variable, value, onChange, disabled, attachments, onAddAttachment, onRemoveAttachment }) => {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const selectRef = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.select()
    }
    if (editing && selectRef.current) {
      selectRef.current.focus()
    }
  }, [editing])

  const startEdit = useCallback(() => {
    if (disabled) return
    setEditValue((value as string) ?? variable.defaultValue ?? '')
    setEditing(true)
  }, [disabled, value, variable.defaultValue])

  const commitEdit = useCallback(() => {
    setEditing(false)
    if (editValue.trim()) {
      onChange(editValue.trim())
    }
  }, [editValue, onChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      commitEdit()
    }
    if (e.key === 'Escape') {
      setEditing(false)
    }
  }, [commitEdit])

  if (variable.type === 'upload') {
    return (
      <InlineUploadSlot
        variable={variable}
        attachments={attachments ?? []}
        onAdd={onAddAttachment}
        onRemove={onRemoveAttachment}
        disabled={disabled}
      />
    )
  }

  if (variable.type === 'toggle') {
    return <InlineToggleSlot variable={variable} value={value} onChange={onChange} disabled={disabled} />
  }

  if (variable.type === 'multiselect') {
    return <InlineMultiselectSlot variable={variable} value={value} onChange={onChange} disabled={disabled} />
  }

  if (variable.type === 'slider') {
    return <InlineSliderSlot variable={variable} value={value} onChange={onChange} disabled={disabled} />
  }

  const displayValue = (value as string) || (variable.defaultValue as string) || variable.placeholder || variable.key
  const hasUserValue = value !== undefined && value !== null && value !== ''
  const isNotDefault = hasUserValue && value !== variable.defaultValue

  if (variable.type === 'select' && variable.options) {
    if (editing) {
      return (
        <select
          ref={selectRef}
          className={`${TEXT.body} inline rounded border border-accent/40 bg-accent/5 px-1 py-0.5 text-accent outline-none`}
          value={(value as string) ?? ''}
          onChange={e => {
            onChange(e.target.value || undefined)
            setEditing(false)
          }}
          onBlur={() => setEditing(false)}
        >
          <option value="">{variable.placeholder ?? '请选择...'}</option>
          {variable.options.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      )
    }

    const selectedLabel = variable.options.find(o => o.value === (value as string))?.label ?? displayValue
    return (
      <span className="inline-flex items-center gap-0.5">
        <button
          type="button"
          onClick={startEdit}
          disabled={disabled}
          className={`${TEXT.body} inline ${CARD_RADIUS} bg-accent/8 px-1.5 py-0.5 font-medium text-accent transition-colors hover:bg-accent/15 cursor-pointer`}
        >
          {selectedLabel}
        </button>
        {hasUserValue && !disabled && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className={cn('text-muted-foreground/40 hover:text-destructive leading-none', COMPOSER_TEXT_MICRO)}
          >
            ✕
          </button>
        )}
      </span>
    )
  }

  if (editing) {
    if (variable.type === 'textarea') {
      return (
        <textarea
          ref={textareaRef}
          className={`${TEXT.body} inline-block min-w-[24ch] max-w-full rounded border border-accent/40 bg-accent/5 px-1.5 py-0.5 text-accent outline-none align-middle`}
          rows={(variable.config?.rows as number) ?? 2}
          value={editValue}
          onChange={e => {
            setEditValue(e.target.value)
            onChange(e.target.value)
          }}
          onBlur={commitEdit}
          onKeyDown={e => {
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      )
    }

    // 'text' 与 'input' 同为单行文本；其余非 number/url 也走 text input
    const inputType =
      variable.type === 'number' ? 'number' : variable.type === 'url' ? 'url' : 'text'
    return (
      <input
        ref={inputRef}
        type={inputType}
        className={`${TEXT.body} inline w-auto min-w-[3ch] rounded border border-accent/40 bg-accent/5 px-1.5 py-0.5 text-accent outline-none`}
        style={{ width: `${Math.max(3, editValue.length + 1)}ch` }}
        value={editValue}
        onChange={e => setEditValue(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={handleKeyDown}
      />
    )
  }

  if (variable.type === 'number') {
    const step = (variable.config?.step as number) ?? 1
    const min = variable.config?.min as number | undefined
    const max = variable.config?.max as number | undefined
    const numValue = typeof value === 'number' ? value : (typeof variable.defaultValue === 'number' ? variable.defaultValue : 0)

    const handleStep = (delta: number) => {
      let next = numValue + delta
      if (min !== undefined && next < min) next = min
      if (max !== undefined && next > max) next = max
      onChange(next)
    }

    return (
      <span className="inline-flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => handleStep(-step)}
          disabled={disabled || (min !== undefined && numValue <= min)}
          className={`${COMPOSER_TEXT_META_BASE} ${CARD_RADIUS} h-5 w-5 inline-flex items-center justify-center bg-muted/20 text-muted-foreground/60 hover:bg-accent/15 hover:text-accent transition-colors disabled:opacity-30`}
        >
          −
        </button>
        <button
          type="button"
          onClick={startEdit}
          disabled={disabled}
          className={`${TEXT.body} inline ${CARD_RADIUS} bg-accent/8 px-1.5 py-0.5 font-medium text-accent tabular-nums transition-colors hover:bg-accent/15 cursor-pointer`}
        >
          {displayValue}
        </button>
        <button
          type="button"
          onClick={() => handleStep(step)}
          disabled={disabled || (max !== undefined && numValue >= max)}
          className={`${COMPOSER_TEXT_META_BASE} ${CARD_RADIUS} h-5 w-5 inline-flex items-center justify-center bg-muted/20 text-muted-foreground/60 hover:bg-accent/15 hover:text-accent transition-colors disabled:opacity-30`}
        >
          +
        </button>
        {isNotDefault && !disabled && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className={cn('text-muted-foreground/40 hover:text-destructive leading-none', COMPOSER_TEXT_MICRO)}
          >
            ✕
          </button>
        )}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={startEdit}
        disabled={disabled}
        className={`${TEXT.body} inline ${CARD_RADIUS} bg-accent/8 px-1.5 py-0.5 font-medium text-accent transition-colors hover:bg-accent/15 cursor-pointer`}
      >
        {displayValue}
      </button>
      {isNotDefault && !disabled && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className={cn('text-muted-foreground/40 hover:text-destructive leading-none', COMPOSER_TEXT_MICRO)}
        >
          ✕
        </button>
      )}
    </span>
  )
}

export const PromptTemplateRenderer: React.FC<PromptTemplateRendererProps> = ({
  template,
  variables,
  state,
  onChange,
  disabled,
  slotAttachments,
  onAddSlotAttachment,
  onRemoveSlotAttachment,
}) => {
  const parts = parseTemplate(template)
  const variableMap = new Map(variables.map(v => [v.key, v]))

  return (
    <div className={`${TEXT.body} ${TEXT_COLOR.primary} leading-relaxed`}>
      {parts.map((part, i) => {
        if (part.type === 'text') {
          return <span key={i}>{part.content}</span>
        }

        const variable = variableMap.get(part.variableKey!)
        if (!variable) {
          return <span key={i} className="text-muted-foreground">{`{{${part.content}}}`}</span>
        }

        return (
          <VariableSlot
            key={part.variableKey}
            variable={variable}
            value={state[variable.key]}
            onChange={val => onChange({ [variable.key]: val })}
            disabled={disabled}
            attachments={slotAttachments?.[variable.key] ?? []}
            onAddAttachment={
              onAddSlotAttachment
                ? (file: File) => onAddSlotAttachment(variable.key, file)
                : undefined
            }
            onRemoveAttachment={
              onRemoveSlotAttachment
                ? (attachmentId: string) => onRemoveSlotAttachment(variable.key, attachmentId)
                : undefined
            }
          />
        )
      })}
    </div>
  )
}
