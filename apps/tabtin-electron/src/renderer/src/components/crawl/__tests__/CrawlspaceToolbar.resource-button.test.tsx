import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CrawlspaceToolbar } from '@tabtin/crawlspace-core'

describe('CrawlspaceToolbar resource button', () => {
  it('在完整工具栏下显示资源按钮并触发切换', () => {
    const onToggleResources = vi.fn()

    render(
      <CrawlspaceToolbar
        currentUrl="https://example.com/article"
        actionsLayoutWidthPx={800}
        resourceCount={7}
        resourcePanelOpen={false}
        onToggleResources={onToggleResources}
      />
    )

    const resourceButton = screen.getByRole('button', { name: /资源中心|resources/i })
    expect(resourceButton).toBeTruthy()
    // 视觉上不再渲染数字角标（避免抢视觉权重），仅靠小圆点指示有/无；
    // aria-label 仍然带数量，无障碍读屏用户能拿到具体值。
    expect(resourceButton.textContent).not.toContain('7')
    expect(resourceButton.getAttribute('aria-label')).toContain('7')

    fireEvent.click(resourceButton)
    expect(onToggleResources).toHaveBeenCalledTimes(1)
  })

  it('资源数为 0 时既不显示角标也不在 aria-label 里带数字', () => {
    render(
      <CrawlspaceToolbar
        currentUrl="https://example.com/article"
        actionsLayoutWidthPx={800}
        resourceCount={0}
        resourcePanelOpen={false}
        onToggleResources={vi.fn()}
      />
    )

    const resourceButton = screen.getByRole('button', { name: /资源中心|resources/i })
    expect(resourceButton.textContent).not.toContain('0')
    expect(resourceButton.getAttribute('aria-label')).not.toContain('0')
  })

  it('刷新按钮右侧显示主页按钮并触发 onHome', () => {
    const onHome = vi.fn()

    render(
      <CrawlspaceToolbar
        currentUrl="https://example.com/article"
        actionsLayoutWidthPx={800}
        onHome={onHome}
      />
    )

    const homeButton = screen.getByRole('button', { name: /主页|home/i })
    const reloadButton = screen.getByRole('button', { name: /刷新|reload/i })
    expect(homeButton.compareDocumentPosition(reloadButton) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()

    fireEvent.click(homeButton)
    expect(onHome).toHaveBeenCalledTimes(1)
  })

  it('未传入 onHome 时不渲染主页按钮', () => {
    render(
      <CrawlspaceToolbar
        currentUrl="https://example.com/article"
        actionsLayoutWidthPx={800}
      />
    )

    expect(screen.queryByRole('button', { name: /主页|home/i })).toBeNull()
  })
})
