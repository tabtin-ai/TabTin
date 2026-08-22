import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PresentationToolFoldRow } from '../PresentationToolFoldRow'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}))

vi.mock('../../registry/toolCardRegistry', () => ({
  getCompactSummary: () => null,
  getToolDescriptor: () => ({ defaultCollapsed: false }),
  getToolIcon: () => 'Wrench',
}))

vi.mock('../../registry/toolDisplayName', () => ({
  getToolDisplayName: () => '展示内容',
}))

vi.mock('../../registry/iconMap', () => ({
  resolveIcon: () => () => <svg data-testid="tool-icon" />,
}))

describe('PresentationToolFoldRow', () => {
  it('流式中保留工具 icon，标签扫光，无 Loader2', () => {
    const { container } = render(
      <PresentationToolFoldRow
        toolName="present_to_user"
        input={{}}
        finalized={false}
        inputFinalized={false}
      />,
    )
    expect(screen.getByTestId('tool-icon')).toBeTruthy()
    expect(screen.getByTestId('shiny-text').textContent).toContain('展示内容')
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('partial 终态不显示未封口的 title 或 summary', () => {
    const input = {
      title: '尚未完成的标题',
      summary: '尚未完成的摘要',
    }
    const { rerender } = render(
      <PresentationToolFoldRow
        toolName="present_to_user"
        input={input}
        finalized
        inputFinalized={false}
      />,
    )

    expect(screen.getByText('展示内容')).toBeTruthy()
    expect(screen.queryByText('尚未完成的标题')).toBeNull()
    expect(screen.queryByText('尚未完成的摘要')).toBeNull()

    rerender(
      <PresentationToolFoldRow
        toolName="present_to_user"
        input={input}
        finalized
        inputFinalized
      />,
    )

    expect(screen.getByText('尚未完成的标题')).toBeTruthy()
    expect(screen.getByText('尚未完成的摘要')).toBeTruthy()
  })
})
