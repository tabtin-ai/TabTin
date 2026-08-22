import { createRef, useRef } from 'react'
import type { Editor } from '@tiptap/core'
import { EditorProvider } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useBlurEditorWhenReadOnly } from './useBlurEditorWhenReadOnly'

describe('useBlurEditorWhenReadOnly', () => {
  it('removes the local caret when a focused editor changes to readonly', async () => {
    let editor: Editor | null = null

    function Harness({ readOnly }: { readOnly: boolean }) {
      const editorRef = useRef<Editor | null>(null)
      useBlurEditorWhenReadOnly(readOnly, editorRef)

      return (
        <EditorProvider
          immediatelyRender={false}
          content={{ type: 'doc', content: [{ type: 'paragraph' }] }}
          extensions={[StarterKit]}
          editorProps={{ editable: () => !readOnly }}
          onCreate={({ editor: createdEditor }) => {
            editorRef.current = createdEditor
            editor = createdEditor
          }}
        />
      )
    }

    const view = render(<Harness readOnly={false} />)
    await waitFor(() => expect(editor).not.toBeNull())

    act(() => {
      editor!.commands.focus('end')
    })
    await waitFor(() => expect(document.activeElement).toBe(editor!.view.dom))

    view.rerender(<Harness readOnly />)

    await waitFor(() => expect(editor!.isEditable).toBe(false))
    await waitFor(() => expect(document.activeElement).not.toBe(editor!.view.dom))
  })

  it('does not disturb focus outside the editor', () => {
    const blur = vi.fn()
    const editorRef = createRef<{
      isFocused: boolean
      commands: { blur: () => boolean }
    }>()
    editorRef.current = { isFocused: false, commands: { blur } }

    renderHook(() => useBlurEditorWhenReadOnly(true, editorRef))

    expect(blur).not.toHaveBeenCalled()
  })
})
