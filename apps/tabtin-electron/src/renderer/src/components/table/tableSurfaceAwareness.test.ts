import { beforeEach, describe, expect, it } from 'vitest'

import {
  claimTableSurfaceAwareness,
  releaseTableSurfaceAwareness,
  resetTableSurfaceAwarenessForTests,
} from './tableSurfaceAwareness'

describe('TabData surface awareness ownership', () => {
  beforeEach(() => resetTableSurfaceAwarenessForTests())

  it('旧 surface 在新 surface 接管后不能清除新 surface 的光标', () => {
    claimTableSurfaceAwareness('table-1', 'surface-A')
    claimTableSurfaceAwareness('table-1', 'surface-B')

    expect(releaseTableSurfaceAwareness('table-1', 'surface-A')).toBe(false)
    expect(releaseTableSurfaceAwareness('table-1', 'surface-B')).toBe(true)
  })

  it('不同表的 surface owner 互不影响', () => {
    claimTableSurfaceAwareness('table-1', 'surface-A')
    claimTableSurfaceAwareness('table-2', 'surface-B')

    expect(releaseTableSurfaceAwareness('table-1', 'surface-A')).toBe(true)
    expect(releaseTableSurfaceAwareness('table-2', 'surface-B')).toBe(true)
  })
})
