import { describe, expect, it } from 'vitest'

import { buildTableCollabSharedRuntimeKey } from '../useTableCollaboration'

describe('TabData shared collaboration runtime key', () => {
  it('同一账号同一张表在不同父文档授权入口下保持同一资源身份', () => {
    const first = buildTableCollabSharedRuntimeKey({
      serverUrl: 'ws://localhost:4100/collaboration',
      userId: 'user-1',
      tableId: 'table-1',
    })
    const second = buildTableCollabSharedRuntimeKey({
      serverUrl: 'ws://localhost:4100/collaboration',
      userId: 'user-1',
      tableId: 'table-1',
    })

    expect(first).toBe(second)
    expect(first).not.toContain('parent-document')
  })

  it('不同账号、协同端点或表不会共享运行时', () => {
    const base = buildTableCollabSharedRuntimeKey({
      serverUrl: 'ws://localhost:4100/collaboration',
      userId: 'user-1',
      tableId: 'table-1',
    })

    expect(buildTableCollabSharedRuntimeKey({
      serverUrl: 'ws://localhost:4100/collaboration',
      userId: 'user-2',
      tableId: 'table-1',
    })).not.toBe(base)
    expect(buildTableCollabSharedRuntimeKey({
      serverUrl: 'wss://preprod.example/collaboration',
      userId: 'user-1',
      tableId: 'table-1',
    })).not.toBe(base)
    expect(buildTableCollabSharedRuntimeKey({
      serverUrl: 'ws://localhost:4100/collaboration',
      userId: 'user-1',
      tableId: 'table-2',
    })).not.toBe(base)
  })
})
