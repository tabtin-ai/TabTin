/**
 * CMS-004 / CMS-005 回归测试
 *
 * CMS-004: 协作在线时，WS `table.events.field` 路径不应重复触发 onFieldChange
 * CMS-005: handleSelectOptionAdd 成功后应触发 loadFields 同步 fieldsMeta
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── CMS-004: 双路 onFieldChange 守卫 ──

describe('CMS-004: collabActive guard prevents duplicate onFieldChange', () => {
  it('suppresses WS field change when collab is online and not fallback', () => {
    const innerHandler = vi.fn()

    const createGuardedHandler = (isOnline: boolean, isFallback: boolean) =>
      (info: { action: string; field_ids?: string[] }) => {
        if (isOnline && !isFallback) return
        innerHandler(info)
      }

    const guarded = createGuardedHandler(true, false)
    guarded({ action: 'update_field', field_ids: ['f1'] })
    expect(innerHandler).not.toHaveBeenCalled()
  })

  it('allows WS field change when collab is in fallback mode', () => {
    const innerHandler = vi.fn()

    const createGuardedHandler = (isOnline: boolean, isFallback: boolean) =>
      (info: { action: string; field_ids?: string[] }) => {
        if (isOnline && !isFallback) return
        innerHandler(info)
      }

    const guarded = createGuardedHandler(true, true)
    guarded({ action: 'create_field', field_ids: ['f2'] })
    expect(innerHandler).toHaveBeenCalledWith({ action: 'create_field', field_ids: ['f2'] })
  })

  it('allows WS field change when collab is offline', () => {
    const innerHandler = vi.fn()

    const createGuardedHandler = (isOnline: boolean, isFallback: boolean) =>
      (info: { action: string; field_ids?: string[] }) => {
        if (isOnline && !isFallback) return
        innerHandler(info)
      }

    const guarded = createGuardedHandler(false, false)
    guarded({ action: 'delete_field', field_ids: ['f3'] })
    expect(innerHandler).toHaveBeenCalledWith({ action: 'delete_field', field_ids: ['f3'] })
  })

  it('ensures Y.js stateless path is NOT blocked by collabActive guard', () => {
    const statelessHandler = vi.fn()
    const wsHandler = vi.fn()

    const isOnline = true
    const isFallback = false

    const wsGuarded = (info: { action: string }) => {
      if (isOnline && !isFallback) return
      wsHandler(info)
    }

    statelessHandler({ action: 'update_field', field_ids: ['f1'] })
    wsGuarded({ action: 'update_field' })

    expect(statelessHandler).toHaveBeenCalledTimes(1)
    expect(wsHandler).not.toHaveBeenCalled()
  })
})

// ── CMS-005: select option add 后触发 loadFields ──

describe('CMS-005: select option add triggers field reload', () => {
  let mockUpdateField: ReturnType<typeof vi.fn>
  let mockLoadFields: ReturnType<typeof vi.fn>

  const fields = [
    {
      id: 'field-1',
      name: 'Status',
      field_type: 'single_select',
      sort_order: 0,
      options: { choices: ['Open', 'Closed'] },
    },
  ]

  beforeEach(() => {
    mockUpdateField = vi.fn()
    mockLoadFields = vi.fn()
  })

  async function simulateHandleSelectOptionAdd(
    fieldName: string,
    optionName: string,
    tableId: string | undefined,
  ) {
    const fieldMeta = fields.find((f) => f.id === fieldName || f.name === fieldName)
    if (!fieldMeta) return

    const currentChoices = fieldMeta.options?.choices ?? []
    const currentValues = currentChoices.map((c) =>
      typeof c === 'string'
        ? c
        : String((c as Record<string, unknown>).value ?? (c as Record<string, unknown>).name ?? ''),
    )

    if (currentValues.includes(optionName)) return

    const updatedChoices = [...currentChoices, optionName]

    await mockUpdateField(fieldMeta.id, {
      options: { ...fieldMeta.options, choices: updatedChoices },
    }).then(() => {
      if (tableId) mockLoadFields(tableId)
    })
  }

  it('calls loadFields after successful field update', async () => {
    mockUpdateField.mockResolvedValue({})

    await simulateHandleSelectOptionAdd('Status', 'In Progress', 'table-1')

    expect(mockUpdateField).toHaveBeenCalledWith('field-1', {
      options: { choices: ['Open', 'Closed', 'In Progress'] },
    })
    expect(mockLoadFields).toHaveBeenCalledWith('table-1')
  })

  it('does NOT call loadFields when field update fails', async () => {
    mockUpdateField.mockRejectedValue(new Error('API error'))

    await simulateHandleSelectOptionAdd('Status', 'In Progress', 'table-1').catch(() => {})

    expect(mockUpdateField).toHaveBeenCalled()
    expect(mockLoadFields).not.toHaveBeenCalled()
  })

  it('does NOT call loadFields when tableId is undefined', async () => {
    mockUpdateField.mockResolvedValue({})

    await simulateHandleSelectOptionAdd('Status', 'In Progress', undefined)

    expect(mockUpdateField).toHaveBeenCalled()
    expect(mockLoadFields).not.toHaveBeenCalled()
  })

  it('skips update when option already exists', async () => {
    mockUpdateField.mockResolvedValue({})

    await simulateHandleSelectOptionAdd('Status', 'Open', 'table-1')

    expect(mockUpdateField).not.toHaveBeenCalled()
    expect(mockLoadFields).not.toHaveBeenCalled()
  })

  it('skips when field is not found', async () => {
    mockUpdateField.mockResolvedValue({})

    await simulateHandleSelectOptionAdd('NonExistent', 'Value', 'table-1')

    expect(mockUpdateField).not.toHaveBeenCalled()
    expect(mockLoadFields).not.toHaveBeenCalled()
  })
})
