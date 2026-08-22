/**
 * SessionExpiredNotice 单测
 *
 * Agent 设置面板认证门控的兜底 UI：
 *   1. 渲染「会话已过期」提示文案（不呈现任何可编辑表单）
 *   2. 点击「重新登录」触发 logout('token_expired')，把应用切回登录界面
 */
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { logoutMock } = vi.hoisted(() => ({
  logoutMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: string | { defaultValue?: string },
    ) =>
      typeof options === 'string'
        ? options
        : typeof options?.defaultValue === 'string'
          ? options.defaultValue
          : key,
  }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ logout: logoutMock }),
  },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}))

import { SessionExpiredNotice } from './SessionExpiredNotice'

describe('SessionExpiredNotice ', () => {
  beforeEach(() => {
    logoutMock.mockClear()
  })

  it('渲染会话过期提示文案', () => {
    render(<SessionExpiredNotice />)

    expect(screen.getByText('会话已过期')).toBeTruthy()
    expect(
      screen.getByText('登录状态已失效，设置已切换为只读。请重新登录后再修改工作空间设置。'),
    ).toBeTruthy()
  })

  it('点击「重新登录」触发 logout(token_expired)', () => {
    render(<SessionExpiredNotice />)

    fireEvent.click(screen.getByText('重新登录'))

    expect(logoutMock).toHaveBeenCalledOnce()
    expect(logoutMock).toHaveBeenCalledWith('token_expired')
  })
})
