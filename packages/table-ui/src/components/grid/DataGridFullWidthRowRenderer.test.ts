import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataGridFullWidthRowRenderer } from './DataGridFullWidthRowRenderer'

describe('DataGridFullWidthRowRenderer', () => {
  it('分组 add 行激活草稿后应和普通 add 行一样显示保存/取消动作', () => {
    const handleAddRow = vi.fn()
    const handleCommitDraft = vi.fn()
    const handleCancelDraft = vi.fn()
    const handleParentMouseDown = vi.fn()

    render(
      React.createElement(
        'div',
        { onMouseDown: handleParentMouseDown },
        React.createElement(DataGridFullWidthRowRenderer, {
          data: {
            __rowType: 'group_add',
            __groupLevel: 0,
            __groupPath: 'Todo',
            __groupValues: { Status: 'Todo' },
          },
          hasDraft: true,
          draftGroupPath: 'Todo',
          isDraftSubmitting: false,
          addRowLabel: '新建记录',
          groupAddRowLabel: '在此分组中新建记录',
          addRowDraftLabel: '继续编辑草稿',
          saveDraftLabel: '保存',
          cancelDraftLabel: '取消',
          submittingDraftLabel: '保存中...',
          onAddRow: handleAddRow,
          onCommitDraft: handleCommitDraft,
          onCancelDraft: handleCancelDraft,
        })
      ),
    )

    const cancelButton = screen.getByRole('button', { name: '取消' })
    const cancelMouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    cancelButton.dispatchEvent(cancelMouseDown)
    expect(cancelMouseDown.defaultPrevented).toBe(true)
    expect(handleParentMouseDown).not.toHaveBeenCalled()

    const saveButton = screen.getByRole('button', { name: '保存' })
    const saveMouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    saveButton.dispatchEvent(saveMouseDown)
    expect(saveMouseDown.defaultPrevented).toBe(false)

    fireEvent.click(saveButton)
    fireEvent.click(cancelButton)

    expect(screen.getByText('继续编辑草稿')).toBeTruthy()
    expect(handleCommitDraft).toHaveBeenCalledTimes(1)
    expect(handleCancelDraft).toHaveBeenCalledTimes(1)
    expect(handleAddRow).not.toHaveBeenCalled()
  })

  it('其他分组的 add 行不应显示当前草稿动作', () => {
    render(
      React.createElement(DataGridFullWidthRowRenderer, {
        data: {
          __rowType: 'group_add',
          __groupLevel: 0,
          __groupPath: 'Done',
          __groupValues: { Status: 'Done' },
        },
        hasDraft: true,
        draftGroupPath: 'Todo',
        isDraftSubmitting: false,
        addRowLabel: '新建记录',
        groupAddRowLabel: '在此分组中新建记录',
        addRowDraftLabel: '继续编辑草稿',
        saveDraftLabel: '保存',
        cancelDraftLabel: '取消',
        submittingDraftLabel: '保存中...',
      }),
    )

    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    expect(screen.getByText('在此分组中新建记录')).toBeTruthy()
  })

  it('#9513 组头只展示名称，不展示数量徽章', () => {
    render(
      React.createElement(DataGridFullWidthRowRenderer, {
        data: {
          __rowType: 'group_header',
          __groupLevel: 0,
          __groupPath: 'Alice',
          __groupLabel: 'Alice',
          __groupCount: 40,
          __groupLoadedCount: 0,
        },
        ungroupedLabel: '未分组',
      }),
    )

    expect(screen.getByText('Alice')).toBeTruthy()
    expect(screen.queryByText('40')).toBeNull()
    expect(screen.queryByText(/已加载/)).toBeNull()
  })

  it('分组 add 行提交中应禁用保存和取消动作', () => {
    render(
      React.createElement(DataGridFullWidthRowRenderer, {
        data: {
          __rowType: 'group_add',
          __groupLevel: 0,
          __groupPath: 'Todo',
          __groupValues: { Status: 'Todo' },
        },
        hasDraft: true,
        draftGroupPath: 'Todo',
        isDraftSubmitting: true,
        addRowLabel: '新建记录',
        groupAddRowLabel: '在此分组中新建记录',
        addRowDraftLabel: '继续编辑草稿',
        saveDraftLabel: '保存',
        cancelDraftLabel: '取消',
        submittingDraftLabel: '保存中...',
      }),
    )

    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true)
    screen
      .getAllByRole('button', { name: '保存中...' })
      .forEach(button => {
        expect((button as HTMLButtonElement).disabled).toBe(true)
      })
  })
})
