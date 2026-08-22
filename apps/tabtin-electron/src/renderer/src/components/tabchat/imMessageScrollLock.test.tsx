import React, { useRef, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { IMMessageScrollLockProvider, useIMMessageScrollLock } from './imMessageScrollLock'

function LockToggle({ locked }: { locked: boolean }) {
  useIMMessageScrollLock(locked)
  return <button type="button">toggle-anchor</button>
}

function Harness() {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [locked, setLocked] = useState(false)

  return (
    <div ref={viewportRef} data-testid="viewport" style={{ width: 200, height: 200 }}>
      <div
        ref={scrollerRef}
        data-testid="scroller"
        style={{ width: 200, height: 200, overflowY: 'auto' }}
      >
        <IMMessageScrollLockProvider scrollerRef={scrollerRef} viewportRef={viewportRef}>
          <LockToggle locked={locked} />
          <button type="button" onClick={() => setLocked(true)}>
            lock
          </button>
          <button type="button" onClick={() => setLocked(false)}>
            unlock
          </button>
        </IMMessageScrollLockProvider>
      </div>
    </div>
  )
}

describe('imMessageScrollLock', () => {
  it('blocks wheel over the message viewport while locked', () => {
    render(<Harness />)
    const viewport = screen.getByTestId('viewport')
    const scroller = screen.getByTestId('scroller')
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    fireEvent.click(screen.getByRole('button', { name: 'lock' }))
    expect(scroller.style.overflowY).toBe('hidden')

    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
      deltaY: 40,
    })
    const prevented = !document.dispatchEvent(wheel)
    expect(prevented || wheel.defaultPrevented).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'unlock' }))
    expect(scroller.style.overflowY).not.toBe('hidden')
  })

  it('does not block wheel over scroll-lock exempt targets', () => {
    function ExemptHarness() {
      const scrollerRef = useRef<HTMLDivElement | null>(null)
      const viewportRef = useRef<HTMLDivElement | null>(null)
      return (
        <div ref={viewportRef} data-testid="viewport" style={{ width: 200, height: 200 }}>
          <div ref={scrollerRef} data-testid="scroller">
            <IMMessageScrollLockProvider scrollerRef={scrollerRef} viewportRef={viewportRef}>
              <LockToggle locked />
              <div data-im-scroll-lock-exempt data-testid="exempt">
                menu
              </div>
            </IMMessageScrollLockProvider>
          </div>
        </div>
      )
    }

    render(<ExemptHarness />)
    const viewport = screen.getByTestId('viewport')
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    const exempt = screen.getByTestId('exempt')
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
      deltaY: 40,
    })
    Object.defineProperty(wheel, 'target', { value: exempt })
    document.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(false)
  })

  it('is a no-op outside the provider', () => {
    function Orphan() {
      useIMMessageScrollLock(true)
      return <div>orphan</div>
    }
    expect(() => {
      act(() => {
        render(<Orphan />)
      })
    }).not.toThrow()
  })
})
