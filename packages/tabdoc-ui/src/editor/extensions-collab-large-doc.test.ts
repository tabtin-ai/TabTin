import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const editorDir = dirname(fileURLToPath(import.meta.url))

describe('TabDoc collaborative editor extensions', () => {
  it('does not configure CharacterCount with a hard limit that blocks large collaborative sync', () => {
    const source = readFileSync(resolve(editorDir, 'extensions.ts'), 'utf8')

    expect(source).not.toMatch(/CharacterCount\.configure\(\s*\{[\s\S]*?\blimit\s*:/)
  })

  it('passes the real collaboration user into CollaborationCursor', () => {
    const source = readFileSync(resolve(editorDir, 'collaboration-extensions.ts'), 'utf8')

    expect(source).toContain('CollaborationCursor.configure({')
    expect(source).toMatch(/\bprovider,\s*\n\s*user,\s*\n\s*render:/)
    expect(source).toContain('id: string')
    expect(source).toContain('label.textContent = name')
  })

  it('disables StarterKit history when realtime collab is live ', () => {
    const viewState = readFileSync(resolve(editorDir, 'useDocEditorViewState.ts'), 'utf8')
    const extensions = readFileSync(resolve(editorDir, 'extensions.ts'), 'utf8')

    expect(extensions).toContain('disableHistory?: boolean')
    expect(extensions).toContain('starterKit.configure({ history: false })')
    expect(viewState).toContain('disableHistory: collabLive')
  })

  it('keeps collaboration cursor styling scoped to the TabDoc editor', () => {
    const source = readFileSync(resolve(editorDir, 'prosemirror.css'), 'utf8')

    expect(source).toContain('.ProseMirror .tabdoc-collaboration-cursor__caret')
    expect(source).toContain('.ProseMirror .tabdoc-collaboration-cursor__label')
  })
})

