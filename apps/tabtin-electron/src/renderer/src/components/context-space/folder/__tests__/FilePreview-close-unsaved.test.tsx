import React, { useEffect, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilePreviewHandle } from '../FilePreview'

const saveMock = vi.hoisted(() => vi.fn(async () => true))
const editorMountState = vi.hoisted(() => ({ count: 0 }))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('lucide-react', () => ({
  FileText: (props: Record<string, unknown>) => <span {...props} />,
  FileArchive: (props: Record<string, unknown>) => <span {...props} />,
  AlertCircle: (props: Record<string, unknown>) => <span {...props} />,
  Save: (props: Record<string, unknown>) => <span {...props} />,
  Check: (props: Record<string, unknown>) => <span {...props} />,
  Loader2: (props: Record<string, unknown>) => <span {...props} />,
  Eye: (props: Record<string, unknown>) => <span {...props} />,
  Code2: (props: Record<string, unknown>) => <span {...props} />,
  X: (props: Record<string, unknown>) => <span {...props} />,
}))

vi.mock('@components/shared/file-icon/FileIcon', () => ({
  FileIcon: ({ fileName }: { fileName: string }) => <span data-testid="file-icon">{fileName}</span>,
}))

vi.mock('@components/shared/file-preview/CsvViewer', () => ({
  CsvViewer: () => <div data-testid="csv-viewer" />,
}))

vi.mock('@components/shared/file-preview/FileKindPreview', () => ({
  FileKindPreview: () => <div data-testid="kind-preview" />,
}))

vi.mock('@components/shared/file-preview/MarkdownViewer', () => ({
  MarkdownViewer: () => <div data-testid="markdown-viewer" />,
}))

vi.mock('@components/shared/file-preview/TextFileEditor', () => ({
  TextFileEditor: ({ onStateChange }: {
    onStateChange?: (state: {
      dirty: boolean
      status: 'idle'
      saveError: null
      save: () => Promise<boolean>
    }) => void
  }) => {
    const [instanceId] = useState(() => {
      editorMountState.count += 1
      return editorMountState.count
    })

    useEffect(() => {
      const timer = window.setTimeout(() => {
        onStateChange?.({
          dirty: instanceId === 1,
          status: 'idle',
          saveError: null,
          save: saveMock,
        })
      }, 0)
      return () => window.clearTimeout(timer)
    }, [instanceId, onStateChange])

    return <div data-testid="text-editor" data-instance-id={instanceId} />
  },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  OVERLAY_SURFACE_CLASS: '',
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    open ? <div>{children}</div> : null
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | { defaultValue?: string; name?: string }) => {
      const translations: Record<string, string> = {
        'folder.labels.closePreview': '关闭预览',
        'folder.closePreviewConfirm.title': '有未保存的修改',
        'folder.closePreviewConfirm.message': `"${typeof options === 'object' ? options.name : 'file'}" 还有未保存的修改。`,
        'folder.closePreviewConfirm.chooseHint': '关闭预览前，你可以选择保存，或直接关闭并放弃这些修改。',
        'folder.closePreviewConfirm.chooseHintLeave': '切换文件前，你可以选择保存，或不保存并放弃这些修改。',
        'folder.closePreviewConfirm.cancel': '取消',
        'folder.closePreviewConfirm.closeWithoutSaving': '直接关闭',
        'folder.closePreviewConfirm.discardWithoutSaving': '不保存',
        'folder.closePreviewConfirm.saveAndClose': '保存并关闭',
        'folder.closePreviewConfirm.saveAndContinue': '保存',
      }
      if (translations[key]) return translations[key]
      return typeof options === 'string' ? options : options?.defaultValue ?? key
    },
  }),
}))

const noteEntry = {
  name: 'note.txt',
  path: '/tmp/project/note.txt',
  isDirectory: false,
  size: 12,
  modifiedAt: 1,
}

const textPreview = {
  kind: 'text' as const,
  content: 'original',
  truncated: false,
}

describe('FilePreview unsaved close confirmation', () => {
  beforeEach(() => {
    saveMock.mockClear()
    editorMountState.count = 0
  })

  it('discards local editor changes when closing without saving', async () => {
    const { FilePreview } = await import('../FilePreview')
    const onClosePreview = vi.fn()

    render(
      <FilePreview
        entry={noteEntry}
        preview={textPreview}
        isLoading={false}
        onClosePreview={onClosePreview}
      />,
    )

    expect(screen.getByTestId('text-editor').getAttribute('data-instance-id')).toBe('1')
    await screen.findByText('folder.labels.save')

    fireEvent.click(screen.getByLabelText('关闭预览'))
    fireEvent.click(await screen.findByText('直接关闭'))

    expect(saveMock).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(onClosePreview).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.getByTestId('text-editor').getAttribute('data-instance-id')).toBe('2')
    })
  })

  it('still prompts for unsaved markdown edits after switching to rendered preview', async () => {
    const { FilePreview } = await import('../FilePreview')
    const onClosePreview = vi.fn()

    render(
      <FilePreview
        entry={{
          name: 'readme.md',
          path: '/tmp/project/readme.md',
          isDirectory: false,
          size: 12,
          modifiedAt: 1,
        }}
        preview={{
          kind: 'text',
          content: '# original',
          truncated: false,
        }}
        isLoading={false}
        onClosePreview={onClosePreview}
      />,
    )

    await screen.findByText('folder.labels.save')
    fireEvent.click(screen.getByText('folder.labels.viewRendered'))
    expect(await screen.findByTestId('markdown-viewer')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('关闭预览'))

    expect(await screen.findByText('直接关闭')).toBeTruthy()
    expect(onClosePreview).not.toHaveBeenCalled()
  })

  it('requestLeave prompts before switching and allows discard', async () => {
    const { FilePreview } = await import('../FilePreview')
    const previewRef = React.createRef<FilePreviewHandle>()

    render(
      <FilePreview
        ref={previewRef}
        entry={noteEntry}
        preview={textPreview}
        isLoading={false}
        onClosePreview={vi.fn()}
      />,
    )

    await screen.findByText('folder.labels.save')

    let leaveResult: boolean | undefined
    let leavePromise!: Promise<void>
    await act(async () => {
      leavePromise = previewRef.current!.requestLeave().then((ok) => {
        leaveResult = ok
      })
    })

    expect(await screen.findByText('不保存')).toBeTruthy()
    expect(screen.getByText('切换文件前，你可以选择保存，或不保存并放弃这些修改。')).toBeTruthy()
    expect(leaveResult).toBeUndefined()

    fireEvent.click(screen.getByText('不保存'))
    await leavePromise
    expect(leaveResult).toBe(true)
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('requestLeave can cancel and keep the editor dirty', async () => {
    const { FilePreview } = await import('../FilePreview')
    const previewRef = React.createRef<FilePreviewHandle>()

    render(
      <FilePreview
        ref={previewRef}
        entry={noteEntry}
        preview={textPreview}
        isLoading={false}
        onClosePreview={vi.fn()}
      />,
    )

    await screen.findByText('folder.labels.save')

    let leaveResult: boolean | undefined
    let leavePromise!: Promise<void>
    await act(async () => {
      leavePromise = previewRef.current!.requestLeave().then((ok) => {
        leaveResult = ok
      })
    })

    fireEvent.click(await screen.findByText('取消'))
    await leavePromise
    expect(leaveResult).toBe(false)
    expect(screen.getByText('folder.labels.save')).toBeTruthy()
  })

  it('requestLeave saves before allowing leave', async () => {
    const { FilePreview } = await import('../FilePreview')
    const previewRef = React.createRef<FilePreviewHandle>()

    render(
      <FilePreview
        ref={previewRef}
        entry={noteEntry}
        preview={textPreview}
        isLoading={false}
        onClosePreview={vi.fn()}
      />,
    )

    await screen.findByText('folder.labels.save')

    let leaveResult: boolean | undefined
    let leavePromise!: Promise<void>
    await act(async () => {
      leavePromise = previewRef.current!.requestLeave().then((ok) => {
        leaveResult = ok
      })
    })

    fireEvent.click(await screen.findByText('保存'))
    await leavePromise
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(leaveResult).toBe(true)
  })
})
