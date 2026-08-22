import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataGridPaginationBar } from './DataGridPaginationBar'

describe('DataGridPaginationBar', () => {
  it('当总记录数超过当前页时，应显示分页信息并支持下一页', () => {
    const handlePaginationChange = vi.fn()

    render(
      React.createElement(DataGridPaginationBar, {
        currentPage: 1,
        pageSize: 100,
        totalCount: 164,
        isLoading: false,
        pageSizeOptions: [50, 100, 200],
        summary: '1 / 2 · 164',
        pageSizeLabel: '每页',
        prevLabel: '上一页',
        nextLabel: '下一页',
        onPaginationChange: handlePaginationChange,
      })
    )

    expect(screen.getByText('1 / 2 · 164')).toBeTruthy()
    expect(screen.getByText('每页')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))

    expect(handlePaginationChange).toHaveBeenCalledWith({
      page: 2,
      pageSize: 100,
    })
  })

  it('当总记录数不超过 100 行且当前只有 1 页时，应隐藏分页栏', () => {
    render(
      React.createElement(DataGridPaginationBar, {
        currentPage: 1,
        pageSize: 100,
        totalCount: 80,
        isLoading: false,
        pageSizeOptions: [50, 100, 200],
        summary: '1 / 1 · 80',
        pageSizeLabel: '每页',
        prevLabel: '上一页',
        nextLabel: '下一页',
        onPaginationChange: vi.fn(),
      })
    )

    expect(screen.queryByText('1 / 1 · 80')).toBeNull()
  })

  it('当用户主动把每页条数调小导致产生多页时，仍应显示分页栏', () => {
    render(
      React.createElement(DataGridPaginationBar, {
        currentPage: 1,
        pageSize: 50,
        totalCount: 80,
        isLoading: false,
        pageSizeOptions: [50, 100, 200],
        summary: '1 / 2 · 80',
        pageSizeLabel: '每页',
        prevLabel: '上一页',
        nextLabel: '下一页',
        onPaginationChange: vi.fn(),
      })
    )

    expect(screen.getByText('1 / 2 · 80')).toBeTruthy()
  })

  it('当总数超过 100 但当前仍只有 1 页时，只显示摘要和页大小选择', () => {
    render(
      React.createElement(DataGridPaginationBar, {
        currentPage: 1,
        pageSize: 200,
        totalCount: 101,
        isLoading: false,
        pageSizeOptions: [50, 100, 200],
        summary: '1 / 1 · 101',
        pageSizeLabel: '每页',
        prevLabel: '上一页',
        nextLabel: '下一页',
        onPaginationChange: vi.fn(),
      })
    )

    expect(screen.getByText('1 / 1 · 101')).toBeTruthy()
    expect(screen.getByText('每页')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '上一页' })).toBeNull()
    expect(screen.queryByRole('button', { name: '下一页' })).toBeNull()
  })
})
