import React, { useEffect } from 'react'
import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TurnEndLayoutProvider,
  useTurnEndLayout,
} from '../TurnEndLayoutContext'
import { useTurnEndLayoutController } from '../useTurnEndLayout'

function StreamingEdgeController({ isStreaming }: { isStreaming: boolean }) {
  const { snapshot, beginTurnEnd } = useTurnEndLayoutController()
  const wasStreamingRef = React.useRef(isStreaming)

  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      beginTurnEnd()
    }
    wasStreamingRef.current = isStreaming
  }, [beginTurnEnd, isStreaming])

  return (
    <div data-testid="phase" data-turn-end-phase={snapshot.phase}>
      {snapshot.phase}
      {snapshot.shouldHoldThinkingPreviewBudget ? '|hold' : ''}
    </div>
  )
}

function ConsumerProbe() {
  const layout = useTurnEndLayout()
  return (
    <div
      data-testid="consumer"
      data-phase={layout.phase}
      data-hold-thinking={String(layout.shouldHoldThinkingPreviewBudget)}
      data-hold-spacer={String(layout.shouldHoldClosingSpacer)}
    >
      {layout.phase}
    </div>
  )
}

describe('useTurnEndLayoutController', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('beginTurnEnd on streaming true→false and exposes hold flags', () => {
    const { rerender } = render(<StreamingEdgeController isStreaming={true} />)
    expect(screen.getByTestId('phase').getAttribute('data-turn-end-phase')).toBe('idle')

    rerender(<StreamingEdgeController isStreaming={false} />)
    expect(screen.getByTestId('phase').getAttribute('data-turn-end-phase')).toBe('committing')
    expect(screen.getByTestId('phase').textContent).toContain('|hold')
  })

  it('timer advances committing → settling → released → idle', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTurnEndLayoutController())

    act(() => {
      result.current.beginTurnEnd()
    })
    expect(result.current.snapshot.phase).toBe('committing')
    expect(result.current.snapshot.shouldHoldThinkingPreviewBudget).toBe(true)
    expect(result.current.snapshot.shouldHoldClosingSpacer).toBe(true)

    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(result.current.snapshot.phase).toBe('settling')

    act(() => {
      vi.advanceTimersByTime(120)
    })
    expect(result.current.snapshot.phase).toBe('released')
    expect(result.current.snapshot.shouldHoldThinkingPreviewBudget).toBe(false)

    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(result.current.snapshot.phase).toBe('idle')
  })

  it('subscribe notifies and unmount disposes so timers do not revive disposed machine', () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useTurnEndLayoutController())

    act(() => {
      result.current.beginTurnEnd()
    })
    expect(result.current.snapshot.phase).toBe('committing')

    unmount()

    act(() => {
      vi.advanceTimersByTime(500)
    })
    // disposed：timer 不得把已卸载实例推回 settling/released
    expect(result.current.snapshot.phase).toBe('committing')
  })

  it('StrictMode remount replaces disposed machine; beginTurnEnd uses live instance', () => {
    vi.useFakeTimers()
    const first = renderHook(() => useTurnEndLayoutController())

    act(() => {
      first.result.current.beginTurnEnd()
    })
    expect(first.result.current.snapshot.phase).toBe('committing')

    first.unmount()
    const second = renderHook(() => useTurnEndLayoutController())
    expect(second.result.current.snapshot.phase).toBe('idle')

    act(() => {
      second.result.current.beginTurnEnd()
    })
    expect(second.result.current.snapshot.phase).toBe('committing')

    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(second.result.current.snapshot.phase).toBe('settling')

    second.unmount()
  })
})

describe('TurnEndLayoutProvider / useTurnEndLayout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('descendants read phase and actions from provider', () => {
    vi.useFakeTimers()
    function Host() {
      const { beginTurnEnd, providerValue } = useTurnEndLayoutController()
      useEffect(() => {
        beginTurnEnd()
      }, [beginTurnEnd])
      return (
        <TurnEndLayoutProvider value={providerValue}>
          <ConsumerProbe />
        </TurnEndLayoutProvider>
      )
    }

    render(<Host />)
    expect(screen.getByTestId('consumer').getAttribute('data-phase')).toBe('committing')
    expect(screen.getByTestId('consumer').getAttribute('data-hold-thinking')).toBe('true')
  })

  it('without provider returns idle and no-op actions', () => {
    const { result } = renderHook(() => useTurnEndLayout())
    expect(result.current.phase).toBe('idle')
    expect(result.current.shouldHoldThinkingPreviewBudget).toBe(false)
    expect(result.current.shouldHoldClosingSpacer).toBe(false)
    expect(() => {
      result.current.markClosingUiReady()
      result.current.release()
    }).not.toThrow()
  })
})
