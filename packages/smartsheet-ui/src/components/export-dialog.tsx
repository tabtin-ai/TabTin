/**
 * ExportDialog - 数据导出对话框
 *
 * 提供多格式数据导出功能：CSV、Excel、PDF
 * 支持自定义导出范围、字段选择、高级选项
 *
 * H1: 9 useState → useReducer 状态收敛
 * H2: 拆分 FormatSection / RangeSection / FieldsSection / AdvancedOptions
 * H3: 警告/错误 Banner 统一为 ExportBanner
 * H4: FieldsSection 字段虚拟化（>50 字段时启用）
 */

import * as React from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './sheet';
import { Button } from './button';
import { Label } from './label';
import { Input } from './input';
import { Checkbox } from './checkbox';
import { RadioGroup, RadioGroupItem } from './radio-group';
import { ScrollArea } from './scroll-area';
import {
  Download,
  FileText,
  FileSpreadsheet,
  FileType,
  Loader2,
} from 'lucide-react';
import { cn } from '../utils/cn';
import { t } from '../i18n';

// ── Types ─────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'excel' | 'json' | 'pdf';
export type ExportRange = 'all' | 'selected' | 'view';
export type JsonExportFormat = 'array' | 'structured' | 'table_full';

export interface Field {
  id: string;
  name: string;
}

export interface ExportConfig {
  format: ExportFormat;
  range: ExportRange;
  selectedFields: string[];
  includeHeaders: boolean;
  jsonFormat?: JsonExportFormat;
  sheetName?: string;
  orientation?: 'portrait' | 'landscape';
  title?: string;
}

export interface ExportStats {
  fieldCount: number;
  recordCount: number;
  estimatedSize: {
    csvKb: number;
    excelKb: number;
    jsonKb: number;
    pdfKb: number;
  };
}

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container?: HTMLElement | null;
  fields: Field[];
  selectedRecordCount: number;
  totalRecordCount: number;
  viewRecordCount?: number;
  hasActiveView?: boolean;
  defaultRange?: ExportRange;
  stats?: ExportStats;
  isLoadingStats?: boolean;
  onExport: (config: ExportConfig) => void | Promise<void>;
  onRangeChange?: (range: ExportRange) => void;
  isExporting?: boolean;
  error?: string | null;
  statsSampledHint?: string | null;
  onRetry?: () => void;
}

// ── Validation helpers ────────────────────────────────────────

const EXPORT_FORMATS: ReadonlySet<string> = new Set<ExportFormat>([
  'csv',
  'excel',
  'json',
  'pdf',
]);
const EXPORT_RANGES: ReadonlySet<string> = new Set<ExportRange>([
  'all',
  'selected',
  'view',
]);
const ORIENTATIONS: ReadonlySet<string> = new Set(['portrait', 'landscape']);

const asExportFormat = (v: string): ExportFormat =>
  EXPORT_FORMATS.has(v) ? (v as ExportFormat) : 'csv';
const asExportRange = (v: string): ExportRange =>
  EXPORT_RANGES.has(v) ? (v as ExportRange) : 'all';
const asOrientation = (v: string): 'portrait' | 'landscape' =>
  ORIENTATIONS.has(v) ? (v as 'portrait' | 'landscape') : 'landscape';

// ── H1: Reducer ───────────────────────────────────────────────

interface ExportDialogState {
  format: ExportFormat;
  range: ExportRange;
  selectAllFields: boolean;
  selectedFields: string[];
  includeHeaders: boolean;
  jsonFormat: JsonExportFormat;
  sheetName: string;
  orientation: 'portrait' | 'landscape';
  title: string;
}

type ExportDialogAction =
  | { type: 'RESET'; fields: Field[]; range: ExportRange }
  | { type: 'SYNC_FIELDS'; fields: Field[] }
  | { type: 'SET_FORMAT'; format: ExportFormat }
  | { type: 'SET_RANGE'; range: ExportRange }
  | { type: 'TOGGLE_FIELD'; fieldId: string; fieldCount: number }
  | { type: 'SET_ALL_FIELDS'; checked: boolean; fields: Field[] }
  | { type: 'SET_INCLUDE_HEADERS'; value: boolean }
  | { type: 'SET_JSON_FORMAT'; value: JsonExportFormat }
  | { type: 'SET_SHEET_NAME'; value: string }
  | { type: 'SET_ORIENTATION'; value: 'portrait' | 'landscape' }
  | { type: 'SET_TITLE'; value: string };

function createInitialState(
  fields: Field[],
  range: ExportRange = 'all',
): ExportDialogState {
  return {
    format: 'csv',
    range,
    selectAllFields: true,
    selectedFields: fields.map((f) => f.id),
    includeHeaders: true,
    jsonFormat: 'array',
    sheetName: t('exportDialog.defaultSheetName'),
    orientation: 'landscape',
    title: '',
  };
}

function exportDialogReducer(
  state: ExportDialogState,
  action: ExportDialogAction,
): ExportDialogState {
  switch (action.type) {
    case 'RESET':
      return createInitialState(action.fields, action.range);
    case 'SYNC_FIELDS': {
      const nextFieldIds = action.fields.map((f) => f.id);
      if (state.selectAllFields) {
        return { ...state, selectedFields: nextFieldIds };
      }
      const nextFieldIdSet = new Set(nextFieldIds);
      const nextSelectedFields = state.selectedFields.filter((fieldId) =>
        nextFieldIdSet.has(fieldId),
      );
      return {
        ...state,
        selectedFields: nextSelectedFields,
        selectAllFields: nextSelectedFields.length === nextFieldIds.length,
      };
    }
    case 'SET_FORMAT':
      return { ...state, format: action.format };
    case 'SET_RANGE':
      return { ...state, range: action.range };
    case 'TOGGLE_FIELD': {
      const next = state.selectedFields.includes(action.fieldId)
        ? state.selectedFields.filter((id) => id !== action.fieldId)
        : [...state.selectedFields, action.fieldId];
      return {
        ...state,
        selectedFields: next,
        selectAllFields: next.length === action.fieldCount,
      };
    }
    case 'SET_ALL_FIELDS': {
      const ids = action.checked ? action.fields.map((f) => f.id) : [];
      return { ...state, selectAllFields: action.checked, selectedFields: ids };
    }
    case 'SET_INCLUDE_HEADERS':
      return { ...state, includeHeaders: action.value };
    case 'SET_JSON_FORMAT':
      return { ...state, jsonFormat: action.value };
    case 'SET_SHEET_NAME':
      return {
        ...state,
        sheetName: action.value.replace(/[\\/*?:\[\]]/g, '_').slice(0, 31),
      };
    case 'SET_ORIENTATION':
      return { ...state, orientation: action.value };
    case 'SET_TITLE':
      return { ...state, title: action.value };
  }
}

export function resolveInitialExportRange(
  defaultRange: ExportRange | undefined,
  hasActiveView: boolean,
  selectedRecordCount: number,
): ExportRange {
  const range = defaultRange ?? 'all';
  if (isExportRangeAvailable(range, hasActiveView, selectedRecordCount)) {
    return range;
  }
  return hasActiveView ? 'view' : 'all';
}

function isExportRangeAvailable(
  range: ExportRange,
  hasActiveView: boolean,
  selectedRecordCount: number,
): boolean {
  if (range === 'view') {
    return hasActiveView;
  }
  if (range === 'selected') {
    return selectedRecordCount > 0;
  }
  return true;
}

export function supportsExportFieldSelection(
  format: ExportFormat,
  jsonFormat?: JsonExportFormat,
): boolean {
  return !(format === 'json' && jsonFormat === 'table_full');
}

// ── H3: Unified Banner ───────────────────────────────────────

type BannerVariant = 'error' | 'warning' | 'info';

const BANNER_STYLES: Record<BannerVariant, string> = {
  error: 'border-destructive/30 bg-destructive/5 text-destructive',
  warning:
    'border-warning bg-warning text-warning dark:border-warning dark:bg-warning/30 dark:text-warning',
  info: 'border-border/60 bg-muted/30 text-muted-foreground',
};

const ExportBanner: React.FC<{
  variant: BannerVariant;
  children: React.ReactNode;
}> = ({ variant, children }) => (
  <div className={cn('rounded-lg border p-3', BANNER_STYLES[variant])}>
    <div className="text-body">{children}</div>
  </div>
);

// ── H2: FormatSection ─────────────────────────────────────────

const FORMAT_OPTIONS = [
  {
    value: 'csv' as const,
    label: 'CSV',
    descKey: 'exportDialog.format.csv.description',
  },
  {
    value: 'excel' as const,
    label: 'Excel',
    descKey: 'exportDialog.format.excel.description',
  },
  {
    value: 'pdf' as const,
    label: 'PDF',
    descKey: 'exportDialog.format.pdf.description',
  },
] as const;

const FORMAT_ICONS: Record<ExportFormat, React.ReactNode> = {
  csv: <FileText className="h-4 w-4" />,
  excel: <FileSpreadsheet className="h-4 w-4" />,
  json: <FileText className="h-4 w-4" />,
  pdf: <FileType className="h-4 w-4" />,
};

interface FormatSectionProps {
  format: ExportFormat;
  onFormatChange: (v: ExportFormat) => void;
}

const FormatSection: React.FC<FormatSectionProps> = ({
  format,
  onFormatChange,
}) => (
  <div className="space-y-3">
    <Label className="text-body font-semibold">
      {t('exportDialog.formatSection')}
    </Label>
    <RadioGroup
      value={format}
      onValueChange={(v) => onFormatChange(asExportFormat(v))}
      className="grid grid-cols-2 gap-2"
    >
      {FORMAT_OPTIONS.map((fmt) => (
        <label
          key={fmt.value}
          htmlFor={fmt.value}
          className={cn(
            'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors',
            format === fmt.value
              ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
              : 'border-border hover:bg-muted/50',
          )}
        >
          <RadioGroupItem value={fmt.value} id={fmt.value} className="mt-0.5" />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              {FORMAT_ICONS[fmt.value]}
              <span className="text-body font-medium">{fmt.label}</span>
            </div>
            <p className="mt-0.5 text-body text-muted-foreground">
              {t(fmt.descKey)}
            </p>
          </div>
        </label>
      ))}
    </RadioGroup>
  </div>
);

// ── H2: RangeSection ──────────────────────────────────────────

interface RangeSectionProps {
  range: ExportRange;
  onRangeChange: (v: ExportRange) => void;
  totalRecordCount: number;
  selectedRecordCount: number;
  hasActiveView: boolean;
}

const RangeSection: React.FC<RangeSectionProps> = ({
  range,
  onRangeChange,
  totalRecordCount,
  selectedRecordCount,
  hasActiveView,
}) => (
  <div className="space-y-3">
    <Label className="text-body font-semibold">
      {t('exportDialog.rangeSection')}
    </Label>
    <RadioGroup
      value={range}
      onValueChange={(v) => onRangeChange(asExportRange(v))}
      className="space-y-2"
    >
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="all" id="range-all" />
        <Label htmlFor="range-all" className="cursor-pointer">
          {t('exportDialog.range.all', { count: totalRecordCount })}
        </Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem
          value="selected"
          id="range-selected"
          disabled={selectedRecordCount === 0}
        />
        <Label
          htmlFor="range-selected"
          className={
            selectedRecordCount === 0
              ? 'text-muted-foreground'
              : 'cursor-pointer'
          }
        >
          {t('exportDialog.range.selected', { count: selectedRecordCount })}
        </Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem
          value="view"
          id="range-view"
          disabled={!hasActiveView}
        />
        <Label
          htmlFor="range-view"
          className={
            !hasActiveView ? 'text-muted-foreground' : 'cursor-pointer'
          }
        >
          {t('exportDialog.range.view')}
          {!hasActiveView && (
            <span className="ml-1 text-body">
              ({t('exportDialog.range.noView')})
            </span>
          )}
        </Label>
      </div>
    </RadioGroup>
  </div>
);

// ── H2 + H4: FieldsSection with virtualization ───────────────

const FIELD_ROW_HEIGHT = 28;
const VIRTUALIZE_THRESHOLD = 50;
const FIELDS_VISIBLE_HEIGHT = 128;

interface FieldsSectionProps {
  fields: Field[];
  selectAllFields: boolean;
  selectedFields: string[];
  onToggleField: (fieldId: string) => void;
  onSelectAll: (checked: boolean | 'indeterminate') => void;
}

const FieldsSection: React.FC<FieldsSectionProps> = ({
  fields,
  selectAllFields,
  selectedFields,
  onToggleField,
  onSelectAll,
}) => {
  const useVirtual = fields.length > VIRTUALIZE_THRESHOLD;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);

  const handleScroll = React.useCallback(() => {
    if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop);
  }, []);

  const cols = 2;
  const rowCount = Math.ceil(fields.length / cols);
  const totalHeight = rowCount * FIELD_ROW_HEIGHT;

  const startRow = Math.max(0, Math.floor(scrollTop / FIELD_ROW_HEIGHT) - 2);
  const visibleRows = Math.ceil(FIELDS_VISIBLE_HEIGHT / FIELD_ROW_HEIGHT) + 4;
  const endRow = Math.min(rowCount, startRow + visibleRows);

  const visibleFields = useVirtual
    ? fields.slice(startRow * cols, endRow * cols)
    : fields;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-body font-semibold">
          {t('exportDialog.fieldsSection')}
        </Label>
        <div className="flex items-center space-x-2">
          <Checkbox
            id="select-all-fields"
            checked={selectAllFields}
            onCheckedChange={onSelectAll}
          />
          <Label
            htmlFor="select-all-fields"
            className="text-body cursor-pointer"
          >
            {t('exportDialog.fieldsSelectAll', { count: fields.length })}
          </Label>
        </div>
      </div>
      {useVirtual ? (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          role="list"
          aria-label={t('exportDialog.fieldsSection')}
          aria-roledescription={t('exportDialog.fieldsListDescription')}
          tabIndex={0}
          className="border rounded-lg p-3 overflow-y-auto"
          style={{ height: FIELDS_VISIBLE_HEIGHT }}
        >
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                top: startRow * FIELD_ROW_HEIGHT,
                left: 0,
                right: 0,
              }}
            >
              <div className="grid grid-cols-2 gap-x-2" style={{ rowGap: 0 }}>
                {visibleFields.map((field, idx) => (
                  <div
                    key={field.id}
                    role="listitem"
                    className="flex items-center space-x-2"
                    style={{ height: FIELD_ROW_HEIGHT }}
                    aria-setsize={fields.length}
                    aria-posinset={startRow * cols + idx + 1}
                  >
                    <Checkbox
                      id={`vf-${field.id}`}
                      checked={selectedFields.includes(field.id)}
                      onCheckedChange={() => onToggleField(field.id)}
                      aria-label={field.name}
                    />
                    <Label
                      htmlFor={`vf-${field.id}`}
                      className="text-body cursor-pointer truncate"
                    >
                      {field.name}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <ScrollArea
          className="h-32 border rounded-lg p-3"
          role="list"
          aria-label={t('exportDialog.fieldsSection')}
        >
          <div className="grid grid-cols-2 gap-2">
            {fields.map((field) => (
              <div
                key={field.id}
                role="listitem"
                className="flex items-center space-x-2"
              >
                <Checkbox
                  id={field.id}
                  checked={selectedFields.includes(field.id)}
                  onCheckedChange={() => onToggleField(field.id)}
                  aria-label={field.name}
                />
                <Label htmlFor={field.id} className="text-body cursor-pointer">
                  {field.name}
                </Label>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
};

// ── H2: AdvancedOptions ───────────────────────────────────────

interface AdvancedOptionsProps {
  state: ExportDialogState;
  dispatch: React.Dispatch<ExportDialogAction>;
}

const AdvancedOptions: React.FC<AdvancedOptionsProps> = ({
  state,
  dispatch,
}) => {
  const { format, includeHeaders, sheetName, orientation, title } = state;
  return (
    <div className="space-y-3">
      <Label className="text-body font-semibold">
        {t('exportDialog.advancedSection')}
      </Label>
      <div className="space-y-2">
        {(format === 'csv' || format === 'excel') && (
          <div className="flex items-center space-x-2">
            <Checkbox
              id="include-headers"
              checked={includeHeaders}
              onCheckedChange={(checked) =>
                dispatch({
                  type: 'SET_INCLUDE_HEADERS',
                  value: checked === true,
                })
              }
            />
            <Label htmlFor="include-headers" className="cursor-pointer">
              {t('exportDialog.includeHeaders')}
            </Label>
          </div>
        )}

        {format === 'excel' && (
          <div className="space-y-2">
            <Label htmlFor="sheet-name">
              {t('exportDialog.sheetNameLabel')}
            </Label>
            <Input
              id="sheet-name"
              value={sheetName}
              onChange={(e) =>
                dispatch({ type: 'SET_SHEET_NAME', value: e.target.value })
              }
              placeholder={t('exportDialog.sheetNamePlaceholder')}
            />
          </div>
        )}

        {format === 'pdf' && (
          <>
            <div className="space-y-2">
              <Label htmlFor="pdf-title">
                {t('exportDialog.pdfTitleLabel')}
              </Label>
              <Input
                id="pdf-title"
                value={title}
                onChange={(e) =>
                  dispatch({ type: 'SET_TITLE', value: e.target.value })
                }
                placeholder={t('exportDialog.pdfTitlePlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('exportDialog.orientationLabel')}</Label>
              <RadioGroup
                value={orientation}
                onValueChange={(v) =>
                  dispatch({ type: 'SET_ORIENTATION', value: asOrientation(v) })
                }
                className="flex gap-4"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="portrait" id="orient-portrait" />
                  <Label htmlFor="orient-portrait" className="cursor-pointer">
                    {t('exportDialog.orientationPortrait')}
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="landscape" id="orient-landscape" />
                  <Label htmlFor="orient-landscape" className="cursor-pointer">
                    {t('exportDialog.orientationLandscape')}
                  </Label>
                </div>
              </RadioGroup>
            </div>
          </>
        )}

      </div>
    </div>
  );
};

// ── Derived helpers ───────────────────────────────────────────

function getEstimatedSize(
  stats: ExportStats | undefined,
  format: ExportFormat,
): string | null {
  if (!stats) return null;
  const sizes = stats.estimatedSize;
  const formatSize = (kb: number) =>
    kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
  switch (format) {
    case 'csv':
      return formatSize(sizes.csvKb);
    case 'excel':
      return formatSize(sizes.excelKb);
    case 'json':
      return formatSize(sizes.jsonKb);
    case 'pdf':
      return formatSize(sizes.pdfKb);
  }
}

function getRecordCount(
  range: ExportRange,
  totalRecordCount: number,
  selectedRecordCount: number,
  viewRecordCount: number | undefined,
  statsRecordCount: number | undefined,
): number {
  switch (range) {
    case 'all':
      return totalRecordCount;
    case 'selected':
      return selectedRecordCount;
    case 'view':
      return viewRecordCount ?? statsRecordCount ?? totalRecordCount;
  }
}

// ── Main Component ────────────────────────────────────────────

export const ExportDialog: React.FC<ExportDialogProps> = ({
  open,
  onOpenChange,
  container,
  fields,
  selectedRecordCount,
  totalRecordCount,
  viewRecordCount,
  hasActiveView = false,
  defaultRange,
  stats,
  isLoadingStats = false,
  onExport,
  onRangeChange,
  isExporting = false,
  error,
  statsSampledHint,
  onRetry,
}) => {
  const initialRange = resolveInitialExportRange(
    defaultRange,
    hasActiveView,
    selectedRecordCount,
  );
  const [state, dispatch] = React.useReducer(
    exportDialogReducer,
    { fields, range: initialRange },
    (input) => createInitialState(input.fields, input.range),
  );
  const previousInitialRangeRef = React.useRef(initialRange);

  const prevOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (open && !prevOpenRef.current) {
      dispatch({ type: 'RESET', fields, range: initialRange });
    }
    prevOpenRef.current = open;
  }, [open, fields, initialRange]);

  React.useEffect(() => {
    if (!open) {
      previousInitialRangeRef.current = initialRange;
      return;
    }
    const previousInitialRange = previousInitialRangeRef.current;
    previousInitialRangeRef.current = initialRange;
    if (previousInitialRange === initialRange) return;
    if (state.range !== previousInitialRange) return;
    dispatch({ type: 'SET_RANGE', range: initialRange });
    onRangeChange?.(initialRange);
  }, [open, initialRange, state.range, onRangeChange]);

  React.useEffect(() => {
    if (!open) return;
    if (isExportRangeAvailable(state.range, hasActiveView, selectedRecordCount)) {
      return;
    }
    dispatch({ type: 'SET_RANGE', range: initialRange });
    onRangeChange?.(initialRange);
  }, [
    open,
    state.range,
    hasActiveView,
    selectedRecordCount,
    initialRange,
    onRangeChange,
  ]);

  React.useEffect(() => {
    if (!open) return;
    dispatch({ type: 'SYNC_FIELDS', fields });
  }, [open, fields]);

  const supportsFieldSelection = supportsExportFieldSelection(
    state.format,
    state.jsonFormat,
  );
  const handleExport = async () => {
    const config: ExportConfig = {
      format: state.format,
      range: state.range,
      selectedFields:
        supportsFieldSelection && !state.selectAllFields
          ? state.selectedFields
          : [],
      includeHeaders: state.includeHeaders,
      ...(state.format === 'json' && { jsonFormat: state.jsonFormat }),
      ...(state.format === 'excel' && { sheetName: state.sheetName }),
      ...(state.format === 'pdf' && {
        orientation: state.orientation,
        title: state.title || undefined,
      }),
    };
    try {
      await onExport(config);
    } catch (err) {
      console.error('[ExportDialog] onExport callback error:', err);
    }
  };

  const handleRangeChange = React.useCallback(
    (range: ExportRange) => {
      dispatch({ type: 'SET_RANGE', range });
      onRangeChange?.(range);
    },
    [onRangeChange],
  );

  const hasFieldsSelected =
    state.selectAllFields || state.selectedFields.length > 0;
  const canExport = supportsFieldSelection
    ? hasFieldsSelected && fields.length > 0
    : true;
  const exportRecordCount = getRecordCount(
    state.range,
    totalRecordCount,
    selectedRecordCount,
    viewRecordCount,
    stats?.recordCount,
  );
  const maxExportRows = state.format === 'pdf' ? 5000 : 100000;
  const isOverLimit = exportRecordCount > maxExportRows;
  const isLargeExport = exportRecordCount > 10000;
  const estimatedSize = getEstimatedSize(stats, state.format);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!isExporting) onOpenChange(v);
      }}
      modal={false}
    >
      <SheetContent
        side="right"
        overlay={false}
        container={container}
        className="pointer-events-auto w-[420px] sm:max-w-[420px] flex flex-col overflow-hidden p-0 data-[state=open]:!animate-none data-[state=closed]:!animate-none !transition-none"
        onEscapeKeyDown={(e) => {
          if (isExporting) e.preventDefault();
        }}
        onFocusOutside={(event) => event.preventDefault()}
      >
        <SheetHeader className="shrink-0 border-b border-border/40 px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-body">
            <Download className="h-5 w-5" />
            {t('exportDialog.title')}
          </SheetTitle>
          <SheetDescription className="text-body">
            {t('exportDialog.description')}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="space-y-6 px-4 py-4">
            <FormatSection
              format={state.format}
              onFormatChange={(f) =>
                dispatch({ type: 'SET_FORMAT', format: f })
              }
            />

            <RangeSection
              range={state.range}
              onRangeChange={handleRangeChange}
              totalRecordCount={totalRecordCount}
              selectedRecordCount={selectedRecordCount}
              hasActiveView={hasActiveView}
            />

            {supportsFieldSelection && (
              <FieldsSection
                fields={fields}
                selectAllFields={state.selectAllFields}
                selectedFields={state.selectedFields}
                onToggleField={(id) =>
                  dispatch({
                    type: 'TOGGLE_FIELD',
                    fieldId: id,
                    fieldCount: fields.length,
                  })
                }
                onSelectAll={(checked) =>
                  dispatch({
                    type: 'SET_ALL_FIELDS',
                    checked: checked === true,
                    fields,
                  })
                }
              />
            )}

            <AdvancedOptions state={state} dispatch={dispatch} />

            {isOverLimit && (
              <ExportBanner variant="error">
                {t('exportDialog.rowLimitWarning', {
                  count: exportRecordCount.toLocaleString(),
                  max: maxExportRows.toLocaleString(),
                  format:
                    state.format === 'pdf' ? 'PDF' : state.format.toUpperCase(),
                })}
              </ExportBanner>
            )}

            {isLargeExport && !isOverLimit && (
              <ExportBanner variant="warning">
                {t('exportDialog.largeExportWarning')}
              </ExportBanner>
            )}

            {error && (
              <ExportBanner variant="error">
                <span className="flex items-center justify-between gap-2">
                  <span>{error}</span>
                  {onRetry && (
                    <button
                      type="button"
                      className="shrink-0 text-body font-medium underline underline-offset-2 hover:no-underline"
                      onClick={onRetry}
                    >
                      {t('exportDialog.retry')}
                    </button>
                  )}
                </span>
              </ExportBanner>
            )}

            {(stats || isLoadingStats) && (
              <div className="rounded-lg bg-muted/30 p-3">
                {isLoadingStats ? (
                  <div className="flex items-center gap-2 text-body text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('exportDialog.loadingStats')}
                  </div>
                ) : (
                  <div className="flex items-center gap-4 text-body">
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground">
                        {t('exportDialog.summary.recordCount')}
                      </span>
                      <span className="font-medium">{exportRecordCount}</span>
                    </div>
                    {supportsFieldSelection && (
                      <>
                        <span className="text-border">|</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted-foreground">
                            {t('exportDialog.summary.fieldCount')}
                          </span>
                          <span className="font-medium">
                            {state.selectAllFields
                              ? fields.length
                              : state.selectedFields.length}
                          </span>
                        </div>
                      </>
                    )}
                    {estimatedSize && (
                      <>
                        <span className="text-border">|</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted-foreground">
                            {t('exportDialog.summary.estimatedSize')}
                          </span>
                          <span className="font-medium">{estimatedSize}</span>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {statsSampledHint && (
                  <p className="mt-1.5 text-body text-muted-foreground">
                    {statsSampledHint}
                  </p>
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        <SheetFooter className="shrink-0 border-t border-border/40 px-4 py-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isExporting}
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={handleExport} disabled={isExporting || !canExport}>
            {isExporting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('exportDialog.exporting')}
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                {t('exportDialog.exportFile')}
              </>
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
