/**
 * 数据导入容器组件
 *
 * 职责：
 * - 连接 DataImportDialog UI 组件和 API 服务
 * - 管理导入状态和数据流
 * - 调用导入预览和实际导入 API
 * - 处理下载模板
 * - 导入完成后刷新表格数据
 */

import React from 'react';
import {
  DataImportDialog,
  DataImportPreviewResponse,
  DataImportConfig,
  DataImportResult,
  DataImportField,
} from '@tabtin/smartsheet-ui';
import { ImportExportApiService, isImportResultError } from '@tabtin/table-core';
import { useTableStore } from '@/stores/useTableStore';
import { useRecordStore } from '@/stores/useRecordStore';
import { useViewStore } from '@/stores/useViewStore';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@/utils/logger';
import { refreshAfterImport } from './refreshAfterImport';
import { mapImportPreviewError } from './mapImportPreviewError';
import { useTableOverlayDrawerContainer } from '@/components/table/utils/TableOverlayDrawerHost';
import { useTableCollabOptional } from '@/components/table/TableCollabContext';

const log = createLogger('Import');

/**
 * 容器组件 Props
 */
export interface ImportContainerProps {
  /** 是否打开对话框 */
  open: boolean;
  /** 打开状态变化回调 */
  onOpenChange: (open: boolean) => void;
  /** 表格 ID */
  tableId: string;
}

/**
 * 导入容器组件
 */
export const ImportContainer: React.FC<ImportContainerProps> = ({
  open,
  onOpenChange,
  tableId,
}) => {
  const { t } = useTranslation('import');
  const drawer = useTableOverlayDrawerContainer(open);
  const tableCollab = useTableCollabOptional();
  const skipViewRecordsRefresh = Boolean(
    tableCollab?.isCollabRuntime &&
      !tableCollab.collabBridge.collab.isTruncated,
  );
  // 从 store 获取表格字段信息
  const fields = useTableStore((state) => state.fields);
  const selectedTable = useTableStore((state) => state.selectedTable);
  const getTable = useTableStore((state) => state.getTable);
  const loadFields = useTableStore((state) => state.loadFields);
  const loadTableStats = useTableStore((state) => state.loadTableStats);
  const loadRecordsByTable = useRecordStore(
    (state) => state.loadRecordsByTable,
  );
  const page = useRecordStore((state) => state.page);
  const pageSize = useRecordStore((state) => state.pageSize);
  const refreshCurrentView = useViewStore((state) => state.refreshCurrentView);
  const currentViewId = useViewStore((state) => state.currentViewId);
  const importInFlightRef = React.useRef(false);

  /**
   * 转换字段格式为 UI 组件需要的格式
   */
  const uiFields: DataImportField[] = fields.map((field) => ({
    id: field.id,
    name: field.name,
    field_type: field.field_type,
  }));

  const templateFields = fields.map((field) => ({
    name: field.name,
    field_type: field.field_type,
    config: (field as { config?: Record<string, unknown> | null }).config ?? null,
  }));

  /**
   * 处理文件预览
   */
  const handlePreview = async (
    file: File,
  ): Promise<DataImportPreviewResponse> => {
    try {
      log.debug('开始预览文件', {
        fileName: file.name,
        tableId,
      });

      const response = await ImportExportApiService.previewImport(
        file,
        tableId,
      );

      log.debug('预览 API 响应', response);

      // 验证响应数据结构
      if (!response || typeof response !== 'object') {
        log.error('响应数据无效', response);
        throw new Error(t('errors.responseInvalid'));
      }

      if (!response.stats) {
        log.error('缺少 stats 字段', response);
        throw new Error(t('errors.missingStats'));
      }

      if (!response.field_mapping) {
        log.error('缺少 field_mapping 字段', response);
        throw new Error(t('errors.missingFieldMapping'));
      }

      log.info('预览成功', {
        totalRows: response.stats.total_rows,
        previewRows: response.stats.preview_rows,
        fieldCount: response.stats.field_count,
        mappingCount: response.field_mapping.length,
        issuesCount: response.validation_issues?.length || 0,
      });

      return response;
    } catch (error: any) {
      // 诊断包保留原始 code/reason；用户可见文案走网络不稳定提示。
      log.error('预览失败', {
        message: error?.message,
        code: error?.code,
        reason: error?.reason,
        error,
      });
      throw new Error(mapImportPreviewError(error, t));
    }
  };

  /**
   * 处理导入
   */
  const handleImport = async (
    config: DataImportConfig,
  ): Promise<DataImportResult> => {
    if (importInFlightRef.current) {
      throw new Error(t('errors.importInFlight'));
    }
    importInFlightRef.current = true;
    try {
      log.debug('开始导入', {
        fileName: config.file.name,
        tableId,
        mappingCount: config.fieldMapping.length,
        skipErrors: config.skipErrors,
        updateExisting: config.updateExisting,
        primaryKeyField: config.primaryKeyField,
      });

      // 调用统一导入接口（自动根据文件类型选择）
      const result = await ImportExportApiService.import(config.file, tableId, {
        skipErrors: config.skipErrors,
        updateExisting: config.updateExisting,
        primaryKeyField: config.primaryKeyField,
      });

      log.info('导入成功', {
        created: result.created_count,
        updated: result.updated_count,
        errors: result.errors.length,
      });

      log.debug('刷新表格结构和数据');
      await refreshAfterImport({
        tableId,
        page,
        pageSize,
        currentViewId,
        getTable,
        loadFields,
        loadTableStats,
        loadRecordsByTable,
        refreshCurrentView,
        skipViewRecordsRefresh,
        onViewRefreshError: (refreshError) =>
          log.error('刷新视图数据失败:', refreshError),
      });

      return result;
    } catch (error: any) {
      log.error('导入失败', error);
      // 保留结构化导入结果，供失败页展示明细（勿压成纯字符串 Error）
      if (isImportResultError(error)) {
        throw error;
      }
      throw new Error(error.message || t('errors.importFailed'));
    } finally {
      importInFlightRef.current = false;
    }
  };

  /**
   * 处理下载模板（Excel / CSV / JSON）
   *
   * 优先用当前表字段本地生成，保证 JSON 一定是可导入的对象数组；
   * 避免后端未重载 / 错把 CSV 存成 .json。
   */
  const handleDownloadTemplate = async (
    format: 'xlsx' | 'csv' | 'json' = 'csv',
  ): Promise<void> => {
    try {
      log.debug('开始下载模板', { tableId, format, fieldCount: templateFields.length });

      let blob: Blob
      try {
        blob = ImportExportApiService.buildTemplateFromFields(templateFields, format)
      } catch (localError) {
        if (format === 'xlsx') {
          throw localError
        }
        log.warn('本地生成模板失败，回退后端下载', localError)
        blob = await ImportExportApiService.downloadTemplate(tableId, format)
      }

      const tableName = selectedTable?.name || t('template.defaultTableName');
      const filename =
        format === 'xlsx'
          ? t('template.filenameExcel', { tableName })
          : format === 'json'
            ? t('template.filenameJson', { tableName })
            : t('template.filename', { tableName });

      log.debug('下载模板文件', {
        filename,
        size: blob.size,
        format,
      });

      ImportExportApiService.downloadFile(blob, filename);

      log.info('模板下载成功', { format });
    } catch (error: any) {
      log.error('下载模板失败', error);
      throw new Error(error.message || t('errors.templateDownloadFailed'));
    }
  };

  /**
   * 处理对话框关闭
   */
  const handleOpenChange = (newOpen: boolean) => {
    log.debug('对话框状态变化', { open: newOpen });
    onOpenChange(newOpen);
  };

  return (
    <>
      {drawer.host}
      {drawer.ready && (
        <DataImportDialog
          open={open}
          onOpenChange={handleOpenChange}
          container={drawer.container ?? undefined}
          tableId={tableId}
          fields={uiFields}
          onPreview={handlePreview}
          onImport={handleImport}
          onDownloadTemplate={handleDownloadTemplate}
        />
      )}
    </>
  );
};
