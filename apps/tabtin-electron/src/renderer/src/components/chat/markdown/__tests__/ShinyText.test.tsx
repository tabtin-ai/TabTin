import React from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShinyText } from '../ShinyText'

vi.mock('@components/layout/SpaceActivityContext', () => ({
  useSpaceActivity: () => ({ isForeground: true }),
}))

describe('ShinyText', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('同一前台页面只激活最后挂载的一条，卸载后把活动权交还上一条', () => {
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{} as DOMRect])
    const { rerender } = render(
      <>
        <ShinyText>first</ShinyText>
        <ShinyText>second</ShinyText>
      </>,
    )

    const [first, second] = screen.getAllByTestId('shiny-text')
    expect(first.dataset.shinyActive).toBe('false')
    expect(second.dataset.shinyActive).toBe('true')

    rerender(<ShinyText>first</ShinyText>)
    expect(screen.getByTestId('shiny-text').dataset.shinyActive).toBe('true')
  })

  it('允许显式并行动画，且不抢占默认实例的活动权', () => {
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{} as DOMRect])
    render(
      <>
        <ShinyText>default</ShinyText>
        <ShinyText allowConcurrent>concurrent one</ShinyText>
        <ShinyText allowConcurrent>concurrent two</ShinyText>
      </>,
    )

    const [defaultText, concurrentOne, concurrentTwo] = screen.getAllByTestId('shiny-text')
    expect(defaultText.dataset.shinyActive).toBe('true')
    expect(concurrentOne.dataset.shinyActive).toBe('true')
    expect(concurrentTwo.dataset.shinyActive).toBe('true')
  })
})
