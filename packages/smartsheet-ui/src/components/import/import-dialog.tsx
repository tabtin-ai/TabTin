/**
 * 数据导入对话框
 *
 * 三步向导流程：
 * 1. 文件上传
 * 2. 预览和映射
 * 3. 导入进度
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, ArrowRight, AlertTriangle, RotateCw } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '../sheet';
import { Button } from '../button';
import { FileUpload, type ImportTemplateFormat } from './file-upload';
import {
  PreviewMapping,
  Field,
  FieldMapping,
  ValidationIssue,
  PreviewMappingHandle,
  isIncrementalPrimaryKeyMissing,
} from './preview-mapping';
import { ImportProgress, ImportStatus, ImportResult } from './import-progress';
import { ConfirmDialog } from '../confirm-dialog';
import { cn } from '../../utils/cn';
import { ScrollArea } from '../scroll-area';
import { t } from '../../i18n';
import { isImportResultError } from '@tabtin/table-core';

/**
 * 导入预览响应
 */
export interface ImportPreviewResponse {
  preview_data: Array<Record<string, any>>;
  field_mapping: FieldMapping[];
  validation_issues: ValidationIssue[];
  stats: {
    total_rows: number;
    preview_rows: number;
    field_count: number;
  };
}

/**
 * 导入配置
 */
export interface ImportConfig {
  file: File;
  fieldMapping: FieldMapping[];
  skipErrors: boolean;
  updateExisting: boolean;
  primaryKeyField?: string;
}

/**
 * 对话框 Props
 */
export interface ImportProgressEvent {
  phase: string;
  percentage: number;
}

export interface ImportDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 打开状态变化回调 */
  onOpenChange: (open: boolean) => void;
  /** 手动指定 Portal 容器 */
  container?: HTMLElement | null;
  /** 表格ID */
  tableId: string;
  /** 表格字段列表 */
  fields: Field[];
  /** 文件选择后的预览回调 */
  onPreview: (file: File) => Promise<ImportPreviewResponse>;
  /** 确认导入回调 */
  onImport: (config: ImportConfig) => Promise<ImportResult>;
  /** 下载模板回调（按格式） */
  onDownloadTemplate: (format: ImportTemplateFormat) => Promise<void>;
  /** 订阅导入进度 WS 事件，返回取消订阅函数 */
  onSubscribeProgress?: (
    tableId: string,
    callback: (data: ImportProgressEvent) => void,
  ) => () => void;
}

/**
 * 导入步骤
 */
type ImportStep = 'upload' | 'preview' | 'progress';

export const ImportDialog: React.FC<ImportDialogProps> = ({
  open,
  onOpenChange,
  container,
  tableId,
  fields,
  onPreview,
  onImport,
  onDownloadTemplate,
  onSubscribeProgress,
}) => {
  // 步骤状态
  const [currentStep, setCurrentStep] = useState<ImportStep>('upload');
  const [canGoNext, setCanGoNext] = useState(false);

  // 文件上传状态
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [uploadError, setUploadError] = useState<string>('');

  // 预览数据状态
  const [previewResponse, setPreviewResponse] =
    useState<ImportPreviewResponse | null>(null);
  const [fieldMapping, setFieldMapping] = useState<FieldMapping[]>([]);
  const [skipErrors, setSkipErrors] = useState(false);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [primaryKeyField, setPrimaryKeyField] = useState<string>('');

  // 导入进度状态
  const [importStatus, setImportStatus] = useState<ImportStatus>('idle');
  const [importProgress, setImportProgress] = useState(0);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string>('');
  const [importStalled, setImportStalled] = useState(false);
  const lastProgressTimeRef = useRef<number>(0);
  const progressUnsubRef = useRef<(() => void) | null>(null);
  const stalledTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const importInFlightRef = useRef(false);

  // 增量导入确认
  const [showUpdateConfirm, setShowUpdateConfirm] = useState(false);
  const [primaryKeyError, setPrimaryKeyError] = useState('');
  const previewMappingRef = useRef<PreviewMappingHandle>(null);

  /**
   * 重置所有状态
   */
  const cleanupProgressSubscription = useCallback(() => {
    progressUnsubRef.current?.();
    progressUnsubRef.current = null;
    if (stalledTimerRef.current) {
      clearInterval(stalledTimerRef.current);
      stalledTimerRef.current = null;
    }
  }, []);

  const resetAllState = () => {
    cleanupProgressSubscription();
    importInFlightRef.current = false;
    setCurrentStep('upload');
    setSelectedFile(null);
    setUploadError('');
    setPreviewResponse(null);
    setFieldMapping([]);
    setSkipErrors(false);
    setUpdateExisting(false);
    setPrimaryKeyField('');
    setPrimaryKeyError('');
    setImportStatus('idle');
    setImportProgress(0);
    setImportResult(null);
    setImportError('');
    setImportStalled(false);
    setCanGoNext(false);
  };

  useEffect(() => {
    return () => cleanupProgressSubscription();
  }, [cleanupProgressSubscription]);

  /**
   * 监听对话框打开/关闭
   */
  useEffect(() => {
    if (!open) {
      if (importStatus !== 'success') {
        resetAllState();
      }
    }
  }, [open, importStatus]);

  /**
   * 监听步骤变化，更新"下一步"按钮状态
   * 预览步保持可点：增量缺主键在点击时校验并聚焦，不靠禁用按钮。
   */
  useEffect(() => {
    if (currentStep === 'upload') {
      setCanGoNext(!!selectedFile && !isLoadingPreview);
    } else if (currentStep === 'preview') {
      setCanGoNext(true);
    } else {
      setCanGoNext(false);
    }
  }, [currentStep, selectedFile, isLoadingPreview]);

  /**
   * 处理文件选择
   */
  const handleFileSelect = async (file: File | null) => {
    setSelectedFile(file);
    setUploadError('');
    setPreviewResponse(null);

    if (!file) {
      return;
    }

    // 自动触发预览
    setIsLoadingPreview(true);
    try {
      console.log('🔍 开始预览文件:', file.name);
      const response = await onPreview(file);

      console.log('✅ 预览成功:', {
        totalRows: response.stats.total_rows,
        fields: response.field_mapping.length,
        issues: response.validation_issues.length,
      });

      setPreviewResponse(response);
      setFieldMapping(response.field_mapping);

      // 自动进入下一步
      setCurrentStep('preview');
    } catch (error: any) {
      console.error('❌ 预览失败:', error);
      setUploadError(error.message || t('importDialog.errors.previewFailed'));
    } finally {
      setIsLoadingPreview(false);
    }
  };

  /**
   * 处理下载模板
   */
  const handleDownloadTemplate = async (format: ImportTemplateFormat) => {
    try {
      await onDownloadTemplate(format);
    } catch (error: any) {
      console.error('❌ 下载模板失败:', error);
      setUploadError(error.message || t('importDialog.errors.templateFailed'));
    }
  };

  /**
   * 处理上一步
   */
  const handlePrevious = () => {
    if (currentStep === 'preview') {
      setCurrentStep('upload');
    } else if (currentStep === 'progress' && importStatus !== 'importing') {
      setCurrentStep('preview');
      setImportStatus('idle');
      setImportProgress(0);
      setImportResult(null);
      setImportError('');
    }
  };

  /**
   * 处理下一步 / 开始导入
   */
  const handleNext = async () => {
    if (currentStep === 'upload') {
      setCurrentStep('preview');
    } else if (currentStep === 'preview') {
      if (isIncrementalPrimaryKeyMissing(updateExisting, primaryKeyField)) {
        setPrimaryKeyError(t('previewMapping.options.primaryKey.required'));
        // 等主键 Select 展开渲染后再聚焦
        requestAnimationFrame(() => {
          previewMappingRef.current?.focusPrimaryKey();
        });
        return;
      }
      if (updateExisting) {
        setShowUpdateConfirm(true);
      } else {
        await handleStartImport();
      }
    }
  };

  /**
   * 开始导入
   */
  const handleStartImport = async () => {
    if (!selectedFile || !previewResponse) {
      return;
    }
    if (isIncrementalPrimaryKeyMissing(updateExisting, primaryKeyField)) {
      setPrimaryKeyError(t('previewMapping.options.primaryKey.required'));
      setCurrentStep('preview');
      requestAnimationFrame(() => {
        previewMappingRef.current?.focusPrimaryKey();
      });
      return;
    }
    // 单次提交门闩：防止「导入中」状态落盘前的重复点击触发二次请求。
    if (importInFlightRef.current || importStatus === 'importing') {
      return;
    }
    importInFlightRef.current = true;

    setCurrentStep('progress');
    setImportStatus('importing');
    setImportProgress(0);
    setImportError('');
    setImportStalled(false);

    lastProgressTimeRef.current = Date.now();

    if (onSubscribeProgress) {
      progressUnsubRef.current = onSubscribeProgress(tableId, (data) => {
        setImportProgress(data.percentage);
        lastProgressTimeRef.current = Date.now();
        setImportStalled(false);
      });
    }

    stalledTimerRef.current = setInterval(() => {
      if (Date.now() - lastProgressTimeRef.current > 30_000) {
        setImportStalled(true);
      }
    }, 5_000);

    try {
      const config: ImportConfig = {
        file: selectedFile,
        fieldMapping,
        skipErrors,
        updateExisting,
        primaryKeyField: updateExisting ? primaryKeyField : undefined,
      };

      const result = await onImport(config);

      setImportProgress(100);
      setImportStatus('success');
      setImportResult(result);
    } catch (error: any) {
      setImportStatus('error');
      if (isImportResultError(error)) {
        setImportResult({
          created_count: error.result.created_count,
          updated_count: error.result.updated_count,
          skipped_count: error.result.skipped_count,
          error_summary: error.result.error_summary,
          errors: error.result.errors,
        });
        setImportError(error.message || t('importDialog.errors.importFailed'));
      } else {
        setImportError(error.message || t('importDialog.errors.importFailed'));
      }
    } finally {
      importInFlightRef.current = false;
      cleanupProgressSubscription();
    }
  };

  /**
   * 处理关闭对话框
   */
  const handleClose = () => {
    if (importStatus === 'importing') {
      // 正在导入时不允许关闭
      return;
    }
    onOpenChange(false);
    // 延迟重置状态，让关闭动画完成
    setTimeout(resetAllState, 300);
  };

  /**
   * 处理完成
   */
  const handleFinish = () => {
    onOpenChange(false);
    setTimeout(resetAllState, 300);
  };

  /**
   * 获取步骤标题
   */
  const getStepTitle = () => {
    switch (currentStep) {
      case 'upload':
        return t('importDialog.step.upload.title');
      case 'preview':
        return t('importDialog.step.preview.title');
      case 'progress':
        return t('importDialog.step.progress.title');
      default:
        return t('importDialog.step.default.title');
    }
  };

  /**
   * 获取步骤描述
   */
  const getStepDescription = () => {
    switch (currentStep) {
      case 'upload':
        return t('importDialog.step.upload.description');
      case 'preview':
        return t('importDialog.step.preview.description');
      case 'progress':
        return t('importDialog.step.progress.description');
      default:
        return '';
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleClose} modal={false}>
      <SheetContent
        side="right"
        overlay={false}
        container={container}
        className="pointer-events-auto w-[420px] sm:max-w-[420px] flex flex-col overflow-hidden p-0 data-[state=open]:!animate-none data-[state=closed]:!animate-none !transition-none"
        onFocusOutside={(event) => event.preventDefault()}
      >
        <SheetHeader className="shrink-0 border-b border-border/40 px-4 py-3">
          <SheetTitle className="pr-8 text-body">
            {t('importDialog.step.default.title')}
          </SheetTitle>
          <SheetDescription className="text-body">
            {t('importDialog.drawerDescription')}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="px-4 py-4">
            <div className="mb-4 space-y-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-body font-medium">{getStepTitle()}</div>
                  <div className="text-body text-muted-foreground">
                    {getStepDescription()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {(['upload', 'preview', 'progress'] as const).map(
                    (step, index) => {
                      const order: ImportStep[] = [
                        'upload',
                        'preview',
                        'progress',
                      ];
                      const isActive = currentStep === step;
                      const isPast =
                        order.indexOf(currentStep) > order.indexOf(step);
                      return (
                        <React.Fragment key={step}>
                          <div
                            className={cn(
                              'flex h-7 w-7 items-center justify-center rounded-full text-caption font-semibold transition-colors',
                              isActive
                                ? 'bg-primary text-primary-foreground'
                                : isPast
                                  ? 'bg-primary/20 text-primary'
                                  : 'bg-muted text-muted-foreground',
                            )}
                          >
                            {index + 1}
                          </div>
                          {index < 2 && (
                            <div
                              className={cn(
                                'h-px w-6 transition-colors',
                                isPast ? 'bg-primary/40' : 'bg-border',
                              )}
                            />
                          )}
                        </React.Fragment>
                      );
                    },
                  )}
                </div>
              </div>
            </div>

            {currentStep === 'upload' && (
              <FileUpload
                onFileSelect={handleFileSelect}
                onDownloadTemplate={handleDownloadTemplate}
                selectedFile={selectedFile}
                isProcessing={isLoadingPreview}
                error={uploadError}
              />
            )}

            {currentStep === 'preview' && previewResponse && (
              <PreviewMapping
                ref={previewMappingRef}
                previewData={previewResponse.preview_data}
                fieldMapping={fieldMapping}
                validationIssues={previewResponse.validation_issues}
                fields={fields}
                totalRows={previewResponse.stats.total_rows}
                previewRows={previewResponse.stats.preview_rows}
                onMappingChange={setFieldMapping}
                onIncrementalChange={(enabled, primaryKey) => {
                  setUpdateExisting(enabled);
                  setPrimaryKeyField(primaryKey || '');
                }}
                onSkipErrorsChange={setSkipErrors}
                primaryKeyError={primaryKeyError}
                onPrimaryKeyErrorClear={() => setPrimaryKeyError('')}
              />
            )}

            {currentStep === 'progress' && (
              <div className="space-y-4">
                <ImportProgress
                  status={importStatus}
                  progress={importProgress}
                  result={importResult || undefined}
                  error={importError}
                  totalRows={previewResponse?.stats.total_rows}
                />

                {importStalled && importStatus === 'importing' && (
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-warning/10 border border-warning/20">
                    <AlertTriangle className="w-5 h-5 text-warning shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-body text-warning font-medium">
                        {t('importDialog.progress.stalled.title')}
                      </p>
                      <p className="text-body text-warning/80">
                        {t('importDialog.progress.stalled.description')}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => {
                        setImportStalled(false);
                        lastProgressTimeRef.current = Date.now();
                      }}
                    >
                      <RotateCw className="w-3.5 h-3.5 mr-1.5" />
                      {t('importDialog.progress.stalled.retry')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* 底部按钮 */}
        <SheetFooter className="shrink-0 flex items-center justify-between border-t border-border/40 px-4 py-3">
          <div>
            {currentStep !== 'upload' && importStatus !== 'importing' && (
              <Button variant="outline" onClick={handlePrevious}>
                <ArrowLeft className="w-4 h-4 mr-2" />
                {t('common.previous')}
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={importStatus === 'importing'}
            >
              {importStatus === 'success'
                ? t('common.close')
                : t('common.cancel')}
            </Button>

            {currentStep !== 'progress' && (
              <Button
                onClick={handleNext}
                disabled={!canGoNext || importStatus === 'importing'}
              >
                {currentStep === 'preview'
                  ? t('importDialog.button.startImport')
                  : t('common.next')}
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            )}

            {importStatus === 'success' && (
              <Button onClick={handleFinish}>
                {t('importDialog.button.finish')}
              </Button>
            )}
          </div>
        </SheetFooter>

        <ConfirmDialog
          open={showUpdateConfirm}
          onOpenChange={setShowUpdateConfirm}
          title={t('importDialog.updateConfirm.title')}
          description={t('importDialog.updateConfirm.description', {
            count: previewResponse?.stats?.total_rows ?? 0,
          })}
          variant="destructive"
          confirmText={t('importDialog.updateConfirm.confirm')}
          cancelText={t('common.cancel')}
          onConfirm={async () => {
            await handleStartImport();
          }}
        />
      </SheetContent>
    </Sheet>
  );
};
