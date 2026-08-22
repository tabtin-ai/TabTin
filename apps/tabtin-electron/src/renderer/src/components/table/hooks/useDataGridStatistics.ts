/**
 * useDataGridStatistics - 列统计计算 hook
 *
 * 职责：
 * 1. 统计函数配置读取与持久化（视图级别 column_statistic_funcs）
 * 2. 远程列统计查询（ViewApiService.getViewColumnStatistics）
 * 3. 本地统计计算（Count / Sum / Avg / Min / Max / Date / Checkbox 等）
 * 4. 行评论数统计
 * 5. 统计菜单操作处理
 */

import React from 'react';
import {
  StatFunc,
  getValidStatFuncs,
} from '@tabtin/table-engine-canvas/statistics';
import {
  CANVAS_TABLE_ENGINE,
} from '@tabtin/table-engine-canvas/engine';
import {
  toast,
} from '@tabtin/smartsheet-ui';
import {
  resolveRecordId,
  type TableGridRendererProps,
  type TableGridColumnStatistic,
  type TableGridColumnStatistics,
  type TableGridHeaderContextMenuInfo,
} from '@tabtin/table-engine';
import { ViewApiService, type ViewFilter, type ViewMeta } from '@tabtin/table-core';
import { formatNumber } from '@/utils/i18n/format';

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

const COLUMN_STATISTIC_FUNCS_CONFIG_KEY = 'column_statistic_funcs';
const STAT_FUNC_SET = new Set<string>(Object.values(StatFunc));
const CHECKBOX_TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const CHECKBOX_FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);
const GROUP_HEADER_ROW_TYPE = 'group_header';

const normalizeStatFunc = (value: unknown): StatFunc | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return STAT_FUNC_SET.has(normalized) ? (normalized as StatFunc) : null;
};

const isCellValueEmpty = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

const normalizeStatisticValueKey = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string:${value}`;
  if (typeof value === 'number') return `number:${String(value)}`;
  if (typeof value === 'boolean') return `boolean:${String(value)}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  try { return `json:${JSON.stringify(value)}`; } catch { return `fallback:${String(value)}`; }
};

const parseNumericValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/,/g, '');
  const direct = Number(normalized);
  if (Number.isFinite(direct)) return direct;

  const sanitized = normalized.replace(/[^0-9.+-]/g, '');
  if (!sanitized) return null;
  const fallback = Number(sanitized);
  return Number.isFinite(fallback) ? fallback : null;
};

const collectNumericValues = (value: unknown, target: number[]): void => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNumericValues(item, target));
    return;
  }
  const parsed = parseNumericValue(value);
  if (parsed === null) return;
  target.push(parsed);
};

interface DateCandidate {
  timestamp: number;
  raw: unknown;
}

const parseTimestamp = (value: unknown): number | null => {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.abs(value) < 1e11 ? value * 1000 : value;
    return Number.isFinite(normalized) ? normalized : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return parseTimestamp(Number(trimmed));
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const collectDateCandidates = (
  value: unknown,
  target: DateCandidate[],
): void => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectDateCandidates(item, target));
    return;
  }
  const timestamp = parseTimestamp(value);
  if (timestamp === null) return;
  target.push({ timestamp, raw: value });
};

const parseCheckboxState = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (CHECKBOX_TRUE_VALUES.has(normalized)) return true;
    if (CHECKBOX_FALSE_VALUES.has(normalized)) return false;
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const states = value
      .map((item) => parseCheckboxState(item))
      .filter((item): item is boolean => item !== null);
    if (states.includes(true)) return true;
    return states.length > 0 ? false : null;
  }
  return null;
};

const calculateMonthDiff = (
  maxTimestamp: number,
  minTimestamp: number,
): number => {
  const maxDate = new Date(maxTimestamp);
  const minDate = new Date(minTimestamp);

  let months =
    (maxDate.getUTCFullYear() - minDate.getUTCFullYear()) * 12 +
    (maxDate.getUTCMonth() - minDate.getUTCMonth());

  const isPartialMonth =
    maxDate.getUTCDate() < minDate.getUTCDate() ||
    (maxDate.getUTCDate() === minDate.getUTCDate() &&
      (maxDate.getUTCHours() < minDate.getUTCHours() ||
        (maxDate.getUTCHours() === minDate.getUTCHours() &&
          (maxDate.getUTCMinutes() < minDate.getUTCMinutes() ||
            (maxDate.getUTCMinutes() === minDate.getUTCMinutes() &&
              (maxDate.getUTCSeconds() < minDate.getUTCSeconds() ||
                (maxDate.getUTCSeconds() === minDate.getUTCSeconds() &&
                  maxDate.getUTCMilliseconds() <
                    minDate.getUTCMilliseconds())))))));

  if (isPartialMonth) {
    months -= 1;
  }
  return Math.max(0, months);
};

const formatPercentValue = (value: number): string => {
  const safeValue = Number.isFinite(value) ? value : 0;
  const truncated = Math.floor(safeValue * 100) / 100;
  return `${formatNumber(truncated, { maximumFractionDigits: 2 })}%`;
};

const isDataRecordRow = (row: Record<string, unknown>): boolean => {
  const rowType = row.__rowType;
  return !(typeof rowType === 'string' && rowType.length > 0);
};

const getDisplayDataRows = (
  rows: GridDisplayRows,
): Array<Record<string, unknown>> =>
  rows.filter((row) => isDataRecordRow(row as Record<string, unknown>)) as Array<
    Record<string, unknown>
  >;

interface GroupStatisticBucket {
  groupPath: string;
  rows: Array<Record<string, unknown>>;
}

const collectGroupStatisticBuckets = (
  rows: GridDisplayRows,
): GroupStatisticBucket[] => {
  const buckets: GroupStatisticBucket[] = [];
  const activeGroups: Array<GroupStatisticBucket & { level: number }> = [];

  rows.forEach((row) => {
    const rowData = row as Record<string, unknown>;
    const rowType = rowData.__rowType;

    if (rowType === GROUP_HEADER_ROW_TYPE) {
      const groupPath =
        typeof rowData.__groupPath === 'string' && rowData.__groupPath.length > 0
          ? rowData.__groupPath
          : null;
      if (!groupPath) return;

      const level =
        typeof rowData.__groupLevel === 'number' ? rowData.__groupLevel : 0;
      while (
        activeGroups.length > 0 &&
        activeGroups[activeGroups.length - 1].level >= level
      ) {
        activeGroups.pop();
      }

      const bucket = { groupPath, rows: [], level };
      buckets.push(bucket);
      activeGroups.push(bucket);
      return;
    }

    if (!isDataRecordRow(rowData)) return;

    activeGroups.forEach((bucket) => {
      bucket.rows.push(rowData);
    });
  });

  return buckets;
};

const formatDateDisplayValue = (column: ColumnDef, raw: unknown): string => {
  if (typeof column.valueFormatter === 'function') {
    try {
      const formatted = column.valueFormatter({
        value: raw,
        data: undefined,
      });
      if (formatted !== undefined && formatted !== null) {
        return String(formatted);
      }
    } catch { /* fall through */ }
  }

  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  return raw == null ? '' : String(raw);
};

const formatRemoteStatisticValue = (
  func: StatFunc,
  value: string | number | null,
  column: ColumnDef,
): string | number | null => {
  const nextValue: string | number | null = value;
  if (nextValue === null || nextValue === undefined) return null;

  switch (func) {
    case StatFunc.Count:
    case StatFunc.Empty:
    case StatFunc.Filled:
    case StatFunc.Unique:
    case StatFunc.Sum:
    case StatFunc.Checked:
    case StatFunc.Unchecked:
    case StatFunc.DateRangeOfDays:
    case StatFunc.DateRangeOfMonths:
      return typeof nextValue === 'number' ? formatNumber(nextValue) : nextValue;
    case StatFunc.Average:
    case StatFunc.Min:
    case StatFunc.Max:
      return typeof nextValue === 'number'
        ? formatNumber(nextValue, { maximumFractionDigits: 2 })
        : nextValue;
    case StatFunc.PercentEmpty:
    case StatFunc.PercentFilled:
    case StatFunc.PercentUnique:
    case StatFunc.PercentChecked:
    case StatFunc.PercentUnchecked:
      if (typeof nextValue === 'number') return formatPercentValue(nextValue);
      if (typeof nextValue === 'string') {
        const trimmed = nextValue.trim();
        if (trimmed.length > 0 && !trimmed.endsWith('%')) {
          const parsed = Number(trimmed);
          if (Number.isFinite(parsed)) return formatPercentValue(parsed);
        }
      }
      return nextValue;
    case StatFunc.EarliestDate:
    case StatFunc.LatestDate:
      return formatDateDisplayValue(column, nextValue);
    default:
      return nextValue;
  }
};

const computeLocalStatisticValue = (
  rows: Array<Record<string, unknown>>,
  column: ColumnDef,
  func: StatFunc,
): string | number | null => {
  const field = column.field;
  const totalRows = rows.length;
  const denominator = Math.max(totalRows, 1);
  let filledCount = 0;
  let checkedCount = 0;
  const uniqueValues = new Set<string>();
  let numericCount = 0;
  let numericSum = 0;
  let numericMin: number | null = null;
  let numericMax: number | null = null;
  let minDate: DateCandidate | null = null;
  let maxDate: DateCandidate | null = null;

  rows.forEach((row) => {
    const value = row[field];
    if (!isCellValueEmpty(value)) {
      filledCount += 1;
      uniqueValues.add(normalizeStatisticValueKey(value));
    }

    const numericValues: number[] = [];
    collectNumericValues(value, numericValues);
    numericValues.forEach((numericValue) => {
      numericCount += 1;
      numericSum += numericValue;
      numericMin =
        numericMin === null ? numericValue : Math.min(numericMin, numericValue);
      numericMax =
        numericMax === null ? numericValue : Math.max(numericMax, numericValue);
    });

    const dateCandidates: DateCandidate[] = [];
    collectDateCandidates(value, dateCandidates);
    dateCandidates.forEach((candidate) => {
      if (!minDate || candidate.timestamp < minDate.timestamp) {
        minDate = candidate;
      }
      if (!maxDate || candidate.timestamp > maxDate.timestamp) {
        maxDate = candidate;
      }
    });

    const checkboxState = parseCheckboxState(value);
    if (checkboxState === true) {
      checkedCount += 1;
    }
  });

  const emptyCount = totalRows - filledCount;
  const uncheckedCount = totalRows - checkedCount;
  const minDateCandidate = minDate as DateCandidate | null;
  const maxDateCandidate = maxDate as DateCandidate | null;

  switch (func) {
    case StatFunc.Count:
      return formatNumber(totalRows);
    case StatFunc.Empty:
      return formatNumber(emptyCount);
    case StatFunc.Filled:
      return formatNumber(filledCount);
    case StatFunc.Unique:
      return formatNumber(uniqueValues.size);
    case StatFunc.Sum:
      return formatNumber(numericCount > 0 ? numericSum : 0);
    case StatFunc.Average:
      return numericCount > 0
        ? formatNumber(numericSum / numericCount, { maximumFractionDigits: 2 })
        : null;
    case StatFunc.Min:
      return numericMin === null
        ? null
        : formatNumber(numericMin, { maximumFractionDigits: 2 });
    case StatFunc.Max:
      return numericMax === null
        ? null
        : formatNumber(numericMax, { maximumFractionDigits: 2 });
    case StatFunc.Checked:
      return formatNumber(checkedCount);
    case StatFunc.Unchecked:
      return formatNumber(uncheckedCount);
    case StatFunc.PercentEmpty:
      return formatPercentValue((emptyCount / denominator) * 100);
    case StatFunc.PercentFilled:
      return formatPercentValue((filledCount / denominator) * 100);
    case StatFunc.PercentUnique:
      return formatPercentValue((uniqueValues.size / denominator) * 100);
    case StatFunc.PercentChecked:
      return formatPercentValue((checkedCount / denominator) * 100);
    case StatFunc.PercentUnchecked:
      return formatPercentValue((uncheckedCount / denominator) * 100);
    case StatFunc.EarliestDate:
      return minDateCandidate
        ? formatDateDisplayValue(column, minDateCandidate.raw)
        : null;
    case StatFunc.LatestDate:
      return maxDateCandidate
        ? formatDateDisplayValue(column, maxDateCandidate.raw)
        : null;
    case StatFunc.DateRangeOfDays:
      return minDateCandidate && maxDateCandidate
        ? formatNumber(
            Math.max(
              0,
              Math.floor(
                (maxDateCandidate.timestamp - minDateCandidate.timestamp) /
                  (24 * 60 * 60 * 1000),
              ),
            ),
          )
        : formatNumber(0);
    case StatFunc.DateRangeOfMonths:
      return minDateCandidate && maxDateCandidate
        ? formatNumber(
            calculateMonthDiff(
              maxDateCandidate.timestamp,
              minDateCandidate.timestamp,
            ),
          )
        : formatNumber(0);
    default:
      return null;
  }
};

// ---------------------------------------------------------------------------
// Hook params & return
// ---------------------------------------------------------------------------

type GridDisplayRows = TableGridRendererProps['rows'];

interface ColumnDef {
  field: string;
  fieldId?: string;
  type?: string;
  originalFieldType?: string;
  valueFormatter?: (params: { value: unknown; data: unknown }) => unknown;
}

interface FieldRef {
  id: string;
  name: string;
}

export interface UseDataGridStatisticsParams {
  activeEngineId: string;
  columns: ColumnDef[];
  resolvedCurrentView: ViewMeta | null;
  fieldById: Map<string, FieldRef>;
  searchFilteredRowsForDisplay: GridDisplayRows;
  searchHideNotMatchRows: boolean;
  normalizedSearchQuery: string;
  selectedTableId: string | null;
  currentViewId: string | null;
  allowViewMutation: boolean;
  isPersonalViewEnabled: boolean;
  setPersonalViewDraft: (
    tableId: string,
    viewId: string,
    draft: any,
  ) => void;
  updateView: (viewId: string, data: any, options?: any) => Promise<any>;
  t: (key: string, options?: Record<string, unknown>) => string;
  /** 协作在线且 Y.Doc 投影完整时，列统计值从本地投影行计算，不走 REST */
  useCollabLocalStatistics?: boolean;
  /** 服务端按记录 UUID 返回的评论数；不得从业务字段名猜测。 */
  recordCommentCountMap?: Record<string, number>;
}

export interface UseDataGridStatisticsReturn {
  canvasColumnStatistics: TableGridColumnStatistics;
  canvasCommentCountMap: Record<string, number>;
  handleCanvasColumnStatisticAction: (
    fieldName: string,
    info: TableGridHeaderContextMenuInfo,
  ) => void;
  configuredColumnStatisticFuncs: Record<string, StatFunc>;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useDataGridStatistics({
  activeEngineId,
  columns,
  resolvedCurrentView,
  fieldById,
  searchFilteredRowsForDisplay,
  searchHideNotMatchRows,
  normalizedSearchQuery,
  selectedTableId,
  currentViewId,
  allowViewMutation,
  isPersonalViewEnabled,
  setPersonalViewDraft,
  updateView,
  t,
  useCollabLocalStatistics = false,
  recordCommentCountMap = {},
}: UseDataGridStatisticsParams): UseDataGridStatisticsReturn {
  const columnIndexByField = React.useMemo(() => {
    const map = new Map<string, number>();
    columns.forEach((column, index) => {
      map.set(column.field, index);
    });
    return map;
  }, [columns]);

  // ── Configured statistic funcs from view config ──
  const viewColumnStatisticFuncs = React.useMemo<Record<string, StatFunc>>(
    () => {
      const config = resolvedCurrentView?.config as
        | Record<string, unknown>
        | null
        | undefined;
      const rawMap = config?.[COLUMN_STATISTIC_FUNCS_CONFIG_KEY];
      if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
        return {};
      }

      const normalized: Record<string, StatFunc> = {};
      Object.entries(rawMap as Record<string, unknown>).forEach(
        ([key, rawValue]) => {
          const normalizedFunc = normalizeStatFunc(rawValue);
          if (!normalizedFunc || normalizedFunc === StatFunc.None) return;
          normalized[key] = normalizedFunc;
        },
      );

      return normalized;
    },
    [resolvedCurrentView?.config],
  );

  // 选函数后立即用本地 pending 驱动展示；等视图配置追上后再清掉。
  // pending 只属于触发操作时的表和视图，切换资源后不能覆盖新视图的已保存配置。
  const statisticScopeKey = `${selectedTableId ?? ''}:${
    resolvedCurrentView?.id ?? currentViewId ?? ''
  }`;
  const [pendingColumnStatisticState, setPendingColumnStatisticState] =
    React.useState<{
      scopeKey: string;
      funcs: Record<string, StatFunc>;
    } | null>(null);

  const pendingColumnStatisticFuncs =
    pendingColumnStatisticState?.scopeKey === statisticScopeKey
      ? pendingColumnStatisticState.funcs
      : null;

  React.useEffect(() => {
    if (!pendingColumnStatisticState) return;
    if (pendingColumnStatisticState.scopeKey !== statisticScopeKey) {
      setPendingColumnStatisticState(null);
      return;
    }
    const pendingColumnStatisticFuncs = pendingColumnStatisticState.funcs;
    const pendingKeys = Object.keys(pendingColumnStatisticFuncs);
    const viewKeys = Object.keys(viewColumnStatisticFuncs);
    if (pendingKeys.length !== viewKeys.length) return;
    const caughtUp = pendingKeys.every(
      (key) =>
        viewColumnStatisticFuncs[key] === pendingColumnStatisticFuncs[key],
    );
    if (caughtUp) {
      setPendingColumnStatisticState(null);
    }
  }, [pendingColumnStatisticState, statisticScopeKey, viewColumnStatisticFuncs]);

  const configuredColumnStatisticFuncs =
    pendingColumnStatisticFuncs ?? viewColumnStatisticFuncs;

  // ── Remote column statistics ──
  const [remoteColumnStatisticByField, setRemoteColumnStatisticByField] =
    React.useState<
      Record<string, { func: StatFunc; value: string | number | null }>
    >({});
  const columnStatisticsRequestIdRef = React.useRef(0);

  // ── Persist statistic func ──
  const persistColumnStatisticFunc = React.useCallback(
    async (fieldName: string, nextFunc: StatFunc | null) => {
      const columnIndex = columnIndexByField.get(fieldName);
      const column =
        columnIndex === undefined ? undefined : columns[columnIndex];
      if (!column || !resolvedCurrentView?.id) return;

      const columnConfigKey = column.fieldId ?? column.field;
      const previousFunc =
        configuredColumnStatisticFuncs[columnConfigKey] ??
        configuredColumnStatisticFuncs[column.field] ??
        null;
      const normalizedNextFunc =
        nextFunc && nextFunc !== StatFunc.None ? nextFunc : null;

      if (previousFunc === normalizedNextFunc) return;

      const nextFuncMap: Record<string, StatFunc> = {
        ...configuredColumnStatisticFuncs,
      };
      delete nextFuncMap[column.field];
      if (column.fieldId) {
        delete nextFuncMap[column.fieldId];
      }
      if (normalizedNextFunc) {
        nextFuncMap[columnConfigKey] = normalizedNextFunc;
      }

      if (!allowViewMutation) {
        toast({
          title: String(t('table:header.lockedEditDeniedTitle' as any)),
          description: String(t('table:header.lockedEditDeniedDesc' as any)),
          variant: 'destructive',
        });
        return;
      }

      // 先乐观更新展示，避免协作态 viewsMeta 回写前汇总格一直停在「汇总」
      setPendingColumnStatisticState({
        scopeKey: statisticScopeKey,
        funcs: nextFuncMap,
      });

      if (isPersonalViewEnabled) {
        if (selectedTableId) {
          setPersonalViewDraft(
            selectedTableId,
            resolvedCurrentView.id as string,
            {
              config: {
                [COLUMN_STATISTIC_FUNCS_CONFIG_KEY]: nextFuncMap,
              },
            },
          );
        }
        return;
      }

      try {
        // 只传 column_statistic_funcs 局部 patch；协作态由 applyViewUpdatePayload
        // 深合并进 Y.Doc，REST 态由 view_service / ViewStore 合并进既有 config。
        const updated = await updateView(
          resolvedCurrentView.id as string,
          {
            config: {
              [COLUMN_STATISTIC_FUNCS_CONFIG_KEY]: nextFuncMap,
            },
          },
          {
            silent: true,
            refreshRecords: false,
            optimisticConfig: {
              [COLUMN_STATISTIC_FUNCS_CONFIG_KEY]: nextFuncMap,
            },
          },
        );
        if (updated == null) {
          setPendingColumnStatisticState(null);
          toast({
            title: String(t('table:statistics.persistFailedTitle' as any)),
            description: String(t('table:statistics.persistFailedDesc' as any)),
            variant: 'destructive',
          });
        }
      } catch (error: unknown) {
        setPendingColumnStatisticState(null);
        console.error('[DataGridStatistics] 持久化列统计失败:', error);
        toast({
          title: String(t('table:statistics.persistFailedTitle' as any)),
          description:
            error instanceof Error
              ? error.message
              : String(t('table:statistics.persistFailedDesc' as any)),
          variant: 'destructive',
        });
      }
    },
    [
      columnIndexByField,
      columns,
      configuredColumnStatisticFuncs,
      allowViewMutation,
      isPersonalViewEnabled,
      resolvedCurrentView,
      selectedTableId,
      setPersonalViewDraft,
      statisticScopeKey,
      t,
      updateView,
    ],
  );

  const handleCanvasColumnStatisticAction = React.useCallback(
    (fieldName: string, info: TableGridHeaderContextMenuInfo) => {
      const nextFunc = normalizeStatFunc(info.api?.statisticFunc);
      if (!nextFunc) return;

      const columnIndex = columnIndexByField.get(fieldName);
      const column =
        columnIndex === undefined ? undefined : columns[columnIndex];
      if (!column) return;

      const fieldType = String(
        column.originalFieldType ?? column.type ?? 'text',
      ).toLowerCase();
      const validFuncs = getValidStatFuncs(fieldType);
      if (nextFunc !== StatFunc.None && !validFuncs.includes(nextFunc)) return;

      void persistColumnStatisticFunc(
        fieldName,
        nextFunc === StatFunc.None ? null : nextFunc,
      );
    },
    [columnIndexByField, columns, persistColumnStatisticFunc],
  );

  // ── Fetch remote statistics ──
  const shouldUseLocalSearchStatistics =
    searchHideNotMatchRows && normalizedSearchQuery.length > 0;
  const shouldSkipRemoteStatistics =
    useCollabLocalStatistics || shouldUseLocalSearchStatistics;

  React.useEffect(() => {
    if (activeEngineId !== CANVAS_TABLE_ENGINE.id) {
      setRemoteColumnStatisticByField({});
      return;
    }

    const viewId = resolvedCurrentView?.id;
    if (!viewId || shouldSkipRemoteStatistics) {
      setRemoteColumnStatisticByField({});
      return;
    }

    const requestFuncs: Record<string, string> = {};
    columns.forEach((column) => {
      const func =
        configuredColumnStatisticFuncs[column.fieldId ?? column.field] ??
        configuredColumnStatisticFuncs[column.field];
      if (!func || func === StatFunc.None) return;
      requestFuncs[column.fieldId ?? column.field] = func;
    });

    if (Object.keys(requestFuncs).length === 0) {
      setRemoteColumnStatisticByField({});
      return;
    }

    const viewFilterLogicRaw = (
      resolvedCurrentView?.config as Record<string, unknown> | undefined
    )?.filter_logic;
    const viewFilterLogic =
      typeof viewFilterLogicRaw === 'string'
        ? viewFilterLogicRaw.trim().toLowerCase()
        : undefined;
    const normalizedFilterLogic =
      viewFilterLogic === 'or' || viewFilterLogic === 'and'
        ? (viewFilterLogic as 'or' | 'and')
        : undefined;

    const requestId = ++columnStatisticsRequestIdRef.current;
    void ViewApiService.getViewColumnStatistics(viewId as string, {
      column_statistic_funcs: requestFuncs,
      filters: Array.isArray(resolvedCurrentView?.filters)
        ? (resolvedCurrentView!.filters as ViewFilter[])
        : undefined,
      filter_logic: normalizedFilterLogic,
    })
      .then((response) => {
        if (columnStatisticsRequestIdRef.current !== requestId) return;

        const nextMap: Record<
          string,
          { func: StatFunc; value: string | number | null }
        > = {};
        const statistics = Array.isArray(response.data?.column_statistics)
          ? response.data.column_statistics
          : [];

        statistics.forEach((item: any) => {
          const func = normalizeStatFunc(item?.agg_func);
          if (!func || func === StatFunc.None) return;

          const rawValue = item?.value;
          const normalizedValue =
            rawValue === null || rawValue === undefined
              ? null
              : typeof rawValue === 'string' || typeof rawValue === 'number'
                ? rawValue
                : String(rawValue);

          const fieldId =
            typeof item?.field_id === 'string' &&
            item.field_id.trim().length > 0
              ? item.field_id
              : null;
          const fieldNameFromPayload =
            typeof item?.field_name === 'string' &&
            item.field_name.trim().length > 0
              ? item.field_name
              : null;
          const fieldNameFromId = fieldId
            ? fieldById.get(fieldId)?.name
            : undefined;
          const fieldName = fieldNameFromPayload ?? fieldNameFromId ?? null;

          if (fieldId) {
            nextMap[fieldId] = { func, value: normalizedValue };
          }
          if (fieldName) {
            nextMap[fieldName] = { func, value: normalizedValue };
          }
        });

        setRemoteColumnStatisticByField(nextMap);
      })
      .catch((error: unknown) => {
        if (columnStatisticsRequestIdRef.current !== requestId) return;
        console.warn(
          '[DataGridAdapter] 获取后端列统计失败，已回退本地统计。',
          error,
        );
        setRemoteColumnStatisticByField({});
      });
  }, [
    activeEngineId,
    columns,
    configuredColumnStatisticFuncs,
    fieldById,
    normalizedSearchQuery.length,
    resolvedCurrentView?.config,
    resolvedCurrentView?.filters,
    resolvedCurrentView?.id,
    searchHideNotMatchRows,
    shouldSkipRemoteStatistics,
    shouldUseLocalSearchStatistics,
  ]);

  // ── Comment count map ──
  const canvasCommentCountMap = React.useMemo<Record<string, number>>(() => {
    if (activeEngineId !== CANVAS_TABLE_ENGINE.id) return {};

    const map: Record<string, number> = {};
    searchFilteredRowsForDisplay.forEach((row) => {
      const rowData = row as Record<string, unknown>;
      if (
        typeof rowData.__rowType === 'string' &&
        rowData.__rowType.length > 0
      )
        return;

      const recordId = resolveRecordId(rowData);
      const count = recordId ? recordCommentCountMap[recordId] ?? 0 : 0;
      if (count <= 0) return;
      if (recordId) map[recordId] = count;
    });
    return map;
  }, [activeEngineId, recordCommentCountMap, searchFilteredRowsForDisplay]);

  // ── Local column statistics computation ──
  const canvasColumnStatistics =
    React.useMemo<TableGridColumnStatistics>(() => {
      if (activeEngineId !== CANVAS_TABLE_ENGINE.id) return {};

      const dataRows = getDisplayDataRows(searchFilteredRowsForDisplay);
      const groupStatisticBuckets = collectGroupStatisticBuckets(
        searchFilteredRowsForDisplay,
      );
      const statistics: TableGridColumnStatistics = {};

      columns.forEach((column) => {
        const field = column.field;
        if (!field) return;

        const fieldType = String(
          column.originalFieldType ?? column.type ?? 'text',
        ).toLowerCase();
        const configuredFunc =
          configuredColumnStatisticFuncs[column.fieldId ?? field] ??
          configuredColumnStatisticFuncs[field];
        if (!configuredFunc || configuredFunc === StatFunc.None) return;
        if (!getValidStatFuncs(fieldType).includes(configuredFunc)) return;

        const remoteStatistic = shouldSkipRemoteStatistics
          ? undefined
          : (remoteColumnStatisticByField[column.fieldId ?? field] ??
              remoteColumnStatisticByField[field]);

        const statisticEntry: TableGridColumnStatistic = {
          func: configuredFunc,
          value:
            remoteStatistic && remoteStatistic.func === configuredFunc
              ? formatRemoteStatisticValue(
                  configuredFunc,
                  remoteStatistic.value,
                  column,
                )
              : computeLocalStatisticValue(dataRows, column, configuredFunc),
        };

        const groupValues: NonNullable<TableGridColumnStatistic['groupValues']> =
          Object.create(null);
        groupStatisticBuckets.forEach((bucket) => {
          if (bucket.rows.length === 0) return;
          groupValues[bucket.groupPath] = computeLocalStatisticValue(
            bucket.rows,
            column,
            configuredFunc,
          );
        });
        if (Object.keys(groupValues).length > 0) {
          statisticEntry.groupValues = groupValues;
        }

        statistics[field] = statisticEntry;
      });

      return statistics;
    }, [
      activeEngineId,
      columns,
      configuredColumnStatisticFuncs,
      remoteColumnStatisticByField,
      searchFilteredRowsForDisplay,
      shouldSkipRemoteStatistics,
    ]);

  return {
    canvasColumnStatistics,
    canvasCommentCountMap,
    handleCanvasColumnStatisticAction,
    configuredColumnStatisticFuncs,
  };
}
