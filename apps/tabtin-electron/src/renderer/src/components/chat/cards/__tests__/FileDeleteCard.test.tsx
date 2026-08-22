/**
 * FileDeleteCard 渲染测试 —— 钉死「删除文件卡片在 phase=end / phase=error 下
 * 都正确显示文件名 + path + 状态徽章」的契约。
 */

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => String(opts?.defaultValue ?? key),
  }),
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: { getState: () => ({ selectedSpace: { id: 'space-1' } }) },
}))

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: { getState: () => ({ openResourceTab: vi.fn() }) },
}))

import { FileDeleteCardRenderer } from '../FileDeleteCard'

const TOOL_ID = 'tc_delete_test'

describe('FileDeleteCard', () => {
  it('phase=end 成功：显示文件名 + -deleted chip', () => {
    const path = '/Users/developer/Documents/calc.html'
    render(
      <FileDeleteCardRenderer
        id={TOOL_ID}
        toolName="delete_file"
        phase="end"
        input={{ path }}
        output={{ success: true, path }}
      />,
    )

    expect(screen.getByText('calc.html')).toBeTruthy()
    expect(screen.getByText(/-deleted/)).toBeTruthy()
  })

  it('phase=error：显示 -failed chip + ErrorBanner', () => {
    const path = '/Users/developer/Documents/missing.html'
    render(
      <FileDeleteCardRenderer
        id={TOOL_ID}
        toolName="delete_file"
        phase="error"
        input={{ path }}
        error="文件不存在"
      />,
    )

    expect(screen.getByText('missing.html')).toBeTruthy()
    expect(screen.getByText(/-failed/)).toBeTruthy()
    expect(screen.getByText('文件不存在')).toBeTruthy()
  })

  it('从 input.kwargs.path 解析（Anthropic tool-use 入参形态）', () => {
    const path = '/tmp/legacy/file.txt'
    render(
      <FileDeleteCardRenderer
        id={TOOL_ID}
        toolName="delete_file"
        phase="end"
        input={{ kwargs: { path } }}
      />,
    )

    expect(screen.getByText('file.txt')).toBeTruthy()
  })

  it('从 output.data.path 兜底（input 无 path 时）', () => {
    const path = '/tmp/data/output.json'
    render(
      <FileDeleteCardRenderer
        id={TOOL_ID}
        toolName="delete_file"
        phase="end"
        output={{ data: { path } }}
      />,
    )

    expect(screen.getByText('output.json')).toBeTruthy()
  })
})
