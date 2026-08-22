import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/smartsheet-ui')>('@tabtin/smartsheet-ui')
  return {
    ...actual,
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  }
})

const updateSpaceMock = vi.fn()

vi.mock('@stores/useSpaceStore', () => {
  const space = {
    id: 'space-1',
    name: 'Demo 工作空间',
    description: 'hello',
    avatar: 'https://cdn.example.com/legacy.png',
  }
  const useSpaceStore = Object.assign(
    (selector: (s: unknown) => unknown) => selector({
      spaces: [space],
      updateSpace: updateSpaceMock,
      isLoading: false,
      error: null,
    }),
    { getState: () => ({ error: null }) },
  )
  return { useSpaceStore }
})

import { ProfileIdentityForm } from './ProfileIdentityForm'

describe('ProfileIdentityForm', () => {
  beforeEach(() => {
    updateSpaceMock.mockReset()
    updateSpaceMock.mockResolvedValue(true)
  })

  it('不提供工作空间头像编辑入口', () => {
    render(<ProfileIdentityForm spaceId="space-1" canManage />)

    expect(screen.queryByText('头像')).toBeNull()
    expect(screen.queryByRole('button', { name: /头像/ })).toBeNull()
  })

  it('保存名称和描述后关闭编辑面板，且不再写入头像', async () => {
    const onSaved = vi.fn()
    render(<ProfileIdentityForm spaceId="space-1" canManage onSaved={onSaved} />)
    fireEvent.change(screen.getByDisplayValue('Demo 工作空间'), { target: { value: '新的现场' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(updateSpaceMock).toHaveBeenCalledWith('space-1', {
        name: '新的现场',
        description: 'hello',
      })
      expect(onSaved).toHaveBeenCalledOnce()
    })
  })

  it('清空简介时显式提交空字符串', async () => {
    render(<ProfileIdentityForm spaceId="space-1" canManage />)
    fireEvent.change(screen.getByDisplayValue('hello'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(updateSpaceMock).toHaveBeenCalledWith('space-1', {
        name: 'Demo 工作空间',
        description: '',
      })
    })
  })
})
