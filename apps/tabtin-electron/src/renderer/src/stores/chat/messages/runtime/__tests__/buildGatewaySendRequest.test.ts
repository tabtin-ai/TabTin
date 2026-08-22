/**
 * 远程 gateway 物料测试：UI 薄 payload——
 *   1. payload.message = 用户原文（不在 renderer 拼 MCP/preset/@）；
 *   2. payload.blocks 保留 mcp_server 等块，供 Host 拼装 + 气泡渲染；
 *   3. 无 contextBlocks 时 message 与入参完全一致。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}))

const { getLastAppContextMock } = vi.hoisted(() => ({
  getLastAppContextMock: vi.fn(() => null as unknown),
}))

vi.mock('../../../session/slices/contextSyncSlice', () => ({
  getLastAppContext: (...args: unknown[]) => getLastAppContextMock(...args),
}))

const { awaitInFlightContextSyncMock } = vi.hoisted(() => ({
  awaitInFlightContextSyncMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../execution/contextSyncInFlight', () => ({
  awaitInFlightContextSync: (...args: unknown[]) => awaitInFlightContextSyncMock(...args),
}))

import { buildGatewaySendRequest } from '../buildGatewaySendRequest'
import type { BuildGatewaySendRequestParams } from '../buildGatewaySendRequest'

const MCP_BLOCK = {
  type: 'mcp_server',
  connection_id: 'conn-1',
  server_name: 'github',
  preview: 'github',
}

function buildParams(overrides: Partial<BuildGatewaySendRequestParams> = {}): BuildGatewaySendRequestParams {
  return {
    sessionId: 's1',
    message: '帮我看下这个仓库的 issue',
    displayMessage: '帮我看下这个仓库的 issue',
    clientMessageId: 'client-1',
    modelId: 'model-1',
    currentAgentMode: 'agent',
    currentApprovalMode: 'always_ask',
    capturedOrganizationId: 'org-1',
    capturedRuntimeSpaceId: 'space-1',
    ...overrides,
  }
}

describe('buildGatewaySendRequest — MCP focus 远程物料', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getLastAppContextMock.mockReturnValue(null)
  })

  it('contextBlocks 含 mcp_server 时：message 仍为原文，blocks 保留 mcp_server', async () => {
    const params = buildParams({ contextBlocks: [{ ...MCP_BLOCK }] })
    const { payload } = await buildGatewaySendRequest(params)

    expect(payload.message).toBe(params.message)
    expect(String(payload.message)).not.toContain('本轮 MCP focus')

    const blocks = payload.blocks as Array<Record<string, unknown>>
    expect(blocks).toBeDefined()
    const mcpBlock = blocks.find(b => b.type === 'mcp_server')
    expect(mcpBlock).toEqual(MCP_BLOCK)
  })

  it('contextBlocks 不含 mcp_server 时：message 与入参完全一致，不追加任何内容', async () => {
    const params = buildParams({
      contextBlocks: [
        { type: 'webpage', url: 'https://example.com', preview: 'Example' },
      ],
    })
    const { payload } = await buildGatewaySendRequest(params)
    expect(payload.message).toBe(params.message)
  })

  it('contextBlocks 为空时：message 与入参完全一致', async () => {
    const params = buildParams()
    const { payload } = await buildGatewaySendRequest(params)
    expect(payload.message).toBe(params.message)
  })
})

describe('buildGatewaySendRequest — app_context Focus 投影', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getLastAppContextMock.mockReturnValue(null)
  })

  it('gateway payload.app_context 含 appType + openTabs，且无危险字段', async () => {
    getLastAppContextMock.mockReturnValue({
      appType: 'tabcode',
      appMeta: { idField: 'repo-1' },
      openTabs: [
        { type: 'tabcode', id: 'repo-1', title: 'src', active: true, app_key: 'tabcode' },
      ],
      spaceId: 'space-cached',
      userTimeZone: 'Asia/Tokyo',
      billing_precheck_source: 'should-not-leak',
      runtime_mode: 'should-not-leak',
    })

    const { payload } = await buildGatewaySendRequest(buildParams({
      capturedOrganizationId: 'org-9',
      capturedRuntimeSpaceId: 'space-9',
      capturedTabScopeKey: 'desktop:main',
    }))

    const appContext = payload.app_context as Record<string, unknown>
    expect(appContext.appType).toBe('tabcode')
    expect(appContext.openTabs).toEqual([
      { type: 'tabcode', id: 'repo-1', title: 'src', active: true, app_key: 'tabcode' },
    ])
    expect(appContext.userTimeZone).toBe('Asia/Tokyo')
    expect(appContext.spaceId).toBe('space-9')
    expect(appContext.current_space_id).toBe('space-9')
    expect(appContext.current_organization_id).toBe('org-9')
    expect(appContext._invoked_from).toBe('desktop:main')
    expect(appContext).not.toHaveProperty('billing_precheck_source')
    expect(appContext).not.toHaveProperty('runtime_mode')
    expect(appContext).not.toHaveProperty('user_time_zone')
  })

  it('awaitInFlightContextSync 完成后再读取 getLastAppContext（用 post-sync 快照）', async () => {
    const order: string[] = []
    awaitInFlightContextSyncMock.mockImplementation(async () => {
      order.push('await-sync')
    })
    getLastAppContextMock.mockImplementation(() => {
      order.push('get-context')
      return {
        appType: 'tabdoc',
        appMeta: { idField: 'doc-post-sync' },
        openTabs: [
          { type: 'tabdoc', id: 'doc-post-sync', title: '新文档', active: true, app_key: 'tabdoc' },
        ],
        spaceId: 'space-post',
        userTimeZone: 'Asia/Shanghai',
      }
    })

    const { payload } = await buildGatewaySendRequest(buildParams({
      capturedRuntimeSpaceId: 'space-post',
    }))

    expect(order).toEqual(['await-sync', 'get-context'])
    expect(awaitInFlightContextSyncMock).toHaveBeenCalledWith('s1')
    const appContext = payload.app_context as Record<string, unknown>
    expect(appContext.appType).toBe('tabdoc')
    expect(appContext.appMeta).toEqual({ idField: 'doc-post-sync' })
    expect(appContext.openTabs).toEqual([
      { type: 'tabdoc', id: 'doc-post-sync', title: '新文档', active: true, app_key: 'tabdoc' },
    ])
  })
})
