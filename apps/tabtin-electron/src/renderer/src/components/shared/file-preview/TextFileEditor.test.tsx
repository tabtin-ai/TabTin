import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextFileEditor } from './TextFileEditor'
import type { GitGutterBaseline } from './gitGutterDecorations'

vi.mock('@components/shared/file-preview/CodeEditor', () => ({
  CodeEditor: ({
    readOnly,
    className,
    editorOptions,
    onSave,
    modelKey,
    value,
    initialLine,
    initialLineKey,
    findRequest,
    gitGutterBaseline,
  }: {
    readOnly?: boolean
    className?: string
    editorOptions?: Record<string, unknown>
    onSave?: () => void
    modelKey?: string
    value: string
    initialLine?: number
    initialLineKey?: number
    findRequest?: { query: string; key: number }
    gitGutterBaseline?: GitGutterBaseline | null
  }) => (
    <>
      <div
        data-testid="code-editor"
        data-class-name={className}
        data-read-only={String(readOnly)}
        data-dom-read-only={String(editorOptions?.domReadOnly)}
        data-read-only-message={String((editorOptions?.readOnlyMessage as { value?: string } | undefined)?.value ?? '')}
        data-initial-line={initialLine == null ? '' : String(initialLine)}
        data-initial-line-key={initialLineKey == null ? '' : String(initialLineKey)}
        data-find-query={findRequest?.query ?? ''}
        data-find-key={findRequest == null ? '' : String(findRequest.key)}
        data-git-gutter-revision={gitGutterBaseline == null ? '' : String(gitGutterBaseline.revision)}
        data-model-key={modelKey ?? ''}
        data-value={value}
      />
      {onSave && <button type="button" onClick={onSave}>save</button>}
    </>
  ),
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TextFileEditor', () => {
  it('shows a stable read-only hint for preview-only editors', async () => {
    render(
      <TextFileEditor
        filePath="/tmp/data.json"
        fileName="data.json"
        content='{"ok":true}'
        readOnly
      />,
    )

    const editor = await screen.findByTestId('code-editor')
    expect(editor.getAttribute('data-read-only')).toBe('true')
    expect(editor.getAttribute('data-class-name')).toContain('readonly-preview-editor')
    expect(editor.getAttribute('data-dom-read-only')).toBe('true')
    expect(editor.getAttribute('data-read-only-message')).toBe('')
    const hint = screen.getByText('只读预览，可选中复制内容')
    expect(hint).toBeTruthy()
    expect(hint.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not show the read-only hint for editable editors', async () => {
    render(
      <TextFileEditor
        filePath="/tmp/data.json"
        fileName="data.json"
        content='{"ok":true}'
        savePath="/tmp/data.json"
      />,
    )

    const editor = await screen.findByTestId('code-editor')
    expect(editor.getAttribute('data-read-only')).toBe('false')
    expect(editor.getAttribute('data-class-name')).not.toContain('readonly-preview-editor')
    expect(screen.queryByText('只读预览，可选中复制内容')).toBeNull()
  })

  it('keeps one Monaco host mounted while switching TabCode files', async () => {
    const { rerender } = render(
      <TextFileEditor
        filePath="/tmp/first.ts"
        content="const first = true"
        preserveEditorOnFileChange
      />,
    )
    const firstEditorNode = await screen.findByTestId('code-editor')

    rerender(
      <TextFileEditor
        filePath="/tmp/second.ts"
        content="const second = true"
        preserveEditorOnFileChange
      />,
    )

    const secondEditorNode = await screen.findByTestId('code-editor')
    expect(secondEditorNode).toBe(firstEditorNode)
    expect(secondEditorNode.getAttribute('data-model-key')).toBe('/tmp/second.ts')
    expect(secondEditorNode.getAttribute('data-value')).toBe('const second = true')
  })

  it('recreates the Monaco host for shared previews by default', async () => {
    const { rerender } = render(
      <TextFileEditor
        filePath="/tmp/first.ts"
        content="const first = true"
      />,
    )
    const firstEditorNode = await screen.findByTestId('code-editor')

    rerender(
      <TextFileEditor
        filePath="/tmp/second.ts"
        content="const second = true"
      />,
    )

    expect(await screen.findByTestId('code-editor')).not.toBe(firstEditorNode)
  })

  it('preserves custom editor class names for read-only previews', async () => {
    render(
      <TextFileEditor
        filePath="/tmp/data.json"
        fileName="data.json"
        content='{"ok":true}'
        className="custom-editor-class"
        readOnly
      />,
    )

    const editor = await screen.findByTestId('code-editor')
    expect(editor.getAttribute('data-class-name')).toContain('custom-editor-class')
    expect(editor.getAttribute('data-class-name')).toContain('readonly-preview-editor')
  })

  it('does not mount the Monaco editor for truncated previews', () => {
    render(
      <TextFileEditor
        filePath="/tmp/data.json"
        fileName="data.json"
        content='{"ok":true}'
        truncated
        labels={{
          truncatedPreview: '预览内容已截断',
          largePreviewHint: '仅显示前半部分',
          saveFailed: '保存失败',
        }}
        readOnly
      />,
    )

    expect(screen.queryByTestId('code-editor')).toBeNull()
    expect(screen.queryByText('只读预览，可选中复制内容')).toBeNull()
    expect(screen.getByText('预览内容已截断')).toBeTruthy()
  })

  it('notifies the caller immediately after a successful save', async () => {
    const writeFile = vi.fn().mockResolvedValue({ success: true })
    const onSaveSuccess = vi.fn()
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: { fileSystem: { writeFile } },
    })

    render(
      <TextFileEditor
        filePath={'C:\\workspace\\project\\demo.ts'}
        content="const demo = true"
        onSaveSuccess={onSaveSuccess}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'save' }))

    await waitFor(() => {
      expect(writeFile).toHaveBeenCalledWith(
        'C:\\workspace\\project\\demo.ts',
        'const demo = true',
      )
      expect(onSaveSuccess).toHaveBeenCalledOnce()
    })
  })

  it('does not notify the caller when saving fails', async () => {
    const writeFile = vi.fn().mockResolvedValue({ success: false, error: 'disk full' })
    const onSaveSuccess = vi.fn()
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: { fileSystem: { writeFile } },
    })

    render(
      <TextFileEditor
        filePath="/tmp/demo.ts"
        content="const demo = true"
        onSaveSuccess={onSaveSuccess}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'save' }))

    await waitFor(() => {
      expect(writeFile).toHaveBeenCalledOnce()
      expect(onSaveSuccess).not.toHaveBeenCalled()
    })
  })

  it('forwards initialLine to Monaco for editable editors (search jump path)', async () => {
    render(
      <TextFileEditor
        filePath="/tmp/demo.ts"
        content={'line1\nline2\nline3\n'}
        initialLine={3}
        initialLineKey={42}
      />,
    )

    const editor = await screen.findByTestId('code-editor')
    expect(editor.getAttribute('data-read-only')).toBe('false')
    expect(editor.getAttribute('data-initial-line')).toBe('3')
    expect(editor.getAttribute('data-initial-line-key')).toBe('42')
  })

  it('forwards initialLine to Monaco for read-only editors', async () => {
    render(
      <TextFileEditor
        filePath="/tmp/demo.ts"
        content={'line1\nline2\nline3\n'}
        readOnly
        initialLine={2}
        initialLineKey={7}
      />,
    )

    const editor = await screen.findByTestId('code-editor')
    expect(editor.getAttribute('data-read-only')).toBe('true')
    expect(editor.getAttribute('data-initial-line')).toBe('2')
    expect(editor.getAttribute('data-initial-line-key')).toBe('7')
  })

  it('forwards findRequest to Monaco for editable editors', async () => {
    render(
      <TextFileEditor
        filePath="/tmp/demo.ts"
        content={'alpha\nneedle\nomega\n'}
        initialLine={2}
        initialLineKey={9}
        findRequest={{
          query: 'needle',
          key: 9,
          preferOccurrence: { line: 2 },
        }}
      />,
    )

    const editor = await screen.findByTestId('code-editor')
    expect(editor.getAttribute('data-find-query')).toBe('needle')
    expect(editor.getAttribute('data-find-key')).toBe('9')
  })

  it('forwards the optional Git gutter baseline without enabling it by default', async () => {
    const { rerender } = render(
      <TextFileEditor
        filePath="/tmp/demo.ts"
        content="changed\n"
      />,
    )

    let editor = await screen.findByTestId('code-editor')
    expect(editor.getAttribute('data-git-gutter-revision')).toBe('')

    rerender(
      <TextFileEditor
        filePath="/tmp/demo.ts"
        content="changed\n"
        gitGutterBaseline={{ content: 'original\n', revision: 3 }}
      />,
    )

    editor = await screen.findByTestId('code-editor')
    expect(editor.getAttribute('data-git-gutter-revision')).toBe('3')

    rerender(
      <TextFileEditor
        filePath="/tmp/demo.ts"
        content="changed\n"
        gitGutterBaseline={null}
      />,
    )
    editor = await screen.findByTestId('code-editor')
    expect(editor.getAttribute('data-git-gutter-revision')).toBe('')
  })

  it('keeps a successful save successful when the notification callback throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const writeFile = vi.fn().mockResolvedValue({ success: true })
    const onStateChange = vi.fn()
    const onSaveSuccess = vi.fn(() => {
      throw new Error('refresh failed')
    })
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: { fileSystem: { writeFile } },
    })

    render(
      <TextFileEditor
        filePath="/tmp/demo.ts"
        content="const demo = true"
        onStateChange={onStateChange}
        onSaveSuccess={onSaveSuccess}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'save' }))

    await waitFor(() => {
      expect(onSaveSuccess).toHaveBeenCalledOnce()
      expect(onStateChange.mock.calls.some(([state]) => state.status === 'saved')).toBe(true)
      expect(onStateChange.mock.calls.some(([state]) => state.status === 'error')).toBe(false)
    })
  })
})
