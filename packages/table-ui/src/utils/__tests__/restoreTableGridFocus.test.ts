import { afterEach, describe, expect, it, vi } from 'vitest'
import { restoreTableGridFocus } from '../restoreTableGridFocus'

describe('restoreTableGridFocus', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('prefers the focus-trap input inside data-t-grid-view on the next frame', async () => {
    const view = document.createElement('div')
    view.setAttribute('data-t-grid-view', '')
    const grid = document.createElement('div')
    grid.setAttribute('data-t-grid-container', '')
    grid.tabIndex = 0
    const trap = document.createElement('input')
    trap.setAttribute('data-grid-focus-trap', '')
    grid.appendChild(trap)
    view.appendChild(grid)
    document.body.appendChild(view)

    const trapFocusSpy = vi.spyOn(trap, 'focus')
    const gridFocusSpy = vi.spyOn(grid, 'focus')

    restoreTableGridFocus()
    expect(trapFocusSpy).not.toHaveBeenCalled()

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(trapFocusSpy).toHaveBeenCalledWith({ preventScroll: true })
    expect(gridFocusSpy).not.toHaveBeenCalled()
  })

  it('falls back to data-t-grid-container when focus-trap is absent', async () => {
    const grid = document.createElement('div')
    grid.setAttribute('data-t-grid-container', '')
    grid.tabIndex = 0
    document.body.appendChild(grid)

    const focusSpy = vi.spyOn(grid, 'focus')

    restoreTableGridFocus()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('no-ops when no grid container exists', () => {
    expect(() => restoreTableGridFocus()).not.toThrow()
  })
})
