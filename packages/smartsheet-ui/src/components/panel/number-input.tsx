/**
 * NumberInput — Figma-style numeric input (Tailwind)
 *
 * Features:
 * - Mouse drag to adjust value (horizontal drag on the input)
 * - Mouse wheel to adjust value when focused
 * - Arrow keys: up/down = +/-1, Shift = +/-10, Alt = +/-0.1
 * - Expression evaluation: "100+20", "50*2", relative "+10", "-5"
 * - Mixed value display for multi-selection ("Mixed")
 * - Enter to commit, Escape to cancel, Tab to next input
 * - Optional suffix unit (px, deg, %)
 * - Min/max range constraints
 * - Unmount commit: auto-commits dirty value when component unmounts
 */

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { cn } from '../../utils/cn'
import { createInteractionUndoScheduler } from './interaction-undo-scheduler'

export interface NumberInputProps {
  value: number | 'mixed'
  onChange: (value: number) => void
  onLiveChange?: (value: number) => void
  onCommit?: (value: number) => void
  onBeginEdit?: () => void
  onEndEdit?: () => void
  min?: number
  max?: number
  step?: number
  precision?: number
  suffix?: string
  label?: string
  placeholder?: string
  disabled?: boolean
  fullWidth?: boolean
  className?: string
  style?: React.CSSProperties
}

const NUDGE_COMMIT_DELAY_MS = 260

/**
 * Evaluate expression with optional base value for relative operations.
 * Supports: "100+20", "50*2", "+10" (relative), "-5" (relative), "50%"
 */
export function evaluateExpression(expr: string, baseValue?: number): number | null {
  const cleaned = expr.trim()
  if (!cleaned) return null

  if (cleaned.endsWith('%') && !/[+\-*/]/.test(cleaned.slice(0, -1))) {
    const num = parseFloat(cleaned.slice(0, -1))
    return isNaN(num) ? null : num
  }

  if (baseValue !== undefined && /^[+\-*/]/.test(cleaned)) {
    const op = cleaned[0]
    const operand = parseFloat(cleaned.slice(1))
    if (!isNaN(operand)) {
      switch (op) {
        case '+': return baseValue + operand
        case '-': return baseValue - operand
        case '*': return baseValue * operand
        case '/': return operand !== 0 ? baseValue / operand : null
      }
    }
  }

  if (/^[\d+\-*/().%\s]+$/.test(cleaned)) {
    try {
      const result = new Function(`"use strict"; return (${cleaned})`)() as number
      if (typeof result === 'number' && isFinite(result)) {
        return result
      }
    } catch {
      // fall through
    }
  }

  const num = parseFloat(cleaned)
  return isNaN(num) ? null : num
}

function formatValue(value: number, precision: number): string {
  const rounded = Math.round(value * Math.pow(10, precision)) / Math.pow(10, precision)
  return precision === 0 ? String(rounded) : rounded.toFixed(precision)
}

function clamp(value: number, min?: number, max?: number): number {
  let v = value
  if (min !== undefined) v = Math.max(min, v)
  if (max !== undefined) v = Math.min(max, v)
  return v
}

export const NumberInput = memo(function NumberInput({
  value,
  onChange,
  onLiveChange,
  onCommit,
  onBeginEdit,
  onEndEdit,
  min,
  max,
  step = 1,
  precision = 2,
  suffix,
  label,
  placeholder,
  disabled = false,
  fullWidth = false,
  className,
  style,
}: NumberInputProps) {
  const beginDrag = useCallback(() => onBeginEdit?.(), [onBeginEdit])
  const commitDrag = useCallback(() => onEndEdit?.(), [onEndEdit])
  const beginNudge = useCallback(() => onBeginEdit?.(), [onBeginEdit])
  const commitNudge = useCallback(() => onEndEdit?.(), [onEndEdit])

  const nudgeScheduler = useMemo(
    () => createInteractionUndoScheduler({
      begin: beginNudge,
      commit: commitNudge,
      delayMs: NUDGE_COMMIT_DELAY_MS,
    }),
    [beginNudge, commitNudge],
  )

  const inputRef = useRef<HTMLInputElement>(null)
  const isMixed = value === 'mixed'

  const [localValue, setLocalValue] = useState(
    isMixed ? '' : formatValue(value, precision),
  )
  const [isEditing, setIsEditing] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  const dirtyRef = useRef(false)
  const dragStartValueRef = useRef<number>(0)
  const currentValueRef = useRef<number>(isMixed ? 0 : value)
  const lastLocalValueRef = useRef(localValue)

  const flushNudgeTransaction = useCallback(() => {
    nudgeScheduler.flush()
  }, [nudgeScheduler])

  const startNudgeTransaction = useCallback(() => {
    nudgeScheduler.bump()
  }, [nudgeScheduler])

  useEffect(() => {
    return () => { nudgeScheduler.dispose() }
  }, [nudgeScheduler])

  useEffect(() => {
    if (!isEditing && !isDragging) {
      if (isMixed) {
        setLocalValue('')
        lastLocalValueRef.current = ''
      } else {
        const formatted = formatValue(value, precision)
        setLocalValue(formatted)
        lastLocalValueRef.current = formatted
        currentValueRef.current = value
      }
      dirtyRef.current = false
    }
  }, [value, isMixed, isEditing, isDragging, precision])

  const commitValue = useCallback(
    (newValue: number) => {
      const clamped = clamp(newValue, min, max)
      currentValueRef.current = clamped
      dirtyRef.current = false
      onChange(clamped)
      onCommit?.(clamped)
    },
    [onChange, onCommit, min, max],
  )

  useEffect(() => {
    return () => {
      if (dirtyRef.current) {
        const result = evaluateExpression(lastLocalValueRef.current, currentValueRef.current)
        if (result !== null) {
          const clamped = clamp(result, min, max)
          onChange(clamped)
          onCommit?.(clamped)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setLocalValue(v)
    lastLocalValueRef.current = v
    dirtyRef.current = true
  }, [])

  const handleFocus = useCallback(() => {
    setIsEditing(true)
    dirtyRef.current = true
    requestAnimationFrame(() => { inputRef.current?.select() })
  }, [])

  const handleBlur = useCallback(() => {
    flushNudgeTransaction()
    setIsEditing(false)
    const result = evaluateExpression(localValue, currentValueRef.current)
    if (result !== null) {
      commitValue(result)
    } else {
      const reverted = isMixed ? '' : formatValue(currentValueRef.current, precision)
      setLocalValue(reverted)
      lastLocalValueRef.current = reverted
      dirtyRef.current = false
    }
  }, [localValue, commitValue, isMixed, precision, flushNudgeTransaction])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleBlur()
        inputRef.current?.blur()
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        flushNudgeTransaction()
        const reverted = isMixed ? '' : formatValue(currentValueRef.current, precision)
        setLocalValue(reverted)
        lastLocalValueRef.current = reverted
        dirtyRef.current = false
        setIsEditing(false)
        inputRef.current?.blur()
        return
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const direction = e.key === 'ArrowUp' ? 1 : -1
        let increment = step
        if (e.shiftKey) increment = step * 10
        else if (e.altKey) increment = step * 0.1

        const base = isMixed ? 0 : currentValueRef.current
        const newVal = clamp(base + direction * increment, min, max)
        currentValueRef.current = newVal
        const formatted = formatValue(newVal, precision)
        setLocalValue(formatted)
        lastLocalValueRef.current = formatted
        dirtyRef.current = false
        startNudgeTransaction()
        onChange(newVal)
        onCommit?.(newVal)
      }
    },
    [isMixed, step, min, max, precision, onChange, onCommit, handleBlur, flushNudgeTransaction, startNudgeTransaction],
  )

  useEffect(() => {
    const node = inputRef.current
    if (!node) return

    const handleWheel = (e: WheelEvent) => {
      if (document.activeElement !== node) return
      e.preventDefault()

      const direction = e.deltaY < 0 ? 1 : -1
      let increment = step
      if (e.shiftKey) increment = step * 10
      else if (e.altKey) increment = step * 0.1

      const base = isMixed ? 0 : currentValueRef.current
      const newVal = clamp(base + direction * increment, min, max)
      currentValueRef.current = newVal
      const formatted = formatValue(newVal, precision)
      setLocalValue(formatted)
      lastLocalValueRef.current = formatted
      dirtyRef.current = false
      startNudgeTransaction()
      onChange(newVal)
      onCommit?.(newVal)
    }

    node.addEventListener('wheel', handleWheel, { passive: false })
    return () => node.removeEventListener('wheel', handleWheel)
  }, [isMixed, step, min, max, precision, onChange, onCommit, startNudgeTransaction])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLInputElement>) => {
      if (disabled || isEditing) return
      flushNudgeTransaction()

      const startX = e.clientX
      const startValue = isMixed ? 0 : currentValueRef.current
      dragStartValueRef.current = startValue
      let hasMoved = false
      let currentDragValue = startValue

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX
        if (Math.abs(deltaX) < 2 && !hasMoved) return

        if (!hasMoved) {
          hasMoved = true
          beginDrag()
          setIsDragging(true)
          document.body.style.cursor = 'ew-resize'
          document.body.style.userSelect = 'none'
        }

        let increment = step
        if (moveEvent.shiftKey) increment = step * 10
        else if (moveEvent.altKey) increment = step * 0.1

        const newVal = clamp(startValue + deltaX * increment, min, max)
        currentDragValue = newVal
        currentValueRef.current = newVal
        const formatted = formatValue(newVal, precision)
        setLocalValue(formatted)
        lastLocalValueRef.current = formatted
        onChange(newVal)
        onLiveChange?.(newVal)
      }

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''

        if (hasMoved) {
          setIsDragging(false)
          dirtyRef.current = false
          onCommit?.(currentDragValue)
          commitDrag()
        }
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [disabled, isEditing, isMixed, step, min, max, precision, onChange, onLiveChange, onCommit, beginDrag, commitDrag, flushNudgeTransaction],
  )

  const ariaLabel = label
    ? `${label}${suffix ? ` (${suffix})` : ''}`
    : suffix
      ? `Value (${suffix})`
      : 'Value'

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1',
        fullWidth && 'w-full',
        className,
      )}
      style={style}
    >
      {label && (
        <span className="flex-shrink-0 text-caption text-muted-foreground">
          {label}
        </span>
      )}
      <div className="relative flex min-w-0 flex-1 items-center">
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          className={cn(
            'h-7 w-full rounded bg-muted/40 px-1.5 text-body text-foreground outline-none',
            'border-none focus:bg-muted/60 focus:ring-1 focus:ring-inset focus:ring-accent/40',
            isDragging && 'bg-muted/60',
          )}
          value={localValue}
          placeholder={isMixed ? 'Mixed' : placeholder}
          disabled={disabled}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          onMouseDown={handleMouseDown}
          style={{ cursor: isEditing ? 'text' : 'ew-resize' }}
          aria-label={ariaLabel}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={isMixed ? undefined : currentValueRef.current}
          role="spinbutton"
        />
        {suffix && (
          <span className="pointer-events-none absolute right-1.5 text-caption text-muted-foreground/60" aria-hidden="true">
            {suffix}
          </span>
        )}
      </div>
    </div>
  )
})
