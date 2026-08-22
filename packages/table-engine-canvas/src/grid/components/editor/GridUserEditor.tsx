import type { ForwardRefRenderFunction, KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { UserInitialsAvatar, type UserOption } from '@tabtin/smartsheet-ui';
import { useGridPopupPosition } from '../../hooks';
import type { IEditorProps, IEditorRef } from './EditorContainer';
import { CheckIcon } from './editorIcons';

interface IGridUserEditorProps extends IEditorProps {
  /** Organization 成员候选（与记录表单 UserSelector 同源） */
  users: UserOption[];
  /** 是否多选（field.options.multiple） */
  multiple?: boolean;
  /** 进入编辑态时的初始选中值（user id 或 id 数组） */
  initialValue: string | string[] | null;
}

const normalizeToIds = (value: string | string[] | null): string[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * 表格内联 user 字段编辑器：对齐 SelectEditor 的内联面板模式——直接渲染
 * 搜索框 + 成员列表，用 useGridPopupPosition 相对单元格定位（不再嵌 Popover，
 * 避免下拉漂移离单元格太远）。
 * 单选：点选即提交并关闭；多选：勾选累加、Done 提交；Escape 关闭；上下键移动。
 */
const GridUserEditorBase: ForwardRefRenderFunction<IEditorRef, IGridUserEditorProps> = (
  props,
  ref
) => {
  const { users, multiple, initialValue, rect, style, isEditing, setEditing, onChange } = props;
  const popupStyle = useGridPopupPosition(rect, 280);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => normalizeToIds(initialValue));
  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const prevIsEditingRef = useRef(isEditing);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    setValue: (next) => setSelectedIds(normalizeToIds((next ?? null) as string | string[] | null)),
    saveValue: () => {},
  }));

  // 同一个编辑器实例会在不同单元格间复用（getCellContent 复用同位置组件），
  // 因此进入编辑态 / 切换单元格时必须用 initialValue 重置选中态，避免串值。
  useEffect(() => {
    const wasEditing = prevIsEditingRef.current;
    prevIsEditingRef.current = isEditing;
    if (isEditing && !wasEditing) {
      setSelectedIds(normalizeToIds(initialValue));
      setSearch('');
    } else if (!isEditing) {
      setSelectedIds(normalizeToIds(initialValue));
    }
  }, [isEditing, initialValue]);

  useEffect(() => {
    if (!isEditing) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [isEditing]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        (u.email ? u.email.toLowerCase().includes(q) : false)
    );
  }, [users, search]);

  useEffect(() => {
    setHighlightedIndex(filteredUsers.length > 0 ? 0 : -1);
  }, [filteredUsers.length, search]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [highlightedIndex]);

  const closeEditor = useCallback(() => setEditing?.(false), [setEditing]);

  const emitChange = useCallback(
    (ids: string[]) => {
      if (multiple) {
        onChange?.(ids.length ? ids : null);
      } else {
        onChange?.(ids[0] ?? null);
      }
    },
    [multiple, onChange]
  );

  const toggleUser = useCallback(
    (userId: string) => {
      if (!multiple) {
        const next = selectedIds[0] === userId ? [] : [userId];
        setSelectedIds(next);
        emitChange(next);
        closeEditor();
        return;
      }
      const next = selectedIds.includes(userId)
        ? selectedIds.filter((id) => id !== userId)
        : [...selectedIds, userId];
      setSelectedIds(next);
      emitChange(next);
    },
    [closeEditor, emitChange, multiple, selectedIds]
  );

  const onInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (filteredUsers.length === 0) return;
        setHighlightedIndex((current) => (current < 0 ? 0 : (current + 1) % filteredUsers.length));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (filteredUsers.length === 0) return;
        setHighlightedIndex((current) =>
          current <= 0 ? filteredUsers.length - 1 : current - 1
        );
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeEditor();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const target = highlightedIndex >= 0 ? filteredUsers[highlightedIndex] : undefined;
        if (target) {
          toggleUser(target.id);
        } else if (multiple) {
          closeEditor();
        }
      }
    },
    [closeEditor, filteredUsers, highlightedIndex, multiple, toggleUser]
  );

  return (
    <div
      className="tt-grid-user-editor rounded-sm border border-border-high bg-popover p-2 shadow-sm"
      style={{ ...style, ...popupStyle }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        value={search}
        placeholder="搜索成员"
        className="h-8 w-full rounded-sm border bg-background px-3 text-body outline-none focus:border-ring focus-visible:outline-none"
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={onInputKeyDown}
      />

      <div
        role="listbox"
        className="mt-2 max-h-48 overflow-auto rounded-sm border border-border/60 bg-background py-1"
      >
        {filteredUsers.length === 0 ? (
          <div className="px-3 py-2 text-center text-body text-muted-foreground">无匹配成员</div>
        ) : (
          filteredUsers.map((user, index) => {
            const isSelected = selectedIds.includes(user.id);
            const isHighlighted = index === highlightedIndex;
            return (
              <button
                key={user.id}
                ref={isHighlighted ? activeItemRef : null}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={[
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-body outline-none transition-colors',
                  isHighlighted
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/60 hover:text-accent-foreground',
                ].join(' ')}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => toggleUser(user.id)}
              >
                <UserInitialsAvatar user={user} size="md" />
                <div className="flex min-w-0 flex-1 flex-col items-start">
                  <span className="truncate font-medium">{user.name}</span>
                  {user.email ? (
                    <span className="truncate text-caption text-muted-foreground">{user.email}</span>
                  ) : null}
                </div>
                {isSelected ? <CheckIcon className="size-4 shrink-0 text-primary" /> : null}
              </button>
            );
          })
        )}
      </div>

      {multiple ? (
        <button
          type="button"
          className="mt-2 w-full rounded-sm border border-border px-3 py-1.5 text-center text-body text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={closeEditor}
        >
          ✓ 完成
        </button>
      ) : null}
    </div>
  );
};

export const GridUserEditor = forwardRef(GridUserEditorBase);
