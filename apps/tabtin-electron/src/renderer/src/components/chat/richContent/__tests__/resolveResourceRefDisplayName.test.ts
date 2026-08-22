import { describe, expect, it } from 'vitest'
import {
  resolvePresentToUserItemLabel,
  resolveResourceRefDisplayName,
} from '../resolveResourceRefDisplayName'

describe('resolveResourceRefDisplayName', () => {
  it('优先 filename，其次 resource_name', () => {
    expect(resolveResourceRefDisplayName({
      summary: '这是 Agent 附带的说明',
      filename: 'report.xlsx',
      resource_name: '季度报告',
    })).toBe('report.xlsx')

    expect(resolveResourceRefDisplayName({
      summary: '这是 Agent 附带的说明',
      resource_name: '季度报告',
      resource_id: '/tmp/other.md',
      resource_type: 'code_file',
    })).toBe('季度报告')
  })

  it('code_file 从 resource_id 路径取 basename，不用 summary', () => {
    expect(resolveResourceRefDisplayName({
      summary: '已为您生成分析脚本',
      resource_type: 'code_file',
      resource_id: '/Users/dev/project/scripts/gen_report.py',
    })).toBe('gen_report.py')
  })

  it('无文件名标识时才回落 summary', () => {
    expect(resolveResourceRefDisplayName({
      summary: '相关文档',
      resource_type: 'document',
      resource_id: 'doc_uuid_12345678',
    })).toBe('相关文档')
  })
})

describe('resolvePresentToUserItemLabel', () => {
  it('file kind 取 filename', () => {
    expect(resolvePresentToUserItemLabel({
      kind: 'file',
      filename: 'budget.xlsx',
      summary: '预算表文件',
    })).toBe('budget.xlsx')
  })

  it('resource_ref 取路径 basename 而非 summary', () => {
    expect(resolvePresentToUserItemLabel({
      kind: 'resource_ref',
      resource_type: 'code_file',
      resource_id: '/tmp/out.ts',
      summary: '修复后的源码',
    })).toBe('out.ts')
  })
})
