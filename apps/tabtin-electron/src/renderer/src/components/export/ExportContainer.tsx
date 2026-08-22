/**
 * 导出容器组件
 *
 * 连接导出 UI（DataExportDialog）和后端 API，完成：
 * 1. 打开时自动加载导出统计
 * 2. 将前端 ExportConfig 映射为后端 ExportConfig
 * 3. 调用导出 API 并触发文件下载
 */

import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from 'react';
import { DataExportDialog } from '@tabtin/smartsheet-ui';
import type {
  DataExportConfig as UIExportConfig,
  DataExportStats as UIExportStats,
  DataExportField,
  DataExportRange,
} from '@tabtin/smartsheet-ui';
import {
  ImportExportApiService,
  resolveExportViewQuery,
  type ExportConfig,
} from '@tabtin/table-core';
import { getViewVisibilitySnapshot } from '@tabtin/table-ui';
import { useTableStore } from '@/stores/useTableStore';
import { useRecordStore } from '@/stores/useRecordStore';
import { useViewStore } from '@/stores/useViewStore';
import { useTranslation } from 'react-i18next';
import { Button, toast } from '@components/ui';
import { saveExportBlob } from '@/services/tableCoreRuntime';
import { useTableOverlayDrawerContainer } from '@/components/table/utils/TableOverlayDrawerHost';
import {
  resolveCurrentViewRecordCount,
  resolveExportFieldsForScope,
  shouldApplyCurrentViewQuery,
} from './export-scope';

type ExportStatsResponse = Awaited<
  ReturnType<typeof ImportExportApiService.getExportStats>
>;

export interface ExportContainerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableId: string;
  selectedRecordIds?: string[];
  viewId?: string;
  /** Grid runtime count; fresher than REST view totals while collaboration filters are local. */
  renderedViewRecordCount?: number;
}

export const ExportContainer: React.FC<ExportContainerProps> = ({
  open,
  onOpenChange,
  tableId,
  selectedRecordIds = [],
  viewId,
  renderedViewRecordCount,
}) => {
  const { t } = useTranslation('export');
  const drawer = useTableOverlayDrawerContainer(open);
  const fields = useTableStore((s) => s.fields);
  const selectedTable = useTableStore((s) => s.selectedTable);
  const totalRecords = useRecordStore((s) => s.total);
  const views = useViewStore((s) => s.views);
  const recordsQuery = useViewStore((s) => s.recordsQuery);
  const currentViewRecords = useViewStore((s) =>
    s.currentViewId === viewId ? s.currentViewRecords : null,
  );
  const currentViewDraft = useViewStore((s) =>
    viewId ? s.draftStates[viewId] : undefined,
  );
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [stats, setStats] = useState<ExportStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<'stats' | 'export' | null>(
    null,
  );
  const [statsSampledHint, setStatsSampledHint] = useState<string | null>(null);
  const currentView = useMemo(
    () => views.find((view) => view.id === viewId && view.table_id === tableId) ?? null,
    [views, viewId, tableId],
  );
  const defaultRange = useMemo<DataExportRange>(
    () => (currentView ? 'view' : 'all'),
    [currentView],
  );
  const [currentRange, setCurrentRange] = useState<DataExportRange>(defaultRange);
  const currentViewQuery = useMemo<
    Pick<ExportConfig, 'filters' | 'filter_logic' | 'sorts' | 'groups'>
  >(
    () => resolveExportViewQuery(recordsQuery, currentViewDraft),
    [currentViewDraft, recordsQuery],
  );

  const selectedRecordIdsRef = useRef(selectedRecordIds);
  selectedRecordIdsRef.current = selectedRecordIds;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadStatsRequestId = useRef(0);
  const lastExportConfigRef = useRef<UIExportConfig | null>(null);

  const tableExportFields = useMemo<DataExportField[]>(() => {
    return fields.map((field) => ({
      id: field.id,
      name: field.name,
    }));
  }, [fields]);

  const viewExportFields = useMemo<DataExportField[]>(() => {
    if (!currentView) {
      return tableExportFields;
    }
    const fieldById = new Map(fields.map((field) => [field.id, field]));
    const { visibleFieldIds } = getViewVisibilitySnapshot(currentView, fields);
    return visibleFieldIds
      .map((fieldId) => fieldById.get(fieldId))
      .filter((field): field is (typeof fields)[number] => Boolean(field))
      .map((field) => ({
        id: field.id,
        name: field.name,
      }));
  }, [currentView, fields, tableExportFields]);

  const exportFields = resolveExportFieldsForScope(
    currentRange,
    tableExportFields,
    viewExportFields,
  );

  const uiStats = useMemo<UIExportStats | undefined>(() => {
    if (!stats) return undefined;

    return {
      fieldCount: stats.field_count,
      recordCount: stats.record_count,
      estimatedSize: {
        csvKb: stats.estimated_size.csv_kb,
        excelKb: stats.estimated_size.excel_kb,
        jsonKb: stats.estimated_size.json_kb,
        pdfKb: stats.estimated_size.pdf_kb,
      },
    };
  }, [stats]);
  const currentViewRecordCount = resolveCurrentViewRecordCount(
    currentViewRecords?.matched_total,
    currentViewRecords?.total,
    stats?.record_count,
    renderedViewRecordCount,
  );

  const loadStats = useCallback(
    async (range: DataExportRange = 'all') => {
      if (!tableId) return;

      const requestId = ++loadStatsRequestId.current;
      setIsLoadingStats(true);
      setError(null);
      setErrorSource(null);
      setStatsSampledHint(null);

      try {
        const ids = selectedRecordIdsRef.current;
        const recordIdsParam =
          range === 'selected' && ids.length > 0 ? ids : undefined;
        const viewIdParam = range === 'view' ? viewId : undefined;

        const statsData = await ImportExportApiService.getExportStats(
          tableId,
          recordIdsParam,
          viewIdParam,
          shouldApplyCurrentViewQuery(range) ? currentViewQuery : undefined,
        );

        if (requestId !== loadStatsRequestId.current) return;

        setStats(statsData);

        if (
          statsData.is_sampled &&
          recordIdsParam &&
          recordIdsParam.length > 0
        ) {
          setStatsSampledHint(
            t('stats.sampledHint', {
              total: recordIdsParam.length,
              defaultValue: `统计基于采样估算，实际导出包含全部 ${recordIdsParam.length} 条选中记录`,
            }),
          );
        }
      } catch (err) {
        if (requestId !== loadStatsRequestId.current) return;
        console.error('加载导出统计失败:', err);
        setError(
          err instanceof Error ? err.message : t('errors.loadStatsFailed'),
        );
        setErrorSource('stats');
      } finally {
        if (requestId === loadStatsRequestId.current) {
          setIsLoadingStats(false);
        }
      }
    },
    [tableId, viewId, currentViewQuery, t],
  );

  useEffect(() => {
    if (open && tableId) {
      setCurrentRange(defaultRange);
      loadStats(defaultRange);
    }
    if (!open) {
      setError(null);
      setErrorSource(null);
      setStatsSampledHint(null);
    }
  }, [open, tableId, defaultRange, loadStats]);

  const handleRangeChange = useCallback(
    (range: DataExportRange) => {
      setCurrentRange(range);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        loadStats(range);
      }, 300);
    },
    [loadStats],
  );

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const handleExportImpl = async (config: UIExportConfig): Promise<void> => {
    lastExportConfigRef.current = config;
    setIsExporting(true);
    setError(null);
    setErrorSource(null);

    try {
      const exportConfig: ExportConfig = {
        table_id: tableId,
      };

      if (config.selectedFields && config.selectedFields.length > 0) {
        exportConfig.field_ids = config.selectedFields;
      }

      const currentRecordIds = selectedRecordIdsRef.current;
      if (config.range === 'selected' && currentRecordIds.length > 0) {
        exportConfig.record_ids = currentRecordIds;
      }

      if (shouldApplyCurrentViewQuery(config.range) && viewId) {
        exportConfig.view_id = viewId;
        Object.assign(exportConfig, currentViewQuery);
      }

      if (config.format === 'csv' || config.format === 'excel') {
        exportConfig.include_headers = config.includeHeaders !== false;
      }

      if (config.format === 'excel' && config.sheetName) {
        exportConfig.sheet_name = config.sheetName;
      }

      if (config.format === 'pdf') {
        if (config.orientation) {
          exportConfig.orientation = config.orientation;
        }
        if (config.title) {
          exportConfig.title = config.title;
        }
      }

      if (config.format === 'json') {
        exportConfig.format_type = config.jsonFormat ?? 'array';
      }

      const blob = await ImportExportApiService.export(
        config.format,
        exportConfig,
      );

      const tableName = selectedTable?.name || t('filename.defaultTableName');
      const filename = ImportExportApiService.generateFilename(
        tableName,
        config.format,
      );

      const result = await saveExportBlob(blob, filename);

      if (result.status === 'cancelled') {
        return;
      }

      if (result.status === 'saved') {
        const tabtin = window.tabtin;
        toast({
          title: t('success.exported', {
            filename,
            defaultValue: `已导出 ${filename}`,
          }),
          action: (
            <Button
              variant="link"
              className="h-auto p-0 text-accent"
              onClick={() => void tabtin?.showItemInFolder?.(result.path)}
            >
              {t('success.showInFolder', {
                defaultValue: '打开文件位置',
              })}
            </Button>
          ),
          variant: 'success',
          duration: 6000,
        });
      } else {
        toast({
          title: t('success.exported', {
            filename,
            defaultValue: `已导出 ${filename}`,
          }),
          variant: 'success',
        });
      }

      onOpenChange(false);
    } catch (err) {
      console.error('导出失败:', err);
      const message =
        err instanceof Error ? err.message : t('errors.exportFailed');
      setError(message);
      setErrorSource('export');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportRef = useRef(handleExportImpl);
  handleExportRef.current = handleExportImpl;

  const handleExport = useCallback(
    (config: UIExportConfig) => handleExportRef.current(config),
    [],
  );

  const handleRetry = useCallback(() => {
    if (errorSource === 'export' && lastExportConfigRef.current) {
      handleExport(lastExportConfigRef.current);
    } else {
      loadStats(currentRange);
    }
  }, [errorSource, handleExport, loadStats, currentRange]);

  return (
    <>
      {drawer.host}
      {drawer.ready && (
        <DataExportDialog
          open={open}
          onOpenChange={onOpenChange}
          container={drawer.container ?? undefined}
          fields={exportFields}
          selectedRecordCount={selectedRecordIds.length}
          totalRecordCount={totalRecords}
          viewRecordCount={currentViewRecordCount}
          hasActiveView={!!currentView}
          defaultRange={defaultRange}
          stats={uiStats}
          isLoadingStats={isLoadingStats}
          onExport={handleExport}
          onRangeChange={handleRangeChange}
          isExporting={isExporting}
          error={error}
          statsSampledHint={statsSampledHint}
          onRetry={handleRetry}
        />
      )}
    </>
  );
};
