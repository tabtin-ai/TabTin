import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import {
  EDITOR_TAB_DRAG_TYPE,
  type EditorDropTarget,
  resolveInsertionIndex,
  TabCodeEditorTabs,
} from './TabCodeEditorTabs'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

function createDataTransfer(payload: { sourceGroupId: string; filePath: string }) {
  const data = new Map([[EDITOR_TAB_DRAG_TYPE, JSON.stringify(payload)]])
  return {
    types: [EDITOR_TAB_DRAG_TYPE],
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => data.set(type, value),
    dropEffect: 'move',
    effectAllowed: 'move',
  }
}

function renderTabs(options: {
  groupId?: string
  draggedTab?: { sourceGroupId: string; filePath: string } | null
  dropTarget?: EditorDropTarget | null
} = {}) {
  const props = {
    groupId: options.groupId ?? 'editor-root',
    draggedTab: options.draggedTab ?? null,
    dropTarget: options.dropTarget ?? null,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onDropTargetChange: vi.fn(),
    onReorder: vi.fn(),
    onMoveHere: vi.fn(),
  }
  render(
    <TabCodeEditorTabs
      rootPath="/repo"
      openFiles={['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']}
      activeFile="/repo/a.ts"
      {...props}
    />,
  )
  return props
}

describe('TabCodeEditorTabs', () => {
  it('keeps the insertion slot stable around a measured tab midpoint', () => {
    const slots = [
      { filePath: '/repo/a.ts', left: 0, width: 100 },
      { filePath: '/repo/b.ts', left: 100, width: 100 },
      { filePath: '/repo/c.ts', left: 200, width: 100 },
    ]

    expect(resolveInsertionIndex(slots, 155, 0, 1)).toBe(2)
    expect(resolveInsertionIndex(slots, 150, 0, 2)).toBe(2)
    expect(resolveInsertionIndex(slots, 145, 0, 2)).toBe(1)
  })

  it('keeps the source tab visible and renders a narrow insertion marker for same-group reorder', () => {
    const props = renderTabs()
    const source = screen.getByRole('tab', { name: 'a.ts' })
    const strip = screen.getByRole('tablist')
    const dataTransfer = createDataTransfer({ sourceGroupId: 'editor-root', filePath: '/repo/a.ts' })

    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(screen.getByRole('tab', { name: 'b.ts' }), { dataTransfer, clientX: 1 })

    expect(document.querySelector('[data-editor-tab-insertion-marker="true"]')).toBeTruthy()
    expect(source.closest('[data-editor-tab-file]')?.className).not.toContain('opacity-0')
    expect(props.onDropTargetChange).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'editor-root', zone: 'tab-strip', mode: 'insert' }),
    )
    expect(strip.getAttribute('data-editor-tab-strip')).toBe('editor-root')
  })

  it('keeps the insertion marker aligned when the strip scrolls during a drag', () => {
    const props = renderTabs()
    let scrollLeft = 40
    const mockStripGeometry = (element: HTMLElement) => {
      Object.defineProperty(element, 'scrollLeft', {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => {
          scrollLeft = value
        },
      })
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        right: 500,
        top: 0,
        bottom: 32,
        width: 400,
        height: 32,
        x: 100,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect)
    }
    const mockTabGeometry = () => {
      screen.getAllByRole('tab').forEach((tab, index) => {
        vi.spyOn(tab.closest('[data-editor-tab-file]')!, 'getBoundingClientRect').mockReturnValue({
          left: 60 + index * 100,
          right: 160 + index * 100,
          top: 0,
          bottom: 32,
          width: 100,
          height: 32,
          x: 60 + index * 100,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect)
      })
    }

    mockStripGeometry(screen.getByRole('tablist'))
    mockTabGeometry()

    const source = screen.getByRole('tab', { name: 'a.ts' })
    const dataTransfer = createDataTransfer({ sourceGroupId: 'editor-root', filePath: '/repo/a.ts' })

    fireEvent.dragStart(source, { dataTransfer })
    const strip = screen.getByRole('tablist')
    mockStripGeometry(strip)
    scrollLeft = 140
    // contentX = clientX - (stripLeft - scrollLeft) = 140 - (100 - 140) = 180,
    // which sits past b.ts midpoint (150) and before c.ts midpoint (250).
    const dragOverEvent = createEvent.dragOver(strip)
    Object.defineProperty(dragOverEvent, 'clientX', { configurable: true, value: 140 })
    Object.defineProperty(dragOverEvent, 'dataTransfer', { configurable: true, value: dataTransfer })
    fireEvent(strip, dragOverEvent)

    expect(props.onDropTargetChange).toHaveBeenCalledWith({
      groupId: 'editor-root',
      zone: 'tab-strip',
      mode: 'insert',
      targetFilePath: '/repo/c.ts',
      position: 'before',
    })
    expect(document.querySelector('[data-editor-tab-insertion-marker="true"]')?.getAttribute('style'))
      .toContain('left: 200px')
  })

  it('renders the active tab with a distinct selection surface and bottom indicator', () => {
    renderTabs()

    const activeTab = screen.getByRole('tab', { name: 'a.ts' })
    const activeTabContainer = activeTab.closest('[data-editor-tab-file]')
    expect(activeTabContainer?.className).toContain('bg-primary/10')
    expect(activeTabContainer?.className).toContain('font-medium')
    expect(activeTabContainer?.className).toContain('shadow-[inset_0_-1px_0_hsl(var(--primary))]')
    expect(activeTabContainer?.querySelector('button[aria-label]')?.className).toContain('opacity-100')
  })

  it('keeps file tabs at a bounded width so the strip can scroll instead of shrinking them', () => {
    renderTabs()

    const strip = screen.getByRole('tablist')
    expect(strip.className).toContain('overflow-x-auto')
    expect(strip.className).toContain('tabcode-editor-tab-strip')

    screen.getAllByRole('tab').forEach((tab) => {
      const tabContainer = tab.closest('[data-editor-tab-file]')
      expect(tabContainer?.className).toContain('min-w-[48px]')
      expect(tabContainer?.className).toContain('max-w-52')
      expect(tabContainer?.className).toContain('shrink-0')
    })
  })

  it('maps vertical wheel input to horizontal tab-strip scrolling', () => {
    renderTabs()

    const strip = screen.getByRole('tablist')
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 300 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    })
    const wheelEvent = createEvent.wheel(strip, { deltaY: 80 })

    fireEvent(strip, wheelEvent)

    expect(strip.scrollLeft).toBe(80)
  })

  it('shows exactly no active tab styling for an unfocused editor group', () => {
    render(
      <TabCodeEditorTabs
        rootPath="/repo"
        groupId="editor-background"
        openFiles={['/repo/a.ts', '/repo/b.ts']}
        activeFile="/repo/a.ts"
        isGroupActive={false}
        draggedTab={null}
        dropTarget={null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onDropTargetChange={vi.fn()}
        onReorder={vi.fn()}
        onMoveHere={vi.fn()}
      />,
    )

    const storedActiveTab = screen.getByRole('tab', { name: 'a.ts' })
    const storedActiveContainer = storedActiveTab.closest('[data-editor-tab-file]')
    expect(storedActiveContainer?.className).not.toContain('bg-primary/10')
    expect(storedActiveContainer?.querySelector('button[aria-label]')?.className).toContain('opacity-0')
  })

  it('shows a single-click preview as a replaceable active tab beside pinned tabs', () => {
    const onClearPreview = vi.fn()
    render(
      <TabCodeEditorTabs
        rootPath="/repo"
        groupId="editor-root"
        openFiles={['/repo/pinned.ts']}
        previewFile="/repo/preview.ts"
        activeFile="/repo/pinned.ts"
        draggedTab={null}
        dropTarget={null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onClearPreview={onClearPreview}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onDropTargetChange={vi.fn()}
        onReorder={vi.fn()}
        onMoveHere={vi.fn()}
      />,
    )

    const previewTab = screen.getByRole('tab', { name: 'preview.ts' })
    const pinnedTab = screen.getByRole('tab', { name: 'pinned.ts' })
    expect(previewTab.closest('[data-editor-tab-file]')?.dataset.editorTabPreview).toBe('true')
    expect(previewTab.closest('[data-editor-tab-file]')?.className).toContain('bg-primary/10')
    expect(pinnedTab.closest('[data-editor-tab-file]')?.className).not.toContain('bg-primary/10')
    expect(previewTab.querySelector('span.truncate')?.className).toContain('italic')
    expect(pinnedTab.querySelector('span.truncate')?.className).not.toContain('italic')
    expect(previewTab.getAttribute('draggable')).toBe('true')
    fireEvent.click(previewTab.closest('[data-editor-tab-file]')!.querySelector('button[aria-label]')!)
    expect(onClearPreview).toHaveBeenCalledTimes(1)
  })

  it('keeps an inactive preview tab when switching to a pinned tab', () => {
    const onActivatePreview = vi.fn()
    const onPinPreview = vi.fn()
    render(
      <TabCodeEditorTabs
        rootPath="/repo"
        groupId="editor-root"
        openFiles={['/repo/pinned.ts']}
        previewFile="/repo/preview.ts"
        isPreviewActive={false}
        activeFile="/repo/pinned.ts"
        draggedTab={null}
        dropTarget={null}
        onActivate={vi.fn()}
        onActivatePreview={onActivatePreview}
        onPinPreview={onPinPreview}
        onClose={vi.fn()}
        onClearPreview={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onDropTargetChange={vi.fn()}
        onReorder={vi.fn()}
        onMoveHere={vi.fn()}
      />,
    )

    const previewTab = screen.getByRole('tab', { name: 'preview.ts' })
    const pinnedTab = screen.getByRole('tab', { name: 'pinned.ts' })
    expect(previewTab.closest('[data-editor-tab-file]')?.className).not.toContain('bg-primary/10')
    expect(pinnedTab.closest('[data-editor-tab-file]')?.className).toContain('bg-primary/10')

    fireEvent.click(previewTab)
    expect(onActivatePreview).toHaveBeenCalledTimes(1)
    fireEvent.dragStart(previewTab, {
      dataTransfer: createDataTransfer({ sourceGroupId: 'editor-root', filePath: '/repo/preview.ts' }),
    })
    expect(onPinPreview).toHaveBeenCalledWith('/repo/preview.ts')
  })

  it('hides the source insertion marker when a cross-group strip is the drop target', () => {
    const dataTransfer = createDataTransfer({ sourceGroupId: 'editor-root', filePath: '/repo/a.ts' })
    render(
      <TabCodeEditorTabs
        rootPath="/repo"
        groupId="editor-root"
        openFiles={['/repo/a.ts', '/repo/b.ts']}
        activeFile="/repo/a.ts"
        draggedTab={{ sourceGroupId: 'editor-root', filePath: '/repo/a.ts' }}
        dropTarget={{
          groupId: 'editor-upper',
          zone: 'tab-strip',
          mode: 'insert',
          targetFilePath: '/repo/b.ts',
          position: 'before',
        }}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onDropTargetChange={vi.fn()}
        onReorder={vi.fn()}
        onMoveHere={vi.fn()}
      />,
    )

    fireEvent.dragStart(screen.getByRole('tab', { name: 'a.ts' }), { dataTransfer })
    expect(document.querySelector('[data-editor-tab-insertion-marker="true"]')).toBeNull()
  })

  it('clears the source insertion marker as soon as cross-group drag leaves its strip', () => {
    const props = renderTabs()
    const source = screen.getByRole('tab', { name: 'a.ts' })
    const strip = screen.getByRole('tablist')
    const dataTransfer = createDataTransfer({ sourceGroupId: 'editor-root', filePath: '/repo/a.ts' })

    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(screen.getByRole('tab', { name: 'b.ts' }), { dataTransfer, clientX: 1 })
    expect(document.querySelector('[data-editor-tab-insertion-marker="true"]')).toBeTruthy()

    // 浏览器在进入另一个编辑器组前，先向源 strip 派发 dragleave；此时即使
    // 父级落点尚未更新，也不能继续显示源组蓝线。
    fireEvent.dragLeave(strip, { dataTransfer, relatedTarget: null })
    expect(document.querySelector('[data-editor-tab-insertion-marker="true"]')).toBeNull()
    expect(props.onDropTargetChange).toHaveBeenLastCalledWith(null)
  })

  it('clears a source insertion marker when the shared drag session ends', () => {
    const dataTransfer = createDataTransfer({ sourceGroupId: 'editor-root', filePath: '/repo/a.ts' })
    const props = {
      rootPath: '/repo',
      groupId: 'editor-root',
      openFiles: ['/repo/a.ts', '/repo/b.ts'],
      activeFile: '/repo/a.ts',
      draggedTab: { sourceGroupId: 'editor-root', filePath: '/repo/a.ts' },
      dropTarget: null,
      onActivate: vi.fn(),
      onClose: vi.fn(),
      onDragStart: vi.fn(),
      onDragEnd: vi.fn(),
      onDropTargetChange: vi.fn(),
      onReorder: vi.fn(),
      onMoveHere: vi.fn(),
    }
    const { rerender } = render(<TabCodeEditorTabs {...props} />)

    fireEvent.dragStart(screen.getByRole('tab', { name: 'a.ts' }), { dataTransfer })
    fireEvent.dragOver(screen.getByRole('tab', { name: 'b.ts' }), { dataTransfer, clientX: 1 })
    expect(document.querySelector('[data-editor-tab-insertion-marker="true"]')).toBeTruthy()

    rerender(<TabCodeEditorTabs {...props} draggedTab={null} />)
    expect(document.querySelector('[data-editor-tab-insertion-marker="true"]')).toBeNull()
  })

  it('moves a cross-group drop into the target strip insertion point without a full-strip highlight', () => {
    const props = renderTabs({
      groupId: 'editor-upper',
      draggedTab: { sourceGroupId: 'editor-lower', filePath: '/repo/a.ts' },
    })
    const strip = screen.getByRole('tablist')
    const dataTransfer = createDataTransfer({ sourceGroupId: 'editor-lower', filePath: '/repo/a.ts' })

    fireEvent.dragOver(strip, { dataTransfer })
    fireEvent.drop(strip, { dataTransfer })

    expect(props.onDropTargetChange).toHaveBeenCalledWith({
      groupId: 'editor-upper',
      zone: 'tab-strip',
      mode: 'insert',
      targetFilePath: '/repo/a.ts',
      position: 'before',
    })
    expect(props.onMoveHere).toHaveBeenCalledWith(
      'editor-lower',
      '/repo/a.ts',
      '/repo/a.ts',
      'before',
    )
    expect(props.onDragEnd).toHaveBeenCalledTimes(1)
    expect(strip.className).not.toContain('ring-primary')
  })

  it('clears the source marker immediately after a cross-group drop', () => {
    const dataTransfer = createDataTransfer({ sourceGroupId: 'editor-source', filePath: '/repo/a.ts' })

    function CrossGroupHarness() {
      const [draggedTab, setDraggedTab] = React.useState<{ sourceGroupId: string; filePath: string } | null>(null)
      const [dropTarget, setDropTarget] = React.useState<EditorDropTarget | null>(null)
      const clearDrag = () => {
        setDraggedTab(null)
        setDropTarget(null)
      }
      return (
        <>
          <TabCodeEditorTabs
            rootPath="/repo"
            groupId="editor-source"
            openFiles={['/repo/a.ts', '/repo/b.ts']}
            activeFile="/repo/a.ts"
            draggedTab={draggedTab}
            dropTarget={dropTarget}
            onActivate={vi.fn()}
            onClose={vi.fn()}
            onDragStart={(_event, sourceGroupId, filePath) => setDraggedTab({ sourceGroupId, filePath })}
            onDragEnd={clearDrag}
            onDropTargetChange={setDropTarget}
            onReorder={vi.fn()}
            onMoveHere={vi.fn()}
          />
          <TabCodeEditorTabs
            rootPath="/repo"
            groupId="editor-target"
            openFiles={['/repo/c.ts']}
            activeFile="/repo/c.ts"
            draggedTab={draggedTab}
            dropTarget={dropTarget}
            onActivate={vi.fn()}
            onClose={vi.fn()}
            onDragStart={vi.fn()}
            onDragEnd={clearDrag}
            onDropTargetChange={setDropTarget}
            onReorder={vi.fn()}
            onMoveHere={vi.fn()}
          />
        </>
      )
    }

    render(<CrossGroupHarness />)
    fireEvent.dragStart(screen.getByRole('tab', { name: 'a.ts' }), { dataTransfer })
    fireEvent.dragOver(screen.getByRole('tab', { name: 'b.ts' }), { dataTransfer, clientX: 1 })
    expect(document.querySelector('[data-editor-tab-insertion-marker="true"]')).toBeTruthy()

    fireEvent.drop(screen.getAllByRole('tablist')[1], { dataTransfer })
    expect(document.querySelector('[data-editor-tab-insertion-marker="true"]')).toBeNull()
  })

  it('renders one cross-group insertion placeholder before an existing preview tab', () => {
    const dataTransfer = createDataTransfer({ sourceGroupId: 'editor-source', filePath: '/repo/a.ts' })

    function TargetWithPreview() {
      const [dropTarget, setDropTarget] = React.useState<EditorDropTarget | null>(null)
      return (
        <TabCodeEditorTabs
          rootPath="/repo"
          groupId="editor-target"
          openFiles={['/repo/b.ts']}
          previewFile="/repo/preview.ts"
          activeFile="/repo/b.ts"
          draggedTab={{ sourceGroupId: 'editor-source', filePath: '/repo/a.ts', tabWidth: 96 }}
          dropTarget={dropTarget}
          onActivate={vi.fn()}
          onClose={vi.fn()}
          onClearPreview={vi.fn()}
          onDragStart={vi.fn()}
          onDragEnd={vi.fn()}
          onDropTargetChange={setDropTarget}
          onReorder={vi.fn()}
          onMoveHere={vi.fn()}
        />
      )
    }

    render(<TargetWithPreview />)
    fireEvent.dragOver(screen.getByRole('tablist'), { dataTransfer, clientX: 100 })

    const placeholders = document.querySelectorAll('[data-editor-tab-cross-group-placeholder="true"]')
    expect(placeholders).toHaveLength(1)
    expect(placeholders[0].className).toContain('min-w-[48px]')
    expect(placeholders[0].className).toContain('shrink-0')
  })

  it('renders a cross-group insertion slot instead of a full-strip merge overlay', () => {
    const dataTransfer = createDataTransfer({ sourceGroupId: 'editor-lower', filePath: '/repo/a.ts' })

    function ControlledTargetStrip() {
      const [dropTarget, setDropTarget] = React.useState<EditorDropTarget | null>(null)
      return (
        <TabCodeEditorTabs
          rootPath="/repo"
          groupId="editor-upper"
          openFiles={['/repo/b.ts', '/repo/c.ts']}
          activeFile="/repo/b.ts"
          draggedTab={{ sourceGroupId: 'editor-lower', filePath: '/repo/a.ts', tabWidth: 96 }}
          dropTarget={dropTarget}
          onActivate={vi.fn()}
          onClose={vi.fn()}
          onDragStart={vi.fn()}
          onDragEnd={vi.fn()}
          onDropTargetChange={setDropTarget}
          onReorder={vi.fn()}
          onMoveHere={vi.fn()}
        />
      )
    }

    render(<ControlledTargetStrip />)
    const strip = screen.getByRole('tablist')
    fireEvent.dragOver(screen.getByRole('tab', { name: 'b.ts' }), { dataTransfer, clientX: 1 })

    expect(document.querySelector('[data-editor-tab-cross-group-placeholder="true"]')).toBeTruthy()
    expect(strip.textContent).not.toContain('editorTabs.moveHere')
    expect(strip.className).not.toContain('ring-primary')
  })

  it('renders a draggable extra history tab and can activate or close it', () => {
    const onActivateExtraTab = vi.fn()
    const onCloseExtraTab = vi.fn()
    render(
      <TabCodeEditorTabs
        rootPath="/repo"
        groupId="editor-root"
        openFiles={['/repo/a.ts']}
        activeFile="/repo/a.ts"
        extraTabs={[{ id: 'git-history', label: 'Git History' }]}
        activeExtraTabId="git-history"
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onDropTargetChange={vi.fn()}
        onReorder={vi.fn()}
        onMoveHere={vi.fn()}
        onActivateExtraTab={onActivateExtraTab}
        onCloseExtraTab={onCloseExtraTab}
      />,
    )

    const historyTab = screen.getByRole('tab', { name: 'Git History' })
    expect(historyTab.getAttribute('aria-selected')).toBe('true')
    expect(historyTab.getAttribute('draggable')).toBe('true')
    expect(screen.getByRole('tab', { name: 'a.ts' }).getAttribute('aria-selected')).toBe('false')

    fireEvent.click(historyTab)
    expect(onActivateExtraTab).toHaveBeenCalledWith('git-history')
    fireEvent.click(screen.getByRole('button', { name: 'editorTabs.closeGitHistory' }))
    expect(onCloseExtraTab).toHaveBeenCalledWith('git-history')
  })

  it('starts a history tab drag with the extra tab id', () => {
    const onDragStart = vi.fn()
    render(
      <TabCodeEditorTabs
        rootPath="/repo"
        groupId="editor-root"
        openFiles={['/repo/a.ts']}
        activeFile="/repo/a.ts"
        extraTabs={[{ id: 'git-history', label: 'Git History' }]}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onDragStart={onDragStart}
        onDragEnd={vi.fn()}
        onDropTargetChange={vi.fn()}
        onReorder={vi.fn()}
        onMoveHere={vi.fn()}
      />,
    )

    fireEvent.dragStart(screen.getByRole('tab', { name: 'Git History' }), {
      dataTransfer: createDataTransfer({ sourceGroupId: 'editor-root', filePath: 'git-history' }),
    })
    expect(onDragStart).toHaveBeenCalledWith(
      expect.anything(),
      'editor-root',
      'git-history',
    )
  })
})
