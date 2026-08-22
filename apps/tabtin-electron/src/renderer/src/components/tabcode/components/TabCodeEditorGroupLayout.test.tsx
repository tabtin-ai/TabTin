import React from 'react'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TabCodeEditorGroupLayout } from './TabCodeEditorGroupLayout'
import { ROOT_EDITOR_GROUP_ID, type TabCodeEditorWorkspace } from '../utils/editorGroupLayout'
import { EDITOR_TAB_DRAG_TYPE } from './TabCodeEditorTabs'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@components/layout/resizable-v4', () => ({
  LayoutGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LayoutPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LayoutSeparator: () => <div />,
}))

vi.mock('./TabCodePreview', () => ({
  TabCodePreview: ({
    contentDropProps,
    contentOverlay,
  }: {
    contentDropProps: React.HTMLAttributes<HTMLDivElement>
    contentOverlay: React.ReactNode
  }) => (
    <div data-testid="editor-content" {...contentDropProps}>
      {contentOverlay}
    </div>
  ),
}))

vi.mock('./git-history/GitHistoryPane', () => ({
  GitHistoryPane: () => <div data-testid="git-history-pane" />,
}))

function createDataTransfer() {
  const data = new Map<string, string>()
  return {
    types: [EDITOR_TAB_DRAG_TYPE],
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => data.set(type, value),
    dropEffect: 'move',
    effectAllowed: 'move',
  }
}

function renderEditorLayout() {
  const workspace: TabCodeEditorWorkspace = {
    groupsById: {
      [ROOT_EDITOR_GROUP_ID]: {
        id: ROOT_EDITOR_GROUP_ID,
        openFiles: ['/repo/a.ts', '/repo/b.ts'],
        activeFile: '/repo/a.ts',
      },
    },
    layout: { type: 'leaf', paneId: ROOT_EDITOR_GROUP_ID },
    activeGroupId: ROOT_EDITOR_GROUP_ID,
  }
  const props = {
    onActivateGroup: vi.fn(),
    onActivateFile: vi.fn(),
    onActivatePreview: vi.fn(),
    onPinPreview: vi.fn(),
    onCloseFile: vi.fn(),
    onMoveFile: vi.fn(),
    onReorderFile: vi.fn(),
    onSplitFile: vi.fn(),
    onSplitResize: vi.fn(),
    onFileSaved: vi.fn(),
    onFileDeleted: vi.fn(),
    onClearPreview: vi.fn(),
  }

  render(
    <TabCodeEditorGroupLayout
      rootPath="/repo"
      workspace={workspace}
      isGitRepo={false}
      gitStatus={new Map()}
      {...props}
    />,
  )

  return props
}

describe('TabCodeEditorGroupLayout', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        fileSystem: {
          readFilePreview: vi.fn().mockResolvedValue(null),
        },
      },
    })
  })

  it('ignores only the displayed file when dropped into an editor group', () => {
    const props = renderEditorLayout()
    const editorContent = screen.getByTestId('editor-content')
    vi.spyOn(editorContent, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 100,
      top: 0,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    const selfDataTransfer = createDataTransfer()

    fireEvent.dragStart(screen.getByRole('tab', { name: 'a.ts' }), { dataTransfer: selfDataTransfer })
    fireEvent.dragOver(editorContent, {
      dataTransfer: selfDataTransfer,
      clientX: 10,
      clientY: 50,
    })

    expect(document.querySelector('[data-editor-body-drop]')).toBeNull()

    fireEvent.drop(editorContent, {
      dataTransfer: selfDataTransfer,
      clientX: 10,
      clientY: 50,
    })

    expect(props.onSplitFile).not.toHaveBeenCalled()
    expect(props.onMoveFile).not.toHaveBeenCalled()

    const otherTabDataTransfer = createDataTransfer()
    fireEvent.dragStart(screen.getByRole('tab', { name: 'b.ts' }), { dataTransfer: otherTabDataTransfer })
    const otherTabDragOver = createEvent.dragOver(editorContent)
    Object.defineProperties(otherTabDragOver, {
      dataTransfer: { configurable: true, value: otherTabDataTransfer },
      clientX: { configurable: true, value: 10 },
      clientY: { configurable: true, value: 50 },
    })
    fireEvent(editorContent, otherTabDragOver)

    expect(document.querySelector('[data-editor-body-drop]')).toBeTruthy()

    const otherTabDrop = createEvent.drop(editorContent)
    Object.defineProperties(otherTabDrop, {
      dataTransfer: { configurable: true, value: otherTabDataTransfer },
      clientX: { configurable: true, value: 10 },
      clientY: { configurable: true, value: 50 },
    })
    fireEvent(editorContent, otherTabDrop)

    expect(props.onSplitFile).toHaveBeenCalledWith(
      ROOT_EDITOR_GROUP_ID,
      ROOT_EDITOR_GROUP_ID,
      '/repo/b.ts',
      'left',
    )
  })

  it('shows the git history pane instead of the file preview when the extra tab is active', () => {
    const workspace: TabCodeEditorWorkspace = {
      groupsById: {
        [ROOT_EDITOR_GROUP_ID]: {
          id: ROOT_EDITOR_GROUP_ID,
          openFiles: ['/repo/a.ts'],
          activeFile: '/repo/a.ts',
        },
      },
      layout: { type: 'leaf', paneId: ROOT_EDITOR_GROUP_ID },
      activeGroupId: ROOT_EDITOR_GROUP_ID,
    }
    render(
      <TabCodeEditorGroupLayout
        rootPath="/repo"
        workspace={workspace}
        isGitRepo
        gitStatus={new Map()}
        gitHistoryOpen
        gitHistoryActive
        gitHistoryGroupId={ROOT_EDITOR_GROUP_ID}
        gitHistoryLabel="Git History"
        onActivateGroup={vi.fn()}
        onActivateFile={vi.fn()}
        onActivatePreview={vi.fn()}
        onPinPreview={vi.fn()}
        onCloseFile={vi.fn()}
        onMoveFile={vi.fn()}
        onReorderFile={vi.fn()}
        onSplitFile={vi.fn()}
        onSplitResize={vi.fn()}
        onFileSaved={vi.fn()}
        onFileDeleted={vi.fn()}
        onClearPreview={vi.fn()}
      />,
    )
    expect(screen.getByTestId('git-history-pane')).toBeTruthy()
    expect(screen.queryByTestId('editor-content')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Git History' }).getAttribute('aria-selected')).toBe('true')
  })

  it('splits history when the extra tab is dropped on an editor edge', () => {
    const workspace: TabCodeEditorWorkspace = {
      groupsById: {
        [ROOT_EDITOR_GROUP_ID]: {
          id: ROOT_EDITOR_GROUP_ID,
          openFiles: ['/repo/a.ts'],
          activeFile: '/repo/a.ts',
        },
      },
      layout: { type: 'leaf', paneId: ROOT_EDITOR_GROUP_ID },
      activeGroupId: ROOT_EDITOR_GROUP_ID,
    }
    const onSplitGitHistory = vi.fn()
    const onMoveGitHistory = vi.fn()
    render(
      <TabCodeEditorGroupLayout
        rootPath="/repo"
        workspace={workspace}
        isGitRepo
        gitStatus={new Map()}
        gitHistoryOpen
        gitHistoryActive
        gitHistoryGroupId={ROOT_EDITOR_GROUP_ID}
        gitHistoryLabel="Git History"
        onActivateGroup={vi.fn()}
        onActivateFile={vi.fn()}
        onActivatePreview={vi.fn()}
        onPinPreview={vi.fn()}
        onCloseFile={vi.fn()}
        onMoveFile={vi.fn()}
        onReorderFile={vi.fn()}
        onSplitFile={vi.fn()}
        onSplitResize={vi.fn()}
        onFileSaved={vi.fn()}
        onFileDeleted={vi.fn()}
        onClearPreview={vi.fn()}
        onMoveGitHistory={onMoveGitHistory}
        onSplitGitHistory={onSplitGitHistory}
      />,
    )

    const dropzone = document.querySelector('[data-editor-content-dropzone]') as HTMLElement
    vi.spyOn(dropzone, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 100,
      top: 0,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    const dataTransfer = createDataTransfer()
    fireEvent.dragStart(screen.getByRole('tab', { name: 'Git History' }), { dataTransfer })
    const dropEvent = createEvent.drop(dropzone)
    Object.defineProperties(dropEvent, {
      dataTransfer: { configurable: true, value: dataTransfer },
      clientX: { configurable: true, value: 90 },
      clientY: { configurable: true, value: 50 },
    })
    fireEvent(dropzone, dropEvent)

    expect(onSplitGitHistory).toHaveBeenCalledWith(
      ROOT_EDITOR_GROUP_ID,
      ROOT_EDITOR_GROUP_ID,
      'right',
    )
    expect(onMoveGitHistory).not.toHaveBeenCalled()
  })
})
