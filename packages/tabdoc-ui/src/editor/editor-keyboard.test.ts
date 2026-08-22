import { Editor } from '@tiptap/core'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it } from 'vitest'

import {
  focusTitleFromBodyStart,
  insertCodeBlockTab,
  isBodyStartTitleNavigationKey,
} from './editor-keyboard'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
  },
})

function createBodyState(cursor: number, to = cursor): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, schema.text('正文')),
  ])
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, cursor, to),
  })
}

describe('TabDoc editor keyboard behavior', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('moves a collapsed cursor at the start of the body to the end of the title', () => {
    const title = document.createElement('textarea')
    title.value = '文档标题'
    document.body.append(title)

    expect(focusTitleFromBodyStart(createBodyState(1), title)).toBe(true)
    expect(document.activeElement).toBe(title)
    expect(title.selectionStart).toBe(title.value.length)
    expect(title.selectionEnd).toBe(title.value.length)
  })

  it('keeps Backspace inside the body when the cursor is not its absolute start', () => {
    const title = document.createElement('textarea')
    title.value = '文档标题'
    document.body.append(title)

    expect(focusTitleFromBodyStart(createBodyState(2), title)).toBe(false)
    expect(document.activeElement).not.toBe(title)
  })

  it('keeps range deletion inside the body even when the selection starts at position one', () => {
    const title = document.createElement('textarea')
    document.body.append(title)

    expect(focusTitleFromBodyStart(createBodyState(1, 2), title)).toBe(false)
    expect(document.activeElement).not.toBe(title)
  })

  it('does not move focus from a read-only body', () => {
    const title = document.createElement('textarea')
    document.body.append(title)

    expect(focusTitleFromBodyStart(createBodyState(1), title, false)).toBe(false)
    expect(document.activeElement).not.toBe(title)
  })

  it('supports Backspace and ArrowUp as title navigation keys at the body start', () => {
    expect(isBodyStartTitleNavigationKey(new KeyboardEvent('keydown', { key: 'Backspace' }))).toBe(true)
    expect(isBodyStartTitleNavigationKey(new KeyboardEvent('keydown', { key: 'ArrowUp' }))).toBe(true)
    expect(isBodyStartTitleNavigationKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(false)
    expect(isBodyStartTitleNavigationKey(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true }))).toBe(false)
    expect(isBodyStartTitleNavigationKey(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true }))).toBe(false)
  })

  it('inserts indentation when Tab is pressed in a code block', () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: {
        type: 'doc',
        content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'const value = 1' }] }],
      },
    })

    editor.commands.setTextSelection(1)

    expect(insertCodeBlockTab(editor)).toBe(true)
    expect(editor.getJSON()).toMatchObject({
      content: [{ type: 'codeBlock', content: [{ type: 'text', text: '\tconst value = 1' }] }],
    })

    editor.destroy()
  })

  it('indents a partially selected code line without replacing its content', () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: {
        type: 'doc',
        content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'const value = 1' }] }],
      },
    })

    editor.commands.setTextSelection({ from: 3, to: 8 })

    expect(insertCodeBlockTab(editor)).toBe(true)
    expect(editor.getText()).toBe('\tconst value = 1')

    editor.destroy()
  })

  it('indents every covered code line without deleting a multi-line selection', () => {
    const code = 'first line\nsecond line\nthird line'
    const editor = new Editor({
      extensions: [StarterKit],
      content: {
        type: 'doc',
        content: [{ type: 'codeBlock', content: [{ type: 'text', text: code }] }],
      },
    })

    editor.commands.setTextSelection({ from: 3, to: 25 })

    expect(insertCodeBlockTab(editor)).toBe(true)
    expect(editor.getText()).toBe('\tfirst line\n\tsecond line\n\tthird line')

    editor.destroy()
  })

  it('does not consume Tab in an ordinary paragraph', () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: '<p>正文</p>',
    })

    editor.commands.setTextSelection(1)

    expect(insertCodeBlockTab(editor)).toBe(false)
    expect(editor.getText()).toBe('正文')

    editor.destroy()
  })
})
