import { describe, expect, it, vi } from 'vitest'
import { waitForCondition } from '../table/hooks/waitForCondition'
import { createAndActivateParentField } from './hierarchyParentFieldFlow'

describe('createAndActivateParentField', () => {
  it('首次创建后刷新字段并激活', async () => {
    const field = {
      id: 'fld-1',
      name: '父记录',
      field_type: 'link',
      config: { isSubRecordParentField: true },
    }
    const createParentField = vi.fn().mockResolvedValue(field)
    const loadFields = vi.fn().mockResolvedValue(undefined)
    const activateParentField = vi.fn().mockResolvedValue(true)

    const result = await createAndActivateParentField({
      tableId: 't-1',
      createParentField,
      loadFields,
      activateParentField,
    })

    expect(result).toEqual({ status: 'activated', field })
    expect(createParentField).toHaveBeenCalledWith('t-1')
    expect(loadFields).toHaveBeenCalledWith('t-1')
    expect(activateParentField).toHaveBeenCalledWith('fld-1')
    expect(loadFields.mock.invocationCallOrder[0]).toBeLessThan(
      activateParentField.mock.invocationCallOrder[0],
    )
  })

  it('第二次创建得到新字段 id', async () => {
    const createParentField = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'fld-1',
        name: '父记录',
        field_type: 'link',
        config: {},
      })
      .mockResolvedValueOnce({
        id: 'fld-2',
        name: '父记录 1',
        field_type: 'link',
        config: {},
      })
    const loadFields = vi.fn().mockResolvedValue(undefined)
    const activateParentField = vi.fn().mockResolvedValue(true)

    const first = await createAndActivateParentField({
      tableId: 't-1',
      createParentField,
      loadFields,
      activateParentField,
    })
    const second = await createAndActivateParentField({
      tableId: 't-1',
      createParentField,
      loadFields,
      activateParentField,
    })

    expect(first.status).toBe('activated')
    expect(second.status).toBe('activated')
    if (first.status === 'activated' && second.status === 'activated') {
      expect(first.field.id).not.toBe(second.field.id)
    }
  })

  it('创建成功但激活失败时保留字段并可恢复', async () => {
    const field = {
      id: 'fld-keep',
      name: '父记录',
      field_type: 'link',
      config: {},
    }
    const result = await createAndActivateParentField({
      tableId: 't-1',
      createParentField: vi.fn().mockResolvedValue(field),
      loadFields: vi.fn().mockResolvedValue(undefined),
      activateParentField: vi.fn().mockResolvedValue(false),
    })

    expect(result).toEqual({ status: 'created_not_activated', field })
  })

  it('创建失败返回 failed', async () => {
    const error = new Error('network')
    const result = await createAndActivateParentField({
      tableId: 't-1',
      createParentField: vi.fn().mockRejectedValue(error),
      loadFields: vi.fn(),
      activateParentField: vi.fn(),
    })

    expect(result).toEqual({ status: 'failed', error })
  })

  it('创建成功但 loadFields 失败时保留字段', async () => {
    const field = {
      id: 'fld-keep-2',
      name: '父记录',
      field_type: 'link',
      config: {},
    }
    const result = await createAndActivateParentField({
      tableId: 't-1',
      createParentField: vi.fn().mockResolvedValue(field),
      loadFields: vi.fn().mockRejectedValue(new Error('refresh failed')),
      activateParentField: vi.fn(),
    })

    expect(result).toEqual({ status: 'created_not_activated', field })
  })

  it('创建后先 waitUntilFieldReady 再激活', async () => {
    const field = {
      id: 'fld-wait',
      name: '父记录',
      field_type: 'link',
      config: {},
    }
    const waitUntilFieldReady = vi.fn().mockResolvedValue(true)
    const activateParentField = vi.fn().mockResolvedValue(true)
    const loadFields = vi.fn().mockResolvedValue(undefined)

    await createAndActivateParentField({
      tableId: 't-1',
      createParentField: vi.fn().mockResolvedValue(field),
      loadFields,
      waitUntilFieldReady,
      activateParentField,
    })

    expect(waitUntilFieldReady).toHaveBeenCalledWith('t-1', 'fld-wait')
    expect(loadFields.mock.invocationCallOrder[0]).toBeLessThan(
      waitUntilFieldReady.mock.invocationCallOrder[0],
    )
    expect(waitUntilFieldReady.mock.invocationCallOrder[0]).toBeLessThan(
      activateParentField.mock.invocationCallOrder[0],
    )
  })

  it('waitUntilFieldReady 返回 false 时不激活', async () => {
    const field = {
      id: 'fld-not-ready',
      name: '父记录',
      field_type: 'link',
      config: {},
    }
    const activateParentField = vi.fn().mockResolvedValue(true)
    const result = await createAndActivateParentField({
      tableId: 't-1',
      createParentField: vi.fn().mockResolvedValue(field),
      loadFields: vi.fn().mockResolvedValue(undefined),
      waitUntilFieldReady: vi.fn().mockResolvedValue(false),
      activateParentField,
    })

    expect(result).toEqual({ status: 'created_not_activated', field })
    expect(activateParentField).not.toHaveBeenCalled()
  })

  it('wait 读 Provider store 立即就绪，不依赖空的全局 fields', async () => {
    const field = {
      id: 'fld-provider',
      name: '父记录',
      field_type: 'link',
      config: {},
    }
    // 模拟 TablePane Provider 内 store 已有字段，模块级全局 tableStore.fields 仍为空
    const providerFields = [{ id: 'fld-provider' }]
    const globalFields: { id: string }[] = []
    const activateParentField = vi.fn().mockResolvedValue(true)
    const waitStartedAt = Date.now()

    const result = await createAndActivateParentField({
      tableId: 't-1',
      createParentField: vi.fn().mockResolvedValue(field),
      loadFields: vi.fn().mockResolvedValue(undefined),
      waitUntilFieldReady: async (_tableId, fieldId) =>
        waitForCondition(
          () => providerFields.some((f) => f.id === fieldId),
          { timeoutMs: 3000, intervalMs: 1 },
        ),
      activateParentField,
    })

    const elapsedMs = Date.now() - waitStartedAt
    expect(globalFields).toEqual([])
    expect(result.status).toBe('activated')
    expect(activateParentField).toHaveBeenCalledWith('fld-provider')
    // 正确读 Provider 时应瞬时通过，绝不应打满 3s 超时
    expect(elapsedMs).toBeLessThan(200)
  })
})
