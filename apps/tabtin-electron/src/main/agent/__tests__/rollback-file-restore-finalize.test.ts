import { describe, expect, it, vi } from 'vitest'
import {
  finalizeLocalFileRestore,
  mergeFinalizedFileRestoreBackend,
  resolvePendingFileRestoreApply,
} from '../rollback-file-restore-finalize'

describe('rollback file restore finalize contract', () => {
  it('从初次 rollback 响应读取 pending apply identity', () => {
    expect(resolvePendingFileRestoreApply({
      file_restore_finalize_required: true,
      file_restore_finalize_expires_at: '2026-08-14T16:30:00+08:00',
      apply_result: { apply_id: 'rollback:session-1:operation-1' },
    })).toEqual({
      required: true,
      applyId: 'rollback:session-1:operation-1',
      expiresAt: '2026-08-14T16:30:00+08:00',
    })
  })

  it('成功 finalize 后不会把初次 rollback 的 pending 标记泄漏给 renderer', () => {
    expect(mergeFinalizedFileRestoreBackend({
      file_restore_finalize_required: true,
      file_restore_finalize_expires_at: '2026-08-14T16:30:00+08:00',
      file_restore_status: 'pending',
    }, {
      file_restore_status: 'success',
    })).toMatchObject({
      file_restore_finalize_required: false,
      file_restore_finalize_expires_at: null,
      file_restore_status: 'success',
      file_restore_coordinated_by_host: true,
      file_restore_host: 'local',
    })
  })

  it('携带双 revision 与真实文件结果完成同一 apply', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        success: true,
        apply_id: 'rollback:session-1:operation-1',
        file_restore_status: 'partial',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await finalizeLocalFileRestore({
      apiBaseUrl: 'http://api.example.test/api',
      sessionId: 'session-1',
      accessToken: 'token-1',
      organizationId: 'organization-1',
      applyId: 'rollback:session-1:operation-1',
      rollbackContractVersion: 2,
      previewRevision: 'preview-1',
      filePreviewRevision: 'file-preview-1',
      result: {
        status: 'partial',
        reason: 'unrestorable_files',
        failedFiles: ['/workspace/missing.bin'],
        unrestorableFiles: [{ path: 'missing.bin', reason: 'backup_missing' }],
      },
      fetchImpl: fetchImpl as typeof fetch,
    })

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ file_restore_status: 'partial' }),
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://api.example.test/api/chat/sessions/session-1/rollback/files/finalize',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Client-Type': 'electron' }),
        body: JSON.stringify({
          apply_id: 'rollback:session-1:operation-1',
          rollback_contract_version: 2,
          preview_revision: 'preview-1',
          file_preview_revision: 'file-preview-1',
          file_restore_status: 'partial',
          file_restore_reason: 'unrestorable_files',
          failed_files: ['/workspace/missing.bin'],
          unrestorable_files: [{ path: 'missing.bin', reason: 'backup_missing' }],
        }),
      }),
    )
  })

  it('finalize 被服务端拒绝时返回显式失败，调用方可停发保稿', async () => {
    const result = await finalizeLocalFileRestore({
      apiBaseUrl: 'http://api.example.test/api',
      sessionId: 'session-1',
      accessToken: 'token-1',
      applyId: 'rollback:session-1:operation-1',
      rollbackContractVersion: 2,
      previewRevision: 'preview-1',
      filePreviewRevision: 'file-preview-1',
      result: { status: 'success', reason: null, failedFiles: [], unrestorableFiles: [] },
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ message: 'stale apply' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch,
    })

    expect(result).toEqual(expect.objectContaining({ ok: false, error: 'stale apply' }))
  })

  it('瞬时网络失败会用同一 apply 进行有限幂等重试', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('socket reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { apply_id: 'rollback:session-1:operation-1', file_restore_status: 'success' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await finalizeLocalFileRestore({
      apiBaseUrl: 'http://api.example.test/api',
      sessionId: 'session-1',
      accessToken: 'token-1',
      applyId: 'rollback:session-1:operation-1',
      rollbackContractVersion: 2,
      previewRevision: 'preview-1',
      filePreviewRevision: 'file-preview-1',
      result: { status: 'success', reason: null, failedFiles: [], unrestorableFiles: [] },
      fetchImpl: fetchImpl as typeof fetch,
      retryDelayMs: 0,
    })

    expect(result).toMatchObject({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
