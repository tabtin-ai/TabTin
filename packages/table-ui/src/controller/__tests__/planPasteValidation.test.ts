import { describe, expect, it } from 'vitest'
import { planPasteOperations } from '../useDataGridClipboard'

describe('planPasteOperations validation_rules', () => {
  it('允许粘贴空值', () => {
    const plan = planPasteOperations({
      parsedRows: [['']],
      anchorRowIndex: 0,
      anchorColIndex: 0,
      columns: [{
        field: 'Title',
        fieldId: 'fld_title',
        originalFieldType: 'text',
      }],
      tableId: 'tbl_1',
      getDisplayRowData: () => ({ id: 'rec_1', Title: 'old' }),
    })

    expect(plan.skippedValidationCount).toBe(0)
    expect(plan.updates).toHaveLength(1)
  })

  it('跳过未通过长度规则的粘贴单元格', () => {
    const plan = planPasteOperations({
      parsedRows: [['ab', 'abcd']],
      anchorRowIndex: 0,
      anchorColIndex: 0,
      columns: [
        {
          field: 'Title',
          fieldId: 'fld_title',
          originalFieldType: 'text',
          validation_rules: { min_length: 3 },
        },
        {
          field: 'Code',
          fieldId: 'fld_code',
          originalFieldType: 'text',
          validation_rules: { max_length: 3 },
        },
      ],
      tableId: 'tbl_1',
      getDisplayRowData: () => ({
        id: 'rec_1',
        Title: 'old',
        Code: 'old',
      }),
    })

    expect(plan.skippedValidationCount).toBe(2)
    expect(plan.updates).toHaveLength(0)
    expect(plan.updatedCellCount).toBe(0)
  })

  it('允许通过规则的粘贴值写入', () => {
    const plan = planPasteOperations({
      parsedRows: [['abcd']],
      anchorRowIndex: 0,
      anchorColIndex: 0,
      columns: [
        {
          field: 'Title',
          fieldId: 'fld_title',
          originalFieldType: 'text',
          validation_rules: { min_length: '3' },
        },
      ],
      tableId: 'tbl_1',
      getDisplayRowData: () => ({
        id: 'rec_1',
        Title: 'old',
      }),
    })

    expect(plan.skippedValidationCount).toBe(0)
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].data).toEqual({ fld_title: 'abcd' })
  })
})
