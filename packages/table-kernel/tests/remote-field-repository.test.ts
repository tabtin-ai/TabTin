import { describe, expect, it, vi } from 'vitest'
import { RemoteFieldRepository } from '../src/index.js'
import type { RemoteApiClient } from '../src/index.js'

function createApi(overrides: Partial<RemoteApiClient> = {}): RemoteApiClient {
  return {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ data: { id: 'fld_1' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
    ...overrides,
  }
}

describe('RemoteFieldRepository', () => {
  it('serializes default values when creating a field', async () => {
    const api = createApi()
    const repository = new RemoteFieldRepository(api)

    const result = await repository.createField({
      tableId: 'tbl_1',
      name: 'Title',
      fieldType: 'text',
      defaultValue: { mode: 'literal', value: 'Draft' },
    })

    expect(result.success).toBe(true)
    expect(api.post).toHaveBeenCalledWith('/tabdata/fields', {
      table_id: 'tbl_1',
      name: 'Title',
      field_type: 'text',
      options: undefined,
      default_value: { mode: 'literal', value: 'Draft' },
    })
  })

  it('deserializes field snapshots', async () => {
    const api = createApi({
      get: vi.fn().mockResolvedValue({
        data: {
          id: 'fld_1',
          table_id: 'tbl_1',
          name: 'Title',
          field_type: 'text',
          is_primary: false,
          default_value: { mode: 'literal', value: 'Draft' },
        },
      }),
    })
    const repository = new RemoteFieldRepository(api)

    const field = await repository.getField('tbl_1', 'fld_1')

    expect(field).toMatchObject({
      fieldId: 'fld_1',
      defaultValue: { mode: 'literal', value: 'Draft' },
    })
  })

  it('serializes default values when updating a field', async () => {
    const api = createApi()
    const repository = new RemoteFieldRepository(api)

    const result = await repository.updateField({
      tableId: 'tbl_1',
      fieldId: 'fld_1',
      changes: { defaultValue: { mode: 'literal', value: 'Ready' } },
    })

    expect(result.success).toBe(true)
    expect(api.patch).toHaveBeenCalledWith('/tabdata/fields/fld_1', {
      default_value: { mode: 'literal', value: 'Ready' },
    })
  })
})
