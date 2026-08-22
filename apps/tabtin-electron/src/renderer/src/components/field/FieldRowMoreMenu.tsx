/**
 * FieldRowMoreMenu — 字段管理行尾「···」菜单
 * hover / click 打开 Popover；布尔项带 Switch，编辑/删除为点击项。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  cn,
} from '@tabtin/smartsheet-ui';
import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isPrimaryFieldAllowedType, type Field } from '@tabtin/table-core';

const CLOSE_DELAY_MS = 150;

export interface FieldRowMoreMenuProps {
  field: Field;
  isVisible: boolean;
  canToggleVisibility: boolean;
  lockPrimaryVisibility: boolean;
  onToggleVisibility: (field: Field) => void;
  onSetPrimary: (field: Field) => void;
  onEdit: (field: Field) => void;
  onDelete: (field: Field) => void;
}

export const FieldRowMoreMenu: React.FC<FieldRowMoreMenuProps> = ({
  field,
  isVisible,
  canToggleVisibility,
  lockPrimaryVisibility,
  onToggleVisibility,
  onSetPrimary,
  onEdit,
  onDelete,
}) => {
  const { t } = useTranslation(['field', 'common']);
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current != null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  const handleOpen = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  const showPrimaryRow =
    field.is_primary || isPrimaryFieldAllowedType(field.field_type);
  const visibilityDisabled =
    field.is_primary && lockPrimaryVisibility;

  const handlePrimaryCheckedChange = (checked: boolean) => {
    if (checked && !field.is_primary) {
      onSetPrimary(field);
    }
  };

  const handleEdit = () => {
    setOpen(false);
    onEdit(field);
  };

  const handleDelete = () => {
    setOpen(false);
    onDelete(field);
  };

  const handleOpenChange = useCallback(
    (next: boolean) => {
      clearCloseTimer();
      setOpen(next);
    },
    [clearCloseTimer],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={String(
            t('field:actions.more', { defaultValue: '更多操作' }),
          )}
          title={t('field:actions.more', { defaultValue: '更多操作' })}
          onMouseEnter={handleOpen}
          onMouseLeave={scheduleClose}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={4}
        className="w-48 p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onMouseEnter={handleOpen}
        onMouseLeave={scheduleClose}
      >
        <div className="flex flex-col gap-0.5">
          {canToggleVisibility && (
            <div
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5"
              onPointerDown={(event) => event.preventDefault()}
            >
              <span className="text-body text-foreground">
                {t('field:actions.showInView', {
                  defaultValue: '在视图中显示',
                })}
              </span>
              <Switch
                checked={isVisible}
                disabled={visibilityDisabled}
                onCheckedChange={() => onToggleVisibility(field)}
                className="h-4 w-8 shrink-0"
              />
            </div>
          )}

          {showPrimaryRow && (
            <div
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5"
              onPointerDown={(event) => event.preventDefault()}
            >
              <span className="text-body text-foreground">
                {t('field:actions.setPrimary')}
              </span>
              <Switch
                checked={Boolean(field.is_primary)}
                disabled={field.is_primary}
                onCheckedChange={handlePrimaryCheckedChange}
                className="h-4 w-8 shrink-0"
              />
            </div>
          )}

          <div className="my-0.5 h-px bg-border/60" />

          <button
            type="button"
            className={cn(
              'flex w-full items-center rounded-md px-2 py-1.5 text-left text-body',
              'text-foreground hover:bg-muted/80',
            )}
            onClick={handleEdit}
          >
            {t('field:actions.edit', { defaultValue: '编辑' })}
          </button>

          <button
            type="button"
            disabled={field.is_primary}
            className={cn(
              'flex w-full items-center rounded-md px-2 py-1.5 text-left text-body',
              field.is_primary
                ? 'cursor-not-allowed text-muted-foreground/60'
                : 'text-destructive hover:bg-destructive/10',
            )}
            onClick={handleDelete}
          >
            {t('field:actions.delete')}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
