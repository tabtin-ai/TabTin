/**
 * configureSurfaceRuntime / getSurfaceContext 测试。
 *
 * 覆盖：
 *   - 未配置时 getSurfaceContext 抛错
 *   - 配置后能取到正确的 ctx
 *   - 多次配置，后者覆盖前者
 *   - _clearSurfaceRuntime 清空后再次抛错
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  configureSurfaceRuntime,
  getSurfaceContext,
  _clearSurfaceRuntime,
} from '../configure-surface-runtime.js'
import type { SurfaceContext } from '../types.js'

const _mockDjangoRequest = vi.fn()

beforeEach(() => {
  _clearSurfaceRuntime()
})

describe('configureSurfaceRuntime / getSurfaceContext', () => {
  it('未配置时 getSurfaceContext 抛错', () => {
    expect(() => getSurfaceContext()).toThrow('configureSurfaceRuntime')
  })

  it('配置后能取到正确的上下文', () => {
    const ctx: SurfaceContext = {
      djangoRequest: _mockDjangoRequest,
      spaceId: 'space-42',
    }
    configureSurfaceRuntime(ctx)

    const got = getSurfaceContext()
    expect(got.spaceId).toBe('space-42')
    expect(got.djangoRequest).toBe(_mockDjangoRequest)
  })

  it('多次配置，后者覆盖前者', () => {
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: 'old-space',
    })
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: 'new-space',
    })

    expect(getSurfaceContext().spaceId).toBe('new-space')
  })

  it('_clearSurfaceRuntime 清空后再次抛错', () => {
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: 'space-1',
    })
    expect(() => getSurfaceContext()).not.toThrow()

    _clearSurfaceRuntime()
    expect(() => getSurfaceContext()).toThrow('configureSurfaceRuntime')
  })

  it('spaceId 可以是 null', () => {
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: null,
    })

    expect(getSurfaceContext().spaceId).toBeNull()
  })
})
