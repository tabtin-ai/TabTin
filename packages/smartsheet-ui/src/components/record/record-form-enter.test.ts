import { describe, expect, it } from 'vitest'
import { shouldRecordFormDeferEnter } from './record-form-enter'

describe('shouldRecordFormDeferEnter', () => {
  it('defers Enter for cmdk search input (select / multi_select overlay)', () => {
    const wrapper = document.createElement('div')
    wrapper.setAttribute('cmdk-input-wrapper', '')
    const input = document.createElement('input')
    input.setAttribute('cmdk-input', '')
    input.type = 'text'
    wrapper.appendChild(input)
    document.body.appendChild(wrapper)

    expect(shouldRecordFormDeferEnter(input)).toBe(true)
    wrapper.remove()
  })

  it('defers Enter for cmdk option items', () => {
    const item = document.createElement('div')
    item.setAttribute('cmdk-item', '')
    item.setAttribute('role', 'option')
    document.body.appendChild(item)

    expect(shouldRecordFormDeferEnter(item)).toBe(true)
    item.remove()
  })

  it('does not defer Enter for ordinary text inputs (form submit shortcut)', () => {
    const input = document.createElement('input')
    input.type = 'text'
    document.body.appendChild(input)

    expect(shouldRecordFormDeferEnter(input)).toBe(false)
    input.remove()
  })

  it('defers Enter for textarea', () => {
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    expect(shouldRecordFormDeferEnter(textarea)).toBe(true)
    textarea.remove()
  })

  it('defers Enter when isContentEditable is true', () => {
    const editable = document.createElement('div')
    Object.defineProperty(editable, 'isContentEditable', {
      configurable: true,
      get: () => true,
    })
    expect(shouldRecordFormDeferEnter(editable)).toBe(true)
  })
})

