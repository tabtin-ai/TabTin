/* eslint-disable jsx-a11y/no-static-element-interactions */
import { clamp } from 'lodash';
import type { CSSProperties, ForwardRefRenderFunction } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useImperativeHandle,
  forwardRef,
  useState,
} from 'react';
import type { IGridTheme } from '../../configs';
import { GRID_FOCUS_TRAP_ATTR } from '../../configs';
import { useKeyboardSelection } from '../../hooks';
import { getRandomString } from '../../shims/gridCoreCompat';
import type { IInteractionLayerProps } from '../../InteractionLayer';
import {
  SelectionRegionType,
  type IActiveCellBound,
  type ICellItem,
  type IRectangle,
  type IScrollState,
} from '../../interface';
import type { CombinedSelection } from '../../managers';
import type { ICell, IInnerCell } from '../../renderers/cell-renderer/interface';
import { CellType } from '../../renderers/cell-renderer/interface';
import { isPrintableKey } from '../../utils';
import { TREE_INDENT_PER_LEVEL } from '../../renderers/layout-renderer/layoutRenderer';
import { BooleanEditor } from './BooleanEditor';
import {
  cellContentDigestForConflict,
  valueDigestForConflict,
} from './cellConflictDigest';
import { RatingEditor } from './RatingEditor';
import { TextEditor } from './TextEditor';

export interface IEditorContainerProps
  extends Pick<
    IInteractionLayerProps,
    | 'theme'
    | 'gridContainerRef'
    | 'coordInstance'
    | 'scrollToItem'
    | 'real2RowIndex'
    | 'getCellContent'
    | 'getRowTreeData'
    | 'onUndo'
    | 'onRedo'
    | 'onCopy'
    | 'onPaste'
    | 'onDelete'
    | 'onRowAppend'
    | 'onRowExpand'
    | 'onTreeToggle'
    | 'editorShiftEnterHint'
    | 'editorSelectSearchPlaceholder'
    | 'editorSelectSearchPlaceholderEmpty'
    | 'editorSelectNoResults'
    | 'editorSelectEmptyHint'
    | 'editorSelectAddOption'
    | 'editorSelectDoneLabel'
    | 'scrollBy'
  > {
  isEditing?: boolean;
  scrollState: IScrollState;
  activeCell: ICellItem | null;
  selection: CombinedSelection;
  activeCellBound: IActiveCellBound | null;
  setActiveCell: React.Dispatch<React.SetStateAction<ICellItem | null>>;
  setSelection: React.Dispatch<React.SetStateAction<CombinedSelection>>;
  setEditing: React.Dispatch<React.SetStateAction<boolean>>;
  onChange?: (cell: ICellItem, cellValue: IInnerCell) => void;
}

export interface IEditorRef<T extends IInnerCell = IInnerCell> {
  focus?: () => void;
  setValue?: (data: T['data']) => void;
  saveValue?: () => void;
}

export interface IEditorProps<T extends IInnerCell = IInnerCell> {
  cell: T;
  rect: IRectangle & { editorId: string };
  theme: IGridTheme;
  style?: CSSProperties;
  isEditing?: boolean;
  initialSearch?: string;
  editorShiftEnterHint?: string;
  editorSelectSearchPlaceholder?: string;
  editorSelectSearchPlaceholderEmpty?: string;
  editorSelectNoResults?: string;
  editorSelectEmptyHint?: string;
  editorSelectAddOption?: string;
  editorSelectDoneLabel?: string;
  setEditing?: React.Dispatch<React.SetStateAction<boolean>>;
  onChange?: (value: unknown) => void;
}

export interface IEditorContainerRef {
  focus?: () => void;
  saveValue?: () => void;
}

const NO_EDITING_CELL_TYPES = new Set([CellType.Boolean, CellType.Rating]);
const MAX_PENDING_LOCAL_DIGESTS = 128;

interface IPendingLocalDigest {
  cellKey: string;
  contentDigest: string;
  dataDigest: string;
}

/** Cells that accept type-to-edit overwrite (first printable key replaces cell value). */
const TEXT_LIKE_TYPE_TO_EDIT_CELL_TYPES = new Set([
  CellType.Text,
  CellType.Number,
  CellType.Link,
]);

interface IVisibleGridViewport {
  width: number;
  height: number;
}

/**
 * Mobile browsers can overlay the software keyboard without changing the
 * layout viewport (and therefore without resizing the Canvas container).
 * Clamp editors to the Visual Viewport so they stay attached to a visible
 * cell instead of being pushed behind the keyboard.
 */
export function resolveVisibleGridViewport(
  containerRect: Pick<DOMRect, 'top' | 'left'>,
  containerSize: IVisibleGridViewport,
  visualViewport?: Pick<VisualViewport, 'height' | 'width' | 'offsetTop' | 'offsetLeft'> | null
): IVisibleGridViewport {
  if (!visualViewport) return containerSize;

  const visualBottom = visualViewport.offsetTop + visualViewport.height;
  const visualRight = visualViewport.offsetLeft + visualViewport.width;
  return {
    width: Math.max(0, Math.min(containerSize.width, visualRight - containerRect.left)),
    height: Math.max(0, Math.min(containerSize.height, visualBottom - containerRect.top)),
  };
}

function createDeferredForwardRefEditor(
  load: () => Promise<{ default: React.ComponentType<any> }>,
  displayName: string
) {
  const DeferredEditor = forwardRef<any, any>((props, ref) => {
    const [Loaded, setLoaded] = useState<React.ComponentType<any> | null>(null);

    useEffect(() => {
      let active = true;
      void load().then((module) => {
        if (!active) return;
        setLoaded(() => module.default);
      });
      return () => {
        active = false;
      };
    }, []);

    if (!Loaded) return null;
    return <Loaded {...props} ref={ref} />;
  });

  DeferredEditor.displayName = displayName;
  return DeferredEditor;
}

const DeferredSelectEditor = createDeferredForwardRefEditor(
  () =>
    import('./SelectEditor').then((module) => ({
      default: module.SelectEditor as React.ComponentType<any>,
    })),
  'DeferredSelectEditor'
);

export const EditorContainerBase: ForwardRefRenderFunction<
  IEditorContainerRef,
  IEditorContainerProps
> = (props, ref) => {
  const {
    theme,
    isEditing,
    gridContainerRef,
    coordInstance,
    scrollState,
    activeCell,
    selection,
    activeCellBound,
    scrollToItem,
    onUndo,
    onRedo,
    onCopy,
    onPaste,
    onChange,
    onDelete,
    onRowExpand,
    onTreeToggle,
    getRowTreeData,
    setEditing,
    setActiveCell,
    setSelection,
    real2RowIndex,
    getCellContent,
    editorShiftEnterHint,
    editorSelectSearchPlaceholder,
    editorSelectSearchPlaceholderEmpty,
    editorSelectNoResults,
    editorSelectEmptyHint,
    editorSelectAddOption,
    editorSelectDoneLabel,
    scrollBy,
  } = props;
  const { scrollLeft, scrollTop } = scrollState;
  const { rowIndex, realRowIndex, columnIndex } = useMemo(() => {
    const [columnIndex, realRowIndex] = activeCell ?? [-1, -1];
    return {
      rowIndex: real2RowIndex(realRowIndex) ?? -1,
      realRowIndex,
      columnIndex,
    };
  }, [activeCell, real2RowIndex]);
  const cellContent = useMemo(() => {
    return getCellContent([columnIndex, realRowIndex]) as IInnerCell;
  }, [columnIndex, realRowIndex, getCellContent]);
  const conflictCellKey = useMemo(() => {
    const stableCellId = typeof cellContent.id === 'string' ? cellContent.id.trim() : '';
    return stableCellId || `${columnIndex}:${realRowIndex}`;
  }, [cellContent.id, columnIndex, realRowIndex]);
  const { type: cellType, readonly, editorWidth } = cellContent;
  const editingEnable = !readonly && isEditing && activeCell;
  const [visibleViewport, setVisibleViewport] = useState<IVisibleGridViewport | null>(null);
  useLayoutEffect(() => {
    if (!activeCell || typeof window === 'undefined') {
      setVisibleViewport(null);
      return;
    }

    let frameId = 0;
    const measure = () => {
      frameId = 0;
      const container = gridContainerRef.current;
      if (!container) return;
      const next = resolveVisibleGridViewport(
        container.getBoundingClientRect(),
        {
          width: coordInstance.containerWidth,
          height: coordInstance.containerHeight,
        },
        window.visualViewport
      );
      setVisibleViewport(current =>
        current?.width === next.width && current.height === next.height ? current : next
      );
    };
    const scheduleMeasure = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('resize', scheduleMeasure);
    window.visualViewport?.addEventListener('resize', scheduleMeasure);
    window.visualViewport?.addEventListener('scroll', scheduleMeasure);
    return () => {
      window.removeEventListener('resize', scheduleMeasure);
      window.visualViewport?.removeEventListener('resize', scheduleMeasure);
      window.visualViewport?.removeEventListener('scroll', scheduleMeasure);
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, [activeCell, coordInstance, gridContainerRef]);

  const visibleContainerWidth = visibleViewport?.width ?? coordInstance.containerWidth;
  const visibleContainerHeight = visibleViewport?.height ?? coordInstance.containerHeight;
  const requestedWidth = editorWidth ?? coordInstance.getColumnWidth(columnIndex);
  const width = Math.min(
    requestedWidth,
    Math.max(0, visibleContainerWidth - coordInstance.columnInitSize - 8)
  );
  const height = activeCellBound?.height ?? coordInstance.getRowHeight(rowIndex);
  const editorRef = useRef<IEditorRef | null>(null);
  const defaultFocusRef = useRef<HTMLInputElement | null>(null);
  const isEditingRef = useRef(isEditing);
  isEditingRef.current = isEditing;
  const editorId = useMemo(() => `editor-container-${getRandomString(8)}`, []);
  const initialSearchRef = useRef<string>('');
  const [hasExternalUpdate, setHasExternalUpdate] = useState(false);
  const conflictBaselineDigestRef = useRef<string | null>(null);
  const conflictBaselineCellKeyRef = useRef<string | null>(null);
  const pendingLocalDigestsRef = useRef<IPendingLocalDigest[]>([]);

  const focusKeyboardTarget = useCallback(() => {
    // Text/Select 等编辑器在「仅选中、未编辑」时仍挂载；此时若 focus 编辑器控件，
    // 宿主 shouldDeferTableUndoToNativeEditor 会把 Cmd/Ctrl+Z 当成原生撤销而放行失败
    //（刷子填充后的典型路径）。非编辑态必须落到 data-grid-focus-trap。
    if (isEditingRef.current) {
      editorRef.current?.focus?.();
      return;
    }
    defaultFocusRef.current?.focus?.();
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => focusKeyboardTarget(),
    saveValue: () => editorRef.current?.saveValue?.(),
  }), [focusKeyboardTarget]);

  useEffect(() => {
    if ((cellContent as ICell).type === CellType.Loading) return;
    if (!activeCell) {
      conflictBaselineDigestRef.current = null;
      conflictBaselineCellKeyRef.current = null;
      pendingLocalDigestsRef.current = [];
      setHasExternalUpdate(false);
      return;
    }

    const cellKey = conflictCellKey;
    const digest = cellContentDigestForConflict(cellContent);

    // 非编辑：同步展示值并清除冲突状态（TEC-008）
    if (!isEditing) {
      conflictBaselineDigestRef.current = null;
      conflictBaselineCellKeyRef.current = null;
      pendingLocalDigestsRef.current = [];
      setHasExternalUpdate(false);

      // Select editors manage their own data sync via their edit-lifecycle effect;
      // skip the displayData conversion that is designed for TextEditor fallback.
      if (cellType === CellType.Select) return;
      // Cells with structured data (Link, User, Image) have data as object
      // arrays that String() would turn into "[object Object]". When these cells
      // don't have a customEditor and fall through to TextEditor, use displayData.
      let valueForEditor = cellContent.data;
      if (!cellContent.customEditor) {
        const d = cellContent.data;
        if (Array.isArray(d) || (d != null && typeof d === 'object' && typeof d !== 'string')) {
          valueForEditor = (cellContent as { displayData?: string }).displayData ?? '';
        }
      }
      editorRef.current?.setValue?.(valueForEditor);
      return;
    }

    if (conflictBaselineCellKeyRef.current !== cellKey) {
      conflictBaselineCellKeyRef.current = cellKey;
      conflictBaselineDigestRef.current = digest;
      pendingLocalDigestsRef.current = [];
      setHasExternalUpdate(false);
      return;
    }

    const dataDigest = valueDigestForConflict(cellContent.data, cellType);
    const pendingMatchIndex = pendingLocalDigestsRef.current.findIndex(
      pendingLocalDigest =>
        pendingLocalDigest.cellKey === cellKey &&
        (pendingLocalDigest.contentDigest === digest ||
          pendingLocalDigest.dataDigest === dataDigest)
    );
    if (pendingMatchIndex >= 0) {
      conflictBaselineDigestRef.current = digest;
      pendingLocalDigestsRef.current = pendingLocalDigestsRef.current.slice(
        pendingMatchIndex + 1
      );
      return;
    }

    if (conflictBaselineDigestRef.current !== null && digest !== conflictBaselineDigestRef.current) {
      setHasExternalUpdate(true);
    }
  }, [cellContent, cellType, activeCell, isEditing, conflictCellKey]);

  useEffect(() => {
    if ((cellType as CellType) === CellType.Loading) return;
    if (!activeCell || selection.type === SelectionRegionType.None) return;

    initialSearchRef.current = '';

    const FOCUS_TIMEOUT_MS = 100;
    const rafId = requestAnimationFrame(() => focusKeyboardTarget());
    const timeoutId = setTimeout(() => {
      focusKeyboardTarget();
    }, FOCUS_TIMEOUT_MS);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timeoutId);
    };
  }, [cellType, activeCell, selection, isEditing, focusKeyboardTarget]);

  useKeyboardSelection({
    editorRef,
    gridContainerRef,
    isEditing,
    activeCell,
    selection,
    coordInstance,
    onUndo,
    onRedo,
    onDelete,
    onRowExpand,
    onTreeToggle,
    getRowTreeData,
    setEditing,
    setActiveCell,
    setSelection,
    scrollToItem,
    scrollBy,
  });

  const hasActiveCell = !!activeCell;
  const editorStyle = useMemo(
    () => {
      // Boolean/Rating cells don't enter editing mode but still need visible UI when active
      const showForInlineEdit = !readonly && hasActiveCell && NO_EDITING_CELL_TYPES.has(cellType);
      return (editingEnable || showForInlineEdit
        ? { pointerEvents: 'auto', minWidth: width, minHeight: height }
        : { pointerEvents: 'none', opacity: 0, width: 0, height: 0 }) as React.CSSProperties;
    },
    [editingEnable, readonly, hasActiveCell, cellType, height, width]
  );

  const rect = useMemo(() => {
    const { rowInitSize, columnInitSize } = coordInstance;

    if (columnIndex < 0 || rowIndex < 0) {
      return { x: columnInitSize, y: rowInitSize, width, height, editorId };
    }

    const xMax = Math.max(columnInitSize, visibleContainerWidth - width);
    const yMax = Math.max(rowInitSize, visibleContainerHeight - height);

    const treeIndent =
      columnIndex === 0
        ? (() => {
            const treeData = getRowTreeData?.(rowIndex);
            return typeof treeData?.treeDepth === 'number'
              ? (treeData.treeDepth + 1) * TREE_INDENT_PER_LEVEL
              : 0;
          })()
        : 0;

    const rawX = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft) + treeIndent;
    const x = clamp(rawX, columnInitSize, xMax);
    const y = clamp(
      coordInstance.getRowOffset(rowIndex) - scrollTop,
      rowInitSize,
      yMax
    );

    return {
      x,
      y,
      width: width - treeIndent,
      height,
      editorId,
    };
  }, [coordInstance, rowIndex, columnIndex, width, height, scrollLeft, scrollTop, editorId, getRowTreeData, visibleContainerWidth, visibleContainerHeight]);

  const onChangeInner = useMemo(() => {
    return (value: unknown) => {
      const nextDigest: IPendingLocalDigest = {
        cellKey: conflictCellKey,
        contentDigest: cellContentDigestForConflict({
          ...cellContent,
          data: value,
        } as IInnerCell),
        dataDigest: valueDigestForConflict(value, cellType),
      };
      const pendingDigests = pendingLocalDigestsRef.current;
      const lastDigest = pendingDigests[pendingDigests.length - 1];
      if (
        lastDigest?.cellKey !== nextDigest.cellKey ||
        lastDigest.contentDigest !== nextDigest.contentDigest ||
        lastDigest.dataDigest !== nextDigest.dataDigest
      ) {
        pendingLocalDigestsRef.current = [...pendingDigests, nextDigest].slice(
          -MAX_PENDING_LOCAL_DIGESTS
        );
      }
      onChange?.([columnIndex, realRowIndex], {
        ...cellContent,
        data: value,
      } as IInnerCell);
    };
  }, [onChange, columnIndex, realRowIndex, cellContent, conflictCellKey, cellType]);

  const selectEditorLabels = useMemo(() => ({
    editorSelectSearchPlaceholder,
    editorSelectSearchPlaceholderEmpty,
    editorSelectNoResults,
    editorSelectEmptyHint,
    editorSelectAddOption,
    editorSelectDoneLabel,
  }), [
    editorSelectSearchPlaceholder,
    editorSelectSearchPlaceholderEmpty,
    editorSelectNoResults,
    editorSelectEmptyHint,
    editorSelectAddOption,
    editorSelectDoneLabel,
  ]);

  const EditorRenderer = useMemo(() => {
    if (readonly) return null;

    const { customEditor } = cellContent;

    if (customEditor) {
      return customEditor(
        {
          rect,
          theme,
          style: editorStyle,
          cell: cellContent as IInnerCell,
          isEditing,
          setEditing,
          onChange: onChangeInner,
          initialSearch: initialSearchRef.current,
        },
        editorRef
      );
    }

    switch (cellType) {
      case CellType.Text:
      case CellType.Link:
      case CellType.Number: {
        return (
          <TextEditor
            ref={editorRef}
            rect={rect}
            theme={theme}
            style={editorStyle}
            cell={cellContent}
            isEditing={isEditing}
            editorShiftEnterHint={editorShiftEnterHint}
            onChange={onChangeInner}
          />
        );
      }
      case CellType.Boolean:
        return (
          <BooleanEditor
            ref={editorRef}
            rect={rect}
            theme={theme}
            style={editorStyle}
            cell={cellContent}
            onChange={onChangeInner}
          />
        );
      case CellType.Rating:
        return (
          <RatingEditor
            ref={editorRef}
            rect={rect}
            theme={theme}
            style={editorStyle}
            cell={cellContent}
            onChange={onChangeInner}
          />
        );
      case CellType.Select:
        return (
          <DeferredSelectEditor
            ref={editorRef}
            rect={rect}
            theme={theme}
            cell={cellContent}
            style={editorStyle}
            isEditing={isEditing}
            initialSearch={initialSearchRef.current}
            editorSelectSearchPlaceholder={selectEditorLabels.editorSelectSearchPlaceholder}
            editorSelectSearchPlaceholderEmpty={selectEditorLabels.editorSelectSearchPlaceholderEmpty}
            editorSelectNoResults={selectEditorLabels.editorSelectNoResults}
            editorSelectEmptyHint={selectEditorLabels.editorSelectEmptyHint}
            editorSelectAddOption={selectEditorLabels.editorSelectAddOption}
            editorSelectDoneLabel={selectEditorLabels.editorSelectDoneLabel}
            setEditing={setEditing}
            onChange={onChangeInner}
          />
        );
      default:
        return null;
    }
  }, [
    rect, theme, readonly, cellType, cellContent,
    editorStyle, isEditing, editorShiftEnterHint,
    selectEditorLabels, onChangeInner, setEditing,
  ]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!activeCell || isEditing || readonly) return;
    if (!isPrintableKey(event.nativeEvent)) return;
    if (NO_EDITING_CELL_TYPES.has(cellType)) return;

    const key = event.key;
    const isSingleChar = Boolean(key && key.length === 1);
    const isIme =
      event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;

    // Select: type-to-search (keep choice values; seed search box only).
    if (cellType === CellType.Select) {
      if (!isSingleChar) return;
      initialSearchRef.current = key;
      setEditing(true);
      if (!isIme) {
        event.preventDefault();
      }
      return;
    }

    // Text / Number / Link (+ text-like custom editors such as long_text / date):
    // overwrite mode — first printable char becomes the new value seed.
    if (!TEXT_LIKE_TYPE_TO_EDIT_CELL_TYPES.has(cellType)) return;

    const seed = !isIme && isSingleChar ? key : '';
    initialSearchRef.current = '';
    setEditing(true);
    editorRef.current?.setValue?.(seed);
    editorRef.current?.focus?.();

    // Seed already applied; block the key from also inserting into a newly focused input.
    // IME composition must not be cancelled — leave the empty editor focused for composition.
    if (!isIme && isSingleChar) {
      event.preventDefault();
    }
  };

  const onPasteInner = (e: React.ClipboardEvent) => {
    if (!activeCell || isEditing) return;
    onPaste?.(selection, e);
  };

  const onCopyInner = (e: React.ClipboardEvent) => {
    if (isEditing || selection.type === SelectionRegionType.None) return;
    onCopy?.(selection, e);
  };

  return (
    <div
      id={editorId}
      className="click-outside-ignore pointer-events-none absolute left-0 top-0 w-full"
    >
      <div
        data-grid-overlay="cell-editor"
        data-grid-editing={isEditing ? 'true' : 'false'}
        className={`${isEditing ? 'pointer-events-auto' : 'pointer-events-none'} absolute z-sticky`}
        style={{
          top: rect.y,
          left: rect.x,
          minWidth: width,
          minHeight: height,
        }}
        onKeyDown={onKeyDown}
        onPaste={onPasteInner}
        onCopy={onCopyInner}
      >
        {EditorRenderer}
        {isEditing && hasExternalUpdate && (
          <div
            data-grid-conflict-warning
            role="alert"
            className="pointer-events-auto mt-0.5 flex items-center gap-2 rounded-interactive bg-warning px-3 py-2 text-body font-medium text-warning-foreground shadow-sm"
            style={{ minWidth: width }}
          >
            <span aria-hidden="true" className="shrink-0">
              ⚠
            </span>
            <span>
              其他协作者已更新此单元格。保存当前内容会覆盖对方的修改。
            </span>
          </div>
        )}
        <input
          {...{ [GRID_FOCUS_TRAP_ATTR]: '' }}
          className="size-0 opacity-0 outline-none focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
          ref={defaultFocusRef}
          readOnly
          tabIndex={-1}
          aria-hidden
        />
      </div>
    </div>
  );
};

export const EditorContainer = forwardRef(EditorContainerBase);
