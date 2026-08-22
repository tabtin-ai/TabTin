/**
 * ：嵌套 sticky stack — 内层 top = 外层 offset + 实测行高
 */
import React from 'react'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render } from '@testing-library/react'
import {
  SUBAGENT_STICKY_ROW_FALLBACK_PX,
  SubagentStickyHeaderShell,
  SubagentStickyStackProvider,
  useSubagentStickyOffset,
} from '../SubagentStickyStackContext'

function OffsetProbe({ testId }: { testId: string }) {
  const offset = useSubagentStickyOffset()
  return <span data-testid={testId}>{offset}</span>
}

describe('SubagentStickyStackContext', () => {
  const originalRO = globalThis.ResizeObserver

  beforeAll(() => {
    class FakeResizeObserver {
      private cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
      }
      observe(target: Element) {
        Object.defineProperty(target, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({
            width: 100,
            height: 48,
            top: 0,
            left: 0,
            bottom: 48,
            right: 100,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          }),
        })
        this.cb([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  })

  afterAll(() => {
    globalThis.ResizeObserver = originalRO
  })

  it('根层展开 sticky top=0，嵌套子树 offset=实测行高', async () => {
    const { container, findByTestId } = render(
      <SubagentStickyHeaderShell
        sticky
        nested={<OffsetProbe testId="child-offset" />}
      >
        <div data-testid="parent-header">parent</div>
      </SubagentStickyHeaderShell>,
    )

    const shell = container.querySelector('[data-subagent-sticky-offset]')
    expect(shell).not.toBeNull()
    expect(shell?.getAttribute('data-subagent-sticky-offset')).toBe('0')
    expect((shell as HTMLElement).style.top).toBe('0px')
    expect(shell?.className).toContain('sticky')
    expect(shell?.className).toContain('z-sticky')
    expect(shell?.className).not.toContain('top-0')

    const child = await findByTestId('child-offset')
    expect(child.textContent).toBe('48')
  })

  it('父 Provider 已有 offset 时，展开行 top 跟父 offset，孙层再累加', async () => {
    const { container, findByTestId } = render(
      <SubagentStickyStackProvider offsetPx={40}>
        <SubagentStickyHeaderShell sticky nested={<OffsetProbe testId="grandchild-offset" />}>
          <div>child header</div>
        </SubagentStickyHeaderShell>
      </SubagentStickyStackProvider>,
    )

    const shell = container.querySelector('[data-subagent-sticky-offset]')
    expect(shell?.getAttribute('data-subagent-sticky-offset')).toBe('40')
    expect((shell as HTMLElement).style.top).toBe('40px')

    const grandchild = await findByTestId('grandchild-offset')
    expect(grandchild.textContent).toBe(String(40 + 48))
  })

  it('未展开时不 sticky，nested 仍继承当前 offset（不叠行高）', () => {
    const { container, getByTestId } = render(
      <SubagentStickyStackProvider offsetPx={12}>
        <SubagentStickyHeaderShell sticky={false} nested={<OffsetProbe testId="idle-offset" />}>
          <div>idle</div>
        </SubagentStickyHeaderShell>
      </SubagentStickyStackProvider>,
    )

    expect(container.querySelector('[data-subagent-sticky-offset]')).toBeNull()
    expect(getByTestId('idle-offset').textContent).toBe('12')
  })

  it('ResizeObserver 未回报前用 fallback 行高', () => {
    class SilentRO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const prev = globalThis.ResizeObserver
    globalThis.ResizeObserver = SilentRO as unknown as typeof ResizeObserver
    try {
      const { getByTestId } = render(
        <SubagentStickyHeaderShell sticky nested={<OffsetProbe testId="fallback-offset" />}>
          <div style={{ height: 0 }}>empty</div>
        </SubagentStickyHeaderShell>,
      )
      expect(getByTestId('fallback-offset').textContent).toBe(String(SUBAGENT_STICKY_ROW_FALLBACK_PX))
    } finally {
      globalThis.ResizeObserver = prev
    }
  })
})
