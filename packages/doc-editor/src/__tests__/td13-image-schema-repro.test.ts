import { describe, it, expect } from 'vitest'
import { getSchema, Node as TiptapNode } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import * as Y from 'yjs'
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from 'y-prosemirror'
import type { Schema } from '@tiptap/pm/model'

/**
 * TD-13 — AI-written images vanish from the live editor but survive in version
 * history ().
 *
 * Root cause: the live editor's image node was BLOCK level (tabdoc-ui `docImage`
 * inherited @tiptap/extension-image default `inline:false`). The backend
 * converter + serverSchema produce INLINE images nested inside paragraphs
 * (Markdown `![](url)` is inline; serverSchema image is `group:'inline'`). When
 * the editor loads the collab binary, a block image cannot live inside a
 * paragraph (content = inline*), so ProseMirror rejects it and the image is
 * dropped — the doc the user sees diverges from what was written.
 *
 * Fix (this PR): configure the editor image node as INLINE
 * (`docImage.configure({ inline: true })`), matching serverSchema and the
 * Markdown/history representation. Then an inline image inside a paragraph is a
 * valid structure and survives — no data migration required.
 *
 * This harness mirrors both schemas and shows:
 *  - block-image editor schema → inline-image-in-paragraph is LOST (the bug)
 *  - inline-image editor schema → inline-image-in-paragraph SURVIVES (the fix)
 */

const imageAttrs = () => ({ src: { default: null }, alt: { default: null }, title: { default: null } })

// Old editor: @tiptap/extension-image default (block).
const BlockImage = TiptapNode.create({ name: 'image', group: 'block', inline: false, addAttributes: imageAttrs })
// Fixed editor: docImage.configure({ inline: true }).
const InlineImage = TiptapNode.create({ name: 'image', group: 'inline', inline: true, addAttributes: imageAttrs })

const blockEditorSchema = getSchema([StarterKit as never, BlockImage as never])
const inlineEditorSchema = getSchema([StarterKit as never, InlineImage as never])

/**
 * Round-trip pm_json through Y.js the way collab does, then re-materialize it
 * with the given editor schema (validating content), returning surviving JSON.
 */
function throughEditorSchema(schema: Schema, pmJson: Record<string, unknown>): string {
  const ydoc = new Y.Doc()
  try {
    const fragment = ydoc.getXmlFragment('default')
    const node = schema.nodeFromJSON(pmJson)
    node.check() // throws if the structure is illegal for this schema
    prosemirrorJSONToYXmlFragment(schema, node.toJSON(), fragment)
    return JSON.stringify(yXmlFragmentToProsemirrorJSON(fragment))
  } finally {
    ydoc.destroy()
  }
}

describe('TD-13 image schema', () => {
  const INLINE_IN_PARAGRAPH = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'image', attrs: { src: 'https://x/cat.jpg', alt: 'cat', title: null } }],
      },
    ],
  }

  it('reproduces the bug: a block-image editor schema rejects an inline image in a paragraph', () => {
    expect(() => throughEditorSchema(blockEditorSchema, INLINE_IN_PARAGRAPH)).toThrow()
  })

  it('the fix: an inline-image editor schema keeps the image inside the paragraph', () => {
    const out = throughEditorSchema(inlineEditorSchema, INLINE_IN_PARAGRAPH)
    expect(out).toContain('cat.jpg')
    // image stays nested as inline content of the paragraph, not lifted to a block.
    const doc = JSON.parse(out)
    expect(doc.content[0].type).toBe('paragraph')
    expect(doc.content[0].content[0].type).toBe('image')
  })
})
