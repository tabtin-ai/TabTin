import React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestGridSearch } from '../../utils/gridSearchFocus'
import {
  GridToolbarSearchButton,
  type GridToolbarSearchButtonProps,
} from './GridToolbarSearchButton'

const createProps = (
  overrides: Partial<GridToolbarSearchButtonProps> = {},
): GridToolbarSearchButtonProps => ({
  value: '',
  fields: [],
  placeholder: '搜索记录',
  activateLabel: '搜索',
  scope: 'all_fields',
  selectedFieldIds: [],
  hideNotMatchRows: false,
  scopeAllFieldsLabel: '所有字段',
  scopeCurrentFieldLabel: '当前字段',
  selectedFieldsCountLabel: '已选 {{count}} 个字段',
  selectFieldsTitle: '选择字段',
  showAllRowsLabel: '显示全部行',
  hideNotMatchRowsLabel: '隐藏不匹配行',
  navigatePrevLabel: '上一个',
  navigateNextLabel: '下一个',
  closeSearchLabel: '关闭搜索',
  searchIndexTitle: '搜索索引',
  searchIndexCheckingLabel: '检查中',
  searchIndexEnableLabel: '启用索引',
  searchIndexDisableLabel: '停用索引',
  searchIndexRepairLabel: '修复索引',
  searchIndexRepairHintLabel: '修复异常索引',
  searchIndexUnsupportedLabel: '暂不支持索引',
  searchIndexStatusEnabledLabel: '索引已启用',
  searchIndexStatusDisabledLabel: '索引未启用',
  searchIndexSupported: false,
  searchIndexEnabled: false,
  searchIndexAbnormalCount: 0,
  searchIndexLoading: false,
  searchIndexActionLoading: false,
  matchCount: 0,
  currentMatchIndex: 0,
  onSearch: vi.fn(),
  onScopeChange: vi.fn(),
  onSelectedFieldIdsChange: vi.fn(),
  onHideNotMatchRowsChange: vi.fn(),
  ...overrides,
})

describe('GridToolbarSearchButton mobile input', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('focuses the input in the same activation gesture', () => {
    const { container, getByPlaceholderText } = render(
      React.createElement(GridToolbarSearchButton, createProps()),
    )

    fireEvent.click(container.querySelector('button')!)

    expect(document.activeElement).toBe(getByPlaceholderText('搜索记录'))
  })

  it('keeps the latest value and focus across consecutive changes', () => {
    const { container, getByPlaceholderText } = render(
      React.createElement(GridToolbarSearchButton, createProps()),
    )

    fireEvent.click(container.querySelector('button')!)
    const input = getByPlaceholderText('搜索记录') as HTMLInputElement
    fireEvent.change(input, { target: { value: '你' } })
    fireEvent.change(input, { target: { value: '你好' } })

    expect(input.value).toBe('你好')
    expect(document.activeElement).toBe(input)
  })

  it('does not navigate search results while the IME is composing', () => {
    const onNavigateNext = vi.fn()
    const { getByPlaceholderText } = render(
      React.createElement(GridToolbarSearchButton, createProps({
        value: '初始',
        matchCount: 1,
        onNavigateNext,
      })),
    )
    const input = getByPlaceholderText('搜索记录')

    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })

    expect(onNavigateNext).not.toHaveBeenCalled()
  })

  it('keeps the composing text when an older controlled value arrives', () => {
    const props = createProps({ value: '旧' })
    const { getByPlaceholderText, rerender } = render(
      React.createElement(GridToolbarSearchButton, props),
    )
    const input = getByPlaceholderText('搜索记录') as HTMLInputElement

    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '旧你' } })
    rerender(React.createElement(GridToolbarSearchButton, { ...props, value: '旧结果' }))

    expect(input.value).toBe('旧你')
  })

  it('focuses search when the active table is targeted before its grid receives focus', async () => {
    const outsideInput = document.createElement('input')
    document.body.appendChild(outsideInput)
    outsideInput.focus()

    const { getByPlaceholderText } = render(
      React.createElement(GridToolbarSearchButton, createProps({
        searchTargetId: 'table-1',
      })),
    )

    act(() => requestGridSearch('table-1'))

    const searchInput = getByPlaceholderText('搜索记录')
    await waitFor(() => expect(document.activeElement).toBe(searchInput))
  })

  it('does not open search for another table request', () => {
    const { queryByPlaceholderText } = render(
      React.createElement(GridToolbarSearchButton, createProps({
        searchTargetId: 'table-1',
      })),
    )

    act(() => requestGridSearch('table-2'))

    expect(queryByPlaceholderText('搜索记录')).toBeNull()
  })
})
