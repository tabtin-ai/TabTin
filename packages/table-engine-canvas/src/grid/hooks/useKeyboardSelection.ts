import { useEffect, useRef } from 'react';
import { useHotkeys, isHotkeyPressed } from 'react-hotkeys-hook';
import type { IEditorContainerProps, IEditorRef } from '../components';
import { SelectionRegionType } from '../interface';
import type { IRange } from '../interface';
import {
  estimatePageRowDelta,
  isEventOutsideContainer,
  resolveArrowDirectionFromEvent,
  resolveCellNavigationMove,
  resolvePageNavigationRow,
} from '../utils/keyboardNavigation';

export { isEventOutsideContainer } from '../utils/keyboardNavigation';

interface ISelectionKeyboardProps
  extends Omit<
    IEditorContainerProps,
    | 'theme'
    | 'onChange'
    | 'scrollState'
    | 'activeCellBound'
    | 'real2RowIndex'
    | 'getCellContent'
    | 'onCellActivated'
  > {
  editorRef: React.MutableRefObject<IEditorRef | null>;
}

export const useKeyboardSelection = (props: ISelectionKeyboardProps) => {
  const mountedRef = useRef(true);

  const {
    isEditing,
    activeCell,
    gridContainerRef,
    coordInstance,
    selection,
    scrollToItem,
    setEditing,
    setActiveCell,
    setSelection,
    onUndo,
    onRedo,
    onDelete,
    onRowExpand,
    onTreeToggle,
    getRowTreeData,
    editorRef,
  } = props;
  const { pureRowCount, columnCount } = coordInstance;

  // 把全局 document 级热键限定在「本」grid 实例内（gridContainerRef 指向本实例的 [data-t-grid-container]）
  const isEventOutsideGrid = (event: KeyboardEvent): boolean =>
    isEventOutsideContainer(event, gridContainerRef?.current ?? null);

  // 未接线 onUndo/onRedo 时不要注册：否则 preventDefault 会吞掉 Cmd/Ctrl+Z，
  // 而宿主 document 级 useUndoRedo 才是表撤销 SSoT（见 docs/agent/tabdata-undo-redo-convergence.md）。
  useHotkeys(
    'mod+z',
    () => {
      onUndo?.();
    },
    {
      enabled:
        Boolean(onUndo) && !isEditing && selection.type !== SelectionRegionType.None,
      preventDefault: true,
      enableOnFormTags: ['input', 'select', 'textarea'],
      ignoreEventWhen: isEventOutsideGrid,
    }
  );

  useHotkeys(
    ['mod+shift+z', 'mod+y'],
    () => {
      onRedo?.();
    },
    {
      enabled:
        Boolean(onRedo) && !isEditing && selection.type !== SelectionRegionType.None,
      preventDefault: true,
      enableOnFormTags: ['input', 'select', 'textarea'],
      ignoreEventWhen: isEventOutsideGrid,
    }
  );

  useHotkeys(
    [
      'up',
      'down',
      'left',
      'right',
      'mod+up',
      'mod+down',
      'mod+left',
      'mod+right',
      'shift+up',
      'shift+down',
      'shift+left',
      'shift+right',
      'mod+shift+up',
      'mod+shift+down',
      'mod+shift+left',
      'mod+shift+right',
    ],
    (keyboardEvent, hotkeysEvent) => {
      const { shift, mod } = hotkeysEvent;
      const isMod = Boolean(mod);
      const isSelectionExpand = Boolean(shift);
      const rangeIndex = isSelectionExpand ? 1 : 0;
      const targetRange = selection.ranges[rangeIndex] ?? selection.ranges[0];
      if (!targetRange) return;

      const direction = resolveArrowDirectionFromEvent(keyboardEvent, hotkeysEvent);
      if (!direction) return;

      let [columnIndex, rowIndex] = targetRange;

      // 树形首列：左右键折叠/展开优先于列迁移
      if (!isMod && !isSelectionExpand && columnIndex === 0 && getRowTreeData) {
        const td = getRowTreeData(rowIndex);
        if (direction === 'left' && td?.treeHasChildren && td.treeExpanded) {
          onTreeToggle?.(rowIndex);
          return;
        }
        if (direction === 'right' && td?.treeHasChildren && !td.treeExpanded) {
          onTreeToggle?.(rowIndex);
          return;
        }
      }

      const next = resolveCellNavigationMove({
        columnIndex,
        rowIndex,
        direction,
        columnCount,
        pureRowCount,
        isMod,
      });
      columnIndex = next.columnIndex;
      rowIndex = next.rowIndex;

      const newRange = <IRange>[columnIndex, rowIndex];
      const ranges = isSelectionExpand ? [selection.ranges[0], newRange] : [newRange, newRange];

      scrollToItem([columnIndex, rowIndex]);
      !isSelectionExpand && setActiveCell(newRange);
      setSelection(selection.setRanges(ranges));
    },
    {
      enabled: Boolean(activeCell && !isEditing),
      preventDefault: true,
      enableOnFormTags: ['input', 'select', 'textarea'],
      ignoreEventWhen: isEventOutsideGrid,
    }
  );

  useHotkeys(
    ['tab', 'shift+tab'],
    () => {
      const [columnIndex, rowIndex] = selection.ranges[0];

      let newColumnIndex = Math.min(columnIndex + 1, columnCount - 1);
      if (isHotkeyPressed('shift') && isHotkeyPressed('tab'))
        newColumnIndex = Math.max(columnIndex - 1, 0);

      const newRange = <IRange>[newColumnIndex, rowIndex];
      const ranges = [newRange, newRange];

      editorRef.current?.saveValue?.();
      scrollToItem([newColumnIndex, rowIndex]);
      setEditing(false);
      setActiveCell(newRange);
      setSelection(selection.setRanges(ranges));
    },
    {
      enabled: Boolean(activeCell),
      enableOnFormTags: ['input', 'select', 'textarea'],
      ignoreEventWhen: isEventOutsideGrid,
    }
  );

  useHotkeys(
    [
      'home',
      'end',
      'mod+home',
      'mod+end',
      'shift+home',
      'shift+end',
      'mod+shift+home',
      'mod+shift+end',
    ],
    (keyboardEvent, hotkeysEvent) => {
      const { shift, mod } = hotkeysEvent;
      const isMod = Boolean(mod);
      const isSelectionExpand = Boolean(shift);
      const hkRangeIndex = isSelectionExpand ? 1 : 0;
      const hkTargetRange = selection.ranges[hkRangeIndex] ?? selection.ranges[0];
      if (!hkTargetRange) return;
      let [columnIndex, rowIndex] = hkTargetRange;

      const isHome = keyboardEvent.key === 'Home' || isHotkeyPressed('home');
      const isEnd = keyboardEvent.key === 'End' || isHotkeyPressed('end');
      if (isHome) {
        columnIndex = 0;
        if (isMod) rowIndex = 0;
      } else if (isEnd) {
        columnIndex = columnCount - 1;
        if (isMod) rowIndex = pureRowCount - 1;
      }

      const newRange = <IRange>[columnIndex, rowIndex];
      const ranges = isSelectionExpand ? [selection.ranges[0], newRange] : [newRange, newRange];

      scrollToItem([columnIndex, rowIndex]);
      if (!isSelectionExpand) setActiveCell(newRange);
      setSelection(selection.setRanges(ranges));
    },
    {
      enabled: Boolean(activeCell && !isEditing),
      preventDefault: true,
      enableOnFormTags: ['input', 'select', 'textarea'],
      ignoreEventWhen: isEventOutsideGrid,
    }
  );

  useHotkeys(
    ['PageUp', 'PageDown'],
    (keyboardEvent) => {
      const targetRange = selection.ranges[0];
      if (!targetRange) return;

      const [columnIndex, rowIndex] = targetRange;
      const direction =
        keyboardEvent.key === 'PageUp' || isHotkeyPressed('pageup') ? 'up' : 'down';
      const pageRowDelta = estimatePageRowDelta({
        containerHeight: coordInstance.containerHeight,
        rowInitSize: coordInstance.rowInitSize,
        rowHeight: coordInstance.rowHeight,
      });
      const nextRowIndex = resolvePageNavigationRow({
        rowIndex,
        direction,
        pureRowCount,
        pageRowDelta,
      });

      const newRange = <IRange>[columnIndex, nextRowIndex];
      const ranges = [newRange, newRange];

      scrollToItem([columnIndex, nextRowIndex]);
      setActiveCell(newRange);
      setSelection(selection.setRanges(ranges));
    },
    {
      enabled: Boolean(activeCell && !isEditing),
      preventDefault: true,
      enableOnFormTags: ['input', 'select', 'textarea'],
      ignoreEventWhen: isEventOutsideGrid,
    }
  );
  useHotkeys(
    'mod+a',
    () => {
      const ranges = [
        [0, 0],
        [columnCount - 1, pureRowCount - 1],
      ] as IRange[];
      setSelection(selection.setRanges(ranges));
    },
    {
      enabled: Boolean(activeCell && !isEditing),
      enableOnFormTags: ['input', 'select', 'textarea'],
      ignoreEventWhen: isEventOutsideGrid,
    }
  );

  useHotkeys(
    ['delete', 'backspace', 'f2'],
    () => {
      if (isHotkeyPressed('f2')) {
        return setEditing(true);
      }
      if (isHotkeyPressed('backspace') || isHotkeyPressed('delete')) {
        return onDelete?.(selection);
      }
    },
    {
      enabled: Boolean(activeCell && !isEditing),
      preventDefault: Boolean(onDelete),
      enableOnFormTags: ['input', 'select', 'textarea'],
      ignoreEventWhen: isEventOutsideGrid,
    }
  );

  useHotkeys(
    ['enter', 'shift+enter'],
    (keyboardEvent) => {
      if (keyboardEvent.isComposing) return;

      const isShift = keyboardEvent.shiftKey;
      const { isColumnSelection, ranges: selectionRanges } = selection;
      if (isEditing) {
        let range = selectionRanges[0];
        if (isColumnSelection) {
          range = [range[0], 0];
        }
        const [columnIndex, rowIndex] = range;
        const nextRowIndex = isShift
          ? Math.max(rowIndex - 1, 0)
          : Math.min(rowIndex + 1, pureRowCount - 1);
        const newRange = [columnIndex, nextRowIndex] as IRange;
        editorRef.current?.saveValue?.();
        // Use queueMicrotask to avoid stale closure from setTimeout;
        // guard against unmounted component state updates
        const pendingSelection = selection.set(SelectionRegionType.Cells, [newRange, newRange]);
        queueMicrotask(() => {
          if (!mountedRef.current) return;
          setSelection(pendingSelection);
          setActiveCell(newRange);
          setEditing(false);
          scrollToItem(newRange as IRange);
        });
      } else {
        setEditing(true);
      }
    },
    {
      enabled: Boolean(activeCell),
      enableOnFormTags: ['input', 'select', 'textarea'],
      ignoreEventWhen: isEventOutsideGrid,
    }
  );

  useHotkeys(
    'esc',
    () => {
      setEditing(false);
    },
    {
      enabled: Boolean(activeCell),
      enableOnFormTags: ['input', 'select', 'textarea'],
      ignoreEventWhen: isEventOutsideGrid,
    }
  );

  useHotkeys(
    'space',
    (keyboardEvent) => {
      // 中文等 IME 输入法下空格用于选字，不触发行展开
      if (keyboardEvent.isComposing) return;
      // enabled 依赖 React 状态更新，存在批量渲染竞态窗口，需二次防护
      if (isEditing) return;
      const [, rowIndex] = activeCell!;
      onRowExpand?.(rowIndex);
    },
    {
      enabled: Boolean(activeCell && !isEditing),
      // 焦点在输入框/文本框时不响应空格，避免编辑中误触发行展开
      enableOnFormTags: false,
      ignoreEventWhen: isEventOutsideGrid,
    }
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
};
