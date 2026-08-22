import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ForwardRefRenderFunction,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { useGridPopupPosition } from '../../hooks';
import type { ISelectCell } from '../../renderers';
import type { IEditorProps, IEditorRef } from './EditorContainer';
import { CheckIcon, PlusIcon } from './editorIcons';

interface SelectChoiceEntry {
  kind: 'choice';
  id?: string;
  name: string;
}

interface SelectCreateEntry {
  kind: 'create';
  name: string;
}

type SelectEditorEntry = SelectChoiceEntry | SelectCreateEntry;

const joinClassNames = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

const normalizeSelectValues = (items: ISelectCell['data']) =>
  items.map((item) => (typeof item === 'object' && item !== null ? item.title : item));

const SelectEditorBase: ForwardRefRenderFunction<
  IEditorRef<ISelectCell>,
  IEditorProps<ISelectCell>
> = (props, ref) => {
  const {
    cell,
    rect,
    isEditing,
    style,
    onChange,
    setEditing,
    theme,
    initialSearch,
    editorSelectSearchPlaceholder,
    editorSelectSearchPlaceholderEmpty,
    editorSelectNoResults,
    editorSelectEmptyHint,
    editorSelectAddOption,
    editorSelectDoneLabel,
  } = props;
  const { data, isMultiple, choiceSorted = [], choiceMap = {}, onOptionAdd } = cell;
  const popupStyle = useGridPopupPosition(rect, 280);
  const [values, setValues] = useState<ISelectCell['data']>(() =>
    Array.isArray(data) ? data : []
  );
  const [searchValue, setSearchValue] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [creatingOptionName, setCreatingOptionName] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const prevIsEditingRef = useRef(isEditing);
  const addingOptionRef = useRef(false);
  const createRequestIdRef = useRef(0);
  const { cellOptionBg, cellOptionTextColor } = theme;
  const hasConfiguredChoices = choiceSorted.length > 0;
  const searchPlaceholder = hasConfiguredChoices
    ? (editorSelectSearchPlaceholder ?? 'Find or create options')
    : (editorSelectSearchPlaceholderEmpty ??
      editorSelectSearchPlaceholder ??
      'Type to create an option');
  const emptyListHint = hasConfiguredChoices
    ? (editorSelectNoResults ?? 'No results')
    : (editorSelectEmptyHint ?? 'No options yet. Type to create one.');

  useEffect(() => {
    const wasEditing = prevIsEditingRef.current;
    prevIsEditingRef.current = isEditing;
    if (isEditing && !wasEditing) {
      setSearchValue(initialSearch ?? '');
      setValues(Array.isArray(data) ? data : []);
      setCreatingOptionName(null);
      setCreateError(null);
    } else if (!isEditing) {
      // Keep values in sync with data when not editing to prevent stale snapshots
      setValues(Array.isArray(data) ? data : []);
      createRequestIdRef.current += 1;
      setCreatingOptionName(null);
      setCreateError(null);
    }
  }, [data, initialSearch, isEditing]);

  useEffect(() => {
    if (!isEditing) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [isEditing]);

  const commitValues = useCallback(() => {
    if (!isMultiple) return;
    const normalized = normalizeSelectValues(values);
    const original = normalizeSelectValues(Array.isArray(data) ? data : []);
    if (
      normalized.length === original.length &&
      normalized.every((value, index) => value === original[index])
    ) {
      return;
    }
    onChange?.(normalized.length ? normalized : null);
  }, [data, isMultiple, onChange, values]);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    setValue: (nextValue: ISelectCell['data']) =>
      setValues(Array.isArray(nextValue) ? nextValue : nextValue != null ? [nextValue as string] : []),
    saveValue: commitValues,
  }));

  const filteredChoices = useMemo(() => {
    if (!searchValue) return choiceSorted;
    const lower = searchValue.toLowerCase();
    return choiceSorted.filter((choice) => choice.name.toLowerCase().includes(lower));
  }, [choiceSorted, searchValue]);

  const checkIsActive = useCallback(
    (name: string) =>
      values.some((item) => {
        if (typeof item === 'string') return item === name;
        return item.title === name;
      }),
    [values]
  );

  const trimmedSearchValue = searchValue.trim();
  const showAddOption =
    trimmedSearchValue.length > 0 &&
    !choiceSorted.some((choice) => choice.name === trimmedSearchValue);

  const visibleEntries = useMemo<SelectEditorEntry[]>(
    () => [
      ...filteredChoices.map((choice) => ({
        kind: 'choice' as const,
        id: choice.id,
        name: choice.name,
      })),
      ...(showAddOption ? [{ kind: 'create' as const, name: trimmedSearchValue }] : []),
    ],
    [filteredChoices, showAddOption, trimmedSearchValue]
  );

  useEffect(() => {
    if (!isEditing) return;
    setHighlightedIndex(visibleEntries.length > 0 ? 0 : -1);
  }, [isEditing, searchValue, visibleEntries.length]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [highlightedIndex]);

  const closeEditor = useCallback(() => {
    createRequestIdRef.current += 1;
    setEditing?.(false);
  }, [setEditing]);

  const selectValue = useCallback(
    (name: string) => {
      setSearchValue('');
      const existingIndex = values.findIndex((item) => {
        if (typeof item === 'string') return item === name;
        return item.title === name;
      });
      const nextValues =
        existingIndex > -1
          ? values.filter((_, index) => index !== existingIndex)
          : [...values, name];

      if (!isMultiple) {
        const nextValue = nextValues.length ? nextValues[nextValues.length - 1] : null;
        const stringValue =
          nextValue && typeof nextValue === 'object' ? nextValue.title : nextValue;
        setValues(stringValue ? [stringValue] : []);
        onChange?.(stringValue);
        closeEditor();
        return;
      }

      const normalized = normalizeSelectValues(nextValues);
      setValues(normalized.length ? normalized : []);
    },
    [closeEditor, isMultiple, onChange, values]
  );

  const addOption = useCallback(() => {
    if (!trimmedSearchValue || addingOptionRef.current) return;
    const optionName = trimmedSearchValue;

    addingOptionRef.current = true;
    const requestId = createRequestIdRef.current + 1;
    createRequestIdRef.current = requestId;
    setCreatingOptionName(optionName);
    setCreateError(null);
    void Promise.resolve(onOptionAdd?.(optionName))
      .then(() => {
        if (createRequestIdRef.current !== requestId) return;
        setSearchValue('');

        if (isMultiple) {
          setValues((current) => [...current, optionName]);
          return;
        }

        setValues([optionName]);
        onChange?.(optionName);
        closeEditor();
      })
      .catch((error) => {
        const message = error instanceof Error && error.message
          ? error.message
          : 'Create failed. Please try again.';
        setCreateError(message);
      })
      .finally(() => {
        addingOptionRef.current = false;
        setCreatingOptionName(null);
      });
  }, [closeEditor, isMultiple, onChange, onOptionAdd, trimmedSearchValue]);

  const activateEntry = useCallback(
    (entry: SelectEditorEntry | undefined) => {
      if (!entry) return;
      if (entry.kind === 'create') {
        addOption();
        return;
      }
      selectValue(entry.name);
    },
    [addOption, selectValue]
  );

  const commitAndClose = useCallback(() => {
    commitValues();
    closeEditor();
  }, [closeEditor, commitValues]);

  const onInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (visibleEntries.length === 0) return;
        setHighlightedIndex((current) =>
          current < 0 ? 0 : (current + 1) % visibleEntries.length
        );
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (visibleEntries.length === 0) return;
        setHighlightedIndex((current) =>
          current <= 0 ? visibleEntries.length - 1 : current - 1
        );
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closeEditor();
        return;
      }

      if (event.key !== 'Enter') return;

      event.preventDefault();
      event.stopPropagation();

      const activeEntry =
        highlightedIndex >= 0 ? visibleEntries[highlightedIndex] : undefined;
      if (activeEntry) {
        activateEntry(activeEntry);
        return;
      }

      if (showAddOption) {
        addOption();
        return;
      }

      if (isMultiple) {
        commitAndClose();
      }
    },
    [
      activateEntry,
      addOption,
      closeEditor,
      commitAndClose,
      highlightedIndex,
      isMultiple,
      showAddOption,
      visibleEntries,
    ]
  );

  const onItemMouseDown = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return (
    <div
      className="tt-grid-select-editor rounded-sm border border-border-high bg-popover p-2 shadow-sm"
      style={{ ...style, ...popupStyle }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        value={searchValue}
        placeholder={searchPlaceholder}
        className="h-8 w-full rounded-sm border bg-background px-3 text-body outline-none focus:border-ring focus-visible:outline-none"
        onChange={(event) => setSearchValue(event.target.value)}
        onKeyDown={onInputKeyDown}
      />

      <div
        role="listbox"
        className="mt-2 max-h-48 overflow-auto rounded-sm border border-border/60 bg-background py-1"
      >
        {visibleEntries.length === 0 ? (
          <div className="px-3 py-2 text-center text-body text-muted-foreground">
            {emptyListHint}
          </div>
        ) : (
          visibleEntries.map((entry, index) => {
            const isCreate = entry.kind === 'create';
            const isSelected = !isCreate && checkIsActive(entry.name);
            const isHighlighted = index === highlightedIndex;
            const isCreatingThisOption = isCreate && creatingOptionName === entry.name;
            const isCreateDisabled = isCreate && Boolean(creatingOptionName);
            const choice = !isCreate ? choiceMap?.[entry.id ?? entry.name] : undefined;
            const entryKey = isCreate
              ? `create-${entry.name}`
              : `${entry.kind}-${entry.id ?? entry.name}`;

            return (
              <button
                key={entryKey}
                ref={isHighlighted ? activeItemRef : null}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-busy={isCreatingThisOption || undefined}
                disabled={isCreateDisabled}
                className={joinClassNames(
                  'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-body outline-none transition-colors',
                  isCreateDisabled
                    ? 'cursor-not-allowed opacity-60'
                    : false,
                  // 行高亮用表格底色系（muted），避免品牌 accent 抢过胶囊本身
                  isHighlighted && !isCreateDisabled
                    ? 'bg-muted text-foreground'
                    : !isCreateDisabled
                      ? 'hover:bg-muted/80'
                      : false
                )}
                onMouseDown={onItemMouseDown}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => activateEntry(entry)}
              >
                {isCreate ? (
                  <span className="inline-flex items-center gap-2 truncate">
                    <PlusIcon className="size-4 shrink-0" />
                    <span className="truncate">
                      {isCreatingThisOption ? 'Creating' : (editorSelectAddOption ?? 'Create')} &quot;{entry.name}&quot;
                    </span>
                  </span>
                ) : (
                  <>
                    <span
                      className="truncate rounded-md px-2 py-0.5 text-body"
                      style={{
                        backgroundColor: choice?.backgroundColor ?? cellOptionBg,
                        color: choice?.color ?? cellOptionTextColor,
                      }}
                    >
                      {entry.name}
                    </span>
                    {isSelected ? <CheckIcon className="size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
                  </>
                )}
              </button>
            );
          })
        )}
      </div>

      {createError ? (
        <div role="alert" className="mt-2 px-1 text-caption text-destructive">
          {createError}
        </div>
      ) : null}

      {isEditing && isMultiple ? (
        <button
          type="button"
          className="mt-2 w-full rounded-sm border border-border px-3 py-1.5 text-center text-body text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          onMouseDown={onItemMouseDown}
          onClick={commitAndClose}
        >
          ✓ {editorSelectDoneLabel ?? 'Done'}
        </button>
      ) : null}
    </div>
  );
};

export const SelectEditor = forwardRef(SelectEditorBase);
