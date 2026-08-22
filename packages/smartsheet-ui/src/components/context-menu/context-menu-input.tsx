/**
 * ContextMenuInput 组件
 * 菜单内输入框（内联编辑）
 */

import React, { useState, useRef, useEffect } from 'react'
import { cn } from '../../utils/cn'
import type { ContextMenuInputProps } from './types'

export const ContextMenuInput: React.FC<ContextMenuInputProps> = ({
  icon,
  placeholder = '',
  defaultValue = '',
  autoFocus = false,
  onSubmit,
  onBlur,
  onChange,
  validation,
  maxLength,
  className,
  testId,
}) => {
  const [value, setValue] = useState(defaultValue)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 响应 defaultValue 变化
  useEffect(() => {
    setValue(defaultValue)
  }, [defaultValue])

  // 自动聚焦
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [autoFocus])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    setValue(newValue)
    onChange?.(newValue)

    // 清除错误
    if (error) {
      setError(null)
    }
  }

  const handleBlur = () => {
    onBlur?.(value)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      e.stopPropagation()

      // 验证
      if (validation) {
        const validationError = validation(value)
        if (validationError) {
          setError(validationError)
          return
        }
      }

      onSubmit?.(value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      // ESC 恢复原值
      setValue(defaultValue)
      setError(null)
      inputRef.current?.blur()
    }
  }

  return (
    <div className={cn('context-menu-input', className)} data-testid={testId}>
      <div className="context-menu-input__container">
        {icon && <span className="context-menu-input__icon">{icon}</span>}
        <input
          ref={inputRef}
          type="text"
          className="context-menu-input__field"
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          maxLength={maxLength}
          aria-invalid={!!error}
        />
      </div>
      {error && (
        <div className="context-menu-input__error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

