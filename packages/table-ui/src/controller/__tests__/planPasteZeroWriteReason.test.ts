import { describe, expect, it } from 'vitest'
import { planPasteOperations } from '../useDataGridClipboard'

describe('planPasteOperations zeroWriteReason', () => {
  it('只贴系统只读列 → readonly', () => {
    const plan = planPasteOperations({
      parsedRows: [['1+1']],
      anchorRowIndex: 0,
      anchorColIndex: 0,
      columns: [
        {
          field: 'CreatedAt',
          fieldId: 'fld_created_at',
          originalFieldType: 'created_time',
          editable: false,
        },
      ],
      tableId: 'tbl_1',
      getDisplayRowData: () => ({
        id: 'rec_1',
        CreatedAt: '2026-08-20',
      }),
    })

    expect(plan.updates).toHaveLength(0)
    expect(plan.creates).toHaveLength(0)
    expect(plan.skippedReadonlyCount).toBe(1)
    expect(plan.zeroWriteReason).toBe('readonly')
  })

  it('数字列贴非法文本 → convert', () => {
    const plan = planPasteOperations({
      parsedRows: [['abc']],
      anchorRowIndex: 0,
      anchorColIndex: 0,
      columns: [
        {
          field: 'Amount',
          fieldId: 'fld_amount',
          originalFieldType: 'number',
        },
      ],
      tableId: 'tbl_1',
      getDisplayRowData: () => ({
        id: 'rec_1',
        Amount: 1,
      }),
    })

    expect(plan.updates).toHaveLength(0)
    expect(plan.skippedConvertCount).toBe(1)
    expect(plan.zeroWriteReason).toBe('convert')
  })

  it('空贴空 → noop', () => {
    const plan = planPasteOperations({
      parsedRows: [['']],
      anchorRowIndex: 0,
      anchorColIndex: 0,
      columns: [
        {
          field: 'Title',
          fieldId: 'fld_title',
          originalFieldType: 'text',
        },
      ],
      tableId: 'tbl_1',
      getDisplayRowData: () => ({
        id: 'rec_1',
        Title: '',
      }),
    })

    expect(plan.updates).toHaveLength(0)
    expect(plan.skippedNoopCount).toBe(1)
    expect(plan.zeroWriteReason).toBe('noop')
  })

  it('校验失败 → validation', () => {
    const plan = planPasteOperations({
      parsedRows: [['ab']],
      anchorRowIndex: 0,
      anchorColIndex: 0,
      columns: [
        {
          field: 'Title',
          fieldId: 'fld_title',
          originalFieldType: 'text',
          validation_rules: { min_length: 3 },
        },
      ],
      tableId: 'tbl_1',
      getDisplayRowData: () => ({
        id: 'rec_1',
        Title: 'old',
      }),
    })

    expect(plan.updates).toHaveLength(0)
    expect(plan.skippedValidationCount).toBe(1)
    expect(plan.zeroWriteReason).toBe('validation')
  })

  it('只读 + 转换失败混合 → mixed', () => {
    const plan = planPasteOperations({
      parsedRows: [['x', 'abc']],
      anchorRowIndex: 0,
      anchorColIndex: 0,
      columns: [
        {
          field: 'CreatedAt',
          fieldId: 'fld_created_at',
          originalFieldType: 'created_time',
          editable: false,
        },
        {
          field: 'Amount',
          fieldId: 'fld_amount',
          originalFieldType: 'number',
        },
      ],
      tableId: 'tbl_1',
      getDisplayRowData: () => ({
        id: 'rec_1',
        CreatedAt: '2026-08-20',
        Amount: 1,
      }),
    })

    expect(plan.updates).toHaveLength(0)
    expect(plan.skippedReadonlyCount).toBe(1)
    expect(plan.skippedConvertCount).toBe(1)
    expect(plan.zeroWriteReason).toBe('mixed')
  })

  it('有溢出行但 tableId 为 null → no_target', () => {
    const plan = planPasteOperations({
      parsedRows: [['hello'], ['overflow']],
      anchorRowIndex: 0,
      anchorColIndex: 0,
      columns: [
        {
          field: 'Title',
          fieldId: 'fld_title',
          originalFieldType: 'text',
        },
      ],
      tableId: null,
      // 锚点下没有展示行 → 全部进入建行路径，但 tableId 为空禁止自动建行
      getDisplayRowData: () => undefined,
    })

    expect(plan.updates).toHaveLength(0)
    expect(plan.creates).toHaveLength(0)
    expect(plan.zeroWriteReason).toBe('no_target')
  })
})
