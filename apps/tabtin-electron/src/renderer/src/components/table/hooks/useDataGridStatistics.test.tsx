import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useDataGridStatistics,
  type UseDataGridStatisticsParams,
} from './useDataGridStatistics'

const { getViewColumnStatistics } = vi.hoisted(() => ({
  getViewColumnStatistics: vi.fn(),
}))

vi.mock('@tabtin/table-engine-canvas/statistics', () => ({
  StatFunc: {
    None: 'none',
    Count: 'count',
    Sum: 'sum',
  },
  getValidStatFuncs: () => ['count', 'sum'],
}))

vi.mock('@tabtin/table-engine-canvas/engine', () => ({
  CANVAS_TABLE_ENGINE: { id: 'canvas' },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({ toast: vi.fn() }))

vi.mock('@tabtin/table-engine', () => ({
  resolveRecordId: (row: { id?: string }) => row.id,
}))

vi.mock('@tabtin/table-core', () => ({
  ViewApiService: { getViewColumnStatistics },
}))

vi.mock('@/utils/i18n/format', () => ({
  formatNumber: (value: number) => String(value),
}))

const makeParams = (
  overrides: Partial<UseDataGridStatisticsParams> = {},
): UseDataGridStatisticsParams => ({
  activeEngineId: 'canvas',
  columns: [{ field: 'name', fieldId: 'field-a', originalFieldType: 'text' }],
  resolvedCurrentView: {
    id: 'view-a',
    config: {},
  } as unknown as UseDataGridStatisticsParams['resolvedCurrentView'],
  fieldById: new Map([['field-a', { id: 'field-a', name: 'name' }]]),
  searchFilteredRowsForDisplay: [{ id: 'record-a', name: 'Alice' }],
  searchHideNotMatchRows: false,
  normalizedSearchQuery: '',
  selectedTableId: 'table-a',
  currentViewId: 'view-a',
  allowViewMutation: true,
  isPersonalViewEnabled: false,
  setPersonalViewDraft: vi.fn(),
  updateView: vi.fn().mockResolvedValue({ id: 'view-a' }),
  t: (key) => key,
  ...overrides,
})

describe('useDataGridStatistics', () => {
  beforeEach(() => {
    getViewColumnStatistics.mockReset()
    getViewColumnStatistics.mockImplementation(
      () => new Promise(() => undefined),
    )
  })

  it('切换表和视图时应采用新视图的已保存汇总配置', async () => {
    const initialParams = makeParams()
    const { result, rerender } = renderHook(
      ({ params }) => useDataGridStatistics(params),
      { initialProps: { params: initialParams } },
    )

    act(() => {
      result.current.handleCanvasColumnStatisticAction('name', {
        api: { statisticFunc: 'count' },
      } as never)
    })
    expect(result.current.configuredColumnStatisticFuncs).toEqual({
      'field-a': 'count',
    })

    act(() => {
      rerender({
        params: makeParams({
          columns: [
            {
              field: 'amount',
              fieldId: 'field-b',
              originalFieldType: 'number',
            },
          ],
          resolvedCurrentView: {
            id: 'view-b',
            config: { column_statistic_funcs: { 'field-b': 'sum' } },
          } as unknown as UseDataGridStatisticsParams['resolvedCurrentView'],
          fieldById: new Map([['field-b', { id: 'field-b', name: 'amount' }]]),
          searchFilteredRowsForDisplay: [{ id: 'record-b', amount: 42 }],
          selectedTableId: 'table-b',
          currentViewId: 'view-b',
        }),
      })
    })

    expect(result.current.configuredColumnStatisticFuncs).toEqual({
      'field-b': 'sum',
    })
    expect(result.current.canvasColumnStatistics.amount).toMatchObject({
      func: 'sum',
      value: '42',
    })
  })

  it('同一张表切换视图时也不应沿用旧视图的乐观汇总配置', () => {
    const { result, rerender } = renderHook(
      ({ params }) => useDataGridStatistics(params),
      { initialProps: { params: makeParams() } },
    )

    act(() => {
      result.current.handleCanvasColumnStatisticAction('name', {
        api: { statisticFunc: 'count' },
      } as never)
    })

    act(() => {
      rerender({
        params: makeParams({
          resolvedCurrentView: {
            id: 'view-b',
            config: { column_statistic_funcs: { 'field-a': 'sum' } },
          } as unknown as UseDataGridStatisticsParams['resolvedCurrentView'],
          currentViewId: 'view-b',
        }),
      })
    })

    expect(result.current.configuredColumnStatisticFuncs).toEqual({
      'field-a': 'sum',
    })
  })
})
