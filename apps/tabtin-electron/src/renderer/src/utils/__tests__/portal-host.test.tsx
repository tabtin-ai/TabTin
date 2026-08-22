import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PortalHostBridge, StableSlot, useStablePortalHost } from '../portal-host'

afterEach(() => {
  cleanup()
})

function HostMarker({ host }: { host: HTMLElement }) {
  host.dataset.testid = 'content-portal-host'
  host.textContent = 'content-area'
  return null
}

function DualSlotHarness({
  showTemp,
  showVisible = true,
}: {
  showTemp: boolean
  showVisible?: boolean
}) {
  const host = useStablePortalHost()

  return (
    <div>
      <HostMarker host={host} />
      {showVisible ? (
        <div data-testid="visible-slot">
          <StableSlot host={host} owner="visible-canvas" className="h-full w-full" />
        </div>
      ) : null}
      {showTemp ? (
        <div data-testid="temp-slot">
          <StableSlot host={host} owner="temp-task-canvas" className="h-full w-full" />
        </div>
      ) : null}
    </div>
  )
}

describe('StableSlot portal host ownership', () => {
  it('临时槽位卸载后，仍存活的可见槽位必须收回同一 host（跨域白屏回归）', () => {
    const view = render(<DualSlotHarness showTemp={false} />)
    const host = document.querySelector('[data-testid="content-portal-host"]')
    expect(host).toBeTruthy()
    expect(host?.parentElement?.closest('[data-testid="visible-slot"]')).toBeTruthy()
    expect(document.contains(host)).toBe(true)

    // 模拟任务三态临时槽位与一级域可见槽位短暂共存，再退出任务域。
    view.rerender(<DualSlotHarness showTemp />)
    expect(host?.parentElement?.closest('[data-testid="temp-slot"]')).toBeTruthy()
    expect(document.contains(host)).toBe(true)

    view.rerender(<DualSlotHarness showTemp={false} />)
    expect(document.contains(host)).toBe(true)
    expect(host?.parentElement?.closest('[data-testid="visible-slot"]')).toBeTruthy()
    expect(host?.getAttribute('data-portal-owner')).toBe('visible-canvas')
  })

  it('PortalHostBridge 按 active 交接时，失活方不得把 host 留在 document 外', () => {
    function BridgeHarness({ activeTarget }: { activeTarget: 'a' | 'b' }) {
      const host = useStablePortalHost()
      const targetA = React.useRef<HTMLDivElement>(null)
      const targetB = React.useRef<HTMLDivElement>(null)
      host.dataset.testid = 'bridge-host'
      host.textContent = 'bridged'

      return (
        <div>
          <div data-testid="target-a" ref={targetA} />
          <div data-testid="target-b" ref={targetB} />
          <PortalHostBridge
            host={host}
            target={targetA.current}
            active={activeTarget === 'a'}
            owner="bridge-a"
          />
          <PortalHostBridge
            host={host}
            target={targetB.current}
            active={activeTarget === 'b'}
            owner="bridge-b"
          />
        </div>
      )
    }

    const view = render(<BridgeHarness activeTarget="a" />)
    // 首帧 ref 就绪后再切一次，确保 bridge 看见 target。
    view.rerender(<BridgeHarness activeTarget="a" />)
    const host = document.querySelector('[data-testid="bridge-host"]')
    expect(host?.parentElement?.getAttribute('data-testid')).toBe('target-a')

    view.rerender(<BridgeHarness activeTarget="b" />)
    expect(document.contains(host)).toBe(true)
    expect(host?.parentElement?.getAttribute('data-testid')).toBe('target-b')
  })
})
