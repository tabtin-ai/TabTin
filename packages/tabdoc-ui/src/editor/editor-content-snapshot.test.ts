import { describe, expect, it, vi } from 'vitest'

import {
  pmJsonContainsStableImageAssets,
  snapshotEditorContentWithRepair,
} from './editor-content-snapshot'

describe('editor content snapshot private images', () => {
  it('detects stable image file identity recursively', () => {
    expect(pmJsonContainsStableImageAssets({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'image', attrs: { fileId: 'file-1', src: '' } }],
      }],
    })).toBe(true)
  })

  it('derives markdown from PM JSON when markdown storage drops private images', () => {
    const fileId = '802cf8e7-08fc-4619-9145-a37b201fb877'
    const pmJson = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'image',
          attrs: { fileId, src: '', alt: 'private' },
        }],
      }],
    }
    const editor = {
      getJSON: vi.fn(() => pmJson),
      storage: { markdown: { getMarkdown: vi.fn(() => '') } },
      commands: { setContent: vi.fn() },
    }

    const snapshot = snapshotEditorContentWithRepair(editor as never)

    expect(snapshot.markdown).toContain(`tabtin-file://asset/${fileId}`)
    expect(editor.storage.markdown.getMarkdown).not.toHaveBeenCalled()
  })
})
