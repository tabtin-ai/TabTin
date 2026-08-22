import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  electronFetch: vi.fn(),
  accessToken: 'token',
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ accessToken: mocks.accessToken }),
  },
}))

vi.mock('@/services/electronFetch', () => ({
  electronFetch: mocks.electronFetch,
}))

vi.mock('@tabtin/config', () => ({
  getApiRuntimeConfig: () => ({ chatApiBaseUrl: 'https://api.example.test' }),
}))

import { resolveContextBlocks } from '../contextBlockResolution'

describe('resolveContextBlocks MCP focus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.accessToken = 'token'
  })

  it('只有 MCP focus 时本地解析且不请求后端', async () => {
    const result = await resolveContextBlocks([
      { type: 'mcp_server', connection_id: 'conn-1', server_name: 'github' },
    ])

    expect(result).toContain('server_name="github"')
    expect(result).toContain('其他已启用 MCP 仍然可用')
    expect(mocks.electronFetch).not.toHaveBeenCalled()
  })

  it('后端资源解析成功时仍保留 MCP focus', async () => {
    mocks.electronFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { context_text: 'RESOURCE_CONTEXT' } }),
    })

    const result = await resolveContextBlocks([
      { type: 'table', table_id: 'table-1', preview: '客户表' },
      { type: 'mcp_server', connection_id: 'conn-1', server_name: 'github' },
    ])

    expect(result).toContain('RESOURCE_CONTEXT')
    expect(result).toContain('server_name="github"')
    const request = mocks.electronFetch.mock.calls[0][1]
    expect(JSON.parse(request.body)).toEqual({
      blocks: [{ type: 'table', table_id: 'table-1', preview: '客户表' }],
    })
  })
})

describe('resolveContextBlocks file ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.accessToken = 'token'
  })

  const fileBlock = {
    type: 'file',
    preview: '测试文件.csv',
    file_id: '35a0a25a-88c5-4cf2-b2c7-58c65e7009b5',
    tab_type: 'file',
  }

  it('file block 必须进入 /resolve-context 请求体', async () => {
    mocks.electronFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          context_text: [
            '## 文件: 测试文件.csv',
            'file_id: 35a0a25a-88c5-4cf2-b2c7-58c65e7009b5',
            '来源标签: file',
          ].join('\n'),
        },
      }),
    })

    const result = await resolveContextBlocks([fileBlock])

    expect(result).toContain('## 文件: 测试文件.csv')
    expect(result).toContain('file_id: 35a0a25a-88c5-4cf2-b2c7-58c65e7009b5')
    expect(mocks.electronFetch).toHaveBeenCalledWith(
      expect.stringContaining('/resolve-context'),
      expect.any(Object),
    )
    const request = mocks.electronFetch.mock.calls[0][1]
    expect(JSON.parse(request.body)).toEqual({ blocks: [fileBlock] })
  })

  it('无 token 时本地 fallback 仍产出含 file_id 的最小上下文', async () => {
    mocks.accessToken = ''

    const result = await resolveContextBlocks([fileBlock])

    expect(result).toContain('## 文件: 测试文件.csv')
    expect(result).toContain('file_id: 35a0a25a-88c5-4cf2-b2c7-58c65e7009b5')
    expect(result).toContain('来源标签: file')
    expect(mocks.electronFetch).not.toHaveBeenCalled()
  })

  it('resolve-context 失败时本地 fallback 仍产出含 file_id 的最小上下文', async () => {
    mocks.electronFetch.mockRejectedValue(new Error('network down'))

    const result = await resolveContextBlocks([fileBlock])

    expect(result).toContain('## 文件: 测试文件.csv')
    expect(result).toContain('file_id: 35a0a25a-88c5-4cf2-b2c7-58c65e7009b5')
    expect(result).toContain('来源标签: file')
  })
})
