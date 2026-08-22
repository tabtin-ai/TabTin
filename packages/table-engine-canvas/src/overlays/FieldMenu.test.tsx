import {
  FIELD_MENU_LIST_VIEWPORT_CLASS_NAME,
  FIELD_MENU_VIEWPORT_CLASS_NAME,
  FieldMenu,
} from './FieldMenu'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useGridOverlayStore } from './store'

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = []

afterEach(() => {
  act(() => {
    useGridOverlayStore.getState().closeHeaderMenu()
    for (const { root, container } of mountedRoots.splice(0)) {
      root.unmount()
      container.remove()
    }
  })
})

describe('FieldMenu mobile viewport bounds', () => {
  it('keeps the menu inside a narrow dynamic viewport', () => {
    expect(FIELD_MENU_VIEWPORT_CLASS_NAME).toContain('calc(100vw-1rem)')
    expect(FIELD_MENU_LIST_VIEWPORT_CLASS_NAME).toContain('calc(100dvh-1rem)')
    expect(FIELD_MENU_LIST_VIEWPORT_CLASS_NAME).toContain('overflow-y-auto')
  })

  it('shows the complete single-field action list', () => {
    const callbacks = {
      onEditField: vi.fn(),
      onDuplicateField: vi.fn(),
      onInsertField: vi.fn(),
      onSortField: vi.fn(),
      onFilterField: vi.fn(),
      onGroupField: vi.fn(),
      onFreezeField: vi.fn(),
      onSetPrimaryField: vi.fn(),
      onHideFields: vi.fn(),
      onDeleteFields: vi.fn(),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedRoots.push({ root, container })

    act(() => {
      root.render(<FieldMenu callbacks={callbacks} ownerId="field-menu-test" />)
      useGridOverlayStore.getState().openHeaderMenu({
        ownerId: 'field-menu-test',
        fields: ['title'],
        fieldNames: ['标题'],
        fieldTypes: ['text'],
        isPrimary: [false],
        editable: [true],
        position: { x: 0, y: 32, coordinateSpace: 'client' },
      })
    })

    const menuItems = Array.from(document.querySelectorAll('[data-grid-overlay="field-menu"] button'))
    expect(menuItems).toHaveLength(11)
    expect(menuItems.map(item => item.textContent)).toEqual([
      'Edit field',
      'Duplicate field',
      'Insert left',
      'Insert right',
      'Sort',
      'Filter',
      'Group',
      'Freeze up to this column',
      'Set as primary field',
      'Hide field',
      'Delete field',
    ])
  })
})
