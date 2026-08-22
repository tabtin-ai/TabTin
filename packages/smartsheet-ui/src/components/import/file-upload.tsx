/**
 * 文件上传组件（导入步骤1）
 *
 * 功能：
 * - 拖拽上传文件
 * - 点击选择文件
 * - 文件类型验证
 * - 文件大小限制
 * - 显示选中文件信息
 * - 下载导入模板
 */

import React, { useRef, useState } from 'react'
import { FileInput, FileText, Download, X, AlertCircle } from 'lucide-react'
import { Button } from '../button'
import { cn } from '../../utils/cn'
import { t } from "../../i18n"

export type ImportTemplateFormat = 'xlsx' | 'csv' | 'json'

export interface FileUploadProps {
  /** 接受的文件类型 */
  accept?: string
  /** 最大文件大小（字节），默认 100MB */
  maxSize?: number
  /** 支持的文件扩展名列表 */
  allowedExtensions?: string[]
  /** 文件选择回调 */
  onFileSelect: (file: File) => void
  /** 下载模板回调（按格式） */
  onDownloadTemplate?: (format: ImportTemplateFormat) => void
  /** 已选择的文件 */
  selectedFile?: File | null
  /** 是否正在处理 */
  isProcessing?: boolean
  /** 错误信息 */
  error?: string
}

export const FileUpload: React.FC<FileUploadProps> = ({
  accept = '.csv,.xlsx,.xls,.json',
  maxSize = 100 * 1024 * 1024, // 100MB
  allowedExtensions = ['csv', 'xlsx', 'xls', 'json'],
  onFileSelect,
  onDownloadTemplate,
  selectedFile,
  isProcessing = false,
  error,
}) => {
  const [isDragging, setIsDragging] = useState(false)
  const [validationError, setValidationError] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  /**
   * 验证文件
   */
  const validateFile = (file: File): { valid: boolean; error?: string } => {
    // 检查文件扩展名
    const fileExtension = file.name.split('.').pop()?.toLowerCase()
    if (!fileExtension || !allowedExtensions.includes(fileExtension)) {
      return {
        valid: false,
        error: t('fileUpload.errors.unsupportedFormat', { formats: allowedExtensions.join(', ') }),
      }
    }

    // 检查文件大小
    if (file.size > maxSize) {
      const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(0)
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2)
      return {
        valid: false,
        error: t('fileUpload.errors.fileTooLarge', { size: fileSizeMB, max: maxSizeMB }),
      }
    }

    // 检查文件是否为空
    if (file.size === 0) {
      return {
        valid: false,
        error: t('fileUpload.errors.emptyFile'),
      }
    }

    return { valid: true }
  }

  /**
   * 处理文件选择
   */
  const handleFileSelect = (file: File) => {
    setValidationError('')

    const validation = validateFile(file)
    if (!validation.valid) {
      setValidationError(validation.error || t('fileUpload.errors.validationFailed'))
      return
    }

    console.log('✅ 文件验证通过:', {
      name: file.name,
      size: file.size,
      type: file.type,
    })

    onFileSelect(file)
  }

  /**
   * 处理拖拽进入
   */
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  /**
   * 处理拖拽离开
   */
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // 只有当离开整个拖拽区域时才设置为 false
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX
    const y = e.clientY

    if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
      setIsDragging(false)
    }
  }

  /**
   * 处理拖拽悬停
   */
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  /**
   * 处理文件放下
   */
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) {
      return
    }

    // 只处理第一个文件
    const file = files[0]
    handleFileSelect(file)
  }

  /**
   * 处理点击选择文件
   */
  const handleClickUpload = () => {
    fileInputRef.current?.click()
  }

  /**
   * 处理文件输入变化
   */
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      handleFileSelect(files[0])
    }
    // 清空 input 值，以便可以重复选择同一文件
    e.target.value = ''
  }

  /**
   * 清除选中的文件
   */
  const handleClearFile = () => {
    setValidationError('')
    onFileSelect(null as any) // 通知父组件清除文件
  }

  /**
   * 格式化文件大小
   */
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
  }

  return (
    <div className="space-y-4">
      {/* 文件拖拽上传区域 */}
      <div
        className={cn(
          'relative flex flex-col items-center justify-center',
          'rounded-lg border-2 border-dashed transition-all duration-200',
          'min-h-[240px] p-8 cursor-pointer',
          isDragging
            ? 'border-primary bg-primary/5 scale-[1.02]'
            : 'border-border hover:border-primary/50 hover:bg-accent/50',
          isProcessing && 'opacity-50 cursor-not-allowed pointer-events-none'
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={handleClickUpload}
      >
        {/* 上传图标 */}
        <div
          className={cn(
            'flex items-center justify-center w-14 h-14 rounded-full mb-4 transition-all duration-200',
            isDragging ? 'bg-primary/10 scale-110' : 'bg-muted'
          )}
        >
          <FileInput
            className={cn(
              'w-6 h-6 transition-colors duration-200',
              isDragging ? 'text-primary' : 'text-muted-foreground'
            )}
          />
        </div>

        {/* 提示文字 */}
        <div className="text-center space-y-2">
          <p className="text-subtitle font-medium text-foreground">
            {isDragging ? t('fileUpload.drag.active') : t('fileUpload.drag.idle')}
          </p>
          <p className="text-body text-muted-foreground">
            {t('fileUpload.supportedFormats')}
          </p>
          <p className="text-body text-muted-foreground">
            {t('fileUpload.maxSize', { size: (maxSize / (1024 * 1024)).toFixed(0) })}
          </p>
        </div>

        {/* 隐藏的文件输入 */}
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          onChange={handleFileInputChange}
          className="hidden"
          disabled={isProcessing}
        />
      </div>

      {/* 已选择的文件信息 */}
      {selectedFile && (
        <div className="flex items-center gap-3 p-4 rounded-lg border border-border bg-accent/50">
          <div className="flex items-center justify-center w-10 h-10 rounded bg-primary/10">
            <FileText className="w-5 h-5 text-primary" />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-body font-medium text-foreground truncate">
              {selectedFile.name}
            </p>
            <p className="text-body text-muted-foreground">
              {formatFileSize(selectedFile.size)}
            </p>
          </div>

          {!isProcessing && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearFile}
              className="shrink-0"
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      )}

      {/* 验证错误提示 */}
      {(validationError || error) && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
          <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
          <p className="text-body text-destructive">
            {validationError || error}
          </p>
        </div>
      )}

      {/* 下载模板：Excel / CSV / JSON 分入口，确保文件格式和扩展名一致 */}
      {onDownloadTemplate && (
        <div className="flex items-center justify-center gap-2 pt-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              onDownloadTemplate('xlsx')
            }}
            disabled={isProcessing}
            className="gap-2"
          >
            <Download className="w-4 h-4" />
            {t('fileUpload.downloadTemplateExcel')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              onDownloadTemplate('csv')
            }}
            disabled={isProcessing}
            className="gap-2"
          >
            <Download className="w-4 h-4" />
            {t('fileUpload.downloadTemplateCsv')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              onDownloadTemplate('json')
            }}
            disabled={isProcessing}
            className="gap-2"
          >
            <Download className="w-4 h-4" />
            {t('fileUpload.downloadTemplateJson')}
          </Button>
        </div>
      )}
    </div>
  )
}
