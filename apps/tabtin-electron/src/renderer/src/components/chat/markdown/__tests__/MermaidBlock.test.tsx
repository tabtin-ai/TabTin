import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

let resolvedTheme = 'light'

vi.mock('@stores/useUIStore', () => ({
  useUIStore: (selector: (state: { resolvedTheme: string }) => unknown) =>
    selector({ resolvedTheme }),
}))

const mermaidInitialize = vi.fn()
const mermaidRender = vi.fn(async () => ({
  svg: '<svg viewBox="0 0 120 60"><g><text>开始处理</text></g></svg>',
}))

vi.mock('mermaid', () => ({
  default: { initialize: mermaidInitialize, render: mermaidRender },
}))

import { MermaidBlock } from '../MermaidBlock'

describe('MermaidBlock', () => {
  beforeEach(() => {
    mermaidInitialize.mockClear()
    mermaidRender.mockClear()
    resolvedTheme = 'light'
  })

  const lastConfig = () =>
    mermaidInitialize.mock.calls.at(-1)?.[0] as {
      theme: string
      htmlLabels: boolean
      flowchart: { htmlLabels: boolean }
    }

  it('禁用 htmlLabels，让节点文字落成 SVG text', async () => {
    render(<MermaidBlock code={'flowchart TD\n  A[开始处理] --> B[结束]'} />)

    await waitFor(() => expect(mermaidInitialize).toHaveBeenCalled())
    expect(lastConfig().htmlLabels).toBe(false)
    expect(lastConfig().flowchart).toEqual({ htmlLabels: false })
  })

  it('浅色主题下不套用 dark 主题', async () => {
    render(<MermaidBlock code={'flowchart TD\n  A --> B'} />)

    await waitFor(() => expect(mermaidInitialize).toHaveBeenCalled())
    expect(lastConfig().theme).toBe('default')
  })

  it('深色主题下套用 dark 主题', async () => {
    resolvedTheme = 'dark'
    render(<MermaidBlock code={'flowchart TD\n  A --> B'} />)

    await waitFor(() => expect(mermaidInitialize).toHaveBeenCalled())
    expect(lastConfig().theme).toBe('dark')
  })

  it('渲染结果里保留中文标签', async () => {
    const { container } = render(<MermaidBlock code={'flowchart TD\n  A[开始处理]'} />)

    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull())
    expect(container.textContent).toContain('开始处理')
  })
})
