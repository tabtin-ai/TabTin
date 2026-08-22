import { describe, expect, it } from 'vitest'
import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import { buildRecoveryPlanContract, resolveRecoveryFileAnchor } from '../recoveryPlan'

describe('resolveRecoveryFileAnchor', () => {
  it('服务端预览有锚点时不依赖本地消息缓存', () => {
    const preview = {
      file_restore_host: 'local',
      rewind_anchor_id: 'run-from-preview',
    } as RollbackPreviewResult

    expect(resolveRecoveryFileAnchor(preview, null)).toEqual({
      id: 'run-from-preview',
      source: 'preview',
    })
  })

  it('服务端锚点与本地缓存不同时仍选择服务端锚点', () => {
    const preview = {
      file_restore_host: 'local',
      rewind_anchor_id: 'run-from-preview',
    } as RollbackPreviewResult

    expect(resolveRecoveryFileAnchor(preview, 'run-from-cache')).toEqual({
      id: 'run-from-preview',
      source: 'preview',
    })
  })

  it('服务端明确返回空锚点时不回落到本地缓存', () => {
    const preview = {
      file_restore_host: 'local',
      rewind_anchor_id: null,
    } as RollbackPreviewResult

    expect(resolveRecoveryFileAnchor(preview, 'run-from-cache')).toEqual({
      id: null,
      source: 'preview',
    })
  })

  it('旧 preview 没有锚点字段时才使用本地缓存', () => {
    const preview = { file_restore_host: 'local' } as RollbackPreviewResult

    expect(resolveRecoveryFileAnchor(preview, 'run-from-cache')).toEqual({
      id: 'run-from-cache',
      source: 'legacy_message_cache',
    })
  })
})

describe('buildRecoveryPlanContract', () => {
  it('把分散的恢复版本和权威锚点收进一个执行契约', () => {
    const preview = {
      rollback_contract_version: 2,
      preview_revision: 'preview-v1',
      file_restore_host: 'local',
      rewind_anchor_id: 'run-from-preview',
    } as RollbackPreviewResult

    expect(buildRecoveryPlanContract({
      preview,
      fileAnchor: { id: 'run-from-preview', source: 'preview' },
      localFilePreviewRevision: 'file-v1',
    })).toEqual({
      version: 2,
      previewRevision: 'preview-v1',
      filePreviewRevision: 'file-v1',
      fileAnchor: {
        id: 'run-from-preview',
        source: 'preview',
      },
    })
  })
})
