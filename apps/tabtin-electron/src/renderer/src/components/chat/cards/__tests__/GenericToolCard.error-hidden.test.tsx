/**
 * GenericToolCard · 工具错误默认隐藏（专题：工具错误改由 Agent 处置）
 *
 * 验证产品决策：默认（DEBUG_PANELS_ENABLED=false，模拟 prod build）下，
 *   - jsonError envelope 路径：banner / "错误详情" / "查看原始 JSON" 全部消失
 *   - 兼容路径（非 envelope 字符串）：banner 消失
 *   - 只有 error 没有其它内容时：整张卡片不渲染空壳
 *
 * 错误处理权交给 Agent，由 Agent 在对话里用人话告知用户。
 *
 */

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/utils/featureFlags', () => ({
  DEBUG_PANELS_ENABLED: false,
  BUILD_PROFILE: 'production',
  IS_PREPROD_BUILD: false,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => String(opts?.defaultValue ?? key),
  }),
}))

import { GenericToolCard } from '../GenericToolCard'

describe('GenericToolCard · 错误默认隐藏（DEBUG_PANELS_ENABLED=false）', () => {
  it('jsonError envelope → banner / 错误详情 / 查看原始 JSON 全部不渲染；input 骨架保留', () => {
    const envelope = {
      success: false,
      error: '系统拒绝访问 /etc/passwd（macOS TCC）',
      error_kind: 'os_access_error',
      error_label: 'tcc_blocked',
      path: '/etc/passwd',
    }

    render(
      <GenericToolCard
        id="tc-1"
        toolName="read_file"
        phase="error"
        input={{ path: '/etc/passwd' }}
        output={JSON.stringify(envelope)}
        error={'系统拒绝访问 /etc/passwd（macOS TCC）'}
      />,
    )

    expect(screen.queryByText(envelope.error)).toBeNull()
    expect(screen.queryByText('tcc_blocked')).toBeNull()
    expect(screen.queryByRole('button', { name: /错误详情/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /查看原始 JSON/ })).toBeNull()

    expect(screen.getAllByText(/etc\/passwd/).length).toBeGreaterThan(0)
  })

  it('兼容路径（非 envelope 字符串）→ ErrorBanner 不渲染', () => {
    const fallbackText = 'OS_ACCESS_ERROR: code=EPERM path=/var/log'

    render(
      <GenericToolCard
        id="tc-2"
        toolName="read_file"
        phase="error"
        input={{ path: '/var/log' }}
        output={fallbackText}
        error={fallbackText}
      />,
    )

    const matches = screen.queryAllByText(fallbackText)
    expect(matches.length).toBeLessThanOrEqual(1)
  })

  it('只有 error 没有 input/output → 整张卡片不渲染空壳', () => {
    const envelope = { success: false, error: 'something failed silently' }

    const { container } = render(
      <GenericToolCard
        id="tc-3"
        toolName="read_file"
        phase="error"
        input={undefined}
        output={JSON.stringify(envelope)}
        error="something failed silently"
      />,
    )

    expect(screen.queryByText('something failed silently')).toBeNull()
    expect(container.textContent).not.toMatch(/something failed silently/)
  })
})
