/* eslint-disable jsx-a11y/no-static-element-interactions */
import type { ForwardRefRenderFunction } from 'react';
import { useImperativeHandle, forwardRef, useRef, useState } from 'react';
import { Key as KeyCode } from 'ts-keycode-enum';
import type { IBooleanCell } from '../../renderers';
import type { IEditorRef, IEditorProps } from './EditorContainer';

const BooleanEditorBase: ForwardRefRenderFunction<
  IEditorRef<IBooleanCell>,
  IEditorProps<IBooleanCell>
> = (props, ref) => {
  const { cell, style, onChange } = props;
  const focusRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(cell.data);

  useImperativeHandle(ref, () => ({
    focus: () => focusRef.current?.focus(),
    setValue: (v: boolean) => setValue(v),
    saveValue: () => onChange?.(value),
  }));

  const toggle = () => {
    const newValue = !value;
    setValue(newValue);
    onChange?.(newValue);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey) return;
    if (e.keyCode === KeyCode.Enter || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <div
      onKeyDown={onKeyDown}
      style={style}
      className="flex items-center justify-center rounded-sm border-2 border-ring bg-popover shadow-sm"
    >
      <button
        type="button"
        tabIndex={-1}
        className={`flex size-5 items-center justify-center rounded border-2 transition-colors ${
          value
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-muted-foreground/40 bg-background'
        }`}
        onClick={toggle}
      >
        {value && <span className="text-caption font-bold leading-none">✓</span>}
      </button>
      <input
        ref={focusRef}
        className="size-0 border-none p-0 opacity-0 shadow-none outline-none focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
      />
    </div>
  );
};

export const BooleanEditor = forwardRef(BooleanEditorBase);
