/**
 * 映射面板
 *
 * 职责：
 * - 显示提取的数据
 * - 展示自动字段映射结果
 * - 选择 Space 并导入数据
 */

import React, { useMemo, useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { autoMapFields } from '../../utils/helpers'
import { SpaceSelectionPanel, type SpaceOption } from './SpaceSelectionPanel'
import { t } from '../../i18n'
interface MappingTaskState {
  extractedData: Record<string, unknown>[]
  paginationInfo?: unknown
  paginationExecution?: {
    status: 'pending' | 'running' | 'completed' | 'failed'
    requestedPages?: number
    successPages?: number
    metrics?: { requestedPages?: number; successPages?: number }
    errorMessage?: string
  }
}

interface MappingImportProgress {
  message: string
  progress: number
  totalRecords?: number
  successCount?: number
  phase?: 'downloading_resources' | 'uploading_resources' | string
  downloadStats?: { completed: number; total: number; current?: string }
  uploadStats?: { completed: number; total: number; current?: string }
}

export interface MappingPanelProps {
  taskState: MappingTaskState
  /** 可选 Space 列表 */
  spaces: SpaceOption[]

  onImport: (result: { tableId: string; tableName: string; recordCount: number }) => void
  onBack: () => void
  pageTitle?: string  // 网页标题
  instruction?: string  // 采集指令
  schemaHistoryId?: string | null  // ✅ Schema History ID（用于定时刷新）
  fieldConfigs?: Array<{  // 🆕 字段配置（用户自定义）
    sourceField: string
    displayName: string
    fieldType: string
    enabled: boolean
  }>
  // 🆕 从父组件接收导入状态和控制函数
  importProgress: MappingImportProgress
  isImporting: boolean
  // 🆕 启动导入的回调（替代内部 hook）
  onStartImport?: (spaceId: string, spaceName: string) => Promise<any>

  onStepChange?: (stepNumber: number, stepTitle: string, canGoBack?: boolean, backLabel?: string, nextLabel?: string) => void
}

export const MappingPanel: React.FC<MappingPanelProps> = ({
  taskState,
  spaces,
  onImport,
  onBack,
  schemaHistoryId,
  pageTitle,
  instruction,
  fieldConfigs,
  importProgress,
  isImporting,
  onStartImport,
  onStepChange,
}) => {
  // 当前步骤：'preview' | 'importing'
  // 如果父组件正在导入，强制显示 importing
  const step = isImporting ? 'importing' : 'preview'

  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)

  // ⭐ 同步内部步骤状态到顶部控制栏
  useEffect(() => {
    if (!onStepChange) return

    if (step === 'preview') {
      // 如果未选择项目，nextLabel 为空（禁用按钮）
      const nextLabel = selectedSpaceId ? t('mappingPanel.step.nextLabel') : ''
      onStepChange(5, t('mappingPanel.step.previewTitle'), true, t('common.cancel'), nextLabel)
    } else if (step === 'importing') {
      onStepChange(5, t('mappingPanel.step.importingTitle'), false, '', '')
    }
  }, [step, selectedSpaceId, onStepChange])


  const fieldMappings = useMemo(() => {
    if (!taskState.extractedData || taskState.extractedData.length === 0) {
      return []
    }

    const fieldSet = new Set<string>()
    for (const item of taskState.extractedData) {
      for (const key of Object.keys(item)) {
        fieldSet.add(key)
      }
    }

    return autoMapFields(Array.from(fieldSet))
  }, [taskState.extractedData])

  const renderPaginationBanner = () => {
    if (!taskState.paginationInfo) {
      return null
    }

    const execution = taskState.paginationExecution

    if (!execution || execution.status === 'pending') {
      return (
        <div className="bg-brand-50 border border-brand-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <span className="text-brand-500" aria-hidden="true">ℹ️</span>
            <div className="flex-1">
              <div className="text-body font-medium text-brand-800">{t('mappingPanel.pagination.detected.title')}</div>
              <div className="text-body text-brand-600 mt-1">
                {t('mappingPanel.pagination.detected.description')}
              </div>
            </div>
          </div>
        </div>
      )
    }

    const requestedPages =
      execution.requestedPages ??
      execution.metrics?.requestedPages
    const successPages =
      execution.successPages ??
      execution.metrics?.successPages

    if (execution.status === 'running') {
      return (
        <div className="bg-warning border border-warning rounded-lg p-4">
          <div className="flex items-start gap-3">
            <span className="text-warning" aria-hidden="true">⏳</span>
            <div className="flex-1">
              <div className="text-body font-medium text-warning">{t('mappingPanel.pagination.running.title')}</div>
              <div className="text-body text-warning mt-1">
                {requestedPages
                  ? t('mappingPanel.pagination.running.descriptionWithTarget', {
                      success: successPages ?? 1,
                      requested: requestedPages
                    })
                  : t('mappingPanel.pagination.running.description', { success: successPages ?? 1 })}
              </div>
            </div>
          </div>
        </div>
      )
    }

    if (execution.status === 'completed') {
      return (
        <div className="bg-success border border-success rounded-lg p-4">
          <div className="flex items-start gap-3">
            <span className="text-success" aria-hidden="true">✅</span>
            <div className="flex-1">
              <div className="text-body font-medium text-success">{t('mappingPanel.pagination.completed.title')}</div>
              <div className="text-body text-success mt-1">
                {requestedPages && successPages && requestedPages !== successPages
                  ? t('mappingPanel.pagination.completed.descriptionWithPlan', {
                      success: successPages ?? requestedPages ?? '?',
                      requested: requestedPages
                    })
                  : t('mappingPanel.pagination.completed.description', {
                      success: successPages ?? requestedPages ?? '?'
                    })}
              </div>
            </div>
          </div>
        </div>
      )
    }

    if (execution.status === 'failed') {
      return (
        <div className="bg-destructive border border-destructive rounded-lg p-4">
          <div className="flex items-start gap-3">
            <span className="text-destructive" aria-hidden="true">⚠️</span>
            <div className="flex-1">
              <div className="text-body font-medium text-destructive">{t('mappingPanel.pagination.failed.title')}</div>
              <div className="text-body text-destructive mt-1">
                {execution.errorMessage || t('mappingPanel.pagination.failed.fallback')}
              </div>
            </div>
          </div>
        </div>
      )
    }

    return null
  }

  // ========== 渲染：数据预览阶段（包含项目选择） ==========
  if (step === 'preview') {
    // CC-020: 空数据时显示 Empty 状态，而非成功 banner
    if (!taskState.extractedData || taskState.extractedData.length === 0) {
      return (
        <div className="p-6 space-y-6">
          <div className="bg-muted/30 rounded-lg p-8 border border-border text-center">
            <span className="text-display block mb-3">📭</span>
            <div className="text-subtitle font-semibold text-foreground mb-1">
              {t('mappingPanel.preview.emptyTitle')}
            </div>
            <div className="text-body text-muted-foreground">
              {t('mappingPanel.preview.emptyDescription')}
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="p-6 space-y-6">
        {/* 成功提示 */}
        <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg p-4 border border-success">
          <div className="flex items-center gap-3">
            <span className="text-heading">🎉</span>
            <div>
              <div className="text-body font-semibold text-success">{t('mappingPanel.preview.successTitle')}</div>
              <div className="text-body text-success mt-0.5">
                {t('mappingPanel.preview.successDescription', { count: taskState.extractedData.length })}
              </div>
            </div>
          </div>
        </div>

        <SpaceSelectionPanel
          spaces={spaces}
          selectedSpaceId={selectedSpaceId as string}
          onSelect={setSelectedSpaceId}
        />

        {/* 数据预览 */}
        <div className="bg-muted/30 rounded-lg p-4 border border-border">
          <div className="flex items-center justify-between mb-3">
            <div className="text-body font-semibold text-foreground">{t('mappingPanel.preview.title')}</div>
            <div className="text-body text-muted-foreground">
              {t('mappingPanel.preview.subtitle', { count: taskState.extractedData.length })}
            </div>
          </div>
          <div className="bg-card rounded-lg border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-body">
                <thead className="bg-muted/50">
                  <tr>
                    {fieldMappings.map((mapping) => (
                      <th
                        key={mapping.source}
                        className="px-3 py-2.5 text-left font-semibold text-foreground border-b border-border whitespace-nowrap"
                      >
                        {mapping.target}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {taskState.extractedData.slice(0, 5).map((item: any, index: number) => (
                    <tr
                      key={index}
                      className={`
                        border-b border-border/50 transition-colors
                        ${index % 2 === 0 ? 'bg-card' : 'bg-muted/30'}
                        hover:bg-brand-50/30
                      `}
                    >
                      {fieldMappings.map((mapping) => (
                        <td key={mapping.source} className="px-3 py-2.5 text-muted-foreground max-w-xs truncate">
                          {item[mapping.source] != null ? String(item[mapping.source]) : '-'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {taskState.extractedData.length > 5 && (
              <div className="text-center py-2.5 text-body text-muted-foreground bg-muted/40 border-t border-border">
                {t('mappingPanel.preview.more', { count: taskState.extractedData.length - 5 })}
              </div>
            )}
          </div>
        </div>

        {/* 字段映射 */}
        <div className="bg-muted/30 rounded-lg p-4 border border-border">
          <div className="text-body font-semibold text-foreground mb-3">
            {t('mappingPanel.fieldMapping.title')}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {fieldMappings.map((mapping) => (
              <div
                key={mapping.source}
                className="flex items-center justify-between bg-card p-2.5 rounded-lg border border-border text-body"
              >
                <span className="text-muted-foreground truncate flex-1">{mapping.source}</span>
                <span className="text-muted-foreground/70 mx-2">→</span>
                <span className="text-brand-600 font-medium truncate flex-1 text-right">{mapping.target}</span>
                <span className="text-success ml-2">✓</span>
              </div>
            ))}
          </div>
        </div>

        {/* 翻页信息（如果有） */}
        {renderPaginationBanner()}
      </div>
    )
  }

  // ========== 渲染：导入进度阶段 ==========
  if (step === 'importing') {
    return (
      <div className="p-6 space-y-6">
        {/* 导入进度 */}
        <div className="bg-brand-50 border border-brand-200 rounded-lg p-6">
          <div className="flex items-start gap-4">
            <Loader2 className="w-6 h-6 text-brand-600 animate-spin flex-shrink-0 mt-1" />
            <div className="flex-1">
              <div className="text-subtitle font-medium text-brand-800 mb-2">
                {importProgress.message}
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1 bg-brand-200 rounded-full h-3">
                  <div
                    className="bg-brand-600 h-3 rounded-full transition-all duration-300"
                    style={{ width: `${importProgress.progress}%` }}
                  />
                </div>
                <span className="text-body text-brand-700 font-medium min-w-[3rem] text-right">
                  {Math.round(importProgress.progress)}%
                </span>
              </div>
              {importProgress.totalRecords && (
                <div className="text-body text-brand-700 mt-2">
                  {t('mappingPanel.importing.importedCount', {
                    success: importProgress.successCount || 0,
                    total: importProgress.totalRecords
                  })}
                </div>
              )}

              {/* 🆕 显示资源下载/上传详情 */}
              {importProgress.phase === 'downloading_resources' && importProgress.downloadStats && (
                <div className="mt-3 text-body text-brand-600 bg-brand-100/50 p-2 rounded">
                  <div>{t('mappingPanel.importing.downloadProgress', {
                    completed: importProgress.downloadStats.completed,
                    total: importProgress.downloadStats.total
                  })}</div>
                  {importProgress.downloadStats.current && (
                    <div className="truncate mt-1">
                      {t('mappingPanel.importing.downloading', { current: importProgress.downloadStats.current })}
                    </div>
                  )}
                </div>
              )}

              {importProgress.phase === 'uploading_resources' && importProgress.uploadStats && (
                <div className="mt-3 text-body text-brand-600 bg-brand-100/50 p-2 rounded">
                  <div>{t('mappingPanel.importing.uploadProgress', {
                    completed: importProgress.uploadStats.completed,
                    total: importProgress.uploadStats.total
                  })}</div>
                  {importProgress.uploadStats.current && (
                    <div className="truncate mt-1">
                      {t('mappingPanel.importing.uploading', { current: importProgress.uploadStats.current })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 提示信息 */}
        <div className="text-center text-body text-muted-foreground">
          {t('mappingPanel.importing.tip')}
        </div>
      </div>
    )
  }

  return null
}
