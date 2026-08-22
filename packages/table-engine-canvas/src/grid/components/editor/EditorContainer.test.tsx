import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMemo, useRef, useState } from 'react';
import { CoordinateManager, CombinedSelection } from '../../managers';
import { SelectionRegionType, type ICellItem, type IRange } from '../../interface';
import {
  CellType,
  type ICustomEditor,
} from '../../renderers/cell-renderer/interface';
import { EditorContainer, resolveVisibleGridViewport } from './EditorContainer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const theme = {
  cellLineColorActived: '#2563eb',
  cellOptionBg: '#eef2ff',
  cellOptionTextColor: '#1e1b4b',
} as any;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

function createCoord() {
  return new CoordinateManager({
    rowHeight: 32,
    columnWidth: 150,
    rowCount: 5,
    pureRowCount: 5,
    columnCount: 3,
    containerWidth: 480,
    containerHeight: 240,
    rowInitSize: 32,
    columnInitSize: 70,
    freezeColumnCount: 0,
  });
}

type HarnessCell = {
  type: CellType;
  id?: string;
  data?: unknown;
  displayData?: unknown;
  readonly?: boolean;
  choiceMap?: Record<string, { id: string; name: string }>;
  choiceSorted?: Array<{ id: string; name: string }>;
  isMultiple?: boolean;
  customEditor?: ICustomEditor;
  editorWidth?: number;
};

function EditorHarness(props: {
  cell: HarnessCell;
  initiallyEditing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const [isEditing, setIsEditing] = useState(Boolean(props.initiallyEditing));
  const [activeCell, setActiveCell] = useState<ICellItem | null>([0, 0]);
  const [selection, setSelection] = useState(
    () =>
      new CombinedSelection(SelectionRegionType.Cells, [
        [0, 0] as IRange,
        [0, 0] as IRange,
      ])
  );
  const coordInstance = useMemo(() => createCoord(), []);
  const scrollState = useMemo(
    () => ({
      scrollTop: 0,
      scrollLeft: 0,
      isScrolling: false,
    }),
    []
  );
  const activeCellBound = useMemo(
    () => ({
      x: 70,
      y: 32,
      width: 150,
      height: 32,
      columnIndex: 0,
      rowIndex: 0,
    }),
    []
  );

  const setEditing = (value: boolean | ((prev: boolean) => boolean)) => {
    setIsEditing(prev => {
      const next = typeof value === 'function' ? value(prev) : value;
      props.onEditingChange?.(next);
      return next;
    });
  };

  return (
    <div ref={gridContainerRef} data-testid="grid-root" tabIndex={0}>
      <EditorContainer
        theme={theme}
        isEditing={isEditing}
        gridContainerRef={gridContainerRef}
        coordInstance={coordInstance}
        scrollState={scrollState as any}
        activeCell={activeCell}
        selection={selection}
        activeCellBound={activeCellBound as any}
        scrollToItem={() => undefined}
        real2RowIndex={index => index}
        getCellContent={() => props.cell as any}
        setActiveCell={setActiveCell}
        setSelection={setSelection}
        setEditing={setEditing as any}
      />
      <span data-testid="editing-flag">{isEditing ? '1' : '0'}</span>
    </div>
  );
}

function renderEditorHarness(cell: HarnessCell, options?: { initiallyEditing?: boolean }) {
  const onEditingChange = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });

  const renderCell = (nextCell: HarnessCell) =>
    act(() => {
      root.render(
        <EditorHarness
          cell={nextCell}
          initiallyEditing={options?.initiallyEditing}
          onEditingChange={onEditingChange}
        />
      );
    });
  renderCell(cell);

  const overlay = () =>
    container.querySelector('[data-grid-overlay="cell-editor"]') as HTMLDivElement | null;

  const fireTypeToEdit = (init: KeyboardEventInit) => {
    const target = overlay();
    if (!target) throw new Error('editor overlay missing');
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    });
  };

  return {
    container,
    onEditingChange,
    fireTypeToEdit,
    rerenderCell: renderCell,
    isEditing: () =>
      container.querySelector('[data-testid="editing-flag"]')?.textContent === '1',
    inputValue: () =>
      (container.querySelector('input:not([aria-hidden])') as HTMLInputElement | null)?.value ??
      (container.querySelector('textarea') as HTMLTextAreaElement | null)?.value ??
      null,
  };
}

describe('EditorContainer collaboration conflict warning', () => {
  it('does not report a conflict when a reordered row temporarily occupies the same index', () => {
    const harness = renderEditorHarness(
      {
        type: CellType.Text,
        id: 'rec-new-name',
        data: '正在输入',
        displayData: '正在输入',
      },
      { initiallyEditing: true }
    );

    harness.rerenderCell({
      type: CellType.Text,
      id: 'rec-old-name',
      data: '旧单元格内容',
      displayData: '旧单元格内容',
    });

    expect(harness.container.querySelector('[data-grid-conflict-warning]')).toBeNull();
  });

  it('shows a clear opaque warning when another collaborator updates the edited cell', () => {
    const harness = renderEditorHarness(
      {
        type: CellType.Text,
        id: 'r1:name',
        data: '本地编辑前的值',
        displayData: '本地编辑前的值',
      },
      { initiallyEditing: true }
    );

    harness.rerenderCell({
      type: CellType.Text,
      id: 'r1:name',
      data: '协作者更新后的值',
      displayData: '协作者更新后的值',
    });

    const warning = harness.container.querySelector(
      '[data-grid-conflict-warning]'
    ) as HTMLDivElement | null;

    expect(warning).not.toBeNull();
    expect(warning?.getAttribute('role')).toBe('alert');
    expect(warning?.textContent).toContain(
      '其他协作者已更新此单元格。保存当前内容会覆盖对方的修改。'
    );
    expect(warning?.className).toContain('bg-warning');
    expect(warning?.className).not.toContain('bg-warning/10');
    expect(warning?.className).toContain('text-body');
  });

  it('does not attribute a completed local attachment overlay to another collaborator', () => {
    const harness = renderEditorHarness(
      {
        type: CellType.Image,
        id: 'r1:attachment',
        data: [],
        displayData: [],
      },
      { initiallyEditing: true }
    );

    harness.rerenderCell({
      type: CellType.Image,
      id: 'r1:attachment',
      data: [
        {
          id: 'ref-local-upload',
          url: 'https://example.com/local.png',
          localUploadOverlay: true,
        },
      ],
      displayData: ['https://example.com/local.png'],
    });

    expect(harness.container.querySelector('[data-grid-conflict-warning]')).toBeNull();
  });

  it('still warns when another collaborator adds an attachment', () => {
    const harness = renderEditorHarness(
      {
        type: CellType.Image,
        id: 'r1:attachment',
        data: [{ id: 'ref-a', url: 'https://example.com/a.png' }],
        displayData: ['https://example.com/a.png'],
      },
      { initiallyEditing: true }
    );

    harness.rerenderCell({
      type: CellType.Image,
      id: 'r1:attachment',
      data: [
        { id: 'ref-a', url: 'https://example.com/a.png' },
        { id: 'ref-b', url: 'https://example.com/b.png' },
      ],
      displayData: ['https://example.com/a.png', 'https://example.com/b.png'],
    });

    expect(harness.container.querySelector('[data-grid-conflict-warning]')).not.toBeNull();
  });

  it('warns on a later remote attachment change after the local overlay is persisted', () => {
    const persistedAttachment = {
      id: 'ref-local-upload',
      url: 'https://example.com/local.png',
    };
    const customEditor: ICustomEditor = props => (
      <button
        type="button"
        data-testid="persist-local-attachment"
        onClick={() => props.onChange?.([persistedAttachment])}
      >
        persist
      </button>
    );
    const createCell = (data: unknown, displayData: unknown): HarnessCell => ({
      type: CellType.Image,
      id: 'r1:attachment',
      data,
      displayData,
      customEditor,
    });
    const harness = renderEditorHarness(createCell([], []), { initiallyEditing: true });

    harness.rerenderCell(
      createCell(
        [{ ...persistedAttachment, localUploadOverlay: true }],
        [persistedAttachment.url]
      )
    );
    expect(harness.container.querySelector('[data-grid-conflict-warning]')).toBeNull();

    act(() => {
      (
        harness.container.querySelector(
          '[data-testid="persist-local-attachment"]'
        ) as HTMLButtonElement
      ).click();
    });
    harness.rerenderCell(createCell([persistedAttachment], [persistedAttachment.url]));
    expect(harness.container.querySelector('[data-grid-conflict-warning]')).toBeNull();

    harness.rerenderCell(createCell([], []));
    expect(harness.container.querySelector('[data-grid-conflict-warning]')).not.toBeNull();
  });

  it('does not warn when a local user selection is echoed as resolved user objects', () => {
    const users = [
      { id: 'user-1', name: 'Alice' },
      { id: 'user-2', name: 'Bob' },
    ];
    const customEditor: ICustomEditor = props => (
      <button
        type="button"
        data-testid="select-local-users"
        onClick={() => props.onChange?.(users.map(user => user.id))}
      >
        select
      </button>
    );
    const createCell = (data: unknown): HarnessCell => ({
      type: CellType.User,
      id: 'r1:assignee',
      data,
      displayData: users
        .filter(user => Array.isArray(data) && data.some(item =>
          typeof item === 'string' ? item === user.id : item?.id === user.id
        ))
        .map(user => user.name),
      isMultiple: true,
      customEditor,
    });
    const harness = renderEditorHarness(createCell([users[0]]), {
      initiallyEditing: true,
    });

    act(() => {
      (
        harness.container.querySelector('[data-testid="select-local-users"]') as HTMLButtonElement
      ).click();
    });
    harness.rerenderCell(createCell(users));

    expect(harness.container.querySelector('[data-grid-conflict-warning]')).toBeNull();
  });

  it('does not warn when an earlier local user selection echoes after a later selection', () => {
    const users = [
      { id: 'user-1', name: 'Alice' },
      { id: 'user-2', name: 'Bob' },
    ];
    const customEditor: ICustomEditor = props => (
      <>
        <button
          type="button"
          data-testid="select-first-user"
          onClick={() => props.onChange?.([users[0].id])}
        >
          first
        </button>
        <button
          type="button"
          data-testid="select-both-users"
          onClick={() => props.onChange?.(users.map(user => user.id))}
        >
          both
        </button>
      </>
    );
    const createCell = (data: unknown): HarnessCell => ({
      type: CellType.User,
      id: 'r1:assignee',
      data,
      displayData: [],
      isMultiple: true,
      customEditor,
    });
    const harness = renderEditorHarness(createCell([]), { initiallyEditing: true });

    act(() => {
      (harness.container.querySelector('[data-testid="select-first-user"]') as HTMLButtonElement)
        .click();
      (harness.container.querySelector('[data-testid="select-both-users"]') as HTMLButtonElement)
        .click();
    });
    harness.rerenderCell(createCell([users[0]]));

    expect(harness.container.querySelector('[data-grid-conflict-warning]')).toBeNull();

    harness.rerenderCell(createCell(users));
    expect(harness.container.querySelector('[data-grid-conflict-warning]')).toBeNull();
  });

  it('keeps a real remote user conflict visible after a pending local echo arrives', () => {
    const localUser = { id: 'user-local', name: 'Alice' };
    const remoteUser = { id: 'user-remote', name: 'Bob' };
    const customEditor: ICustomEditor = props => (
      <button
        type="button"
        data-testid="select-local-user"
        onClick={() => props.onChange?.([localUser.id])}
      >
        local
      </button>
    );
    const createCell = (data: unknown): HarnessCell => ({
      type: CellType.User,
      id: 'r1:assignee',
      data,
      displayData: [],
      isMultiple: true,
      customEditor,
    });
    const harness = renderEditorHarness(createCell([]), { initiallyEditing: true });

    act(() => {
      (harness.container.querySelector('[data-testid="select-local-user"]') as HTMLButtonElement)
        .click();
    });
    harness.rerenderCell(createCell([remoteUser]));
    expect(harness.container.querySelector('[data-grid-conflict-warning]')).not.toBeNull();

    harness.rerenderCell(createCell([localUser]));
    expect(harness.container.querySelector('[data-grid-conflict-warning]')).not.toBeNull();
  });
});

describe('EditorContainer responsive editor bounds', () => {
  it('uses the visual viewport bottom when a software keyboard overlays the grid', () => {
    expect(resolveVisibleGridViewport(
      { top: 320, left: 0 },
      { width: 480, height: 400 },
      { width: 480, height: 560, offsetTop: 0, offsetLeft: 0 },
    )).toEqual({
      width: 480,
      height: 240,
    });
  });

  it('clamps a wide custom editor to the visible grid viewport', () => {
    const customEditor: ICustomEditor = props => (
      <div data-testid="custom-editor-width">{props.rect.width}</div>
    );
    const harness = renderEditorHarness(
      {
        type: CellType.Image,
        id: 'r1:attachment',
        data: [],
        displayData: [],
        editorWidth: 462,
        customEditor,
      },
      { initiallyEditing: true }
    );

    // 480px grid - 70px row header - 8px safe edge.
    expect(
      harness.container.querySelector('[data-testid="custom-editor-width"]')?.textContent
    ).toBe('402');
  });
});

describe('EditorContainer type-to-edit', () => {
  it('seeds first printable character into a text cell and overwrites old value', () => {
    const harness = renderEditorHarness({
      type: CellType.Text,
      id: 'r1:name',
      data: 'old',
      displayData: 'old',
    });

    expect(harness.isEditing()).toBe(false);

    harness.fireTypeToEdit({ key: 'a', keyCode: 65, code: 'KeyA' });

    expect(harness.isEditing()).toBe(true);
    expect(harness.inputValue()).toBe('a');
    expect(harness.onEditingChange).toHaveBeenCalledWith(true);
  });

  it('seeds first digit into a number cell', () => {
    const harness = renderEditorHarness({
      type: CellType.Number,
      id: 'r1:amount',
      data: 42,
      displayData: '42',
    });

    harness.fireTypeToEdit({ key: '7', keyCode: 55, code: 'Digit7' });

    expect(harness.isEditing()).toBe(true);
    expect(harness.inputValue()).toBe('7');
  });

  it('does not type-to-edit readonly cells', () => {
    const harness = renderEditorHarness({
      type: CellType.Text,
      id: 'r1:readonly',
      data: 'locked',
      displayData: 'locked',
      readonly: true,
    });

    harness.fireTypeToEdit({ key: 'x', keyCode: 88, code: 'KeyX' });

    expect(harness.isEditing()).toBe(false);
    expect(harness.onEditingChange).not.toHaveBeenCalled();
  });

  it('does not type-to-edit boolean cells', () => {
    const harness = renderEditorHarness({
      type: CellType.Boolean,
      id: 'r1:done',
      data: false,
    });

    harness.fireTypeToEdit({ key: 'a', keyCode: 65, code: 'KeyA' });

    expect(harness.isEditing()).toBe(false);
  });

  it('opens select editing with initial search seed (does not clear choices via text overwrite)', async () => {
    const harness = renderEditorHarness({
      type: CellType.Select,
      id: 'r1:status',
      data: ['todo'],
      displayData: ['todo'],
      choiceMap: { todo: { id: 'todo', name: 'Todo' } },
      choiceSorted: [{ id: 'todo', name: 'Todo' }],
      isMultiple: false,
    });

    harness.fireTypeToEdit({ key: 't', keyCode: 84, code: 'KeyT' });

    expect(harness.isEditing()).toBe(true);

    // Deferred SelectEditor may resolve asynchronously.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('enters edit on IME composition without seeding Process key', () => {
    const harness = renderEditorHarness({
      type: CellType.Text,
      id: 'r1:name',
      data: '旧值',
      displayData: '旧值',
    });

    harness.fireTypeToEdit({
      key: 'Process',
      keyCode: 229,
      code: 'KeyZ',
      isComposing: true,
    });

    expect(harness.isEditing()).toBe(true);
    // Cleared for composition; must not become the literal "Process".
    expect(harness.inputValue()).toBe('');
  });

  it('keeps existing value when entering edit without type-to-edit (inplace path)', () => {
    const harness = renderEditorHarness(
      {
        type: CellType.Text,
        id: 'r1:name',
        data: 'keep-me',
        displayData: 'keep-me',
      },
      { initiallyEditing: true }
    );

    expect(harness.isEditing()).toBe(true);
    expect(harness.inputValue()).toBe('keep-me');
  });
});
