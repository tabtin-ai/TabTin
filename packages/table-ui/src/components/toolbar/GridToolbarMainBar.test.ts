import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GridToolbarMainBar } from './GridToolbarMainBar'

describe('GridToolbarMainBar', () => {
  beforeEach(() => {
    class ResizeObserverMock {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe() {
        this.callback(
          [{ contentRect: { width: 1200 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        )
      }

      disconnect() {}
      unobserve() {}
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exposes labels for the compact add record and add field icon buttons', () => {
    render(
      React.createElement(GridToolbarMainBar, {
        fields: [],
        canDetailEdit: false,
        hasSelectedRows: false,
        tableFontStyle: 'normal',
        tableFontWeight: '400',
        tableFontSize: 14,
        searchQuery: '',
        searchScope: 'all_fields',
        searchSelectedFieldIds: [],
        searchHideNotMatchRows: false,
        searchMatchCount: 0,
        searchCurrentMatchIndex: 0,
        searchCurrentField: null,
        searchIndexSupported: false,
        searchIndexEnabled: false,
        searchIndexAbnormalCount: 0,
        searchIndexLoading: false,
        searchIndexActionLoading: false,
        translate: (key: string) => {
          const labels: Record<string, string> = {
            'table:toolbar.addRecord': '新增记录',
            'table:toolbar.addField': '添加字段',
            'table:toolbar.search': '搜索',
            'table:toolbar.searchPlaceholder': '搜索记录',
            'table:toolbar.searchScopeAllFields': '所有字段',
            'table:toolbar.searchScopeFieldSearch': '当前字段',
            'table:toolbar.searchSelectedFieldsCount': '已选 {{count}} 个字段',
            'table:toolbar.searchSelectFieldsTitle': '选择字段',
            'table:toolbar.searchShowAllRows': '显示全部行',
            'table:toolbar.searchHideNotMatchRows': '隐藏不匹配行',
            'table:toolbar.searchPrev': '上一个',
            'table:toolbar.searchNext': '下一个',
            'table:toolbar.searchClose': '关闭搜索',
            'table:toolbar.searchIndexTitle': '搜索索引',
            'table:toolbar.searchIndexChecking': '检查中',
            'table:toolbar.searchIndexEnable': '启用索引',
            'table:toolbar.searchIndexDisable': '停用索引',
            'table:toolbar.searchIndexRepair': '修复索引',
            'table:toolbar.searchIndexRepairHint': '修复异常索引',
            'table:toolbar.searchIndexUnsupported': '暂不支持索引',
            'table:toolbar.searchIndexStatusEnabled': '索引已启用',
            'table:toolbar.searchIndexStatusDisabled': '索引未启用',
            'table:toolbar.searchLimitWarning': '只搜索前 5000 行',
            'table:toolbar.searchIndexSuggestion': '当前有 {{count}} 行，启用索引可提升搜索速度',
            'table:toolbar.searchIndexSuggestionEnable': '立即启用',
            'table:toolbar.searchIndexSuggestionDismiss': '忽略',
            'table:toolbar.refresh': '刷新',
            'table:toolbar.manageFields': '管理字段',
            'table:toolbar.export': '导出',
            'table:toolbar.import': '导入',
            'table:toolbar.detailEdit': '详细编辑',
            'table:toolbar.undo': '撤销',
            'table:toolbar.redo': '重做',
            'table:toolbar.tableHistory': '表格历史',
            'table:toolbar.delete': '删除',
            'table:toolbar.share': '分享',
            'table:toolbar.sendToIM': '发送到私信',
          }
          return labels[key] ?? key
        },
        onSearch: vi.fn(),
        onSearchScopeChange: vi.fn(),
        onSearchSelectedFieldIdsChange: vi.fn(),
        onSearchHideNotMatchRowsChange: vi.fn(),
        onAddRow: vi.fn(),
        onAddField: vi.fn(),
        onRefresh: vi.fn(),
        onDeleteSelected: vi.fn(),
      }),
    )

    expect(screen.getByRole('button', { name: '新增记录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加字段' })).toBeTruthy()
  })

  it('shows send-to-im action independently of share permission', () => {
    render(
      React.createElement(GridToolbarMainBar, {
        fields: [],
        canDetailEdit: false,
        hasSelectedRows: false,
        tableFontStyle: 'normal',
        tableFontWeight: '400',
        tableFontSize: 14,
        searchQuery: '',
        searchScope: 'all_fields',
        searchSelectedFieldIds: [],
        searchHideNotMatchRows: false,
        searchMatchCount: 0,
        searchCurrentMatchIndex: 0,
        searchCurrentField: null,
        searchIndexSupported: false,
        searchIndexEnabled: false,
        searchIndexAbnormalCount: 0,
        searchIndexLoading: false,
        searchIndexActionLoading: false,
        canShare: false,
        onSendToIM: vi.fn(),
        translate: (key: string) => {
          const labels: Record<string, string> = {
            'table:toolbar.sendToIM': '发送到私信',
            'table:toolbar.search': '搜索',
            'table:toolbar.searchPlaceholder': '搜索记录',
            'table:toolbar.searchScopeAllFields': '所有字段',
            'table:toolbar.searchScopeFieldSearch': '当前字段',
            'table:toolbar.searchSelectedFieldsCount': '已选 {{count}} 个字段',
            'table:toolbar.searchSelectFieldsTitle': '选择字段',
            'table:toolbar.searchShowAllRows': '显示全部行',
            'table:toolbar.searchHideNotMatchRows': '隐藏不匹配行',
            'table:toolbar.searchPrev': '上一个',
            'table:toolbar.searchNext': '下一个',
            'table:toolbar.searchClose': '关闭搜索',
            'table:toolbar.searchIndexTitle': '搜索索引',
            'table:toolbar.searchIndexChecking': '检查中',
            'table:toolbar.searchIndexEnable': '启用索引',
            'table:toolbar.searchIndexDisable': '停用索引',
            'table:toolbar.searchIndexRepair': '修复索引',
            'table:toolbar.searchIndexRepairHint': '修复异常索引',
            'table:toolbar.searchIndexUnsupported': '暂不支持索引',
            'table:toolbar.searchIndexStatusEnabled': '索引已启用',
            'table:toolbar.searchIndexStatusDisabled': '索引未启用',
            'table:toolbar.searchLimitWarning': '只搜索前 5000 行',
            'table:toolbar.searchIndexSuggestion': '当前有 {{count}} 行，启用索引可提升搜索速度',
            'table:toolbar.searchIndexSuggestionEnable': '立即启用',
            'table:toolbar.searchIndexSuggestionDismiss': '忽略',
            'table:toolbar.refresh': '刷新',
            'table:toolbar.manageFields': '管理字段',
            'table:toolbar.export': '导出',
            'table:toolbar.import': '导入',
            'table:toolbar.detailEdit': '详细编辑',
            'table:toolbar.addRecord': '新增记录',
            'table:toolbar.addField': '添加字段',
          }
          return labels[key] ?? key
        },
        onSearch: vi.fn(),
        onSearchScopeChange: vi.fn(),
        onSearchSelectedFieldIdsChange: vi.fn(),
        onSearchHideNotMatchRowsChange: vi.fn(),
        onAddRow: vi.fn(),
        onAddField: vi.fn(),
        onRefresh: vi.fn(),
        onDeleteSelected: vi.fn(),
      }),
    )

    expect(screen.getByRole('button', { name: '发送到私信' })).toBeTruthy()
  })

  it('shows request-edit-access next to send-to-im when callback provided', () => {
    const onRequestEditAccess = vi.fn()
    render(
      React.createElement(GridToolbarMainBar, {
        fields: [],
        canDetailEdit: false,
        hasSelectedRows: false,
        tableFontStyle: 'normal',
        tableFontWeight: '400',
        tableFontSize: 14,
        searchQuery: '',
        searchScope: 'all_fields',
        searchSelectedFieldIds: [],
        searchHideNotMatchRows: false,
        searchMatchCount: 0,
        searchCurrentMatchIndex: 0,
        searchCurrentField: null,
        searchIndexSupported: false,
        searchIndexEnabled: false,
        searchIndexAbnormalCount: 0,
        searchIndexLoading: false,
        searchIndexActionLoading: false,
        canShare: false,
        onSendToIM: vi.fn(),
        onRequestEditAccess,
        isReadonly: true,
        translate: (key: string) => {
          const labels: Record<string, string> = {
            'table:toolbar.sendToIM': '发送到私信',
            'table:toolbar.requestEditAccess': '申请编辑权限',
            'table:toolbar.search': '搜索',
            'table:toolbar.searchPlaceholder': '搜索记录',
            'table:toolbar.searchScopeAllFields': '所有字段',
            'table:toolbar.searchScopeFieldSearch': '当前字段',
            'table:toolbar.searchSelectedFieldsCount': '已选 {{count}} 个字段',
            'table:toolbar.searchSelectFieldsTitle': '选择字段',
            'table:toolbar.searchShowAllRows': '显示全部行',
            'table:toolbar.searchHideNotMatchRows': '隐藏不匹配行',
            'table:toolbar.searchPrev': '上一个',
            'table:toolbar.searchNext': '下一个',
            'table:toolbar.searchClose': '关闭搜索',
            'table:toolbar.searchIndexTitle': '搜索索引',
            'table:toolbar.searchIndexChecking': '检查中',
            'table:toolbar.searchIndexEnable': '启用索引',
            'table:toolbar.searchIndexDisable': '停用索引',
            'table:toolbar.searchIndexRepair': '修复索引',
            'table:toolbar.searchIndexRepairHint': '修复异常索引',
            'table:toolbar.searchIndexUnsupported': '暂不支持索引',
            'table:toolbar.searchIndexStatusEnabled': '索引已启用',
            'table:toolbar.searchIndexStatusDisabled': '索引未启用',
            'table:toolbar.searchLimitWarning': '只搜索前 5000 行',
            'table:toolbar.searchIndexSuggestion': '当前有 {{count}} 行，启用索引可提升搜索速度',
            'table:toolbar.searchIndexSuggestionEnable': '立即启用',
            'table:toolbar.searchIndexSuggestionDismiss': '忽略',
            'table:toolbar.refresh': '刷新',
            'table:toolbar.manageFields': '管理字段',
            'table:toolbar.export': '导出',
            'table:toolbar.import': '导入',
            'table:toolbar.detailEdit': '详细编辑',
            'table:toolbar.addRecord': '新增记录',
            'table:toolbar.addField': '添加字段',
          }
          return labels[key] ?? key
        },
        onSearch: vi.fn(),
        onSearchScopeChange: vi.fn(),
        onSearchSelectedFieldIdsChange: vi.fn(),
        onSearchHideNotMatchRowsChange: vi.fn(),
        onAddRow: vi.fn(),
        onAddField: vi.fn(),
        onRefresh: vi.fn(),
        onDeleteSelected: vi.fn(),
      }),
    )

    const button = screen.getByRole('button', { name: '申请编辑权限' })
    expect(button).toBeTruthy()
    fireEvent.click(button)
    expect(onRequestEditAccess).toHaveBeenCalledTimes(1)
  })

  it('hides add record and add field buttons when readonly', () => {
    render(
      React.createElement(GridToolbarMainBar, {
        fields: [],
        canDetailEdit: false,
        hasSelectedRows: false,
        tableFontStyle: 'normal',
        tableFontWeight: '400',
        tableFontSize: 14,
        searchQuery: '',
        searchScope: 'all_fields',
        searchSelectedFieldIds: [],
        searchHideNotMatchRows: false,
        searchMatchCount: 0,
        searchCurrentMatchIndex: 0,
        searchCurrentField: null,
        searchIndexSupported: false,
        searchIndexEnabled: false,
        searchIndexAbnormalCount: 0,
        searchIndexLoading: false,
        searchIndexActionLoading: false,
        isReadonly: true,
        translate: (key: string) => key,
        onSearch: vi.fn(),
        onSearchScopeChange: vi.fn(),
        onSearchSelectedFieldIdsChange: vi.fn(),
        onSearchHideNotMatchRowsChange: vi.fn(),
        onAddRow: vi.fn(),
        onAddField: vi.fn(),
        onRefresh: vi.fn(),
        onDeleteSelected: vi.fn(),
      }),
    )

    expect(screen.queryByRole('button', { name: 'table:toolbar.addRecord' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'table:toolbar.addField' })).toBeNull()
  })

  it('hides grid-only create actions when the host renders another view type', () => {
    render(
      React.createElement(GridToolbarMainBar, {
        fields: [],
        canDetailEdit: false,
        hasSelectedRows: false,
        tableFontStyle: 'normal',
        tableFontWeight: '400',
        tableFontSize: 14,
        searchQuery: '',
        searchScope: 'all_fields',
        searchSelectedFieldIds: [],
        searchHideNotMatchRows: false,
        searchMatchCount: 0,
        searchCurrentMatchIndex: 0,
        searchCurrentField: null,
        searchIndexSupported: false,
        searchIndexEnabled: false,
        searchIndexAbnormalCount: 0,
        searchIndexLoading: false,
        searchIndexActionLoading: false,
        showCreateActions: false,
        translate: (key: string) => key,
        onSearch: vi.fn(),
        onSearchScopeChange: vi.fn(),
        onSearchSelectedFieldIdsChange: vi.fn(),
        onSearchHideNotMatchRowsChange: vi.fn(),
        onAddRow: vi.fn(),
        onAddField: vi.fn(),
        onRefresh: vi.fn(),
        onDeleteSelected: vi.fn(),
      }),
    )

    expect(screen.queryByRole('button', { name: 'table:toolbar.addRecord' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'table:toolbar.addField' })).toBeNull()
  })

  it('keeps the view action strip horizontally scrollable on narrow screens', () => {
    render(
      React.createElement(GridToolbarMainBar, {
        fields: [],
        canDetailEdit: false,
        hasSelectedRows: false,
        tableFontStyle: 'normal',
        tableFontWeight: '400',
        tableFontSize: 14,
        searchQuery: '',
        searchScope: 'all_fields',
        searchSelectedFieldIds: [],
        searchHideNotMatchRows: false,
        searchMatchCount: 0,
        searchCurrentMatchIndex: 0,
        searchCurrentField: null,
        searchIndexSupported: false,
        searchIndexEnabled: false,
        searchIndexAbnormalCount: 0,
        searchIndexLoading: false,
        searchIndexActionLoading: false,
        translate: (key: string) => key,
        onSearch: vi.fn(),
        onSearchScopeChange: vi.fn(),
        onSearchSelectedFieldIdsChange: vi.fn(),
        onSearchHideNotMatchRowsChange: vi.fn(),
        onAddRow: vi.fn(),
        onAddField: vi.fn(),
        onRefresh: vi.fn(),
        onDeleteSelected: vi.fn(),
        filterGroupBar: React.createElement('div', { 'data-testid': 'view-actions' }, 'actions'),
      }),
    )

    const scrollContainer = screen.getByTestId('view-actions').parentElement?.parentElement
    expect(scrollContainer?.className).toContain('overflow-x-auto')
    expect(scrollContainer?.className).not.toContain('overflow-hidden')
  })
})
