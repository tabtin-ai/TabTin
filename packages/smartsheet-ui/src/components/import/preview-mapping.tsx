/**
 * 预览和映射组件（导入步骤2）
 *
 * 功能：
 * - 显示数据预览（前N行）
 * - 显示字段映射建议
 * - 支持手动调整映射
 * - 显示数据验证问题
 * - 增量导入选项
 */

import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { ArrowRight, AlertTriangle, Edit2 } from 'lucide-react'
import { Button } from '../button'
import { Label } from '../label'
import { ScrollArea } from '../scroll-area'
import { Checkbox } from '../checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../select'
import { cn } from '../../utils/cn'
import { t } from "../../i18n"

/**
 * 字段信息
 */
export interface Field {
  id: string
  name: string
  field_type: string
}

/**
 * 字段映射
 */
export interface FieldMapping {
  source: string          // 文件中的列名
  target: string          // 表格字段ID
  confidence: number      // 匹配置信度 0-1
  inferred_type: string   // 推断的字段类型
}

/**
 * 验证问题
 */
export interface ValidationIssue {
  row: number
  field: string
  issue: string
}

/** 增量导入已勾选但未选主键时拦截提交 */
export function isIncrementalPrimaryKeyMissing(
  updateExisting: boolean,
  primaryKeyField: string,
): boolean {
  return updateExisting && !primaryKeyField.trim()
}

export interface PreviewMappingHandle {
  focusPrimaryKey: () => void
}

/**
 * 组件 Props
 */
export interface PreviewMappingProps {
  /** 预览数据（前N行） */
  previewData: Array<Record<string, any>>
  /** 字段映射列表 */
  fieldMapping: FieldMapping[]
  /** 验证问题列表 */
  validationIssues: ValidationIssue[]
  /** 表格字段列表 */
  fields: Field[]
  /** 总行数 */
  totalRows: number
  /** 预览行数 */
  previewRows: number
  /** 字段映射变化回调 */
  onMappingChange: (mapping: FieldMapping[]) => void
  /** 增量导入选项变化回调 */
  onIncrementalChange: (enabled: boolean, primaryKeyField?: string) => void
  /** 跳过错误行选项变化回调 */
  onSkipErrorsChange: (skipErrors: boolean) => void
  /** 提交时主键校验失败文案（有值则展示 destructive 报错） */
  primaryKeyError?: string
  /** 选中主键或取消增量时清除报错 */
  onPrimaryKeyErrorClear?: () => void
}

export const PreviewMapping = forwardRef<PreviewMappingHandle, PreviewMappingProps>(function PreviewMapping(
  {
  previewData,
  fieldMapping,
  validationIssues,
  fields,
  totalRows,
  previewRows,
  onMappingChange,
  onIncrementalChange,
  onSkipErrorsChange,
  primaryKeyError,
  onPrimaryKeyErrorClear,
},
  ref,
) {
  const [skipErrors, setSkipErrors] = useState(false)
  const [incrementalImport, setIncrementalImport] = useState(false)
  const [primaryKeyField, setPrimaryKeyField] = useState<string>('')
  const [editingMapping, setEditingMapping] = useState<string | null>(null)
  const primaryKeyTriggerRef = useRef<HTMLButtonElement>(null)

  useImperativeHandle(ref, () => ({
    focusPrimaryKey: () => {
      const trigger = primaryKeyTriggerRef.current
      if (!trigger) return
      trigger.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      trigger.focus()
    },
  }))

  /**
   * 获取字段显示名称
   */
  const getFieldName = (fieldId: string): string => {
    const field = fields.find((f) => f.id === fieldId)
    return field?.name || fieldId
  }

  /**
   * 获取置信度颜色
   */
  const getConfidenceColor = (confidence: number): string => {
    if (confidence >= 0.9) return 'text-success'
    if (confidence >= 0.7) return 'text-warning'
    return 'text-warning'
  }

  /**
   * 获取置信度文本
   */
  const getConfidenceText = (confidence: number): string => {
    return `${(confidence * 100).toFixed(0)}%`
  }

  /**
   * 处理映射变化
   */
  const handleMappingChange = (source: string, newTarget: string) => {
    const newMapping = fieldMapping.map((m) =>
      m.source === source ? { ...m, target: newTarget } : m
    )
    onMappingChange(newMapping)
    setEditingMapping(null)
  }

  /**
   * 处理跳过错误变化
   */
  const handleSkipErrorsChange = (checked: boolean | 'indeterminate') => {
    const enabled = checked === true
    setSkipErrors(enabled)
    onSkipErrorsChange(enabled)
  }

  /**
   * 处理增量导入变化
   */
  const handleIncrementalChange = (checked: boolean | 'indeterminate') => {
    const enabled = checked === true
    setIncrementalImport(enabled)
    if (!enabled) {
      setPrimaryKeyField('')
      onPrimaryKeyErrorClear?.()
      onIncrementalChange(false)
      return
    }
    // 勾选后立即同步父层，即使尚未选主键——否则父层仍以为是全量导入
    onIncrementalChange(true, primaryKeyField || '')
  }

  /**
   * 处理主键字段变化
   */
  const handlePrimaryKeyChange = (fieldId: string) => {
    setPrimaryKeyField(fieldId)
    onPrimaryKeyErrorClear?.()
    if (incrementalImport) {
      onIncrementalChange(true, fieldId)
    }
  }

  return (
    <div className="space-y-6">
      {/* 统计信息 */}
      <div className="flex items-center justify-between p-4 rounded-lg bg-accent/50 border border-border">
        <div className="flex items-center gap-6">
          <div>
            <p className="text-body text-muted-foreground">{t('previewMapping.stats.totalRows')}</p>
            <p className="text-heading font-semibold text-foreground">{totalRows}</p>
          </div>
          <div className="h-10 w-px bg-border" />
          <div>
            <p className="text-body text-muted-foreground">{t('previewMapping.stats.previewRows')}</p>
            <p className="text-heading font-semibold text-foreground">{previewRows}</p>
          </div>
          <div className="h-10 w-px bg-border" />
          <div>
            <p className="text-body text-muted-foreground">{t('previewMapping.stats.fieldCount')}</p>
            <p className="text-heading font-semibold text-foreground">
              {fieldMapping.length}
            </p>
          </div>
        </div>

        {validationIssues.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-warning/20 border border-warning/20">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <span className="text-body font-medium text-warning">
              {t('previewMapping.issues.count', { count: validationIssues.length })}
            </span>
          </div>
        )}
      </div>

      {/* 数据预览 */}
      <div className="space-y-3">
        <h3 className="text-body font-semibold text-foreground">{t('previewMapping.preview.title')}</h3>
        <div className="rounded-lg border border-border overflow-hidden">
          <ScrollArea scrollBar="horizontal">
            <table className="w-full text-body">
              <thead className="bg-muted border-b border-border">
                <tr>
                  {fieldMapping.map((mapping) => (
                    <th
                      key={mapping.source}
                      className="px-4 py-3 text-left font-medium text-foreground whitespace-nowrap"
                    >
                      {mapping.source}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {previewData.map((row, rowIndex) => (
                  <tr
                    key={rowIndex}
                    className="hover:bg-accent/30 transition-colors"
                  >
                    {fieldMapping.map((mapping) => (
                      <td
                        key={`${rowIndex}-${mapping.source}`}
                        className="px-4 py-3 text-muted-foreground max-w-[200px] truncate"
                      >
                        {row[mapping.source]?.toString() || '-'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>

          {previewRows < totalRows && (
            <div className="px-4 py-2 bg-accent/30 border-t border-border text-center">
              <p className="text-body text-muted-foreground">
                {t('previewMapping.preview.more', { preview: previewRows, total: totalRows })}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 字段映射 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-body font-semibold text-foreground">{t('previewMapping.mapping.title')}</h3>
          <p className="text-body text-muted-foreground">
            {t('previewMapping.mapping.hint')}
          </p>
        </div>

        <div className="space-y-2">
          {fieldMapping.map((mapping) => (
            <div
              key={mapping.source}
              className={cn(
                'flex items-center gap-3 p-3 rounded-lg border transition-all',
                editingMapping === mapping.source
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-accent/30 hover:bg-accent/50'
              )}
            >
              {/* 源字段 */}
              <div className="flex-1 min-w-0">
                <p className="text-body font-medium text-foreground truncate">
                  {mapping.source}
                </p>
                <p className="text-body text-muted-foreground">
                  {mapping.inferred_type}
                </p>
              </div>

              {/* 箭头 */}
              <ArrowRight className="w-5 h-5 text-muted-foreground shrink-0" />

              {/* 目标字段 */}
              <div className="flex-1 min-w-0">
                {editingMapping === mapping.source ? (
                  <Select
                    value={mapping.target}
                    onValueChange={(value) => handleMappingChange(mapping.source, value)}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {fields.map((field) => (
                        <SelectItem key={field.id} value={field.id}>
                          <div className="flex items-center gap-2">
                            <span>{field.name}</span>
                            <span className="text-body text-muted-foreground">
                              ({field.field_type})
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-body font-medium text-foreground truncate">
                        {getFieldName(mapping.target)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingMapping(mapping.source)}
                      className="h-7 px-2"
                    >
                      <Edit2 className="w-3 h-3" />
                    </Button>
                  </div>
                )}
              </div>

              {/* 置信度 */}
              <div className="shrink-0 text-right min-w-[60px]">
                <p className={cn('text-body font-medium', getConfidenceColor(mapping.confidence))}>
                  {getConfidenceText(mapping.confidence)}
                </p>
                <p className="text-body text-muted-foreground">{t('previewMapping.mapping.confidence')}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 验证问题 */}
      {validationIssues.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <h3 className="text-body font-semibold text-foreground">
              {t('previewMapping.validation.title', { count: validationIssues.length })}
            </h3>
          </div>

          <ScrollArea className="max-h-[200px]"><div className="space-y-2">
            {validationIssues.slice(0, 10).map((issue, index) => (
              <div
                key={index}
                className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 border border-warning/20"
              >
                <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-body text-foreground">
                    <span className="font-medium">{t('previewMapping.validation.row', { row: issue.row })}</span>
                    {issue.field && (
                      <span className="text-muted-foreground">
                        {' '}· {issue.field}
                      </span>
                    )}
                  </p>
                  <p className="text-body text-muted-foreground mt-0.5">
                    {issue.issue}
                  </p>
                </div>
              </div>
            ))}

            {validationIssues.length > 10 && (
              <p className="text-body text-muted-foreground text-center py-2">
                {t('previewMapping.validation.more', { count: validationIssues.length - 10 })}
              </p>
            )}
          </div></ScrollArea>
        </div>
      )}

      {/* 导入选项 */}
      <div className="space-y-4 p-4 rounded-lg border border-border bg-accent/30">
        <h3 className="text-body font-semibold text-foreground">{t('previewMapping.options.title')}</h3>

        {/* 跳过错误行 */}
        <div className="flex items-start gap-3">
          <Checkbox
            id="skip-errors"
            checked={skipErrors}
            onCheckedChange={handleSkipErrorsChange}
            disabled={validationIssues.length === 0}
          />
          <div className="flex-1">
            <Label
              htmlFor="skip-errors"
              className="text-body font-medium text-foreground cursor-pointer"
            >
              {t('previewMapping.options.skipErrors.title')}
            </Label>
            <p className="text-body text-muted-foreground mt-1">
              {validationIssues.length > 0
                ? t('previewMapping.options.skipErrors.withIssues', { count: validationIssues.length })
                : t('previewMapping.options.skipErrors.none')}
            </p>
          </div>
        </div>

        {/* 增量导入 */}
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <Checkbox
              id="incremental-import"
              checked={incrementalImport}
              onCheckedChange={handleIncrementalChange}
            />
            <div className="flex-1">
              <Label
                htmlFor="incremental-import"
                className="text-body font-medium text-foreground cursor-pointer"
              >
                {t('previewMapping.options.incremental.title')}
              </Label>
              <p className="text-body text-muted-foreground mt-1">
                {t('previewMapping.options.incremental.description')}
              </p>
            </div>
          </div>

          {incrementalImport && (
            <div className="ml-7 space-y-2">
              <Label className="text-body font-medium text-foreground">
                {t('previewMapping.options.primaryKey.label')}
              </Label>
              <Select value={primaryKeyField} onValueChange={handlePrimaryKeyChange}>
                <SelectTrigger
                  ref={primaryKeyTriggerRef}
                  aria-invalid={!!primaryKeyError}
                  className={cn(primaryKeyError && 'ring-1 ring-inset ring-destructive/50')}
                >
                  <SelectValue placeholder={t('previewMapping.options.primaryKey.placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {fields.map((field) => (
                    <SelectItem key={field.id} value={field.id}>
                      {field.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {primaryKeyError ? (
                <p className="text-body text-destructive" role="alert">
                  {primaryKeyError}
                </p>
              ) : !primaryKeyField ? (
                <p className="text-body text-muted-foreground">
                  {t('previewMapping.options.primaryKey.required')}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
