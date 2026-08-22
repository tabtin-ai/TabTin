import { describe, it, expect, vi } from 'vitest'
import { RemoteViewRepository } from '../src/adapters/view/remote-view-repository.js'
import type { RemoteApiClient } from '../src/ports/index.js'

function successEnvelope(data: unknown) {
  return { success: true, data }
}

describe('RemoteViewRepository', () => {
  it('兼容 legacy columnMeta 输入，但请求体统一发送 column_meta', async () => {
    const post = vi.fn(async () => successEnvelope({ id: 'viw_1' }))
    const repo = new RemoteViewRepository({
      basePath: '/tabdata',
      post,
      patch: vi.fn(async () => successEnvelope({})),
      delete: vi.fn(async () => successEnvelope({})),
    } as RemoteApiClient)

    await repo.createView({
      tableId: 'tbl_1',
      name: 'Grid',
      viewType: 'grid',
      columnMeta: { fld_title: { width: 220 } },
    })

    expect(post).toHaveBeenCalledWith('/tabdata/views', {
      table_id: 'tbl_1',
      name: 'Grid',
      view_type: 'grid',
      column_meta: { fld_title: { width: 220 } },
    })
  })

  it('读取接口响应时会把 columnMeta 归一到 column_meta', async () => {
    const repo = new RemoteViewRepository({
      basePath: '/tabdata',
      get: vi.fn(async () => successEnvelope({
        id: 'viw_1',
        table_id: 'tbl_1',
        name: 'Grid',
        view_type: 'grid',
        columnMeta: { fld_title: { order: 0, width: 220 } },
      })),
      post: vi.fn(async () => successEnvelope({ id: 'viw_1' })),
      patch: vi.fn(async () => successEnvelope({})),
      delete: vi.fn(async () => successEnvelope({})),
    } as RemoteApiClient)

    const snapshot = await repo.getView('viw_1')

    expect(snapshot).toMatchObject({
      viewId: 'viw_1',
      tableId: 'tbl_1',
      column_meta: { fld_title: { order: 0, width: 220 } },
    })
    expect(snapshot?.columnMeta).toBeUndefined()
  })
})
