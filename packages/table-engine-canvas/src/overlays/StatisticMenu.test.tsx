import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { StatisticMenu } from './StatisticMenu'
import { StatFunc } from './statistics'
import { useGridOverlayStore } from './store'

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = []

afterEach(() => {
  act(() => {
    useGridOverlayStore.getState().closeStatisticMenu()
    for (const { root, container } of mountedRoots.splice(0)) {
      root.unmount()
      container.remove()
    }
  })
})

describe('StatisticMenu owner isolation', () => {
  it('only renders and dispatches through the grid that opened the menu', () => {
    const ownerASelect = vi.fn()
    const ownerBSelect = vi.fn()

    for (const [ownerId, onSelect] of [
      ['grid-a', ownerASelect],
      ['grid-b', ownerBSelect],
    ] as const) {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      mountedRoots.push({ root, container })
      act(() => {
        root.render(
          <StatisticMenu ownerId={ownerId} onSelect={onSelect} />,
        )
      })
    }

    act(() => {
      useGridOverlayStore.getState().openStatisticMenu({
        ownerId: 'grid-a',
        field: 'title',
        fieldName: '标题',
        fieldType: 'text',
        position: {
          x: 20,
          y: 40,
          width: 120,
          height: 32,
          coordinateSpace: 'client',
        },
      })
    })

    const menus = document.querySelectorAll(
      '[data-grid-overlay="statistic-menu"]',
    )
    expect(menus).toHaveLength(1)
    expect(menus[0]?.getAttribute('data-grid-overlay-owner')).toBe('grid-a')

    const countButton = Array.from(menus[0]!.querySelectorAll('button')).find(
      (button) => button.textContent === 'Count',
    )
    expect(countButton).toBeDefined()

    act(() => {
      countButton!.click()
    })

    expect(ownerASelect).toHaveBeenCalledWith('title', StatFunc.Count)
    expect(ownerBSelect).not.toHaveBeenCalled()
  })
})
