import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ViewFilterRulesEditor } from './ViewFilterRulesEditor'

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)
window.HTMLElement.prototype.scrollIntoView = vi.fn()

describe('ViewFilterRulesEditor', () => {
  it('member filter opens the organization member selector instead of a text input', () => {
    render(
      React.createElement(ViewFilterRulesEditor, {
        fields: [
          {
            id: 'owner',
            name: '负责人',
            fieldType: 'user',
          },
        ],
        rules: [
          {
            id: 'rule-1',
            fieldId: 'owner',
            operator: 'equals',
            value: '',
            enabled: true,
          },
        ],
        operatorOptions: [{ value: 'equals', label: '等于' }],
        userOptions: [
          { value: 'user-1', label: '张三', email: 'alice@example.com' },
        ],
        onAddRule: vi.fn(),
        onRemoveRule: vi.fn(),
        onUpdateRule: vi.fn(),
        texts: {
          valuePlaceholder: '输入内容',
          selectValuePlaceholder: '选择成员',
        },
      })
    )

    expect(screen.queryByPlaceholderText('输入内容')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '选择成员' }))
    expect(screen.getByText('张三')).toBeTruthy()
    expect(screen.getByText('alice@example.com')).toBeTruthy()
  })

  it('member set operators keep the selector open and submit multiple member ids', () => {
    const onUpdateRule = vi.fn()
    const buildProps = (value: string[]) => ({
      fields: [{ id: 'owner', name: '负责人', fieldType: 'user' }],
      rules: [{
        id: 'rule-1',
        fieldId: 'owner',
        operator: 'is_any_of',
        value,
        enabled: true,
      }],
      operatorOptions: [{ value: 'is_any_of', label: '包含任一' }],
      userOptions: [
        { value: 'user-1', label: '张三' },
        { value: 'user-2', label: '林小满' },
      ],
      onAddRule: vi.fn(),
      onRemoveRule: vi.fn(),
      onUpdateRule,
      texts: { selectValuePlaceholder: '选择成员' },
    })
    const { rerender } = render(
      React.createElement(ViewFilterRulesEditor, buildProps([]))
    )

    fireEvent.click(screen.getByRole('button', { name: '选择成员' }))
    fireEvent.click(screen.getByRole('option', { name: /张三/ }))
    expect(onUpdateRule).toHaveBeenLastCalledWith('rule-1', { value: ['user-1'] })

    rerender(React.createElement(ViewFilterRulesEditor, buildProps(['user-1'])))
    fireEvent.click(screen.getByRole('option', { name: /林小满/ }))
    expect(onUpdateRule).toHaveBeenLastCalledWith('rule-1', {
      value: ['user-1', 'user-2'],
    })
  })

  it('member filter selects the highlighted search result with ArrowDown and Enter', () => {
    const onUpdateRule = vi.fn()
    render(
      React.createElement(ViewFilterRulesEditor, {
        fields: [{ id: 'owner', name: '负责人', fieldType: 'user' }],
        rules: [{
          id: 'rule-1',
          fieldId: 'owner',
          operator: 'equals',
          value: '',
          enabled: true,
        }],
        operatorOptions: [{ value: 'equals', label: '等于' }],
        userOptions: [
          { value: 'user-1', label: '张三' },
          { value: 'user-2', label: '林小满' },
        ],
        onAddRule: vi.fn(),
        onRemoveRule: vi.fn(),
        onUpdateRule,
        texts: { selectValuePlaceholder: '选择成员' },
      })
    )

    fireEvent.click(screen.getByRole('button', { name: '选择成员' }))
    const searchInput = screen.getByRole('dialog').querySelector('[role="combobox"]')
    expect(searchInput).not.toBeNull()
    if (!searchInput) throw new Error('member search combobox should be rendered')
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' })
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    expect(onUpdateRule).toHaveBeenCalledWith('rule-1', { value: 'user-2' })
  })

  it('member filter keeps selector semantics while the organization member list is empty', () => {
    render(
      React.createElement(ViewFilterRulesEditor, {
        fields: [{ id: 'owner', name: '负责人', fieldType: 'user' }],
        rules: [{
          id: 'rule-1',
          fieldId: 'owner',
          operator: 'equals',
          value: '',
          enabled: true,
        }],
        operatorOptions: [{ value: 'equals', label: '等于' }],
        userOptions: [],
        onAddRule: vi.fn(),
        onRemoveRule: vi.fn(),
        onUpdateRule: vi.fn(),
        texts: {
          valuePlaceholder: '输入内容',
          selectValuePlaceholder: '选择成员',
        },
      })
    )

    expect(screen.getByRole('button', { name: '选择成员' })).toBeTruthy()
    expect(screen.queryByPlaceholderText('输入内容')).toBeNull()
  })

  it('select filter values display canonical value instead of translated choice label', () => {
    render(
      React.createElement(ViewFilterRulesEditor, {
        fields: [
          {
            id: 'status',
            name: 'Status',
            fieldType: 'select',
            options: {
              choices: [
                { value: 'open', label: '打开', color: '#48BB78' },
                { value: 'closed', label: '关闭', color: '#F56565' },
              ],
            },
          },
        ],
        rules: [
          {
            id: 'rule-1',
            fieldId: 'status',
            operator: 'equals',
            value: 'open',
            enabled: true,
          },
        ],
        operatorOptions: [{ value: 'equals', label: 'is' }],
        onAddRule: vi.fn(),
        onRemoveRule: vi.fn(),
        onUpdateRule: vi.fn(),
      })
    )

    expect(screen.getByText('open')).toBeTruthy()
    expect(screen.queryByText('打开')).toBeNull()
  })

  it('select filter values use id before translated label for legacy choices without value', () => {
    render(
      React.createElement(ViewFilterRulesEditor, {
        fields: [
          {
            id: 'status',
            name: 'Status',
            fieldType: 'select',
            options: {
              choices: [
                { id: 'open', label: '打开', color: '#48BB78' },
              ],
            },
          },
        ],
        rules: [
          {
            id: 'rule-1',
            fieldId: 'status',
            operator: 'equals',
            value: 'open',
            enabled: true,
          },
        ],
        operatorOptions: [{ value: 'equals', label: 'is' }],
        onAddRule: vi.fn(),
        onRemoveRule: vi.fn(),
        onUpdateRule: vi.fn(),
      })
    )

    expect(screen.getByText('open')).toBeTruthy()
    expect(screen.queryByText('打开')).toBeNull()
  })

  it('date filter value uses a preset selector with a specific-date picker', () => {
    const onUpdateRule = vi.fn()

    render(
      React.createElement(ViewFilterRulesEditor, {
        fields: [
          {
            id: 'published_at',
            name: '发布日期',
            fieldType: 'date',
          },
        ],
        rules: [
          {
            id: 'rule-1',
            fieldId: 'published_at',
            operator: 'equals',
            value: '2026-07-16',
            enabled: true,
          },
        ],
        operatorOptions: [{ value: 'equals', label: '等于' }],
        onAddRule: vi.fn(),
        onRemoveRule: vi.fn(),
        onUpdateRule,
        texts: {
          datePlaceholder: 'YYYY-MM-DD',
        },
      })
    )

    expect(screen.getByRole('button', { name: /切换日历|Toggle calendar/i })).toBeTruthy()
    const presetTrigger = screen.getByText('Specific date').closest('button')
    expect(presetTrigger).toBeTruthy()
    fireEvent.click(presetTrigger as HTMLButtonElement)
    fireEvent.click(screen.getByText('Past 7 days'))
    expect(onUpdateRule).toHaveBeenLastCalledWith('rule-1', {
      value: expect.objectContaining({
        mode: 'pastDays',
        numberOfDays: 7,
      }),
    })

    const dateInput = screen.getByDisplayValue('2026-07-16') as HTMLInputElement
    expect(dateInput.readOnly).toBe(true)
  })

  it('date filter keeps preset strings instead of collapsing them to specific dates', () => {
    render(
      React.createElement(ViewFilterRulesEditor, {
        fields: [
          {
            id: 'published_at',
            name: '发布时间',
            fieldType: 'date',
          },
        ],
        rules: [
          {
            id: 'rule-1',
            fieldId: 'published_at',
            operator: 'equals',
            value: 'thisWeek',
            enabled: true,
          },
        ],
        operatorOptions: [{ value: 'equals', label: '绛変簬' }],
        onAddRule: vi.fn(),
        onRemoveRule: vi.fn(),
        onUpdateRule: vi.fn(),
        texts: {
          datePresetExact: 'Specific date',
          datePresetThisWeek: 'This week',
        },
      })
    )

    expect(screen.getByText('This week')).toBeTruthy()
    expect(screen.queryByText('Specific date')).toBeNull()
  })

  it('date filters only ask for a calendar date regardless of field formatting', () => {
    render(
      React.createElement(ViewFilterRulesEditor, {
        fields: [
          {
            id: 'submitted_at',
            name: '提交时间',
            fieldType: 'date',
            options: {
              formatting: {
                date: 'YYYY-MM-DD',
                time: 'HH:mm:ss',
                timeZone: 'Asia/Shanghai',
              },
            },
          },
        ],
        rules: [
          {
            id: 'rule-1',
            fieldId: 'submitted_at',
            operator: 'equals',
            value: '2026-08-14T03:20:18.000Z',
            enabled: true,
          },
        ],
        operatorOptions: [{ value: 'equals', label: '等于' }],
        onAddRule: vi.fn(),
        onRemoveRule: vi.fn(),
        onUpdateRule: vi.fn(),
      })
    )

    expect(screen.getByText('Specific date')).toBeTruthy()
    expect(screen.getByDisplayValue('2026-08-14')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /切换日历|Toggle calendar/i }))
    expect(screen.queryByRole('combobox', { name: /小时|Hour/i })).toBeNull()
    expect(screen.queryByRole('combobox', { name: /分钟|Minute/i })).toBeNull()
    expect(screen.queryByRole('combobox', { name: /秒|Second/i })).toBeNull()
  })

  it.each([
    ['not_equals', 'does not equal'],
    ['greater_than_or_equals', 'on or after'],
    ['less_than_or_equals', 'before or on'],
    ['is_within', 'is within'],
  ])('keeps the legacy date operator %s visible for an existing rule', (operator, label) => {
    const onUpdateRule = vi.fn()

    render(
      React.createElement(ViewFilterRulesEditor, {
        fields: [{ id: 'published_at', name: 'Published at', fieldType: 'date' }],
        rules: [{
          id: 'rule-1',
          fieldId: 'published_at',
          operator,
          value: { mode: 'exactDate', exactDate: '2026-08-15', timeZone: 'Asia/Shanghai' },
          enabled: true,
        }],
        operatorOptions: [{ value: 'equals', label: 'equals' }],
        operatorOptionsByFieldType: {
          date: [
            { value: 'equals', label: 'equals' },
            { value: 'not_equals', label: 'does not equal' },
            { value: 'greater_than', label: 'after' },
            { value: 'greater_than_or_equals', label: 'on or after' },
            { value: 'less_than', label: 'before' },
            { value: 'less_than_or_equals', label: 'before or on' },
            { value: 'is_within', label: 'is within' },
          ],
        },
        onAddRule: vi.fn(),
        onRemoveRule: vi.fn(),
        onUpdateRule,
      }),
    )

    const operatorSelect = screen.getAllByRole('combobox')[1]
    expect(operatorSelect.textContent).toContain(label)
    expect(screen.getByDisplayValue('2026-08-15')).toBeTruthy()

    fireEvent.click(operatorSelect)
    fireEvent.click(screen.getByRole('option', { name: 'equals' }))

    expect(onUpdateRule).toHaveBeenLastCalledWith('rule-1', { operator: 'equals' })
  })

  it('toggles a filter rule enabled state from the switch', () => {
    const onUpdateRule = vi.fn()
    const onMoveRule = vi.fn()
    const outerPointerDown = vi.fn()
    const outerPointerUp = vi.fn()
    const outerMouseDown = vi.fn()
    const outerMouseUp = vi.fn()
    const outerClick = vi.fn()

    render(
      React.createElement(
        'div',
        {
          onPointerDown: outerPointerDown,
          onPointerUp: outerPointerUp,
          onMouseDown: outerMouseDown,
          onMouseUp: outerMouseUp,
          onClick: outerClick,
        },
        React.createElement(ViewFilterRulesEditor, {
          fields: [
            {
              id: 'title',
              name: 'Title',
              fieldType: 'text',
            },
          ],
          rules: [
            {
              id: 'rule-1',
              fieldId: 'title',
              operator: 'contains',
              value: 'hello',
              enabled: true,
            },
            {
              id: 'rule-2',
              fieldId: 'title',
              operator: 'contains',
              value: 'world',
              enabled: true,
            },
          ],
          operatorOptions: [{ value: 'contains', label: 'contains' }],
          onAddRule: vi.fn(),
          onRemoveRule: vi.fn(),
          onUpdateRule,
          onMoveRule,
          texts: {
            enabledLabel: '启用该筛选',
          },
        }),
      )
    )

    const enabledSwitch = screen.getAllByRole('switch', { name: '启用该筛选' })[0]

    fireEvent.pointerDown(enabledSwitch)
    fireEvent.mouseDown(enabledSwitch)
    fireEvent.pointerUp(enabledSwitch)
    fireEvent.mouseUp(enabledSwitch)
    fireEvent.click(enabledSwitch)

    expect(onUpdateRule).toHaveBeenCalledWith('rule-1', { enabled: false })
    expect(onMoveRule).not.toHaveBeenCalled()
    expect(outerPointerDown).not.toHaveBeenCalled()
    expect(outerPointerUp).not.toHaveBeenCalled()
    expect(outerMouseDown).not.toHaveBeenCalled()
    expect(outerMouseUp).not.toHaveBeenCalled()
    expect(outerClick).not.toHaveBeenCalled()
  })
})
