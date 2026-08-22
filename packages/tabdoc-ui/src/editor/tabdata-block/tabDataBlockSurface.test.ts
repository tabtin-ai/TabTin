import { describe, expect, it } from 'vitest'

import { resolveTabDataBlockSurfaceState } from './tabDataBlockSurface'

describe('TabData block surface lifecycle', () => {
  it('父 TabDoc 隐藏时，即使 IntersectionObserver 仍命中也不渲染嵌入运行时', () => {
    expect(resolveTabDataBlockSurfaceState({
      inViewport: true,
      hostVisible: false,
      paneActive: false,
    })).toEqual({ shouldRender: false, isInteractive: false })
  })

  it('可见但未激活的 pane 保留渲染，不取得交互与 awareness 所有权', () => {
    expect(resolveTabDataBlockSurfaceState({
      inViewport: true,
      hostVisible: true,
      paneActive: false,
    })).toEqual({ shouldRender: true, isInteractive: false })
  })

  it('进入缓冲视口且宿主活跃时才同时渲染并可交互', () => {
    expect(resolveTabDataBlockSurfaceState({
      inViewport: true,
      hostVisible: true,
      paneActive: true,
    })).toEqual({ shouldRender: true, isInteractive: true })
  })
})
