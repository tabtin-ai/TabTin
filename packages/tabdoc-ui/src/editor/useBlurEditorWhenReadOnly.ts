import { useEffect, type RefObject } from 'react'

interface BlurCapableEditor {
  isFocused: boolean
  commands: {
    blur: () => boolean
  }
}

/**
 * Entering readonly mode must also release the local caret. Calling Tiptap's
 * blur command while another control is focused would clear that control's
 * browser selection, so only blur when the editor itself owns focus.
 */
export function useBlurEditorWhenReadOnly(
  readOnly: boolean,
  editorRef: RefObject<BlurCapableEditor | null>,
): void {
  useEffect(() => {
    const editor = editorRef.current
    if (!readOnly || !editor?.isFocused) return
    editor.commands.blur()
  }, [editorRef, readOnly])
}
