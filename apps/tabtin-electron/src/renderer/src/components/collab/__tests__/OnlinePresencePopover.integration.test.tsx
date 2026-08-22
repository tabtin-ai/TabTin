import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { OnlinePresencePopover } from '../OnlinePresencePopover'

const originalResizeObserver = globalThis.ResizeObserver

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

afterAll(() => {
  if (originalResizeObserver) {
    globalThis.ResizeObserver = originalResizeObserver
  } else {
    Reflect.deleteProperty(globalThis, 'ResizeObserver')
  }
})

describe('OnlinePresencePopover integration', () => {
  it('opens when the user focuses the trigger', () => {
    render(
      <OnlinePresencePopover
        isOnline
        peers={[{ id: 'p1', name: 'Alice' }]}
        self={{ id: 'me', name: 'Me' }}
      />,
    )

    fireEvent.focus(screen.getByRole('button', { name: 'presence.onlineCount' }))

    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('stays closed after a pointer-triggered close restores focus', async () => {
    vi.useFakeTimers()
    render(
      <OnlinePresencePopover
        isOnline
        peers={[{ id: 'p1', name: 'Alice' }]}
        self={{ id: 'me', name: 'Me' }}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'presence.onlineCount' })
    const hoverSurface = trigger.parentElement
    expect(hoverSurface).toBeTruthy()

    fireEvent.mouseEnter(hoverSurface!)
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.mouseLeave(hoverSurface!)
    await act(async () => {
      vi.advanceTimersByTime(180)
      await Promise.resolve()
    })

    const closingDialog = screen.queryByRole('dialog')
    if (closingDialog) {
      fireEvent.animationEnd(closingDialog)
    }
    await act(async () => {
      vi.runOnlyPendingTimers()
      await Promise.resolve()
    })

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
