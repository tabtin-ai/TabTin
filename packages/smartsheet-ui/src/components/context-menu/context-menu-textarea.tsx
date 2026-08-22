/**
 * ContextMenuTextarea 组件
 * 菜单内多行文本框
 */

import React, { useState, useRef, useEffect } from 'react'
import { cn } from '../../utils/cn'
import type { ContextMenuTextareaProps } from './types'

export const ContextMenuTextarea: React.FC<ContextMenuTextareaProps> = ({
  icon,
  placeholder = '',
  defaultValue = '',
  autoFocus = false,
  rows = 3,
  onSubmit,
  onBlur,
  onChange,
  maxLength,
  className,
  testId,
}) => {
  const [value, setValue] = useState(defaultValue)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 自动聚焦
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        // 光标移到末尾
        const len = textareaRef.current?.value.length || 0
        textareaRef.current?.setSelectionRange(len, len)
      })
    }
  }, [autoFocus])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    setValue(newValue)
    onChange?.(newValue)
  }

  const handleBlur = () => {
    onBlur?.(value)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Cmd/Ctrl + Enter 提交
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      onSubmit?.(value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      // ESC 恢复原值
      setValue(defaultValue)
      textareaRef.current?.blur()
    }
  }

  return (
    <div className={cn('context-menu-textarea', className)} data-testid={testId}>
      <div className="context-menu-textarea__container">
        {icon && <span className="context-menu-textarea__icon">{icon}</span>}
        <textarea
          ref={textareaRef}
          className="context-menu-textarea__field"
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          rows={rows}
          maxLength={maxLength}
        />
      </div>
    </div>
  )
}

