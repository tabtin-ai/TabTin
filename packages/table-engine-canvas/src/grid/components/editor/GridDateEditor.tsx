import type { ForwardRefRenderFunction } from 'react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { DateFieldOptionsLike } from '@tabtin/smartsheet-ui';
import { GRID_CONTAINER_ATTR, GRID_DEFAULT } from '../../configs';
import type { IInnerCell } from '../../renderers';
import { useGridOverlayFloatingPosition } from '../../../overlays/useGridOverlayFloatingPosition';
import { stopOverlayPointerEvent } from '../../../overlays/overlayPointerEvents';
import type { IEditorProps, IEditorRef } from './EditorContainer';
import { DateEditorMain, type IDateEditorMainRef } from './DateEditorMain';
import {
  buildDateInputPlaceholder,
  convertZonedInputToUtc,
  formatDisplayValue,
  resolveDatetimeFormatting,
} from './dateUtils';

const { rowHeight: defaultRowHeight } = GRID_DEFAULT;

interface IGridDateEditorProps extends IEditorProps {
  value?: string | null;
  options?: DateFieldOptionsLike;
}

const normalizeValue = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  // Reject objects/arrays that would produce "[object Object]"
  return null;
};

const GridDateEditorBase: ForwardRefRenderFunction<IEditorRef, IGridDateEditorProps> = (
  props,
  ref
) => {
  const {
    value,
    options,
    rect,
    style,
    theme,
    isEditing,
    setEditing,
    onChange,
  } = props;
  const { width, height } = rect;
  const { cellLineColorActived } = theme;
  const inputRef = useRef<HTMLInputElement>(null);
  const calendarEditorRef = useRef<IDateEditorMainRef | null>(null);
  const gridContainerRef = useRef<HTMLElement | null>(null);
  const [gridContainer, setGridContainer] = useState<HTMLElement | null>(null);
  const [inputValue, setInputValue] = useState('');
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const [currentValue, setCurrentValue] = useState<string | null>(normalizeValue(value));

  const formatting = useMemo(
    () => resolveDatetimeFormatting(options),
    [options]
  );

  const resolvedDateOptions = useMemo<DateFieldOptionsLike>(
    () =>
      ({
        ...(options ?? {}),
        formatting,
      }) as DateFieldOptionsLike,
    [options, formatting]
  );

  useLayoutEffect(() => {
    const editorElement =
      typeof rect.editorId === 'string' && rect.editorId.length > 0
        ? document.getElementById(rect.editorId)
        : null;
    const next =
      (editorElement?.closest(`[${GRID_CONTAINER_ATTR}]`) as HTMLElement | null) ?? null;
    gridContainerRef.current = next;
    setGridContainer(next);
  }, [rect.editorId, rect.x, rect.y]);

  const anchor = useMemo(
    () => ({
      x: rect.x,
      y: rect.y,
      width,
      height: height + 2,
    }),
    [rect.x, rect.y, width, height]
  );

  const { setFloatingRef, floatingStyles } = useGridOverlayFloatingPosition({
    open: Boolean(isEditing) && Boolean(gridContainer),
    anchor,
    anchorRef: gridContainerRef,
    placement: 'bottom-start',
  });

  const inputAttachStyle = useMemo(() => {
    const nextStyle: React.CSSProperties = {
      width: width + 4,
      height: height + 4,
      marginLeft: -1.5,
      marginTop: -2,
    };
    if (height > defaultRowHeight) {
      nextStyle.paddingBottom = height - defaultRowHeight;
    }
    return nextStyle;
  }, [width, height]);

  useEffect(() => {
    const normalized = normalizeValue(value);
    setCurrentValue(normalized);
  }, [value]);

  useEffect(() => {
    const displayValue = formatDisplayValue(currentValue || '', formatting);
    setInputValue(displayValue);
  }, [currentValue, formatting]);

  const onCalendarChange = useCallback(
    (nextValue?: string | null) => {
      const normalized = nextValue ?? null;
      if (normalized === currentValue) return;
      setCurrentValue(normalized);
      onChange?.(normalized);
    },
    [currentValue, onChange]
  );

  const onRequestClose = useCallback(() => {
    setEditing?.(false);
  }, [setEditing]);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus?.(),
    setValue: (nextValue?: IInnerCell['data']) => {
      const normalized = normalizeValue(nextValue);
      setCurrentValue(normalized);
      setInputValue(formatDisplayValue(normalized || '', formatting));
      calendarEditorRef.current?.setValue(normalized);
    },
    saveValue: () => {
      if (!isEditing) return;
      const nextValue = convertZonedInputToUtc(inputValueRef.current, formatting);
      // 转换失败返回 null 时不调用 onChange，保持原值不被意外清空
      if (nextValue === null) return;
      onCalendarChange(nextValue);
    },
  }));

  const calendar =
    isEditing ? (
      <div
        ref={setFloatingRef}
        data-grid-overlay="date-editor"
        className="z-modal min-w-0"
        style={{
          ...floatingStyles,
          width: 'min(340px, calc(100vw - 16px))',
          maxWidth: 'calc(100vw - 16px)',
        }}
        onMouseDown={stopOverlayPointerEvent}
        onPointerDown={stopOverlayPointerEvent}
      >
        <DateEditorMain
          ref={calendarEditorRef}
          className="shadow-md"
          value={currentValue}
          options={resolvedDateOptions}
          onChange={onCalendarChange}
          onRequestClose={onRequestClose}
          portalContainer={null}
        />
      </div>
    ) : null;

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        placeholder={buildDateInputPlaceholder(formatting)}
        style={{
          ...style,
          ...inputAttachStyle,
          border: `2px solid ${cellLineColorActived}`,
        }}
        className="absolute left-0 top-0 h-8 w-full rounded-md bg-background px-2 text-body shadow-none outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        onChange={(event) => setInputValue(event.target.value)}
        onMouseDown={(event) => event.stopPropagation()}
      />
      {typeof document !== 'undefined' && calendar
        ? createPortal(calendar, document.body)
        : null}
    </>
  );
};

export const GridDateEditor = forwardRef(GridDateEditorBase);
