import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CellType } from '../../renderers/cell-renderer/interface';
import { SelectEditor } from './SelectEditor';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const theme = {
  cellOptionBg: '#eef2ff',
  cellOptionTextColor: '#1e1b4b',
} as any;

const rect = {
  x: 0,
  y: 0,
  width: 240,
  height: 32,
  editorId: 'editor-1',
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function renderSelectEditor(overrides: {
  onOptionAdd?: (name: string) => void | Promise<void>;
  onChange?: (value: unknown) => void;
  setEditing?: (value: boolean) => void;
  choices?: Array<{ id: string; name: string }>;
} = {}) {
  const onChange = overrides.onChange ?? vi.fn();
  const setEditing = overrides.setEditing ?? vi.fn();
  const choices = overrides.choices ?? [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });

  const renderEditor = (isEditing: boolean, initialSearch?: string) => {
    root.render(
      <SelectEditor
        cell={{
          type: CellType.Select,
          data: [],
          displayData: [],
          choiceMap: Object.fromEntries(choices.map(choice => [choice.id, choice])),
          choiceSorted: choices,
          isMultiple: false,
          onOptionAdd: overrides.onOptionAdd,
        }}
        rect={rect}
        theme={theme}
        isEditing={isEditing}
        initialSearch={initialSearch}
        onChange={onChange}
        setEditing={setEditing as any}
        editorSelectAddOption="Create"
      />
    );
  };

  act(() => {
    renderEditor(false);
  });

  const openWithSearch = async (value: string) => {
    await act(async () => {
      renderEditor(true, value);
      await flushPromises();
    });
  };

  const getCreateOptionButton = (value: string) => {
    const button = Array.from(container.querySelectorAll('button'))
      .find(item => {
        const text = item.textContent ?? '';
        return (
          (text.includes('Create') || text.includes('Creating')) &&
          text.includes(`"${value}"`)
        );
      });
    if (!button) throw new Error(`create option button not found: ${value}`);
    return button as HTMLButtonElement;
  };

  const clickCreateOption = (value: string) => {
    const button = getCreateOptionButton(value);
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const clickOption = (value: string) => {
    const button = Array.from(container.querySelectorAll('button'))
      .find(item => item.textContent?.trim() === value);
    if (!button) throw new Error(`option button not found: ${value}`);
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  return { onChange, setEditing, openWithSearch, clickCreateOption, getCreateOptionButton, clickOption };
}

describe('SelectEditor option creation', () => {
  it('waits for option creation before committing the new value', async () => {
    const optionAdd = deferred();
    const onOptionAdd = vi.fn(() => optionAdd.promise);
    const { onChange, setEditing, openWithSearch, clickCreateOption } = renderSelectEditor({ onOptionAdd });

    await openWithSearch('In Progress');
    clickCreateOption('In Progress');

    expect(onOptionAdd).toHaveBeenCalledWith('In Progress');
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      optionAdd.resolve();
      await optionAdd.promise;
      await flushPromises();
    });

    expect(onChange).toHaveBeenCalledWith('In Progress');
    expect(setEditing).toHaveBeenCalledWith(false);
  });

  it('does not commit when option creation rejects', async () => {
    const optionAdd = deferred();
    const onOptionAdd = vi.fn(() => optionAdd.promise);
    const { onChange, setEditing, openWithSearch, clickCreateOption } = renderSelectEditor({ onOptionAdd });

    await openWithSearch('Blocked');
    clickCreateOption('Blocked');

    await act(async () => {
      optionAdd.reject(new Error('create failed'));
      await optionAdd.promise.catch(() => undefined);
      await flushPromises();
    });

    expect(onOptionAdd).toHaveBeenCalledWith('Blocked');
    expect(onChange).not.toHaveBeenCalled();
    expect(setEditing).not.toHaveBeenCalledWith(false);
  });

  it('disables create while option creation is pending', async () => {
    const optionAdd = deferred();
    const onOptionAdd = vi.fn(() => optionAdd.promise);
    const { openWithSearch, clickCreateOption, getCreateOptionButton } = renderSelectEditor({ onOptionAdd });

    await openWithSearch('Queued');
    clickCreateOption('Queued');

    const button = getCreateOptionButton('Queued');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('Creating');

    clickCreateOption('Queued');
    expect(onOptionAdd).toHaveBeenCalledTimes(1);

    await act(async () => {
      optionAdd.resolve();
      await optionAdd.promise;
      await flushPromises();
    });
  });

  it('does not overwrite a later existing-choice selection when create resolves', async () => {
    const optionAdd = deferred();
    const onOptionAdd = vi.fn(() => optionAdd.promise);
    const { onChange, openWithSearch, clickCreateOption, clickOption } = renderSelectEditor({
      onOptionAdd,
      choices: [{ id: 'existing', name: 'Existing' }],
    });

    await openWithSearch('E');
    clickCreateOption('E');
    clickOption('Existing');

    expect(onChange).toHaveBeenCalledWith('Existing');

    await act(async () => {
      optionAdd.resolve();
      await optionAdd.promise;
      await flushPromises();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows empty-field hint when there are no configured choices', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });

    await act(async () => {
      root.render(
        <SelectEditor
          cell={{
            type: CellType.Select,
            data: [],
            displayData: [],
            choiceMap: {},
            choiceSorted: [],
            isMultiple: false,
          }}
          rect={rect}
          theme={theme}
          isEditing
          onChange={vi.fn()}
          setEditing={vi.fn() as any}
          editorSelectEmptyHint="暂无选项，输入后可直接创建"
          editorSelectSearchPlaceholderEmpty="输入以创建选项"
        />
      );
      await flushPromises();
    });

    const input = container.querySelector('input');
    expect(input?.getAttribute('placeholder')).toBe('输入以创建选项');
    expect(container.textContent).toContain('暂无选项，输入后可直接创建');
  });
});
