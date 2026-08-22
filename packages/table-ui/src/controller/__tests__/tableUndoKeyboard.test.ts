import { afterEach, describe, expect, it } from 'vitest'
import {
  GRID_FOCUS_TRAP_ATTR,
  isDocumentFallbackFocus,
  shouldDeferTableUndoToNativeEditor,
  shouldHandleTableUndoShortcut,
} from '../tableUndoKeyboard'

describe('shouldDeferTableUndoToNativeEditor', () => {
  it('allows table undo when focus is on the grid focus-trap input', () => {
    const input = document.createElement('input')
    input.setAttribute(GRID_FOCUS_TRAP_ATTR, '')
    expect(shouldDeferTableUndoToNativeEditor(input)).toBe(false)
  })

  it('defers to native undo for ordinary inputs and textareas', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    expect(shouldDeferTableUndoToNativeEditor(input)).toBe(true)
    expect(shouldDeferTableUndoToNativeEditor(textarea)).toBe(true)
  })

  it('defers inside code editors and data-no-table-undo regions', () => {
    const host = document.createElement('div')
    host.className = 'cm-editor'
    const nested = document.createElement('div')
    host.appendChild(nested)
    expect(shouldDeferTableUndoToNativeEditor(nested)).toBe(true)

    const blocked = document.createElement('div')
    blocked.setAttribute('data-no-table-undo', '')
    const child = document.createElement('span')
    blocked.appendChild(child)
    expect(shouldDeferTableUndoToNativeEditor(child)).toBe(true)
  })

  it('allows table undo for ordinary container/div focus', () => {
    const div = document.createElement('div')
    div.tabIndex = 0
    expect(shouldDeferTableUndoToNativeEditor(div)).toBe(false)
  })
})

describe('shouldHandleTableUndoShortcut (fill → Cmd+Z path)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('handles undo when focus is on the post-fill focus-trap inside the pane', () => {
    const pane = document.createElement('div')
    const grid = document.createElement('div')
    grid.setAttribute('data-t-grid-container', '')
    const trap = document.createElement('input')
    trap.setAttribute(GRID_FOCUS_TRAP_ATTR, '')
    grid.appendChild(trap)
    pane.appendChild(grid)
    document.body.appendChild(pane)
    trap.focus()

    expect(
      shouldHandleTableUndoShortcut({
        activeElement: document.activeElement,
        eventTarget: trap,
        container: pane,
      }),
    ).toBe(true)
  })

  it('handles undo when focus leaked to body after fill preventDefault (active pane)', () => {
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    expect(isDocumentFallbackFocus(document.body)).toBe(true)
    expect(
      shouldHandleTableUndoShortcut({
        activeElement: document.body,
        eventTarget: document.body,
        container: pane,
        isActive: true,
      }),
    ).toBe(true)
  })

  it('ignores body-focus undo when the table pane is not the active tab', () => {
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    expect(
      shouldHandleTableUndoShortcut({
        activeElement: document.body,
        eventTarget: document.body,
        container: pane,
        isActive: false,
      }),
    ).toBe(false)
  })

  it('ignores undo when focus is in an outside editor (e.g. chat composer)', () => {
    const pane = document.createElement('div')
    const chat = document.createElement('textarea')
    document.body.appendChild(pane)
    document.body.appendChild(chat)
    chat.focus()

    expect(
      shouldHandleTableUndoShortcut({
        activeElement: document.activeElement,
        eventTarget: chat,
        container: pane,
        isActive: true,
      }),
    ).toBe(false)
  })

  it('still defers to native undo while editing an ordinary cell input', () => {
    const pane = document.createElement('div')
    const editor = document.createElement('textarea')
    pane.appendChild(editor)
    document.body.appendChild(pane)
    editor.focus()

    expect(
      shouldHandleTableUndoShortcut({
        activeElement: document.activeElement,
        eventTarget: editor,
        container: pane,
      }),
    ).toBe(false)
  })

  it('handles undo when focus sits on idle cell-editor textarea after fill', () => {
    const pane = document.createElement('div')
    const overlay = document.createElement('div')
    overlay.setAttribute('data-grid-overlay', 'cell-editor')
    overlay.setAttribute('data-grid-editing', 'false')
    const editor = document.createElement('textarea')
    overlay.appendChild(editor)
    pane.appendChild(overlay)
    document.body.appendChild(pane)
    editor.focus()

    expect(shouldDeferTableUndoToNativeEditor(editor)).toBe(false)
    expect(
      shouldHandleTableUndoShortcut({
        activeElement: document.activeElement,
        eventTarget: editor,
        container: pane,
        isActive: true,
      }),
    ).toBe(true)
  })

  it('defers to native undo when cell-editor is actively editing', () => {
    const pane = document.createElement('div')
    const overlay = document.createElement('div')
    overlay.setAttribute('data-grid-overlay', 'cell-editor')
    overlay.setAttribute('data-grid-editing', 'true')
    const editor = document.createElement('textarea')
    overlay.appendChild(editor)
    pane.appendChild(overlay)
    document.body.appendChild(pane)
    editor.focus()

    expect(shouldDeferTableUndoToNativeEditor(editor)).toBe(true)
    expect(
      shouldHandleTableUndoShortcut({
        activeElement: document.activeElement,
        eventTarget: editor,
        container: pane,
        isActive: true,
      }),
    ).toBe(false)
  })
})
