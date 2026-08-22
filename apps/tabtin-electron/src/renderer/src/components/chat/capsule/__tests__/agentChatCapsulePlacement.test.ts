import { describe, expect, it } from 'vitest'
import { SHELL_TOP_BAR_HEIGHT } from '@shared/shell-top-bar-layout'
import {
  DEFAULT_CAPSULE_PLACEMENT,
  capsulePositionToPlacement,
  clampCapsulePosition,
  normalizeCapsulePlacement,
  resolveCapsuleDockTarget,
  resolveCapsulePosition,
  resolveCapsulePositionBounds,
  resolveOverlayGeometry,
} from '../agentChatCapsulePlacement'

const viewport = { width: 1000, height: 800 }
const capsuleSize = { width: 200, height: 48 }

describe('agentChatCapsulePlacement', () => {
  it('默认停靠右下，并规范化非法持久值', () => {
    expect(DEFAULT_CAPSULE_PLACEMENT).toEqual({ side: 'right', yRatio: 1 })
    expect(normalizeCapsulePlacement(undefined)).toEqual(
      DEFAULT_CAPSULE_PLACEMENT,
    )
    expect(
      normalizeCapsulePlacement({ side: 'middle', yRatio: Number.NaN }),
    ).toEqual(DEFAULT_CAPSULE_PLACEMENT)
    expect(normalizeCapsulePlacement({ side: 'left', yRatio: -2 })).toEqual({
      side: 'left',
      yRatio: 0,
    })
    expect(normalizeCapsulePlacement({ side: 'right', yRatio: 3 })).toEqual({
      side: 'right',
      yRatio: 1,
    })
  })

  it('把左右停靠与纵向比例解析为合法绝对坐标', () => {
    const bounds = resolveCapsulePositionBounds(viewport, capsuleSize)

    expect(bounds).toEqual({
      minX: 20,
      maxX: 780,
      minY: SHELL_TOP_BAR_HEIGHT + 20,
      maxY: 732,
    })
    expect(
      resolveCapsulePosition(
        { side: 'left', yRatio: 0 },
        viewport,
        capsuleSize,
      ),
    ).toEqual({ x: 20, y: SHELL_TOP_BAR_HEIGHT + 20 })
    expect(
      resolveCapsulePosition(
        { side: 'right', yRatio: 1 },
        viewport,
        capsuleSize,
      ),
    ).toEqual({ x: 780, y: 732 })
  })

  it('clamp 与绝对坐标归一化共用同一组边界', () => {
    expect(
      clampCapsulePosition({ x: -100, y: 900 }, viewport, capsuleSize),
    ).toEqual({ x: 20, y: 732 })
    expect(
      capsulePositionToPlacement({ x: 10, y: 400.5 }, viewport, capsuleSize),
    ).toEqual({ side: 'left', yRatio: 0.5 })
    expect(
      capsulePositionToPlacement({ x: 900, y: 400.5 }, viewport, capsuleSize),
    ).toEqual({ side: 'right', yRatio: 0.5 })
  })

  it('小窗口放宽安全边距；能避开顶栏时仍不遮挡顶栏', () => {
    const tightBounds = resolveCapsulePositionBounds(
      { width: 210, height: 100 },
      capsuleSize,
    )
    expect(tightBounds).toEqual({
      minX: 0,
      maxX: 10,
      minY: SHELL_TOP_BAR_HEIGHT,
      maxY: 52,
    })

    const impossibleBounds = resolveCapsulePositionBounds(
      { width: 120, height: 70 },
      capsuleSize,
    )
    expect(impossibleBounds).toEqual({
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 22,
    })
    expect(
      resolveCapsulePosition(
        DEFAULT_CAPSULE_PLACEMENT,
        { width: 120, height: 70 },
        capsuleSize,
      ),
    ).toEqual({ x: 0, y: 22 })
  })

  it('释放位置决定最近停靠侧，速度投影可把目标甩到另一侧', () => {
    expect(
      resolveCapsuleDockTarget({
        position: { x: 200, y: 300 },
        velocity: { x: 0, y: 0 },
        viewport,
        capsuleSize,
      }).placement.side,
    ).toBe('left')
    expect(
      resolveCapsuleDockTarget({
        position: { x: 600, y: 300 },
        velocity: { x: 0, y: 0 },
        viewport,
        capsuleSize,
      }).placement.side,
    ).toBe('right')

    const flingLeft = resolveCapsuleDockTarget({
      position: { x: 600, y: 300 },
      velocity: { x: -3000, y: 1000 },
      viewport,
      capsuleSize,
    })
    expect(flingLeft.placement.side).toBe('left')
    expect(flingLeft.placement.yRatio).toBeGreaterThan(0.6)
    expect(flingLeft.position.x).toBe(20)

    const flingRight = resolveCapsuleDockTarget({
      position: { x: 200, y: 300 },
      velocity: { x: 3000, y: -1000 },
      viewport,
      capsuleSize,
    })
    expect(flingRight.placement.side).toBe('right')
    expect(flingRight.placement.yRatio).toBeLessThan(0.2)
    expect(flingRight.position.x).toBe(780)
  })

  it('overlay 从左右胶囊锚点展开，并保持在视口安全区内', () => {
    const left = resolveOverlayGeometry({
      viewport,
      overlaySize: { width: 420, height: 560 },
      capsuleRect: { x: 20, y: 300, width: 200, height: 48 },
      side: 'left',
    })
    expect(left).toMatchObject({
      x: 20,
      y: 69,
      width: 420,
      height: 560,
      transformOrigin: { x: 0, y: 255 },
    })
    expect(left.transformOriginCss).toBe('0px 255px')

    const right = resolveOverlayGeometry({
      viewport,
      overlaySize: { width: 420, height: 560 },
      capsuleRect: { x: 780, y: 732, width: 200, height: 48 },
      side: 'right',
    })
    expect(right).toMatchObject({
      x: 560,
      y: 220,
      width: 420,
      height: 560,
      transformOrigin: { x: 420, y: 536 },
    })
    expect(right.transformOriginCss).toBe('420px 536px')
  })

  it('小窗口会收缩 overlay，且不越过顶栏或视口边缘', () => {
    const geometry = resolveOverlayGeometry({
      viewport: { width: 180, height: 120 },
      overlaySize: { width: 420, height: 560 },
      capsuleRect: { x: 0, y: 72, width: 200, height: 48 },
      side: 'right',
    })

    expect(geometry).toMatchObject({
      x: 0,
      y: 49,
      width: 180,
      height: 71,
    })
    expect(geometry.x + geometry.width).toBeLessThanOrEqual(180)
    expect(geometry.y).toBeGreaterThanOrEqual(SHELL_TOP_BAR_HEIGHT)
    expect(geometry.y + geometry.height).toBeLessThanOrEqual(120)
    expect(geometry.transformOrigin.x).toBeGreaterThanOrEqual(0)
    expect(geometry.transformOrigin.x).toBeLessThanOrEqual(geometry.width)
    expect(geometry.transformOrigin.y).toBeGreaterThanOrEqual(0)
    expect(geometry.transformOrigin.y).toBeLessThanOrEqual(geometry.height)
  })
})
