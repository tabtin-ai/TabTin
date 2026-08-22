import type { ChangeEvent, ForwardRefRenderFunction, KeyboardEvent, RefObject } from 'react';
import {
  useState,
  useRef,
  useImperativeHandle,
  forwardRef,
  useMemo,
  useCallback,
  useLayoutEffect,
} from 'react';
import { Key } from 'ts-keycode-enum';
import { GRID_DEFAULT } from '../../configs';
import type { ILinkCell, INumberCell, ITextCell } from '../../renderers';
import { CellType } from '../../renderers';
import type { IEditorRef, IEditorProps } from './EditorContainer';
import { getMaxEditorHeight } from './editorHeight';

const { rowHeight: defaultRowHeight } = GRID_DEFAULT;

const EDITOR_HINT_RESERVED_SPACE = 18;

const TextEditorBase: ForwardRefRenderFunction<
  IEditorRef<ITextCell | INumberCell>,
  IEditorProps<ITextCell | INumberCell | ILinkCell>
> = (props, ref) => {
  const { cell, rect, style, theme, isEditing, editorShiftEnterHint, onChange } = props;
  const { cellLineColorActived } = theme;
  const { width, height } = rect;
  const { displayData, type } = cell;
  const needWrap = (cell as ITextCell)?.isWrap;
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [value, setValueInner] = useState(displayData);
  // The editor instance is reused across active cells; cell id is the stable reset boundary.
  const cellIdentity = (cell as { id?: unknown }).id ?? displayData;
  const previousCellIdentityRef = useRef(cellIdentity);

  const placeCaretAtEnd = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch {
      // Some input types may reject setSelectionRange; focus alone is enough.
    }
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
      placeCaretAtEnd();
    },
    setValue: (value: string | number | null | undefined) => {
      let next = '';
      if (Array.isArray(value)) {
        const first = (value as any)[0];
        next =
          typeof first === 'object' && first !== null
            ? String(first.title ?? first.id ?? '')
            : String(first ?? '');
      } else {
        next = String(value ?? '');
      }
      setValueInner(next);
      // After type-to-edit seed, caret must sit after the seeded char so the next
      // keystroke appends rather than inserting at index 0.
      requestAnimationFrame(() => {
        placeCaretAtEnd();
      });
    },
    saveValue,
  }));

  useLayoutEffect(() => {
    if (Object.is(previousCellIdentityRef.current, cellIdentity)) {
      return;
    }
    previousCellIdentityRef.current = cellIdentity;
    setValueInner(displayData);
  }, [cellIdentity, displayData]);

  const saveValue = () => {
    if (!isEditing) return;
    if (type === CellType.Number) {
      // Allow "12%" so percent cells can commit display-style input.
      // Compare against displayData with optional % stripped — editor data may be
      // percent points ("12") while displayData is "12%".
      const cleaned =
        typeof value === 'string' ? value.replace(/%\s*$/, '').trim() : String(value ?? '');
      const cleanedDisplay = String(displayData ?? '')
        .replace(/%\s*$/, '')
        .trim();
      if (cleaned === cleanedDisplay) return;
      if (
        cleaned !== '' &&
        cleanedDisplay !== '' &&
        Number(cleaned) === Number(cleanedDisplay)
      ) {
        return;
      }
      // Invalid input: pass the raw string through (same as email/url/phone Link
      // editors). Upper layer validateBeforeSave shows a stable toast — do not
      // keep an inline tip that disappears when editing exits.
      if (cleaned !== '' && isNaN(Number(cleaned))) {
        onChange?.(cleaned);
        return;
      }
      onChange?.(cleaned === '' ? null : Number(cleaned));
    } else if (value === displayData) {
      return;
    } else if (type === CellType.Link) {
      // email / url / phone 以 Link 单元格呈现但存纯字符串（真正的 link 关联字段是
      // readonly，通过弹窗编辑，不走此保存路径）。统一输出 trim 后的纯字符串，
      // 避免写回 [{id,title}] 对象数组导致渲染层出现 [object Object]。
      const trimmedValue = typeof value === 'string' ? value.trim() : String(value ?? '');
      onChange?.(trimmedValue ? trimmedValue : null);
    } else {
      onChange?.(typeof value === 'string' ? value.trim() : value);
    }
  };

  const onChangeInner = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setValueInner(e.target.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const { keyCode, shiftKey } = event;
    if (keyCode === Key.Enter && !shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
    }
    if (keyCode === Key.Enter && shiftKey) {
      event.stopPropagation();
    }
  };

  const maxEditorHeight = getMaxEditorHeight();

  useLayoutEffect(() => {
    if (!needWrap) return;
    const textarea = inputRef.current;
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    const maxHeight = getMaxEditorHeight();
    textarea.style.height = '0px';
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${Math.max(nextHeight, height + 4)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [height, needWrap, value, width]);

  const attachStyle = useMemo(() => {
    const s: React.CSSProperties = {
      width: width + 4,
      minHeight: height + 4,
      height: needWrap ? 'auto' : height + 4,
      marginLeft: -2,
      marginTop: -2,
      textAlign: type === CellType.Number ? 'right' : 'left',
    };
    if (!needWrap && height > defaultRowHeight) {
      s.paddingBottom = height - defaultRowHeight;
    }
    return s;
  }, [type, height, width, needWrap]);

  return (
    <>
      {needWrap ? (
        <div
          style={{
            ...style,
            ...attachStyle,
            maxHeight: maxEditorHeight,
            border: `2px solid ${cellLineColorActived}`,
          }}
          className="relative flex flex-col overflow-hidden rounded-md bg-background shadow-lg"
        >
          <textarea
            ref={inputRef as RefObject<HTMLTextAreaElement>}
            className="flex-1 resize-none overflow-y-auto border-none bg-background px-2 pt-1 text-body leading-[1.4rem] focus-visible:outline-none"
            style={{
              minHeight: height + 4,
              maxHeight: maxEditorHeight,
              paddingBottom: isEditing ? EDITOR_HINT_RESERVED_SPACE : undefined,
            }}
            value={value}
            rows={1}
            onBlur={saveValue}
            onKeyDown={onKeyDown}
            onChange={onChangeInner}
            onMouseDown={(e) => e.stopPropagation()}
          />
          {isEditing && (
            <div className="pointer-events-none absolute bottom-0 right-0 px-1 py-px text-right text-caption text-muted-foreground/60">
              {editorShiftEnterHint ?? 'Shift+Enter for new line'}
            </div>
          )}
        </div>
      ) : (
        <div className="relative">
          <input
            ref={inputRef as RefObject<HTMLInputElement>}
            type="text"
            style={{
              border: `2px solid ${cellLineColorActived}`,
              ...style,
              ...attachStyle,
            }}
            value={value}
            className="cursor-text rounded-md bg-background px-2 text-body shadow-none outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
            onChange={onChangeInner}
            onBlur={saveValue}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
};

export const TextEditor = forwardRef(TextEditorBase);
