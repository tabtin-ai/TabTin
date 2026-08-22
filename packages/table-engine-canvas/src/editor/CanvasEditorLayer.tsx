import React from 'react'
import type { TableGridColumn, TableGridRow } from '@tabtin/table-engine'

const MIN_EDITOR_SIZE = 24
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

type ColumnRecord = Record<string, unknown>

export type CanvasEditorKind = 'text' | 'longText' | 'number' | 'rating' | 'boolean' | 'date' | 'select' | 'multiSelect'

export interface CanvasEditorOption {
  value: string
  label: string
}

export interface CanvasEditorDescriptor {
  kind: CanvasEditorKind
  options?: CanvasEditorOption[]
}

export interface CanvasEditorSession {
  sessionId: number
  rowIndex: number
  colIndex: number
  row: TableGridRow
  column: TableGridColumn
  initialValue: unknown
  initialTextSeed?: string
}

export interface CanvasEditorRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasEditorLayerProps {
  session: CanvasEditorSession
  rect: CanvasEditorRect
  viewportWidth: number
  viewportHeight: number
  minTop?: number
  labels?: CanvasEditorLayerLabels
  onCommit: (value: unknown) => void
  onCancel: () => void
}

export interface CanvasEditorLayerLabels {
  booleanTrue?: string
  booleanFalse?: string
  emptyOption?: string
  multiSelectHint?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asColumnRecord = (column: TableGridColumn): ColumnRecord => column as unknown as ColumnRecord

const stringifyCellValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const resolveFieldTypeByCellEditor = (cellEditor: unknown): string | null => {
  if (typeof cellEditor !== 'string') {
    return null
  }
  switch (cellEditor) {
    case 'checkboxCellEditor':
      return 'checkbox'
    case 'numberCellEditor':
      return 'number'
    case 'dateCellEditor':
      return 'date'
    case 'selectCellEditor':
      return 'select'
    default:
      return null
  }
}

const resolveColumnFieldType = (column: TableGridColumn): string => {
  const columnRecord = asColumnRecord(column)
  const originalFieldType = columnRecord.originalFieldType
  if (typeof originalFieldType === 'string' && originalFieldType.trim().length > 0) {
    return originalFieldType
  }

  const fieldType = columnRecord.fieldType
  if (typeof fieldType === 'string' && fieldType.trim().length > 0) {
    return fieldType
  }

  if (typeof column.type === 'string' && column.type.trim().length > 0) {
    return column.type
  }

  return resolveFieldTypeByCellEditor(columnRecord.cellEditor) ?? 'text'
}

const normalizeOption = (candidate: unknown): CanvasEditorOption | null => {
  if (candidate === null || candidate === undefined) {
    return null
  }
  if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
    const text = String(candidate)
    return {
      value: text,
      label: text,
    }
  }
  if (!isRecord(candidate)) {
    return null
  }

  const valueCandidate =
    candidate.value ?? candidate.id ?? candidate.key ?? candidate.name ?? candidate.label
  if (valueCandidate === null || valueCandidate === undefined) {
    return null
  }

  const value = String(valueCandidate)
  const labelCandidate = candidate.label ?? candidate.name ?? candidate.value ?? candidate.id
  const label = labelCandidate === null || labelCandidate === undefined ? value : String(labelCandidate)

  return {
    value,
    label,
  }
}

const resolveSelectOptions = (column: TableGridColumn): CanvasEditorOption[] => {
  const columnRecord = asColumnRecord(column)
  const options: CanvasEditorOption[] = []
  const pushOption = (candidate: unknown) => {
    const option = normalizeOption(candidate)
    if (!option) {
      return
    }
    if (options.some(item => item.value === option.value)) {
      return
    }
    options.push(option)
  }

  const editorParams = columnRecord.cellEditorParams
  if (isRecord(editorParams)) {
    const values = editorParams.values
    if (Array.isArray(values)) {
      values.forEach(pushOption)
    }
  }

  const fieldOptions = columnRecord.options
  if (isRecord(fieldOptions)) {
    const choices = fieldOptions.choices
    if (Array.isArray(choices)) {
      choices.forEach(pushOption)
    }
    const fallbackChoices = fieldOptions.options
    if (Array.isArray(fallbackChoices)) {
      fallbackChoices.forEach(pushOption)
    }
  }

  return options
}

export const resolveCanvasEditorDescriptor = (column: TableGridColumn): CanvasEditorDescriptor => {
  const fieldType = resolveColumnFieldType(column).toLowerCase()

  if (fieldType === 'checkbox' || fieldType === 'boolean') {
    return {
      kind: 'boolean',
    }
  }

  if (fieldType === 'number') {
    return {
      kind: 'number',
    }
  }

  if (fieldType === 'rating') {
    return {
      kind: 'rating',
    }
  }

  if (fieldType === 'date') {
    return {
      kind: 'date',
    }
  }

  if (fieldType === 'single_select' || fieldType === 'select' || fieldType === 'singleselect') {
    return {
      kind: 'select',
      options: resolveSelectOptions(column),
    }
  }

  if (fieldType === 'multi_select' || fieldType === 'multiselect') {
    return {
      kind: 'multiSelect',
      options: resolveSelectOptions(column),
    }
  }

  if (fieldType === 'long_text' || fieldType === 'longtext') {
    return {
      kind: 'longText',
    }
  }

  return {
    kind: 'text',
  }
}

export const canSeedCanvasEditor = (descriptor: CanvasEditorDescriptor): boolean =>
  descriptor.kind === 'text' ||
  descriptor.kind === 'longText' ||
  descriptor.kind === 'number' ||
  descriptor.kind === 'date'

const toBooleanValue = (value: unknown): boolean => {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (!normalized) {
      return false
    }
    if (['true', '1', 'yes', 'y'].includes(normalized)) {
      return true
    }
    if (['false', '0', 'no', 'n'].includes(normalized)) {
      return false
    }
  }
  return Boolean(value)
}

const formatDateInputValue = (value: unknown): string => {
  if (typeof value === 'string' && DATE_PATTERN.test(value.trim())) {
    return value.trim()
  }
  const date = value instanceof Date ? value : new Date(value as any)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const formatSelectValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return stringifyCellValue(value[0] ?? '')
  }
  return stringifyCellValue(value)
}

const formatMultiSelectInputValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.map(item => stringifyCellValue(item)).filter(Boolean).join(', ')
  }
  return stringifyCellValue(value)
}

const parseDateValue = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  if (DATE_PATTERN.test(trimmed)) {
    return trimmed
  }
  const parsedDate = new Date(trimmed)
  if (Number.isNaN(parsedDate.getTime())) {
    return null
  }
  return formatDateInputValue(parsedDate)
}

const parseMultiSelectValues = (value: string): string[] =>
  value
    .split(/[,\n，]/)
    .map(item => item.trim())
    .filter((item, index, array) => Boolean(item) && array.indexOf(item) === index)

const stopPropagation = (event: React.MouseEvent<HTMLElement>) => {
  event.stopPropagation()
}

export const CanvasEditorLayer: React.FC<CanvasEditorLayerProps> = ({
  session,
  rect,
  viewportWidth,
  viewportHeight,
  minTop = 0,
  labels,
  onCommit,
  onCancel,
}) => {
  const descriptor = React.useMemo(
    () => resolveCanvasEditorDescriptor(session.column),
    [session.column]
  )

  const inputRef = React.useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLDivElement | null>(null)
  const completedRef = React.useRef(false)
  const skipBlurCommitRef = React.useRef(false)
  const [textValue, setTextValue] = React.useState('')
  const [boolValue, setBoolValue] = React.useState(false)
  const [isComposing, setIsComposing] = React.useState(false)
  const [isInvalid, setIsInvalid] = React.useState(false)
  const [multiSelectValues, setMultiSelectValues] = React.useState<string[]>([])

  React.useEffect(() => {
    completedRef.current = false
    skipBlurCommitRef.current = false
    setIsComposing(false)
    setIsInvalid(false)
    setMultiSelectValues([])

    const seedValue = session.initialTextSeed
    if (descriptor.kind === 'boolean') {
      setBoolValue(
        seedValue !== undefined && seedValue !== ''
          ? toBooleanValue(seedValue)
          : toBooleanValue(session.initialValue)
      )
      setTextValue('')
      return
    }

    if (seedValue !== undefined && canSeedCanvasEditor(descriptor)) {
      setTextValue(seedValue)
      return
    }

    switch (descriptor.kind) {
      case 'rating':
        break
      case 'number':
        setTextValue(stringifyCellValue(session.initialValue))
        break
      case 'date':
        setTextValue(formatDateInputValue(session.initialValue))
        break
      case 'select':
        setTextValue(formatSelectValue(session.initialValue))
        break
      case 'multiSelect': {
        const initialArray = Array.isArray(session.initialValue)
          ? session.initialValue.map((v: unknown) => String(v))
          : typeof session.initialValue === 'string' && session.initialValue
            ? parseMultiSelectValues(session.initialValue)
            : []
        setMultiSelectValues(initialArray)
        break
      }
      default:
        setTextValue(stringifyCellValue(session.initialValue))
        break
    }
  }, [descriptor, session.initialTextSeed, session.initialValue, session.sessionId])

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = inputRef.current
      if (!element) {
        return
      }
      element.focus()
      if (
        session.initialTextSeed === undefined &&
        (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
        descriptor.kind !== 'date'
      ) {
        element.select()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [descriptor.kind, session.initialTextSeed, session.sessionId])

  const editorRect = React.useMemo(() => {
    if (viewportWidth <= 0 || viewportHeight <= 0) {
      return null
    }

    const minimumTop = Math.max(0, minTop)
    const maxLeft = Math.max(0, viewportWidth - MIN_EDITOR_SIZE)
    const maxTop = Math.max(minimumTop, viewportHeight - MIN_EDITOR_SIZE)
    const left = Math.min(Math.max(0, rect.x + 1), maxLeft)
    const top = Math.min(Math.max(minimumTop, rect.y + 1), maxTop)
    const widthLimit = Math.max(MIN_EDITOR_SIZE, viewportWidth - left)
    const heightLimit = Math.max(MIN_EDITOR_SIZE, viewportHeight - top)
    const width = Math.max(MIN_EDITOR_SIZE, Math.min(Math.max(MIN_EDITOR_SIZE, rect.width - 2), widthLimit))
    const height = Math.max(
      MIN_EDITOR_SIZE,
      Math.min(Math.max(MIN_EDITOR_SIZE, rect.height - 2), heightLimit)
    )

    return {
      left,
      top,
      width,
      height,
    }
  }, [minTop, rect.height, rect.width, rect.x, rect.y, viewportHeight, viewportWidth])

  const commit = React.useCallback(
    (nextValue: unknown) => {
      if (completedRef.current) {
        return
      }
      completedRef.current = true
      onCommit(nextValue)
    },
    [onCommit]
  )

  const commitByEditorKind = React.useCallback(() => {
    if (descriptor.kind === 'boolean') {
      commit(boolValue)
      return
    }

    if (descriptor.kind === 'rating') {
      return
    }

    if (descriptor.kind === 'number') {
      const trimmed = textValue.trim()
      if (!trimmed) {
        commit(null)
        return
      }
      const parsedNumber = Number(trimmed)
      if (!Number.isFinite(parsedNumber)) {
        setIsInvalid(true)
        requestAnimationFrame(() => inputRef.current?.focus())
        return
      }
      commit(parsedNumber)
      return
    }

    if (descriptor.kind === 'longText') {
      commit(textValue)
      return
    }

    if (descriptor.kind === 'date') {
      const parsedValue = parseDateValue(textValue)
      if (textValue.trim().length > 0 && parsedValue === null) {
        setIsInvalid(true)
        requestAnimationFrame(() => inputRef.current?.focus())
        return
      }
      commit(parsedValue)
      return
    }

    if (descriptor.kind === 'select') {
      const trimmed = textValue.trim()
      commit(trimmed ? trimmed : null)
      return
    }

    if (descriptor.kind === 'multiSelect') {
      commit(multiSelectValues)
      return
    }

    commit(textValue)
  }, [boolValue, commit, descriptor.kind, multiSelectValues, textValue])

  const cancel = React.useCallback(() => {
    if (completedRef.current) {
      return
    }
    completedRef.current = true
    onCancel()
  }, [onCancel])

  const handleBlur = React.useCallback((e?: React.FocusEvent<HTMLElement>) => {
    if (e && e.currentTarget.contains(e.relatedTarget as Node)) return
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false
      return
    }
    commitByEditorKind()
  }, [commitByEditorKind])

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        skipBlurCommitRef.current = true
        cancel()
        return
      }
      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing || isComposing) {
          return
        }
        if (descriptor.kind === 'longText' && event.shiftKey) {
          return
        }
        event.preventDefault()
        commitByEditorKind()
      }
    },
    [cancel, commitByEditorKind, descriptor.kind, isComposing]
  )

  const toggleMultiSelectValue = React.useCallback((value: string) => {
    setMultiSelectValues(prev =>
      prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]
    )
  }, [])

  const handleCompositionStart = React.useCallback(() => {
    setIsComposing(true)
  }, [])

  const handleCompositionEnd = React.useCallback(() => {
    setIsComposing(false)
  }, [])

  if (!editorRect) {
    return null
  }

  const sharedClassName = [
    'h-full w-full rounded-sm border bg-background px-2 text-body text-foreground shadow-sm outline-none',
    'focus-visible:ring-1 focus-visible:ring-accent/40',
    isInvalid ? 'border-destructive' : 'border-accent',
  ].join(' ')

  const sharedProps = {
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
    onMouseDown: stopPropagation,
  }

  const selectOptions = descriptor.options ?? []
  const hasCurrentSelectValue = selectOptions.some(option => option.value === textValue)
  const resolvedLabels = React.useMemo<Required<CanvasEditorLayerLabels>>(
    () => ({
      booleanTrue: labels?.booleanTrue?.trim() || 'True',
      booleanFalse: labels?.booleanFalse?.trim() || 'False',
      emptyOption: labels?.emptyOption?.trim() || '(empty)',
      multiSelectHint: labels?.multiSelectHint?.trim() || 'Use comma to separate values',
    }),
    [labels]
  )

  React.useEffect(() => {
    if (descriptor.kind === 'rating') {
      onCancel()
    }
  }, [descriptor.kind, onCancel])

  if (descriptor.kind === 'rating') {
    return null
  }

  const maxEditorHeight = viewportHeight - editorRect.top
  let editorHeight = editorRect.height
  if (descriptor.kind === 'longText') {
    editorHeight = Math.min(Math.max(editorRect.height, 80), maxEditorHeight)
  } else if (descriptor.kind === 'multiSelect') {
    const desiredHeight = selectOptions.length * 30 + 8
    editorHeight = Math.min(Math.max(editorRect.height, Math.min(desiredHeight, 200)), maxEditorHeight)
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-floating">
      <div
        className="pointer-events-auto absolute"
        style={{
          left: editorRect.left,
          top: editorRect.top,
          width: editorRect.width,
          height: editorHeight,
        }}
      >
        {descriptor.kind === 'boolean' ? (
          <label
            className={[
              'flex h-full w-full items-center gap-2 rounded-sm border bg-background px-2 text-body text-foreground shadow-sm',
              isInvalid ? 'border-destructive' : 'border-accent',
            ].join(' ')}
            onMouseDown={stopPropagation}
          >
            <input
              ref={inputRef as React.MutableRefObject<HTMLInputElement | null>}
              type="checkbox"
              checked={boolValue}
              onChange={event => {
                setIsInvalid(false)
                setBoolValue(event.target.checked)
              }}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              className="h-3.5 w-3.5 accent-[hsl(var(--accent))]"
            />
            <span>{boolValue ? resolvedLabels.booleanTrue : resolvedLabels.booleanFalse}</span>
          </label>
        ) : descriptor.kind === 'select' ? (
          <select
            ref={inputRef as React.MutableRefObject<HTMLSelectElement | null>}
            value={textValue}
            onChange={event => {
              setIsInvalid(false)
              setTextValue(event.target.value)
            }}
            className={sharedClassName}
            {...sharedProps}
          >
            <option value="">{resolvedLabels.emptyOption}</option>
            {selectOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {!hasCurrentSelectValue && textValue.trim().length > 0 && (
              <option value={textValue}>{textValue}</option>
            )}
          </select>
        ) : descriptor.kind === 'multiSelect' ? (
          <div
            ref={inputRef as React.MutableRefObject<HTMLDivElement | null>}
            tabIndex={0}
            className={[
              'h-full w-full overflow-y-auto rounded-sm border bg-background py-1 text-body text-foreground shadow-sm outline-none',
              'focus-visible:ring-1 focus-visible:ring-accent/40',
              isInvalid ? 'border-destructive' : 'border-accent',
            ].join(' ')}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onMouseDown={stopPropagation}
          >
            {selectOptions.map(option => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-muted"
                onMouseDown={e => e.preventDefault()}
              >
                <input
                  type="checkbox"
                  checked={multiSelectValues.includes(option.value)}
                  onChange={() => toggleMultiSelectValue(option.value)}
                  tabIndex={-1}
                  className="h-3.5 w-3.5 accent-[hsl(var(--accent))]"
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))}
            {selectOptions.length === 0 && (
              <div className="px-2 py-1 text-foreground/60">{resolvedLabels.emptyOption}</div>
            )}
          </div>
        ) : descriptor.kind === 'date' ? (
          <input
            ref={inputRef as React.MutableRefObject<HTMLInputElement | null>}
            type="date"
            value={textValue}
            onChange={event => {
              setIsInvalid(false)
              setTextValue(event.target.value)
            }}
            className={sharedClassName}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            {...sharedProps}
          />
        ) : descriptor.kind === 'number' ? (
          <input
            ref={inputRef as React.MutableRefObject<HTMLInputElement | null>}
            type="number"
            step="any"
            value={textValue}
            onChange={event => {
              setIsInvalid(false)
              setTextValue(event.target.value)
            }}
            className={sharedClassName}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            {...sharedProps}
          />
        ) : descriptor.kind === 'longText' ? (
          <textarea
            ref={inputRef as React.MutableRefObject<HTMLTextAreaElement | null>}
            value={textValue}
            onChange={event => {
              setIsInvalid(false)
              setTextValue(event.target.value)
            }}
            className={[sharedClassName, 'resize-none py-1'].join(' ')}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            {...sharedProps}
          />
        ) : (
          <input
            ref={inputRef as React.MutableRefObject<HTMLInputElement | null>}
            type="text"
            value={textValue}
            onChange={event => {
              setIsInvalid(false)
              setTextValue(event.target.value)
            }}
            className={sharedClassName}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            {...sharedProps}
          />
        )}
      </div>
    </div>
  )
}
