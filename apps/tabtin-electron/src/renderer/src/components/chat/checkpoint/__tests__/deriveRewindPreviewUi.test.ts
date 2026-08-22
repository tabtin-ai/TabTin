import { describe, expect, it } from 'vitest'
import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import {
  deriveDaemonAffectedPaths,
  deriveEditResendImpact,
  deriveFilteredRestorePlan,
  deriveIsSimpleView,
  deriveNoImpact,
  derivePerFileImpact,
  deriveRewindPreviewUi,
  deriveUsesShadowGitFileDiff,
  isMissingTargetError,
} from '../rewind/deriveRewindPreviewUi'
import { getEditResendConfirmLabel } from '../rewind/RewindEditResendDialogParts'

function formatTranslation(defaultValue: string | undefined, options?: Record<string, unknown>) {
  return Object.entries(options ?? {}).reduce((text, [key, value]) => {
    return text.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(value))
  }, defaultValue ?? '')
}

const t = (_key: string, options?: Record<string, unknown> & { defaultValue?: string }) => (
  formatTranslation(options?.defaultValue, options) || _key
)

describe('getEditResendConfirmLabel', () => {
  it.each([
    [{ needsFileAcknowledgement: true, needsResourceAcknowledgement: true, selectedRestorableCount: 1 }, '接受文件及部分资源保持当前状态并重新发送'],
    [{ needsFileAcknowledgement: true, needsResourceAcknowledgement: false, selectedRestorableCount: 1 }, '接受文件不恢复并重新发送'],
    [{ needsFileAcknowledgement: false, needsResourceAcknowledgement: true, selectedRestorableCount: 1 }, '接受部分资源不恢复并重新发送'],
    [{ needsFileAcknowledgement: true, needsResourceAcknowledgement: true, selectedRestorableCount: 0 }, '仅重写对话并重新发送'],
  ])('对文件/资源风险组合给出完整显式授权文案', (input, expected) => {
    expect(getEditResendConfirmLabel({
      isEdit: true,
      ...input,
      t: t as never,
    })).toBe(expected)
  })
})

function basePreview(overrides: Partial<RollbackPreviewResult> = {}): RollbackPreviewResult {
  return {
    target_message_id: 'msg-1',
    target_timestamp: '2026-04-05T12:00:00Z',
    checkpoint_hash: null,
    messages_to_remove: 0,
    messages_preview: [],
    resource_changes: [],
    resource_restore_plan: [],
    resource_preview_status: 'not_applicable',
    unrestorable_items: [],
    no_impact: false,
    degraded_reasons: [],
    impact: {
      files: { available: false, diff_available: false },
      resources: { available: false, change_count: 0, restore_count: 0 },
      messages: { to_remove: 0 },
    },
    effective_checkpoint: null,
    ...overrides,
  }
}

describe('isMissingTargetError', () => {
  it('识别 404 NOT_FOUND', () => {
    expect(isMissingTargetError({ status: 404, code: 'NOT_FOUND' })).toBe(true)
  })

  it('识别本地化文案兜底', () => {
    expect(isMissingTargetError({ message: '消息不存在' })).toBe(true)
  })

  it('非 404 错误返回 false', () => {
    expect(isMissingTargetError({ status: 500, message: 'internal' })).toBe(false)
  })
})

describe('deriveDaemonAffectedPaths', () => {
  it('Daemon 宿主且预览成功时返回 affected_paths', () => {
    const paths = deriveDaemonAffectedPaths({
      ...basePreview(),
      file_restore_host: 'daemon',
      file_preview_success: true,
      affected_paths: ['/a.txt'],
    } as RollbackPreviewResult)
    expect(paths).toEqual(['/a.txt'])
  })

  it('Daemon 预览失败时返回 null（不把空清单当真 0 文件）', () => {
    const paths = deriveDaemonAffectedPaths({
      ...basePreview(),
      file_restore_host: 'daemon',
      file_preview_success: false,
      affected_paths: [],
    } as RollbackPreviewResult)
    expect(paths).toBeNull()
  })

  it('本地宿主返回 null', () => {
    const paths = deriveDaemonAffectedPaths({
      ...basePreview(),
      file_restore_host: 'local',
      affected_paths: ['/a.txt'],
    } as RollbackPreviewResult)
    expect(paths).toBeNull()
  })
})

describe('derivePerFileImpact', () => {
  it('本机 per-file 有文件时 showFileImpact 为 true', () => {
    const result = derivePerFileImpact({
      localAffectedPaths: ['/ws/a.txt'],
      preview: basePreview(),
      localAnchorId: 'run-1',
      fileCheckpointHash: null,
    })
    expect(result.perFileHasFiles).toBe(true)
    expect(result.showFileImpact).toBe(true)
    expect(result.effectiveAffectedPaths).toEqual(['/ws/a.txt'])
  })

  it('本机空清单表示仅回退对话', () => {
    const result = derivePerFileImpact({
      localAffectedPaths: [],
      preview: basePreview({ impact: { files: { available: true, diff_available: true }, resources: { available: false, change_count: 0, restore_count: 0 }, messages: { to_remove: 0 } } }),
      localAnchorId: 'run-1',
      fileCheckpointHash: null,
    })
    expect(result.perFileHasFiles).toBe(false)
    expect(result.showFileImpact).toBe(false)
  })

  it('未解析时回退 shadow-git 能力判定', () => {
    const result = derivePerFileImpact({
      localAffectedPaths: null,
      preview: basePreview({ checkpoint_hash: 'hash-1', impact: { files: { available: true, diff_available: true }, resources: { available: false, change_count: 0, restore_count: 0 }, messages: { to_remove: 0 } } }),
      localAnchorId: null,
      fileCheckpointHash: 'hash-1',
    })
    expect(result.perFileResolved).toBe(false)
    expect(result.showFileImpact).toBe(true)
  })
})

describe('deriveNoImpact', () => {
  it('per-file 有文件时永不为 noImpact', () => {
    expect(deriveNoImpact({
      preview: basePreview({ no_impact: true }),
      perFileHasFiles: true,
    })).toBe(false)
  })

  it('尊重后端 no_impact 字段', () => {
    expect(deriveNoImpact({
      preview: basePreview({ no_impact: true }),
      perFileHasFiles: false,
    })).toBe(true)
  })
})

describe('deriveIsSimpleView', () => {
  it('简单回退且无 per-file 文件时为 true', () => {
    expect(deriveIsSimpleView({
      preview: basePreview({ messages_to_remove: 2 }),
      loading: false,
      perFileHasFiles: false,
      localFilesPending: false,
    })).toBe(true)
  })

  it('per-file 有文件或探测在途时为 false', () => {
    expect(deriveIsSimpleView({
      preview: basePreview({ messages_to_remove: 2 }),
      loading: false,
      perFileHasFiles: true,
      localFilesPending: false,
    })).toBe(false)
    expect(deriveIsSimpleView({
      preview: basePreview({ messages_to_remove: 2 }),
      loading: false,
      perFileHasFiles: false,
      localFilesPending: true,
    })).toBe(false)
  })
})

describe('deriveUsesShadowGitFileDiff', () => {
  it('有 checkpoint_hash 且无 per-file anchor 时使用 shadow-git', () => {
    expect(deriveUsesShadowGitFileDiff({
      fileCheckpointHash: 'hash-1',
      localAnchorId: null,
      fileHistoryAvailable: false,
    })).toBe(true)
  })

  it('有 per-file anchor 且 fileHistory 可用时不使用 shadow-git', () => {
    expect(deriveUsesShadowGitFileDiff({
      fileCheckpointHash: 'hash-1',
      localAnchorId: 'run-1',
      fileHistoryAvailable: true,
    })).toBe(false)
  })
})

describe('deriveFilteredRestorePlan', () => {
  it('排除的资源标记为 skip', () => {
    const plan = deriveFilteredRestorePlan(
      basePreview({
        resource_restore_plan: [{
          resource_type: 'docs',
          resource_id: 'doc-1',
          resource_name: 'Roadmap',
          action: 'restore_version',
          action_label: '恢复',
          can_restore: true,
          restore_to_version_id: 'v1',
          restore_to_version_time: '2026-04-05T11:00:00Z',
          change_count: 1,
        }],
      }),
      new Set(['docs:doc-1']),
    )
    expect(plan?.[0]?.action).toBe('skip')
    expect(plan?.[0]?.can_restore).toBe(false)
  })
})

describe('deriveEditResendImpact', () => {
  it('同一资源有多条变更记录时仍按一个资源计数', () => {
    const preview = basePreview({
      resource_changes: [
        { resource_type: 'docs', resource_id: 'doc-1', resource_name: '方案', change_type: 'update', summary: '修改 1', agent_run_id: 'run-1' },
        { resource_type: 'docs', resource_id: 'doc-1', resource_name: '方案', change_type: 'update', summary: '修改 2', agent_run_id: 'run-1' },
      ],
      resource_restore_plan: [{
        resource_type: 'docs',
        resource_id: 'doc-1',
        resource_name: '方案',
        action: 'restore_version',
        action_label: '恢复',
        can_restore: true,
        restore_to_version_id: 'v1',
        restore_to_version_time: '2026-04-05T11:00:00Z',
        change_count: 2,
      }],
      resource_preview_status: 'available',
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: true, change_count: 2, restore_count: 1 },
        messages: { to_remove: 2 },
      },
    })

    const result = deriveEditResendImpact({
      preview,
      perFile: {
        daemonAffectedPaths: null,
        effectiveAffectedPaths: [],
        perFileResolved: true,
        perFileHasFiles: false,
        showFileImpact: false,
      },
      localFilePreviewFailed: false,
      localAnchorId: null,
      fileHistoryAvailable: true,
    })

    expect(result.resources).toEqual({
      status: 'will_restore',
      affectedCount: 1,
      restorableCount: 1,
      reason: null,
      canContinueConversationOnly: false,
    })
  })

  it('资源预览缺失契约时禁止编辑重发', () => {
    const preview = basePreview({ resource_preview_status: undefined })
    const result = deriveEditResendImpact({
      preview,
      perFile: {
        daemonAffectedPaths: null,
        effectiveAffectedPaths: [],
        perFileResolved: true,
        perFileHasFiles: false,
        showFileImpact: false,
      },
      localFilePreviewFailed: false,
      localAnchorId: null,
      fileHistoryAvailable: true,
    })

    expect(result.resources.status).toBe('unavailable')
    expect(result.resources.canContinueConversationOnly).toBe(false)
    expect(result.resources.reason).toBe('resource_preview_contract_unknown')
  })

  it('资源恢复计划未覆盖全部受影响资源时禁止重发', () => {
    const preview = basePreview({
      resource_preview_status: 'available',
      resource_changes: [
        { resource_type: 'docs', resource_id: 'doc-1', resource_name: '方案', change_type: 'update', summary: '', agent_run_id: 'run-1' },
        { resource_type: 'table', resource_id: 'table-1', resource_name: '数据', change_type: 'update', summary: '', agent_run_id: 'run-1' },
      ],
      resource_restore_plan: [{
        resource_type: 'docs',
        resource_id: 'doc-1',
        resource_name: '方案',
        action: 'restore_version',
        action_label: '恢复',
        can_restore: true,
        restore_to_version_id: 'v1',
        restore_to_version_time: null,
        change_count: 1,
      }],
    })
    const result = deriveEditResendImpact({
      preview,
      perFile: {
        daemonAffectedPaths: null,
        effectiveAffectedPaths: [],
        perFileResolved: true,
        perFileHasFiles: false,
        showFileImpact: false,
      },
      localFilePreviewFailed: false,
      localAnchorId: null,
      fileHistoryAvailable: true,
    })

    expect(result.resources.status).toBe('unavailable')
    expect(result.resources.canContinueConversationOnly).toBe(false)
    expect(result.resources.reason).toBe('resource_restore_plan_incomplete')
  })
})

describe('deriveRewindPreviewUi', () => {
  it('聚合 per-file 覆盖后端文件误报语义', () => {
    const ui = deriveRewindPreviewUi({
      preview: basePreview({
        messages_to_remove: 2,
        degraded_reasons: ['missing_effective_checkpoint'],
      }),
      loading: false,
      localAffectedPaths: ['/ws/a.txt', '/ws/b.txt'],
      localFilesPending: false,
      localAnchorId: 'run-b',
      fileCheckpointHash: null,
      fileHistoryAvailable: true,
      rollbackState: null,
      t,
    })

    expect(ui.perFile.perFileHasFiles).toBe(true)
    expect(ui.noImpact).toBe(false)
    expect(ui.isSimpleView).toBe(false)
    expect(ui.checkpointSemanticFeedback).toBeNull()
    expect(ui.perFile.showFileImpact).toBe(true)
  })

  it('无有效 checkpoint 但资源可恢复时给出 unavailable 反馈', () => {
    const ui = deriveRewindPreviewUi({
      preview: basePreview({
        messages_to_remove: 2,
        degraded_reasons: ['missing_effective_checkpoint'],
        resource_restore_plan: [{
          resource_type: 'docs',
          resource_id: 'doc-1',
          resource_name: 'Roadmap',
          action: 'restore_version',
          action_label: '恢复',
          can_restore: true,
          restore_to_version_id: 'v1',
          restore_to_version_time: '2026-04-05T11:00:00Z',
          change_count: 1,
        }],
      }),
      loading: false,
      localAffectedPaths: null,
      localFilesPending: false,
      localAnchorId: null,
      fileCheckpointHash: null,
      fileHistoryAvailable: false,
      rollbackState: null,
      t,
    })

    expect(ui.checkpointSemanticFeedback?.summary).toContain('恢复可用资源')
    expect(ui.isSimpleView).toBe(false)
  })
})
