import type { ForwardRefRenderFunction } from 'react';
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import {
  Button,
  CalendarMonth,
  TimeSelect,
  cn,
  type DateFieldOptionsLike,
  smartsheetUiT as t,
  useDateEditorCore,
  parseDateStoredValue,
  toDateStoredValue,
  hasSecondsInTimeFormat,
} from '@tabtin/smartsheet-ui';

export interface IDateEditorMainRef {
  focus: () => void;
  setValue: (value?: string | null) => void;
  saveValue: (nextValue?: string | null) => void;
}

export interface IDateEditorMainProps {
  value?: string | null;
  style?: React.CSSProperties;
  className?: string;
  readonly?: boolean;
  options?: DateFieldOptionsLike;
  disableTimePicker?: boolean;
  /**
   * 年月 / 时分 Select 的 Portal 容器。
   * 传 `null` 强制挂 body（网格编辑器已 portal 到 body 时避免再被 OverlayContainer 裁切）。
   */
  portalContainer?: HTMLElement | null;
  onChange?: (value: string | null | undefined) => void;
  onRequestClose?: () => void;
}

const DateEditorMainBase: ForwardRefRenderFunction<IDateEditorMainRef, IDateEditorMainProps> = (
  props,
  ref
) => {
  const {
    value,
    style,
    className,
    onChange,
    onRequestClose,
    readonly,
    options,
    disableTimePicker = false,
    portalContainer,
  } = props;

  const defaultFocusRef = useRef<HTMLInputElement | null>(null);

  const stableOnChange = useCallback(
    (nextValue: string | null) => onChange?.(nextValue),
    [onChange]
  );

  const core = useDateEditorCore({
    value,
    formatting: options?.formatting,
    disableTimePicker,
    onChange: stableOnChange,
    onComplete: onRequestClose,
  });

  useImperativeHandle(ref, () => ({
    focus: () => defaultFocusRef.current?.focus?.(),
    setValue: (nextValue?: string | null) => {
      core.resetFromValue(nextValue);
    },
    saveValue: (nextValue?: string | null) => {
      if (nextValue !== undefined) {
        const parsed = parseDateStoredValue(nextValue, core.formatting);
        onChange?.(parsed ? toDateStoredValue(parsed, core.formatting) : null);
        return;
      }
      onChange?.(core.draftDate ? toDateStoredValue(core.draftDate, core.formatting) : null);
    },
  }));

  return (
    <div style={style} className={cn('overflow-hidden rounded-md border bg-background', className)}>
      <CalendarMonth
        className="border-0 rounded-none"
        month={core.displayMonth}
        onMonthChange={core.setDisplayMonth}
        selected={core.draftDate}
        onSelect={core.handleDaySelect}
        locale={core.locale}
        disabled={readonly}
        portalContainer={portalContainer}
      />

      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
        {core.hasTimePicker ? (
          <TimeSelect
            value={core.timeValue}
            onChange={core.handleTimeChange}
            disabled={readonly || !core.draftDate}
            showSeconds={hasSecondsInTimeFormat(core.formatting.time)}
            portalContainer={portalContainer}
          />
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={core.handleClear}
            disabled={!core.draftDate && !value}
          >
            {t('datePicker.clear')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={core.handleToday}>
            {core.hasTimePicker ? t('datePicker.now') : t('datePicker.today')}
          </Button>
          {core.hasTimePicker ? (
            <Button type="button" size="sm" onClick={core.handleConfirm} disabled={!core.draftDate}>
              {t('common.confirm')}
            </Button>
          ) : null}
        </div>
      </div>

      <input
        className="absolute size-0 opacity-0 outline-none"
        ref={defaultFocusRef}
      />
    </div>
  );
};

export const DateEditorMain = forwardRef(DateEditorMainBase);
