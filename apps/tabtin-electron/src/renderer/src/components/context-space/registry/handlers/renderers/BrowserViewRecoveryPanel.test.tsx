import React from 'react'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BrowserViewRecoveryPanel } from './BrowserViewRecoveryPanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

describe('BrowserViewRecoveryPanel', () => {
  it('恢复中显示明确进度，不呈现空白容器或失败操作', () => {
    const { getByRole, getByText, queryByRole } = render(
      <BrowserViewRecoveryPanel
        state={{ phase: 'restoring' }}
        onRetry={vi.fn()}
      />,
    )

    expect(getByRole('status').getAttribute('data-browser-recovery-state')).toBe('restoring')
    expect(getByText('正在恢复网页')).toBeTruthy()
    expect(getByText('TabTin 正在重新打开上次保存的网页。')).toBeTruthy()
    expect(queryByRole('button')).toBeNull()
  })

  it('失败时保留说明，并提供可执行的重试和关闭按钮', () => {
    const onRetry = vi.fn()
    const onClose = vi.fn()
    const { getByRole, getByText } = render(
      <BrowserViewRecoveryPanel
        state={{ phase: 'failed', code: 'create_failed' }}
        onRetry={onRetry}
        onClose={onClose}
      />,
    )

    expect(getByRole('status').getAttribute('data-browser-recovery-state')).toBe('failed')
    expect(getByText('网页恢复失败')).toBeTruthy()
    expect(getByText('原网址仍然保留。你可以重试，或关闭这个标签。')).toBeTruthy()

    fireEvent.click(getByRole('button', { name: '重试' }))
    fireEvent.click(getByRole('button', { name: '关闭标签' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
