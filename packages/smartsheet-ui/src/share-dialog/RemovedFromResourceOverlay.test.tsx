import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RemovedFromResourceOverlay } from './RemovedFromResourceOverlay'

describe('RemovedFromResourceOverlay', () => {
  it('keeps invalid-resource states limited to returning to the space', () => {
    render(
      <RemovedFromResourceOverlay
        resourceTitle="已失效文档"
        action="unavailable"
        onReturn={vi.fn()}
      />,
    )

    expect(screen.getByText('《已失效文档》已失效')).toBeTruthy()
    expect(screen.getByRole('button', { name: '返回空间' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '申请查看' })).toBeNull()
    expect(screen.queryByRole('button', { name: '申请编辑' })).toBeNull()
  })

  it('offers view and edit requests when permission is insufficient', () => {
    const onRequestView = vi.fn()
    const onRequestEdit = vi.fn()
    render(
      <RemovedFromResourceOverlay
        resourceTitle="权限不足文档"
        action="removed"
        onReturn={vi.fn()}
        onRequestView={onRequestView}
        onRequestEdit={onRequestEdit}
      />,
    )

    expect(screen.getByText('您没有《权限不足文档》的权限')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '申请查看' }))
    fireEvent.click(screen.getByRole('button', { name: '申请编辑' }))

    expect(onRequestView).toHaveBeenCalledOnce()
    expect(onRequestEdit).toHaveBeenCalledOnce()
  })

  it('shows submitted state and prevents duplicate requests', () => {
    render(
      <RemovedFromResourceOverlay
        resourceTitle="权限不足表格"
        action="removed"
        onReturn={vi.fn()}
        onRequestView={vi.fn()}
        onRequestEdit={vi.fn()}
        requestedRole="editor"
      />,
    )

    expect(screen.getByRole<HTMLButtonElement>('button', { name: '已申请查看' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '已申请编辑' }).disabled).toBe(true)
  })
})
