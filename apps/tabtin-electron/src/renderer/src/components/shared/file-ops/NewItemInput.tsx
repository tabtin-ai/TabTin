import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X } from 'lucide-react'
import { FileIcon } from '@components/shared/file-icon/FileIcon'
import { validateFileName } from './validateFileName'
import type { FileTreeActionsI18nNamespace } from './useFileTreeActions'
import type { FileTreeNewItemMode } from './fileTreeTypes'

export interface NewItemInputProps {
  mode: FileTreeNewItemMode
  onSubmit: (name: string) => void
  onCancel: () => void
  depth?: number
  indentStep?: number
  indentBase?: number
  i18nNamespace?: FileTreeActionsI18nNamespace
}

export const NewItemInput: React.FC<NewItemInputProps> = ({
  mode,
  onSubmit,
  onCancel,
  depth = 0,
  indentStep = 12,
  indentBase = 0,
  i18nNamespace = 'tabcode',
}) => {
  const { t } = useTranslation(i18nNamespace)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [])

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (!trimmed) {
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
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
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

  const handleConfirmPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    handleSubmit()
  }

  const handleCancelPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    onCancel()
  }

  const placeholder = mode === 'folder'
    ? t('fileOps.folderName', { defaultValue: '文件夹名' })
    : t('fileOps.fileName', { defaultValue: '文件名' })

  return (
    <div
      className="flex flex-col mx-1"
      style={{ paddingLeft: `${depth * indentStep + indentBase}px` }}
    >
      <div className="flex items-center gap-1 px-1 h-[26px] bg-accent/60 rounded-sm">
        <span className="w-4 h-4 shrink-0" />
        <FileIcon fileName="" isDirectory={mode === 'folder'} className="h-3.5 w-3.5 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={onCancel}
          placeholder={placeholder}
          className={`flex-1 min-w-0 px-1 py-0 text-body bg-background border rounded outline-none ${error ? 'border-destructive' : 'border-ring'}`}
        />
        <button
          type="button"
          aria-label={t('fileOps.confirmCreate', { defaultValue: '确认新建' })}
          onPointerDown={handleConfirmPointerDown}
          className="p-0.5 hover:bg-background/60 rounded"
        >
          <Check className="h-3 w-3 text-muted-foreground" />
        </button>
        <button
          type="button"
          aria-label={t('fileOps.cancelCreate', { defaultValue: '取消新建' })}
          onPointerDown={handleCancelPointerDown}
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
