import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CellType } from '../../renderers/cell-renderer/interface';
import type { IEditorRef } from './EditorContainer';
import { TextEditor } from './TextEditor';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const theme = {
  cellLineColorActived: '#2563eb',
} as any;

const rect = {
  x: 0,
  y: 0,
  width: 240,
  height: 32,
  editorId: 'editor-1',
};

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

function renderTextEditor() {
  const onChange = vi.fn();
  const editorRef = createRef<IEditorRef>();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });

  const renderEditor = (
    cellId: string,
    displayData: string,
    isEditing: boolean,
    cellType: CellType.Text | CellType.Number = CellType.Text
  ) => {
    root.render(
      <TextEditor
        ref={editorRef}
        cell={{
          type: cellType,
          id: cellId,
          data: cellType === CellType.Number ? Number(displayData) || null : displayData,
          displayData,
        }}
        rect={rect}
        theme={theme}
        isEditing={isEditing}
        onChange={onChange}
      />
    );
  };

  return { container, renderEditor, onChange, editorRef };
}

describe('TextEditor', () => {
  it('resets local value when editing moves to another cell', () => {
    const { container, renderEditor } = renderTextEditor();

    act(() => {
      renderEditor('record-a:field-name', 'A', false);
    });
    expect(container.querySelector('input')?.value).toBe('A');

    act(() => {
      renderEditor('record-new:field-name', '', true);
    });

    expect(container.querySelector('input')?.value).toBe('');
  });

  it('keeps original display value for inplace edit (double-click / F2 path)', () => {
    const { container, renderEditor } = renderTextEditor();

    act(() => {
      renderEditor('record-a:field-name', 'keep-me', false);
    });
    act(() => {
      renderEditor('record-a:field-name', 'keep-me', true);
    });

    expect(container.querySelector('input')?.value).toBe('keep-me');
  });

  it('setValue seeds overwrite text and places caret at end for append', async () => {
    const { container, renderEditor, editorRef } = renderTextEditor();

    act(() => {
      renderEditor('record-a:field-name', 'old', true);
    });

    act(() => {
      editorRef.current?.setValue?.('a' as any);
      editorRef.current?.focus?.();
    });

    await act(async () => {
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    });

    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('a');
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(1);
  });

  it('saveValue skips commit when text value is unchanged', () => {
    const { renderEditor, editorRef, onChange } = renderTextEditor();

    act(() => {
      renderEditor('record-a:field-name', 'same', true);
    });
    act(() => {
      editorRef.current?.saveValue?.();
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('saveValue commits trimmed text when value changed', () => {
    const { renderEditor, editorRef, onChange } = renderTextEditor();

    act(() => {
      renderEditor('record-a:field-name', 'old', true);
    });
    act(() => {
      editorRef.current?.setValue?.('  next  ' as any);
    });
    act(() => {
      editorRef.current?.saveValue?.();
    });

    expect(onChange).toHaveBeenCalledWith('next');
  });

  it('invalid number passes raw string through (toast handled upstream like email)', () => {
    const { container, renderEditor, editorRef, onChange } = renderTextEditor();

    act(() => {
      renderEditor('record-a:field-qty', '12', true, CellType.Number);
    });
    act(() => {
      editorRef.current?.setValue?.('abc' as any);
    });
    act(() => {
      editorRef.current?.saveValue?.();
    });

    expect(onChange).toHaveBeenCalledWith('abc');
    expect(container.textContent).not.toContain('请输入有效数字');
  });

  it('valid number still commits numeric value', () => {
    const { renderEditor, editorRef, onChange } = renderTextEditor();

    act(() => {
      renderEditor('record-a:field-qty', '12', true, CellType.Number);
    });
    act(() => {
      editorRef.current?.setValue?.('34' as any);
    });
    act(() => {
      editorRef.current?.saveValue?.();
    });

    expect(onChange).toHaveBeenCalledWith(34);
  });
});
