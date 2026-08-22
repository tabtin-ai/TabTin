import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// contract Wave 1-B：chatExtraApi 已迁出直 fetch，统一走 services/electronFetch。
// 测试相应改为 mock 该 helper（语义等价于原先 stubGlobal('fetch')）。
const { authState, fetchMock } = vi.hoisted(() => ({
  authState: {
    accessToken: 'token-1',
  },
  fetchMock: vi.fn(),
}))

vi.mock('../../stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => authState,
  },
}))

vi.mock('../../config/api', () => ({
  API_CONFIG: {
    baseURL: 'https://api.test',
  },
}))

vi.mock('../electronFetch', () => ({
  electronFetch: fetchMock,
}))

let rollbackAgentRun: typeof import('../chatExtraApi').rollbackAgentRun
let createSpaceCheckpoint: typeof import('../chatExtraApi').createSpaceCheckpoint
let listSpaceCheckpoints: typeof import('../chatExtraApi').listSpaceCheckpoints
let rollbackPreview: typeof import('../chatExtraApi').rollbackPreview
let rollbackSession: typeof import('../chatExtraApi').rollbackSession

function createResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  authState.accessToken = 'token-1'
  fetchMock.mockReset()

  const mod = await import('../chatExtraApi')
  rollbackAgentRun = mod.rollbackAgentRun
  createSpaceCheckpoint = mod.createSpaceCheckpoint
  listSpaceCheckpoints = mod.listSpaceCheckpoints
  rollbackPreview = mod.rollbackPreview
  rollbackSession = mod.rollbackSession
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// E2E-034 回归测试：rollbackAgentRun 函数存在且能正确调用后端端点
describe('chatExtraApi rollbackAgentRun (E2E-034)', () => {
  it('调用 POST /collab/v1/agent-run/{id}/rollback 并返回解析后的响应', async () => {
    const mockResponse = {
      status: 'ok',
      data: {
        agent_run_id: 'run-abc',
        rollback_results: [
          {
            resource_type: 'slide',
            resource_id: 'res-1',
            resource_name: '我的演示文稿',
            status: 'restored',
            restored_to: 'vh-old',
            new_version: 'vh-new',
          },
        ],
      },
    }
    fetchMock.mockResolvedValue(createResponse(mockResponse))

    const result = await rollbackAgentRun('run-abc')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/collab/v1/agent-run/run-abc/rollback',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result.agent_run_id).toBe('run-abc')
    expect(result.rollback_results).toHaveLength(1)
    expect(result.rollback_results[0].resource_name).toBe('我的演示文稿')
  })

  it('当所有资源均被 skip 时，响应中包含 all_skipped=true', async () => {
    const mockResponse = {
      status: 'ok',
      data: {
        agent_run_id: 'run-xyz',
        rollback_results: [
          {
            resource_type: 'doc',
            resource_id: 'res-2',
            resource_name: '测试文档',
            status: 'skipped',
            reason: 'new_resource',
          },
        ],
        all_skipped: true,
      },
    }
    fetchMock.mockResolvedValue(createResponse(mockResponse))

    const result = await rollbackAgentRun('run-xyz')

    expect(result.all_skipped).toBe(true)
    expect(result.rollback_results[0].reason).toBe('new_resource')
    expect(result.rollback_results[0].resource_name).toBe('测试文档')
  })

  // E2E-035 回归测试：skipped 响应包含 reason 细分和 resource_name
  it('skipped 响应包含 reason=no_version_history 时正确透传', async () => {
    const mockResponse = {
      status: 'ok',
      data: {
        agent_run_id: 'run-err',
        rollback_results: [
          {
            resource_type: 'table',
            resource_id: 'res-3',
            resource_name: '数据表',
            status: 'skipped',
            reason: 'no_version_history',
            detail: 'VersionHistory was not written (likely Redis unavailable).',
          },
        ],
      },
    }
    fetchMock.mockResolvedValue(createResponse(mockResponse))

    const result = await rollbackAgentRun('run-err')

    expect(result.rollback_results[0].status).toBe('skipped')
    expect(result.rollback_results[0].reason).toBe('no_version_history')
    expect(result.rollback_results[0].resource_name).toBe('数据表')
    expect(result.rollback_results[0].detail).toBeTruthy()
  })

  it('HTTP 4xx 时抛出错误', async () => {
    fetchMock.mockResolvedValue(
      createResponse({ status: 'error', message: 'resource not found' }, false, 404),
    )

    await expect(rollbackAgentRun('run-notfound')).rejects.toThrow()
  })
})

describe('chatExtraApi createSpaceCheckpoint', () => {
  it('正确解包 collab API 的 {"status": "ok", "data": ...} 格式', async () => {
    const mockResponse = {
      status: 'ok',
      data: {
        id: 'cp-123',
        name: '',
        resource_count: 2,
        created_at: '2026-03-27T14:00:00Z',
      },
    }
    fetchMock.mockResolvedValue(createResponse(mockResponse))

    const result = await createSpaceCheckpoint({ spaceId: 'space-1' })

    expect(result).not.toBeNull()
    expect(result!.id).toBe('cp-123')
  })

  it('HTTP 错误时返回 null 而非抛出', async () => {
    fetchMock.mockResolvedValue(
      createResponse({ status: 'error', message: 'bad request' }, false, 400),
    )

    const result = await createSpaceCheckpoint({ spaceId: 'space-1' })
    expect(result).toBeNull()
  })
})

describe('chatExtraApi listSpaceCheckpoints', () => {
  it('正确解包 list API 的 data + total', async () => {
    fetchMock.mockResolvedValue(createResponse({
      status: 'ok',
      data: [
        {
          id: 'cp-1',
          name: '',
          trigger: 'manual',
          resource_count: 3,
          file_checkpoint_hash: 'hash1',
          agent_run_id: '',
          anchor_session_id: 'session-1',
          anchor_message_id: '',
          editor_type: 'user',
          editor_name: '测试用户',
          created_at: '2026-07-05T10:00:00Z',
        },
      ],
      total: 1,
    }))

    const result = await listSpaceCheckpoints('space-1')

    expect(result.total).toBe(1)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].trigger).toBe('manual')
    expect(result.items[0].anchor_session_id).toBe('session-1')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/collab/v1/space-checkpoint/space-1/list'),
      expect.any(Object),
    )
  })
})

describe('chatExtraApi checkpoint contract alignment', () => {
  it('rollbackPreview 透传聚合字段', async () => {
    fetchMock.mockResolvedValue(createResponse({
      success: true,
      code: 0,
      data: {
        target_message_id: 'msg-1',
        target_timestamp: '2026-04-05T12:00:00Z',
        checkpoint_hash: 'hash-1',
        messages_to_remove: 2,
        messages_preview: [],
        resource_changes: [],
        resource_restore_plan: [],
        unrestorable_items: [],
        no_impact: false,
        degraded_reasons: ['missing_resource_snapshot'],
        impact: {
          files: { available: true, diff_available: true },
          resources: { available: false, change_count: 0, restore_count: 0 },
          messages: { to_remove: 2 },
        },
        effective_checkpoint: {
          checkpoint_id: 'msg-1',
          session_id: 'session-1',
          anchor_type: 'assistant_turn',
          status: 'degraded',
          capability_scope: {
            message_preview: true,
            file_diff: true,
            file_restore: true,
            resource_restore: false,
            unrevert: true,
          },
          degraded_reasons: ['missing_resource_snapshot'],
        },
      },
    }))

    const result = await rollbackPreview('session-1', 'msg-1')

    expect(result.no_impact).toBe(false)
    expect(result.impact?.files.available).toBe(true)
    expect(result.effective_checkpoint?.checkpoint_id).toBe('msg-1')
  })

  it('rollbackSession 透传 apply_result 与 checkpoint_record', async () => {
    fetchMock.mockResolvedValue(createResponse({
      success: true,
      code: 0,
      data: {
        success: true,
        checkpoint_hash: 'hash-1',
        overall_status: 'success',
        rollback_state: {
          session_id: 'session-1',
          revert_active: true,
          cleanup_status: 'pending',
          can_unrevert: true,
        },
        checkpoint_record: {
          checkpoint_id: 'msg-1',
          session_id: 'session-1',
          anchor_type: 'assistant_turn',
          status: 'ready',
          capability_scope: {
            message_preview: true,
            file_diff: true,
            file_restore: true,
            resource_restore: true,
            unrevert: true,
          },
          degraded_reasons: [],
        },
        apply_result: {
          apply_id: 'rollback:1',
          overall_status: 'success',
          session_state: {
            session_id: 'session-1',
            revert_active: true,
            cleanup_status: 'pending',
            can_unrevert: true,
          },
          layers: {
            conversation: { status: 'success', restored_count: 0, failed_count: 0, retryable: [], warnings: [] },
            workspace_files: { status: 'success', restored_count: 0, failed_count: 0, retryable: [], warnings: [] },
            resources: { status: 'not_applicable', restored_count: 0, failed_count: 0, retryable: [], warnings: [] },
            pg_state: { status: 'pending', restored_count: 0, failed_count: 0, retryable: [], warnings: [] },
          },
          collab_sync_warnings: [],
        },
      },
    }))

    const result = await rollbackSession('session-1', 'msg-1')

    expect(result.checkpoint_record?.checkpoint_id).toBe('msg-1')
    expect(result.apply_result?.session_state.cleanup_status).toBe('pending')
  })

  // ：404「目标消息不存在」时，抛出的 Error 需携带 status/code 供前端做 self-heal 判定
  it('rollbackPreview 命中 404 NOT_FOUND 时抛错携带 status 与 code', async () => {
    fetchMock.mockResolvedValue(createResponse(
      { success: false, code: 'NOT_FOUND', message: '目标消息不存在', data: null },
      false,
      404,
    ))

    await expect(rollbackPreview('session-1', 'ghost-msg')).rejects.toMatchObject({
      message: '目标消息不存在',
      status: 404,
      code: 'NOT_FOUND',
    })
  })

  it('rollbackSession 命中 404 NOT_FOUND 时抛错携带 status 与 code', async () => {
    fetchMock.mockResolvedValue(createResponse(
      { success: false, code: 'NOT_FOUND', message: '目标消息不存在', data: null },
      false,
      404,
    ))

    await expect(rollbackSession('session-1', 'ghost-msg')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    })
  })
})

