import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { SelectChoicesEditor } from './select-choices-editor'
import type { SelectChoiceOption } from '../../utils/choice-colors'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView = vi.fn()

describe('SelectChoicesEditor', () => {
  it('lets the user choose a preset color without changing the option value', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    let latest: SelectChoiceOption[] = [
      { value: 'P0', label: 'P0', color: '#0066CC' },
    ]

    const Harness = () => {
      const [choices, setChoices] = React.useState(latest)
      return (
        <SelectChoicesEditor
          choices={choices}
          onChange={(next) => {
            latest = next
            setChoices(next)
          }}
        />
      )
    }

    act(() => root.render(<Harness />))

    const swatch = container.querySelector('button[aria-haspopup="dialog"]')
    expect(swatch).not.toBeNull()
    act(() => swatch!.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const red = document.body.querySelector('button[role="option"][aria-label="#D90A19"]')
    expect(red).not.toBeNull()
    act(() => red!.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(latest).toEqual([{ value: 'P0', label: 'P0', color: '#D90A19' }])
    expect(document.body.querySelector('button[role="option"][aria-label="#D90A19"]')).toBeNull()

    const input = container.querySelector('input')
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      valueSetter?.call(input, 'Critical')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(latest).toEqual([{ value: 'Critical', label: 'Critical', color: '#D90A19' }])

    act(() => root.unmount())
    container.remove()
  })
})
