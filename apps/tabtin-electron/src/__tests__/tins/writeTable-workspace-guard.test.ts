/**
 * Tins writeToTable organizationId 校验回归测试
 *
 * 验证 TL-009：onWriteTable 回调必须校验事件中的 organizationId
 * 与当前 organization 一致，防止跨 organization 越权写入。
 */
import { describe, it, expect, vi } from 'vitest'

interface WriteTableEvent {
  instanceId: string
  tableId: string
  records: Record<string, unknown>[]
  organizationId: string
}

interface WriteTableDeps {
  getCurrentOrganizationId: () => string
  createRecord: (data: { table_id: string; fields: Record<string, unknown>; fieldKeyType: string }) => Promise<any>
  onError: (msg: string) => void
}

/**
 * 提取 onWriteTable 回调的核心逻辑，与 React hooks / IPC 解耦
 */
async function handleWriteTable(
  data: WriteTableEvent,
  deps: WriteTableDeps,
): Promise<{ blocked: boolean; written: number }> {
  if (!Array.isArray(data.records) || data.records.length === 0) {
    return { blocked: false, written: 0 }
  }

  const currentWsId = deps.getCurrentOrganizationId()
  if (!data.organizationId || data.organizationId !== currentWsId) {
    deps.onError(`writeToTable blocked: organization mismatch (event=${data.organizationId}, current=${currentWsId})`)
    return { blocked: true, written: 0 }
  }

  let written = 0
  for (const fields of data.records) {
    await deps.createRecord({
      table_id: data.tableId,
      fields,
      fieldKeyType: 'name',
    })
    written++
  }

  return { blocked: false, written }
}

describe('Tins writeToTable organization guard (TL-009 regression)', () => {
  const CURRENT_WS = 'ws-123'
  const OTHER_WS = 'ws-999'

  const baseEvent: WriteTableEvent = {
    instanceId: 'tin-inst-1',
    tableId: 'tbl-abc',
    records: [{ name: 'Alice' }, { name: 'Bob' }],
    organizationId: CURRENT_WS,
  }

  function makeDeps(overrides?: Partial<WriteTableDeps>): WriteTableDeps {
    return {
      getCurrentOrganizationId: () => CURRENT_WS,
      createRecord: vi.fn().mockResolvedValue({ id: 'rec-1' }),
      onError: vi.fn(),
      ...overrides,
    }
  }

  it('organizationId 匹配时应正常写入所有记录', async () => {
    const deps = makeDeps()
    const result = await handleWriteTable(baseEvent, deps)

    expect(result.blocked).toBe(false)
    expect(result.written).toBe(2)
    expect(deps.createRecord).toHaveBeenCalledTimes(2)
    expect(deps.createRecord).toHaveBeenCalledWith({
      table_id: 'tbl-abc',
      fields: { name: 'Alice' },
      fieldKeyType: 'name',
    })
  })

  it('organizationId 不匹配时应阻断写入', async () => {
    const deps = makeDeps()
    const event = { ...baseEvent, organizationId: OTHER_WS }
    const result = await handleWriteTable(event, deps)

    expect(result.blocked).toBe(true)
    expect(result.written).toBe(0)
    expect(deps.createRecord).not.toHaveBeenCalled()
    expect(deps.onError).toHaveBeenCalledOnce()
  })

  it('organizationId 为空时应阻断写入', async () => {
    const deps = makeDeps()
    const event = { ...baseEvent, organizationId: '' }
    const result = await handleWriteTable(event, deps)

    expect(result.blocked).toBe(true)
    expect(deps.createRecord).not.toHaveBeenCalled()
  })

  it('空记录数组时应跳过不报错', async () => {
    const deps = makeDeps()
    const event = { ...baseEvent, records: [] }
    const result = await handleWriteTable(event, deps)

    expect(result.blocked).toBe(false)
    expect(result.written).toBe(0)
    expect(deps.createRecord).not.toHaveBeenCalled()
    expect(deps.onError).not.toHaveBeenCalled()
  })

  it('records 非数组时应跳过不报错', async () => {
    const deps = makeDeps()
    const event = { ...baseEvent, records: null as any }
    const result = await handleWriteTable(event, deps)

    expect(result.blocked).toBe(false)
    expect(result.written).toBe(0)
  })
})
