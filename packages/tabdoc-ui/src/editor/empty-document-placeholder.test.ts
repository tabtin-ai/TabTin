import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readEditorSource(fileName: string): string {
  return readFileSync(fileURLToPath(new URL(fileName, import.meta.url)), 'utf8')
}

describe('TabDoc empty-document placeholder contract', () => {
  it('wires the placeholder into both editable document surfaces', () => {
    const sharedEditor = readEditorSource('useDocEditorViewState.ts')
    const standaloneEditor = readEditorSource('DocStandaloneEditor.tsx')

    expect(sharedEditor).toContain('createEmptyDocumentPlaceholder(')
    expect(standaloneEditor).toContain('createEmptyDocumentPlaceholder(t)')
  })

  it('limits guidance to editable documents whose whole body is empty', () => {
    const extensions = readEditorSource('extensions.ts')
    const styles = readEditorSource('prosemirror.css')

    expect(extensions).toContain('isPristineEmptyDocumentBody(editor.state.doc)')
    expect(extensions).toContain('includeChildren: false')
    expect(extensions).toContain('showOnlyWhenEditable: true')
    expect(styles).toContain('.ProseMirror .is-editor-empty:first-child::before')
    expect(styles).not.toContain('.ProseMirror p.is-empty::before')
  })

  it('uses the agreed localized guidance', () => {
    const zh = JSON.parse(readEditorSource('../locales/zh-CN.json')) as Record<string, string>
    const en = JSON.parse(readEditorSource('../locales/en-US.json')) as Record<string, string>

    expect(zh.editorPlaceholder).toBe('输入“/”快速插入内容')
    expect(en.editorPlaceholder).toBe('Type "/" to quickly insert content')
  })
})
