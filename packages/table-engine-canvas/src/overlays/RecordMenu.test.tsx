import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RecordMenu } from './RecordMenu'
import { useGridOverlayStore } from './store'

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = []

afterEach(() => {
  act(() => {
    useGridOverlayStore.getState().closeRecordMenu()
    for (const { root, container } of mountedRoots.splice(0)) {
      root.unmount()
      container.remove()
    }
  })
})

describe('RecordMenu comment entry', () => {
  it('shows comment for a single record and invokes its focused comment action', async () => {
    const commentRecord = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedRoots.push({ root, container })

    act(() => {
      root.render(<RecordMenu labels={{ comment: '评论' }} />)
      useGridOverlayStore.getState().openRecordMenu({
        rowData: { id: 'record-1', title: '第一条记录' },
        rowId: 'record-1',
        rowIndex: 0,
        position: { x: 0, y: 32, coordinateSpace: 'client' },
        commentRecord,
      })
    })

    const commentItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-grid-overlay="record-menu"] button'),
    ).find((item) => item.textContent === '评论')

    expect(commentItem).toBeTruthy()
    await act(async () => {
      commentItem?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })

    expect(commentRecord).toHaveBeenCalledTimes(1)
    expect(useGridOverlayStore.getState().recordMenu).toBeUndefined()
  })
})
