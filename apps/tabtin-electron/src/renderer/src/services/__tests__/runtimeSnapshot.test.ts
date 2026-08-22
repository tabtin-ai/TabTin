import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_DISCOVERY_SNAPSHOT_VERSION } from '@tabtin/shared'
import { collectCurrentHostRuntimeSnapshot } from '../runtimeSnapshot'

describe('collectCurrentHostRuntimeSnapshot', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        agent: {
          getRegisteredTools: vi.fn().mockResolvedValue(['read_file', 'tabtin_table_query']),
        },
      },
    })
  })

  it('does not report outbound mcp_server on Electron host snapshots', async () => {
    const snapshot = await collectCurrentHostRuntimeSnapshot()

    expect(snapshot.version).toBe(CAPABILITY_DISCOVERY_SNAPSHOT_VERSION)
    expect(snapshot.source).toBe('electron')
    expect(snapshot.runtime_tools.map(tool => tool.name)).toEqual(['read_file', 'tabtin_table_query'])
    expect(snapshot).not.toHaveProperty('mcp_server')
  })
})
