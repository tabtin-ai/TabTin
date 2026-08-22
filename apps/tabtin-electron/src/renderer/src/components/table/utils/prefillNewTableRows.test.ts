import { beforeEach, describe, expect, it, vi } from 'vitest'

const { bulkCreateRecordsMock } = vi.hoisted(() => ({
  bulkCreateRecordsMock: vi.fn().mockResolvedValue({
    success_count: 7,
    errors: [],
    records: [],
  }),
}))

vi.mock('@tabtin/table-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/table-core')>()
  return {
    ...actual,
    RecordApiService: {
      getRecordsByTable: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          records: [],
          total: 5,
          page: 1,
          page_size: 1,
        },
      }),
      bulkCreateRecords: bulkCreateRecordsMock,
    },
  }
})

import {
  MIN_NEW_TABLE_VISIBLE_ROW_COUNT,
  prefillNewTableRows,
} from './prefillNewTableRows'
import { RecordApiService } from '@tabtin/table-core'

describe('prefillNewTableRows', () => {
  beforeEach(() => {
    bulkCreateRecordsMock.mockClear()
    vi.mocked(RecordApiService.getRecordsByTable).mockClear()
    vi.mocked(RecordApiService.getRecordsByTable).mockResolvedValue({
      status: 200,
      data: {
        records: [],
        total: 5,
        page: 1,
        page_size: 1,
      },
    })
  })

  it('#789：默认不预填任何记录，新表即空表', async () => {
    expect(MIN_NEW_TABLE_VISIBLE_ROW_COUNT).toBe(0)

    await prefillNewTableRows('table-1')

    expect(RecordApiService.getRecordsByTable).not.toHaveBeenCalled()
    expect(bulkCreateRecordsMock).not.toHaveBeenCalled()
  })

  it('显式传入 count 时仍按需补足缺少的空白记录', async () => {
    await prefillNewTableRows('table-1', { count: 12 })

    expect(RecordApiService.getRecordsByTable).toHaveBeenCalledTimes(1)
    expect(RecordApiService.getRecordsByTable).toHaveBeenCalledWith('table-1', { page_size: 1 })
    expect(bulkCreateRecordsMock).toHaveBeenCalledTimes(1)
    expect(bulkCreateRecordsMock).toHaveBeenCalledWith({
      table_id: 'table-1',
      records: Array.from({ length: 12 - 5 }, () => ({})),
    })
  })

  it('显式 count 下已有记录达到阈值时不应重复补行', async () => {
    vi.mocked(RecordApiService.getRecordsByTable).mockResolvedValue({
      status: 200,
      data: {
        records: [],
        total: 12,
        page: 1,
        page_size: 1,
      },
    })

    await prefillNewTableRows('table-1', { count: 12 })

    expect(bulkCreateRecordsMock).not.toHaveBeenCalled()
  })

  it('无效 tableId 或 count<=0 不应触发查询或预填', async () => {
    await prefillNewTableRows('')
    await prefillNewTableRows('table-1', { count: 0 })

    expect(RecordApiService.getRecordsByTable).not.toHaveBeenCalled()
    expect(bulkCreateRecordsMock).not.toHaveBeenCalled()
  })

  it('补行部分成功时应抛错，避免静默失败', async () => {
    bulkCreateRecordsMock.mockResolvedValueOnce({
      success_count: 6,
      errors: ['第 7 条创建失败'],
      records: [],
    })

    await expect(prefillNewTableRows('table-1', { count: 12 })).rejects.toThrow(
      '新表空白行补齐未完成'
    )
  })
})
