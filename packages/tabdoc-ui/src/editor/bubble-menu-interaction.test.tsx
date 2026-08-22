import { type ReactNode, useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const setTippyProps = vi.fn()

const editorState = {
  selection: { empty: false },
}

const editorMock = {
  isEditable: true,
  isActive: vi.fn((_name?: string) => false),
  state: editorState,
  view: { dom: document.createElement('div') },
  chain: () => ({
    unsetHighlight: () => ({ run: vi.fn() }),
  }),
}

vi.mock('novel', async () => {
  const React = await import('react')

  return {
    removeAIHighlight: vi.fn(),
    useEditor: () => ({ editor: editorMock }),
    EditorBubble: ({
      children,
      className,
      shouldShow,
      tippyOptions,
    }: {
      children: ReactNode
      className?: string
      shouldShow?: (props: {
        editor: typeof editorMock
        state: typeof editorState
      }) => boolean
      tippyOptions?: {
        appendTo?: () => Element
        onShow?: (instance: {
          props: { popperOptions?: { modifiers?: unknown[] } }
          setProps: ReturnType<typeof vi.fn>
          popperInstance: { update: ReturnType<typeof vi.fn> }
        }) => void
      }
    }) => {
      const toolbarRef = React.useRef<HTMLDivElement>(null)
      const visible = (
        shouldShow ??
        (({ editor, state }) =>
          editor.isEditable &&
          !editor.isActive('image') &&
          !state.selection.empty)
      )({ editor: editorMock, state: editorState })

      React.useEffect(() => {
        const toolbar = toolbarRef.current
        const target = tippyOptions?.appendTo?.()
        if (!toolbar || !target) return

        const originalParent = toolbar.parentElement
        target.appendChild(toolbar)
        tippyOptions?.onShow?.({
          props: {},
          setProps: setTippyProps,
          popperInstance: { update: vi.fn() },
        })

        return () => {
          originalParent?.appendChild(toolbar)
        }
      }, [tippyOptions])

      if (!visible) return null

      return (
        <div
          ref={toolbarRef}
          className={className}
          data-testid="bubble-toolbar"
        >
          {children}
        </div>
      )
    },
  }
})

import { DocBubbleMenu } from './bubble-menu'

function BubbleMenuHarness({ onFormat }: { onFormat: () => void }) {
  const boundaryRef = useRef<HTMLDivElement>(null)
  const [textMenuOpen, setTextMenuOpen] = useState(false)

  return (
    <div>
      <div
        ref={node => {
          boundaryRef.current = node
          if (node) {
            Object.defineProperty(node, 'clientWidth', {
              configurable: true,
              value: 320,
            })
          }
        }}
        data-tabdoc-bubble-boundary
      >
        <DocBubbleMenu
          boundaryRef={boundaryRef}
          open={textMenuOpen}
          onOpenChange={setTextMenuOpen}
        >
          <button type="button" onClick={onFormat}>
            加粗
          </button>
          <button type="button" onClick={() => setTextMenuOpen(true)}>
            文本
          </button>
          {textMenuOpen ? <div role="menu">文本样式</div> : null}
        </DocBubbleMenu>
      </div>
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  editorState.selection = { empty: false }
})

describe('DocBubbleMenu interaction boundary', () => {
  it('stays hidden when a secondary click turns a collapsed selection into a range', () => {
    editorState.selection = { empty: true }
    const view = render(<BubbleMenuHarness onFormat={vi.fn()} />)

    fireEvent.mouseDown(editorMock.view.dom, { button: 2 })
    editorState.selection = { empty: false }
    fireEvent.contextMenu(editorMock.view.dom)
    view.rerender(<BubbleMenuHarness onFormat={vi.fn()} />)

    expect(screen.queryByTestId('bubble-toolbar')).toBeNull()
  })

  it('stays visible when the secondary click starts with a non-empty selection', () => {
    const view = render(<BubbleMenuHarness onFormat={vi.fn()} />)

    fireEvent.mouseDown(editorMock.view.dom, { button: 2 })
    fireEvent.contextMenu(editorMock.view.dom)
    view.rerender(<BubbleMenuHarness onFormat={vi.fn()} />)

    expect(screen.getByTestId('bubble-toolbar')).toBeTruthy()
  })

  it('shows again for the next primary text-selection gesture', () => {
    editorState.selection = { empty: true }
    const view = render(<BubbleMenuHarness onFormat={vi.fn()} />)

    fireEvent.mouseDown(editorMock.view.dom, { button: 2 })
    editorState.selection = { empty: false }
    fireEvent.contextMenu(editorMock.view.dom)
    view.rerender(<BubbleMenuHarness onFormat={vi.fn()} />)
    expect(screen.queryByTestId('bubble-toolbar')).toBeNull()

    editorState.selection = { empty: true }
    fireEvent.mouseDown(editorMock.view.dom, { button: 0 })
    editorState.selection = { empty: false }
    view.rerender(<BubbleMenuHarness onFormat={vi.fn()} />)

    expect(screen.getByTestId('bubble-toolbar')).toBeTruthy()
  })

  it('uses the pre-menu selection for a keyboard-opened context menu', () => {
    editorState.selection = { empty: true }
    const view = render(<BubbleMenuHarness onFormat={vi.fn()} />)

    fireEvent.keyDown(editorMock.view.dom, { key: 'F10', shiftKey: true })
    editorState.selection = { empty: false }
    fireEvent.contextMenu(editorMock.view.dom)
    view.rerender(<BubbleMenuHarness onFormat={vi.fn()} />)

    expect(screen.queryByTestId('bubble-toolbar')).toBeNull()
  })

  it('does not treat Escape from the context menu as a new text selection', () => {
    editorState.selection = { empty: true }
    const view = render(<BubbleMenuHarness onFormat={vi.fn()} />)

    fireEvent.mouseDown(editorMock.view.dom, { button: 2 })
    editorState.selection = { empty: false }
    fireEvent.contextMenu(editorMock.view.dom)
    fireEvent.keyDown(editorMock.view.dom, { key: 'Escape' })
    view.rerender(<BubbleMenuHarness onFormat={vi.fn()} />)

    expect(screen.queryByTestId('bubble-toolbar')).toBeNull()
  })

  it('shows again for a keyboard text-selection gesture', () => {
    editorState.selection = { empty: true }
    const view = render(<BubbleMenuHarness onFormat={vi.fn()} />)

    fireEvent.mouseDown(editorMock.view.dom, { button: 2 })
    editorState.selection = { empty: false }
    fireEvent.contextMenu(editorMock.view.dom)
    fireEvent.keyDown(editorMock.view.dom, { key: 'ArrowRight', shiftKey: true })
    view.rerender(<BubbleMenuHarness onFormat={vi.fn()} />)

    expect(screen.getByTestId('bubble-toolbar')).toBeTruthy()
  })

  it('keeps format buttons clickable after Tippy mounts the toolbar', () => {
    const onFormat = vi.fn()
    render(<BubbleMenuHarness onFormat={onFormat} />)

    fireEvent.click(screen.getByRole('button', { name: '加粗' }))

    expect(onFormat).toHaveBeenCalledTimes(1)
  })

  it('keeps the text selector interactive after Tippy mounts the toolbar', () => {
    render(<BubbleMenuHarness onFormat={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '文本' }))

    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('keeps an open text selector visible when focus collapses the editor selection', () => {
    const view = render(<BubbleMenuHarness onFormat={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '文本' }))
    editorState.selection = { empty: true }
    view.rerender(<BubbleMenuHarness onFormat={vi.fn()} />)

    expect(screen.getByTestId('bubble-toolbar')).toBeTruthy()
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('keeps wrapping enabled when the toolbar width is constrained', () => {
    render(<BubbleMenuHarness onFormat={vi.fn()} />)

    const toolbar = screen.getByTestId('bubble-toolbar')
    const boundary = document.querySelector('[data-tabdoc-bubble-boundary]')

    expect(toolbar.parentElement).toBe(boundary)
    expect(toolbar.className).toContain('flex-wrap')
    expect(setTippyProps).toHaveBeenCalledWith(
      expect.objectContaining({ maxWidth: 304 }),
    )
  })
})
