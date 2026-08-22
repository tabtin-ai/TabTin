import * as React from 'react';
import { X, Check, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { Input } from '../input';
import { ScrollArea } from '../scroll-area';
import { UserAvatar } from '../common/user-avatar';
import { cn } from '../../utils/cn';
import { t } from '../../i18n';

export interface UserOption {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
}

export interface UserSelectorProps {
  value: string | string[] | null;
  onChange: (value: string | string[] | null) => void;
  users: UserOption[];
  multiple?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** 初始即展开下拉（用于表格内联编辑：进入编辑态直接打开选择面板） */
  defaultOpen?: boolean;
  /** 下拉关闭时的回调（表格内联编辑用来退出编辑态） */
  onOpenChange?: (open: boolean) => void;
  /** 触发器样式覆盖，供表单、筛选栏等不同密度场景复用 */
  className?: string;
}

export const UserInitialsAvatar: React.FC<{
  user: UserOption;
  size?: 'sm' | 'md';
}> = ({ user, size = 'sm' }) => {
  return (
    <UserAvatar
      name={user.name}
      seed={user.id}
      avatarUrl={user.avatarUrl}
      size={size === 'sm' ? 20 : 24}
    />
  );
};

const normalizeToIds = (value: string | string[] | null): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
};

export const UserSelector: React.FC<UserSelectorProps> = ({
  value,
  onChange,
  users,
  multiple = false,
  disabled = false,
  placeholder,
  defaultOpen = false,
  onOpenChange,
  className,
}) => {
  const [open, setOpen] = React.useState(defaultOpen);
  const [search, setSearch] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const activeOptionRef = React.useRef<HTMLButtonElement | null>(null);
  const listboxId = React.useId();

  const selectedIds = React.useMemo(() => normalizeToIds(value), [value]);

  const selectedUsers = React.useMemo(
    () => users.filter((u) => selectedIds.includes(u.id)),
    [users, selectedIds],
  );

  const filteredUsers = React.useMemo(() => {
    if (!search.trim()) return users;
    const q = search.toLowerCase();
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        (u.email && u.email.toLowerCase().includes(q)),
    );
  }, [users, search]);

  React.useEffect(() => {
    setActiveIndex(open && filteredUsers.length > 0 ? 0 : -1);
  }, [filteredUsers, open]);

  React.useEffect(() => {
    activeOptionRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, filteredUsers]);

  const toggleUser = (userId: string) => {
    if (multiple) {
      const next = selectedIds.includes(userId)
        ? selectedIds.filter((id) => id !== userId)
        : [...selectedIds, userId];
      onChange(next.length > 0 ? next : null);
    } else {
      if (selectedIds.includes(userId)) {
        onChange(null);
      } else {
        onChange(userId);
      }
      setOpen(false);
    }
  };

  const removeUser = (userId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    if (multiple) {
      const next = selectedIds.filter((id) => id !== userId);
      onChange(next.length > 0 ? next : null);
    } else {
      onChange(null);
    }
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (filteredUsers.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex((current) =>
        current < 0 ? 0 : (current + 1) % filteredUsers.length,
      );
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex((current) =>
        current < 0
          ? filteredUsers.length - 1
          : (current - 1 + filteredUsers.length) % filteredUsers.length,
      );
      return;
    }

    if (event.key === 'Enter' && activeIndex >= 0) {
      const activeUser = filteredUsers[activeIndex];
      if (!activeUser) return;
      event.preventDefault();
      event.stopPropagation();
      toggleUser(activeUser.id);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={
        disabled
          ? undefined
          : (openState) => {
              setOpen(openState);
              if (!openState) setSearch('');
              onOpenChange?.(openState);
            }
      }
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex min-h-[36px] w-full flex-wrap items-center gap-1 rounded-md border border-transparent bg-muted px-3 py-1.5 text-body',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
            disabled && 'cursor-not-allowed opacity-50',
            !disabled && 'cursor-pointer hover:border-ring/50',
            className,
          )}
        >
          {selectedUsers.length > 0 ? (
            selectedUsers.map((user) => (
              <span
                key={user.id}
                className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-body font-medium text-secondary-foreground"
              >
                <UserInitialsAvatar user={user} size="sm" />
                <span className="max-w-[100px] truncate">{user.name}</span>
                {!disabled && (
                  <span
                    aria-hidden="true"
                    className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
                    onClick={(e) => removeUser(user.id, e)}
                  >
                    <X className="h-3 w-3" />
                  </span>
                )}
              </span>
            ))
          ) : (
            <span className="text-muted-foreground">
              {placeholder || t('userSelector.placeholder')}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t('userSelector.search')}
            className="h-7 border-0 p-0 shadow-none focus-visible:ring-0"
            role="combobox"
            aria-label={t('userSelector.search')}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={
              activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
            }
          />
        </div>
        <ScrollArea className="max-h-[220px]">
          <div
            id={listboxId}
            role="listbox"
            aria-multiselectable={multiple || undefined}
            className="p-1"
          >
            {filteredUsers.length > 0 ? (
              filteredUsers.map((user, index) => {
                const isSelected = selectedIds.includes(user.id);
                const isActive = activeIndex === index;
                return (
                  <button
                    key={user.id}
                    id={`${listboxId}-option-${index}`}
                    ref={isActive ? activeOptionRef : undefined}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-body',
                      'hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.08]',
                      isSelected && 'bg-accent/15',
                      isActive && 'bg-foreground/[0.06] dark:bg-foreground/[0.08]',
                    )}
                    onClick={() => toggleUser(user.id)}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <UserInitialsAvatar user={user} size="md" />
                    <div className="flex min-w-0 flex-1 flex-col items-start">
                      <span className="truncate font-medium">{user.name}</span>
                      {user.email && (
                        <span className="truncate text-body text-muted-foreground">
                          {user.email}
                        </span>
                      )}
                    </div>
                    {isSelected && (
                      <Check className="h-4 w-4 shrink-0 text-primary" />
                    )}
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-6 text-center text-body text-muted-foreground">
                {t('userSelector.noResults')}
              </div>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
};
