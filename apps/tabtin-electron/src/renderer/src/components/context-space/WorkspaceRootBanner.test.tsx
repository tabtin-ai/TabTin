/**
 * WorkspaceRootBanner — RT-3 渲染契约
 *
 * 验证：
 *   1. status !== 'unreachable' → 不渲染
 *   2. status === 'unreachable' → 渲染为占据布局高度的顶部横幅
 *   3. 渲染路径 + 标题 + hint + 重试/重新选择
 *   4. 重试调 retry()；重新选择调 openSheet('working-dir', spaceId, { relocate: true })
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const { mockUseHealth, mockOpen, mockRetry } = vi.hoisted(() => ({
  mockUseHealth: vi.fn(),
  mockOpen: vi.fn(),
  mockRetry: vi.fn(),
}))

vi.mock('./hooks/useWorkspaceRootHealth', () => ({
  useWorkspaceRootHealth: (spaceId: string | null) => mockUseHealth(spaceId),
}))

vi.mock('@stores/useAgentSettingsSheetStore', () => ({
  useAgentSettingsSheetStore: (selector: (s: { open: typeof mockOpen }) => unknown) =>
    selector({ open: mockOpen }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}))

vi.mock('lucide-react', () => ({
  AlertTriangle: () => <svg data-testid="icon-alert" />,
  RefreshCw: () => <svg data-testid="icon-refresh" />,
}))

import { WorkspaceRootBanner } from './WorkspaceRootBanner'

describe('WorkspaceRootBanner (RT-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['idle', 'checking', 'ok'] as const)('status=%s 时不渲染', (status) => {
    mockUseHealth.mockReturnValue({ status, workingDir: '/some/dir', retry: mockRetry })
    const { container } = render(<WorkspaceRootBanner spaceId="s1" />)
    expect(container.firstChild).toBeNull()
  })

  it('unreachable → 渲染路径 + 重试/重新选择按钮', () => {
    mockUseHealth.mockReturnValue({
      status: 'unreachable',
      workingDir: '/Volumes/开发/tabtin/edit_file',
      retry: mockRetry,
    })
    render(<WorkspaceRootBanner spaceId="s1" />)
    const banner = screen.getByRole('alert')
    expect(banner).toBeTruthy()
    expect(banner.className).toContain('shrink-0')
    expect(banner.className).not.toContain('absolute')
    expect(screen.getByText('/Volumes/开发/tabtin/edit_file')).toBeTruthy()
    expect(screen.getByText('Agent 工作目录不可访问')).toBeTruthy()
    expect(screen.getByText('重试')).toBeTruthy()
    expect(screen.getByText('重新选择...')).toBeTruthy()
  })

  it('点重试 → retry()；点重新选择 → openSheet(working-dir, spaceId, relocate)', () => {
    mockUseHealth.mockReturnValue({
      status: 'unreachable',
      workingDir: '/gone',
      retry: mockRetry,
    })
    render(<WorkspaceRootBanner spaceId="space-42" />)
    fireEvent.click(screen.getByText('重试'))
    expect(mockRetry).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('重新选择...'))
    expect(mockOpen).toHaveBeenCalledWith('working-dir', 'space-42', { relocate: true })
  })

  it('spaceId 为 null 时点重新选择不调 openSheet（防御）', () => {
    mockUseHealth.mockReturnValue({ status: 'unreachable', workingDir: '/gone', retry: mockRetry })
    render(<WorkspaceRootBanner spaceId={null} />)
    fireEvent.click(screen.getByText('重新选择...'))
    expect(mockOpen).not.toHaveBeenCalled()
  })
})
