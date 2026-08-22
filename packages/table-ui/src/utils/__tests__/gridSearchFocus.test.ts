import { afterEach, describe, expect, it } from 'vitest'
import {
  GRID_SEARCH_INPUT_ATTR,
  GRID_SEARCH_INPUT_VALUE,
  isGridSearchInputFocused,
  shouldActivateGridForSearchMatch,
} from '../gridSearchFocus'

describe('grid search focus helpers', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('detects when the table search input owns focus', () => {
    const input = document.createElement('input')
    input.setAttribute(GRID_SEARCH_INPUT_ATTR, GRID_SEARCH_INPUT_VALUE)
    document.body.appendChild(input)

    input.focus()

    expect(isGridSearchInputFocused()).toBe(true)
    expect(shouldActivateGridForSearchMatch()).toBe(false)
  })

  it('allows grid activation when focus is outside the table search input', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)

    input.focus()

    expect(isGridSearchInputFocused()).toBe(false)
    expect(shouldActivateGridForSearchMatch()).toBe(true)
  })

  it('uses an explicit active element when provided', () => {
    const input = document.createElement('input')
    input.setAttribute(GRID_SEARCH_INPUT_ATTR, GRID_SEARCH_INPUT_VALUE)

    expect(isGridSearchInputFocused(input)).toBe(true)
    expect(shouldActivateGridForSearchMatch(input)).toBe(false)
  })
})
