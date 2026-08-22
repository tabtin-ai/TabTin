import React, { act } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dragStart: vi.fn(),
  latestMotionProps: null as null | {
    onDragStart?: () => void
    onDragEnd?: (
      event: Event,
      info: {
        velocity: { x: number; y: number }
      },
    ) => void
  },
  motionValues: [] as Array<{
    get: () => number
    set: (value: number) => void
  }>,
}))

vi.mock('framer-motion', () => ({
  animate: (value: { set: (next: number) => void }, target: number) => {
    value.set(target)
    return { stop: vi.fn() }
  },
  useDragControls: () => ({ start: mocks.dragStart }),
  useReducedMotion: () => false,
  useMotionValue: (initial: number) => {
    const ref = React.useRef<{
      get: () => number
      set: (value: number) => void
    } | null>(null)
    if (!ref.current) {
      let current = initial
      ref.current = {
        get: () => current,
        set: (value: number) => {
          current = value
        },
      }
      mocks.motionValues.push(ref.current)
    }
    return ref.current
  },
  motion: {
    div: React.forwardRef<
      HTMLDivElement,
      React.HTMLAttributes<HTMLDivElement> & {
        drag?: boolean
        dragControls?: unknown
        dragListener?: boolean
        dragConstraints?: unknown
        dragElastic?: number
        dragMomentum?: boolean
        onDragStart?: () => void
        onDragEnd?: (
          event: Event,
          info: {
            velocity: { x: number; y: number }
          },
        ) => void
        style?: React.CSSProperties & { x?: unknown; y?: unknown }
      }
    >(
      (
        {
          children,
          drag: _drag,
          dragControls: _dragControls,
          dragListener: _dragListener,
          dragConstraints: _dragConstraints,
          dragElastic: _dragElastic,
          dragMomentum: _dragMomentum,
          onDragStart,
          onDragEnd,
          style,
          ...props
        },
        ref,
      ) => {
        mocks.latestMotionProps = { onDragStart, onDragEnd }
        const { x: _x, y: _y, ...domStyle } = style ?? {}
        return (
          <div ref={ref} style={domStyle} {...props}>
            {children}
          </div>
        )
      },
    ),
  },
}))

import {
  AgentChatCapsulePositioner,
  AgentChatOverlayPositioner,
} from '../AgentChatFloatingPositioners'

describe('AgentChatFloatingPositioners', () => {
  beforeEach(() => {
    mocks.dragStart.mockReset()
    mocks.latestMotionProps = null
    mocks.motionValues = []
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 200,
      height: 48,
      top: 0,
      right: 200,
      bottom: 48,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect)
    Object.defineProperty(window, 'innerWidth', {
      value: 1000,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(window, 'innerHeight', {
      value: 800,
      writable: true,
      configurable: true,
    })
  })

  it('初始按持久化偏好定位，并用 8px 阈值启动拖拽', () => {
    render(
      <AgentChatCapsulePositioner
        placement={{ side: 'right', yRatio: 1 }}
        onPlacementChange={() => {}}
        onActivate={() => {}}
      >
        {({ onActivate }) => (
          <button type="button" onClick={onActivate}>
            capsule
          </button>
        )}
      </AgentChatCapsulePositioner>,
    )

    expect(mocks.motionValues[0].get()).toBe(780)
    expect(mocks.motionValues[1].get()).toBe(732)

    fireEvent.pointerDown(screen.getByText('capsule'), {
      button: 0,
      isPrimary: true,
    })
    expect(mocks.dragStart).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        distanceThreshold: 8,
        snapToCursor: false,
      }),
    )
  })

  it('为共享元素动画解析真实尺寸下的最终停靠矩形', () => {
    render(
      <AgentChatCapsulePositioner
        placement={{ side: 'right', yRatio: 1 }}
        onPlacementChange={() => {}}
        onActivate={() => {}}
      >
        {({ resolveMorphTargetRect }) => {
          const target = resolveMorphTargetRect({
            width: 320,
            height: 48,
          } as DOMRect)
          return (
            <div data-testid="morph-target">
              {target.left},{target.top},{target.width},{target.height}
            </div>
          )
        }}
      </AgentChatCapsulePositioner>,
    )

    expect(screen.getByTestId('morph-target').textContent).toBe(
      '660,732,320,48',
    )
  })

  it('释放时按速度投影吸附，并阻止拖拽结束产生的误点击', () => {
    vi.useFakeTimers()
    const onPlacementChange = vi.fn()
    const onActivate = vi.fn()

    render(
      <AgentChatCapsulePositioner
        placement={{ side: 'right', yRatio: 1 }}
        onPlacementChange={onPlacementChange}
        onActivate={onActivate}
      >
        {({ onActivate: activate }) => (
          <button type="button" onClick={activate}>
            capsule
          </button>
        )}
      </AgentChatCapsulePositioner>,
    )

    act(() => {
      mocks.latestMotionProps?.onDragStart?.()
      mocks.motionValues[0].set(600)
      mocks.motionValues[1].set(300)
      mocks.latestMotionProps?.onDragEnd?.(new Event('pointerup'), {
        velocity: { x: -3000, y: 1000 },
      })
    })

    expect(onPlacementChange).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'left' }),
    )
    fireEvent.click(screen.getByText('capsule'))
    expect(onActivate).not.toHaveBeenCalled()

    act(() => vi.runAllTimers())
    fireEvent.click(screen.getByText('capsule'))
    expect(onActivate).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('展开面板从胶囊所在边缘生成动态动画原点', () => {
    render(
      <AgentChatOverlayPositioner
        placement={{ side: 'left', yRatio: 0.4 }}
        capsuleSize={{ width: 200, height: 48 }}
      >
        {({ transformOrigin }) => (
          <div data-testid="overlay-origin">{transformOrigin}</div>
        )}
      </AgentChatOverlayPositioner>,
    )

    expect(screen.getByTestId('overlay-origin').textContent).toMatch(/^0px /)
  })
})
