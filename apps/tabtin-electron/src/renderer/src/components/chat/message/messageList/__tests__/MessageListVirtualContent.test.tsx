import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MessageListVirtualContent } from '../MessageListVirtualContent'

describe('MessageListVirtualContent', () => {
  it('keeps the visible virtual window in flow so growing content pushes the composer spacer down', () => {
    render(
      <MessageListVirtualContent
        contentRef={vi.fn()}
        bottomMarkerRef={vi.fn()}
        totalSize={120}
        offsetTop={80}
        contentPadding="px-4"
        bottomSpacerHeight={240}
      >
        <div>growing message</div>
      </MessageListVirtualContent>,
    )

    const visibleWindow = screen.getByText('growing message').parentElement
    const virtualFrame = visibleWindow?.parentElement

    expect(virtualFrame?.style.minHeight).toBe('120px')
    expect(virtualFrame?.style.boxSizing).toBe('border-box')
    expect(virtualFrame?.style.paddingTop).toBe('80px')
    expect(visibleWindow?.style.position).not.toBe('absolute')
  })

  it('places the follow target after the composer clearance spacer', () => {
    render(
      <MessageListVirtualContent
        contentRef={vi.fn()}
        bottomMarkerRef={vi.fn()}
        totalSize={120}
        offsetTop={0}
        contentPadding="px-4"
        bottomSpacerHeight={240}
      >
        <div>message</div>
      </MessageListVirtualContent>,
    )

    const spacer = screen.getByTestId('message-list-bottom-spacer')
    const marker = screen.getByTestId('message-list-bottom-marker')
    expect(spacer.nextElementSibling).toBe(marker)
  })
})
