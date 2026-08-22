import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UserOption } from '@tabtin/smartsheet-ui';
import type { IGridTheme } from '../../configs';
import { CellType } from '../../renderers/cell-renderer/interface';
import { GridUserEditor } from './GridUserEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function createEditorHarness(
  initialUsers: UserOption[],
  options: {
    multiple?: boolean;
    initialValue?: string | string[] | null;
  } = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });

  const render = (users: UserOption[]) => {
    root.render(
      <GridUserEditor
        cell={{
          type: CellType.User,
          data: [],
        }}
        rect={{
          x: 0,
          y: 0,
          width: 240,
          height: 32,
          editorId: 'user-editor',
        }}
        theme={{} as IGridTheme}
        users={users}
        multiple={options.multiple}
        initialValue={options.initialValue ?? null}
        isEditing
        setEditing={vi.fn()}
        onChange={vi.fn()}
      />,
    );
  };

  act(() => render(initialUsers));

  return { container, render };
}

describe('GridUserEditor member profile updates', () => {
  it('finds the new name while the member dropdown remains open', () => {
    const memberId = 'member-1';
    const { container, render } = createEditorHarness([
      { id: memberId, name: 'aa' },
    ]);
    const input = container.querySelector('input');
    expect(input).not.toBeNull();

    act(() => setInputValue(input!, 'bb'));

    expect(container.querySelector('[role="option"]')).toBeNull();
    expect(container.textContent).toContain('无匹配成员');

    act(() => render([{ id: memberId, name: 'bb' }]));

    expect(input?.value).toBe('bb');
    expect(container.querySelector('[role="option"]')?.textContent).toContain('bb');
    expect(container.textContent).not.toContain('无匹配成员');
  });

  it('finds the new name in a multi-user field without losing the current selection', () => {
    const memberId = 'member-1';
    const { container, render } = createEditorHarness(
      [{ id: memberId, name: 'aa' }],
      { multiple: true, initialValue: [memberId] },
    );
    const input = container.querySelector('input');
    expect(input).not.toBeNull();

    act(() => setInputValue(input!, 'bb'));

    expect(container.querySelector('[role="option"]')).toBeNull();
    expect(container.textContent).toContain('无匹配成员');

    act(() => render([{ id: memberId, name: 'bb' }]));

    const renamedMember = container.querySelector('[role="option"]');
    expect(input?.value).toBe('bb');
    expect(renamedMember?.textContent).toContain('bb');
    expect(renamedMember?.getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).not.toContain('无匹配成员');
  });
});
