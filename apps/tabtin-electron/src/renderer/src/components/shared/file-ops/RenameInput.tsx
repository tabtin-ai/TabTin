import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X } from 'lucide-react'
import { FileIcon } from '@components/shared/file-icon/FileIcon'
import { validateFileName } from './validateFileName'
import type { FileTreeActionsI18nNamespace } from './useFileTreeActions'

export interface RenameInputProps {
  name: string
  isDirectory: boolean
  onSubmit: (newName: string) => void
  onCancel: () => void
  depth?: number
  /** 每级缩进像素，TabCode 14、TabFolder FileTreeItem 12 */
  indentStep?: number
  /** 额外左侧内边距，TabCode 6、TabFolder 0 */
  indentBase?: number
  i18nNamespace?: FileTreeActionsI18nNamespace
}

export const RenameInput: React.FC<RenameInputProps> = ({
  name,
  isDirectory,
  onSubmit,
  onCancel,
  depth = 0,
  indentStep = 14,
  indentBase = 6,
  i18nNamespace = 'tabcode',
}) => {
  const { t } = useTranslation(i18nNamespace)
  const [value, setValue] = useState(name)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus()
        const lastDot = name.lastIndexOf('.')
        if (!isDirectory && lastDot > 0) {
          inputRef.current.setSelectionRange(0, lastDot)
        } else {
          inputRef.current.select()
        }
      }
    }, 50)
    return () => clearTimeout(timer)
  }, [name, isDirectory])

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (!trimmed || trimmed === name) {
      onCancel()
      return
    }
    const validationError = validateFileName(trimmed, t)
    if (validationError) {
      setError(validationError)
      return
    }
    onSubmit(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value)
    if (error) setError(null)
  }

  return (
    <div
      className="flex flex-col mx-1"
      style={{ paddingLeft: `${depth * indentStep + indentBase}px` }}
    >
      <div className="flex items-center gap-1 px-1 h-[26px] bg-accent/60 rounded-sm">
        <span className="w-4 h-4 shrink-0" />
        <FileIcon fileName={name} isDirectory={isDirectory} className="h-3.5 w-3.5 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={onCancel}
          className={`flex-1 min-w-0 px-1 py-0 text-body bg-background border rounded outline-none ${error ? 'border-destructive' : 'border-ring'}`}
        />
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); handleSubmit() }}
          className="p-0.5 hover:bg-background/60 rounded"
        >
          <Check className="h-3 w-3 text-muted-foreground" />
        </button>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); onCancel() }}
          className="p-0.5 hover:bg-background/60 rounded"
        >
          <X className="h-3 w-3 text-muted-foreground" />
        </button>
      </div>
      {error && (
        <span className="text-caption text-destructive px-6 py-0.5">{error}</span>
      )}
    </div>
  )
}
