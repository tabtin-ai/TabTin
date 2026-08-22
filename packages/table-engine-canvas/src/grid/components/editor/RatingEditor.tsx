/* eslint-disable jsx-a11y/no-static-element-interactions */
import type { ForwardRefRenderFunction } from 'react';
import { useImperativeHandle, forwardRef, useRef, useState } from 'react';
import type { IRatingCell } from '../../renderers';
import { isNumberKey } from '../../utils';
import type { IEditorRef, IEditorProps } from './EditorContainer';

const RatingEditorBase: ForwardRefRenderFunction<
  IEditorRef<IRatingCell>,
  IEditorProps<IRatingCell>
> = (props, ref) => {
  const { cell, style, onChange } = props;
  const focusRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState<number | null>(cell.data);
  const [lastTime, setLastTime] = useState(0);

  useImperativeHandle(ref, () => ({
    focus: () => focusRef.current?.focus(),
    setValue: (v: number) => setValue(v),
    saveValue: () => onChange?.(value),
  }));

  const setRating = (nextValue: number | null) => {
    setValue(nextValue);
    onChange?.(nextValue);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey) return;
    if (!isNumberKey(e.keyCode)) return;

    const currentTime = Date.now();
    const digit = Number(e.key);
    let newValue: number | null = digit;

    // Try combining with previous value for multi-digit ratings (e.g., max=10: "1" then "0" = 10)
    if (value !== null && value > 0 && digit >= 0 && currentTime - lastTime <= 500) {
      const combined = value * 10 + digit;
      if (combined > 0 && combined <= cell.max) {
        newValue = combined;
      }
    }

    // Toggle: pressing same value clears it; 0 or NaN clears; always clamp to max
    if (newValue === value || newValue === 0 || Number.isNaN(newValue)) {
      newValue = null;
    } else {
      newValue = Math.min(newValue, cell.max);
    }

    setRating(newValue);
    setLastTime(currentTime);
  };

  const maxStars = cell.max;

  return (
    <div
      onKeyDown={onKeyDown}
      style={style}
      className="flex items-center gap-0.5 rounded-sm border-2 border-ring bg-popover px-1 shadow-sm"
    >
      {Array.from({ length: maxStars }, (_, i) => {
        const starValue = i + 1;
        const isFilled = starValue <= (value ?? 0);
        return (
          <button
            key={i}
            type="button"
            tabIndex={-1}
            className={`text-subtitle transition-colors ${
              isFilled ? 'text-amber-400' : 'text-muted-foreground/30'
            }`}
            onClick={() => setRating(starValue === value ? null : starValue)}
          >
            ★
          </button>
        );
      })}
      <input
        ref={focusRef}
        className="size-0 border-none p-0 opacity-0 shadow-none outline-none focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
      />
    </div>
  );
};

export const RatingEditor = forwardRef(RatingEditorBase);
