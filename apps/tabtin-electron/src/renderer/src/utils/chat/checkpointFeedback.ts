import type {
  CheckpointCapabilityKey,
  CheckpointCapabilityScope,
  CheckpointDegradedReason,
  CheckpointRecordStatus,
  CheckpointRecordView,
} from '@tabtin/chat-client'

type Translate = (key: string, options?: Record<string, unknown>) => string

type CheckpointFeedbackTone = 'success' | 'warning' | 'destructive' | 'muted'

export interface CheckpointCapabilityFeedback {
  key: CheckpointCapabilityKey
  available: boolean
  label: string
  detail: string
}

export interface CheckpointSemanticFeedback {
  status: CheckpointRecordStatus
  tone: CheckpointFeedbackTone
  badgeLabel: string
  title: string
  summary: string
  inlineHint: string
  rollbackTooltip: string
  disabledTooltip: string
  reasons: Array<{
    id: CheckpointDegradedReason
    text: string
  }>
  capabilities: CheckpointCapabilityFeedback[]
  capabilityScope: CheckpointCapabilityScope
}

export interface CheckpointSemanticInput {
  checkpointRecord?: CheckpointRecordView | null
  degradedReasons?: Array<CheckpointDegradedReason | string> | null
  capabilityScope?: Partial<CheckpointCapabilityScope> | null
  status?: CheckpointRecordStatus | null
}

const DEFAULT_CAPABILITY_SCOPE: CheckpointCapabilityScope = {
  message_preview: true,
  file_diff: false,
  file_restore: false,
  resource_restore: false,
  unrevert: false,
}

function asCheckpointDegradedReason(reason: string): CheckpointDegradedReason | null {
  if (
    reason === 'missing_file_snapshot'
    || reason === 'missing_resource_snapshot'
    || reason === 'missing_effective_checkpoint'
  ) {
    return reason
  }
  return null
}

function dedupeReasons(
  checkpointRecord?: CheckpointRecordView | null,
  degradedReasons?: Array<CheckpointDegradedReason | string> | null,
): CheckpointDegradedReason[] {
  const merged = [
    ...(checkpointRecord?.degraded_reasons ?? []),
    ...(degradedReasons ?? []),
  ]

  const seen = new Set<CheckpointDegradedReason>()
  const output: CheckpointDegradedReason[] = []
  for (const item of merged) {
    const reason = asCheckpointDegradedReason(String(item))
    if (!reason || seen.has(reason)) continue
    seen.add(reason)
    output.push(reason)
  }
  return output
}

function getStatus(
  checkpointRecord?: CheckpointRecordView | null,
  degradedReasons?: CheckpointDegradedReason[],
  status?: CheckpointRecordStatus | null,
): CheckpointRecordStatus {
  if (status) return status
  if (checkpointRecord?.status) return checkpointRecord.status
  return (degradedReasons?.length ?? 0) > 0 ? 'unavailable' : 'ready'
}

function getCapabilityScope(
  checkpointRecord?: CheckpointRecordView | null,
  capabilityScope?: Partial<CheckpointCapabilityScope> | null,
): CheckpointCapabilityScope {
  return {
    ...DEFAULT_CAPABILITY_SCOPE,
    ...(checkpointRecord?.capability_scope ?? {}),
    ...(capabilityScope ?? {}),
  }
}

function getReasonText(
  reason: CheckpointDegradedReason,
  capabilityScope: CheckpointCapabilityScope,
  t: Translate,
) {
  switch (reason) {
    case 'missing_file_snapshot':
      return t('checkpoint.reason.missingFileSnapshot', {
        defaultValue: '没有保存当时的工作区文件版本，所以这次不能自动恢复文件；如需恢复原状，工作区文件可能仍需要你手动确认。',
      })
    case 'missing_resource_snapshot':
      return t('checkpoint.reason.missingResourceSnapshot', {
        defaultValue: '没有记录文档、表格等资源的版本，所以这次不能自动恢复这些资源。',
      })
    case 'missing_effective_checkpoint':
      if (capabilityScope.resource_restore) {
        return t('checkpoint.reason.missingEffectiveCheckpointWithResource', {
          defaultValue: '这个位置没有找到可用的文件版本点，所以不能恢复工作区文件；可恢复的资源会按历史变更单独回退。',
        })
      }
      return t('checkpoint.reason.missingEffectiveCheckpoint', {
        defaultValue: '这个位置没有找到可用的版本点，所以这次只能回退对话，不能恢复文件或资源。',
      })
  }
}

function buildCapabilityFeedback(
  capabilityScope: CheckpointCapabilityScope,
  t: Translate,
): CheckpointCapabilityFeedback[] {
  return [
    {
      key: 'message_preview',
      available: capabilityScope.message_preview,
      label: t('checkpoint.capability.messagePreview.label', { defaultValue: '消息预览' }),
      detail: capabilityScope.message_preview
        ? t('checkpoint.capability.messagePreview.available', {
            defaultValue: '可先确认会移除哪些消息',
          })
        : t('checkpoint.capability.messagePreview.unavailable', {
            defaultValue: '当前不能预览会移除的消息',
          }),
    },
    {
      key: 'file_diff',
      available: capabilityScope.file_diff,
      label: t('checkpoint.capability.fileDiff.label', { defaultValue: '文件变化预览' }),
      detail: capabilityScope.file_diff
        ? t('checkpoint.capability.fileDiff.available', {
            defaultValue: '可查看工作区文件会怎么变化',
          })
        : t('checkpoint.capability.fileDiff.unavailable', {
            defaultValue: '当前看不到文件变化详情',
          }),
    },
    {
      key: 'file_restore',
      available: capabilityScope.file_restore,
      label: t('checkpoint.capability.fileRestore.label', { defaultValue: '文件恢复' }),
      detail: capabilityScope.file_restore
        ? t('checkpoint.capability.fileRestore.available', {
            defaultValue: '可把工作区文件恢复到当时状态',
          })
        : t('checkpoint.capability.fileRestore.unavailable', {
            defaultValue: '当前不能自动恢复工作区文件',
          }),
    },
    {
      key: 'resource_restore',
      available: capabilityScope.resource_restore,
      label: t('checkpoint.capability.resourceRestore.label', { defaultValue: '资源恢复' }),
      detail: capabilityScope.resource_restore
        ? t('checkpoint.capability.resourceRestore.available', {
            defaultValue: '可恢复文档、表格等资源',
          })
        : t('checkpoint.capability.resourceRestore.unavailable', {
            defaultValue: '当前不能自动恢复文档、表格等资源',
          }),
    },
    {
      key: 'unrevert',
      available: capabilityScope.unrevert,
      label: t('checkpoint.capability.unrevert.label', { defaultValue: '恢复原状' }),
      detail: capabilityScope.unrevert
        ? t('checkpoint.capability.unrevert.available', {
            defaultValue: '回退后，在发送新消息前仍可恢复原状',
          })
        : t('checkpoint.capability.unrevert.unavailable', {
            defaultValue: '回退后不能一键恢复到现在的状态',
          }),
    },
  ]
}

function getTone(status: CheckpointRecordStatus): CheckpointFeedbackTone {
  if (status === 'ready') return 'success'
  if (status === 'degraded') return 'warning'
  if (status === 'unavailable') return 'destructive'
  return 'muted'
}

function buildStatusCopy(
  status: CheckpointRecordStatus,
  capabilityScope: CheckpointCapabilityScope,
  reasons: CheckpointDegradedReason[],
  t: Translate,
) {
  if (status === 'ready') {
    return {
      badgeLabel: t('checkpoint.semantic.readyBadge', { defaultValue: '可完整回退' }),
      title: t('checkpoint.semantic.readyTitle', { defaultValue: '这个版本点可完整回退' }),
      summary: t('checkpoint.semantic.readySummary', {
        defaultValue: '可以回退对话、查看文件变化，并恢复文件与资源；回退后也能恢复原状。',
      }),
      inlineHint: t('checkpoint.semantic.readyInline', {
        defaultValue: '可回退对话、文件和资源',
      }),
      rollbackTooltip: t('checkpoint.semantic.readyTooltip', {
        defaultValue: '回退到此版本：会回退对话、文件和资源（如有变更）',
      }),
      disabledTooltip: t('checkpoint.semantic.readyTooltip', {
        defaultValue: '回退到此版本：会回退对话、文件和资源（如有变更）',
      }),
    }
  }

  if (status === 'degraded') {
    if (reasons.includes('missing_resource_snapshot')) {
      return {
        badgeLabel: t('checkpoint.semantic.degradedBadge', { defaultValue: '可部分回退' }),
        title: t('checkpoint.semantic.degradedTitle', { defaultValue: '这个版本点只能部分回退' }),
        summary: t('checkpoint.semantic.degradedMissingResourceSummary', {
          defaultValue: '可以回退对话和文件，但不能自动恢复文档、表格等资源。',
        }),
        inlineHint: t('checkpoint.semantic.degradedMissingResourceInline', {
          defaultValue: '可回退对话和文件，不能恢复资源',
        }),
        rollbackTooltip: t('checkpoint.semantic.degradedMissingResourceTooltip', {
          defaultValue: '回退到此版本：会回退对话和文件，但不会自动恢复文档、表格等资源',
        }),
        disabledTooltip: t('checkpoint.semantic.degradedMissingResourceTooltip', {
          defaultValue: '回退到此版本：会回退对话和文件，但不会自动恢复文档、表格等资源',
        }),
      }
    }

    if (!capabilityScope.file_restore && capabilityScope.resource_restore) {
      return {
        badgeLabel: t('checkpoint.semantic.degradedBadge', { defaultValue: '可部分回退' }),
        title: t('checkpoint.semantic.degradedTitle', { defaultValue: '这个版本点只能部分回退' }),
        summary: t('checkpoint.semantic.degradedMissingFileSummary', {
          defaultValue: '可以回退对话和资源，但不能自动恢复工作区文件。',
        }),
        inlineHint: t('checkpoint.semantic.degradedMissingFileInline', {
          defaultValue: '可回退对话和资源，不能恢复文件',
        }),
        rollbackTooltip: t('checkpoint.semantic.degradedMissingFileTooltip', {
          defaultValue: '回退到此版本：会回退对话和资源，但不会自动恢复工作区文件',
        }),
        disabledTooltip: t('checkpoint.semantic.degradedMissingFileTooltip', {
          defaultValue: '回退到此版本：会回退对话和资源，但不会自动恢复工作区文件',
        }),
      }
    }

    return {
      badgeLabel: t('checkpoint.semantic.degradedBadge', { defaultValue: '可部分回退' }),
      title: t('checkpoint.semantic.degradedTitle', { defaultValue: '这个版本点只能部分回退' }),
      summary: t('checkpoint.semantic.degradedGenericSummary', {
        defaultValue: '这个版本点可回退对话，但有一部分恢复能力不可用。',
      }),
      inlineHint: t('checkpoint.semantic.degradedGenericInline', {
        defaultValue: '可回退对话，但有部分能力不可用',
      }),
      rollbackTooltip: t('checkpoint.semantic.degradedGenericTooltip', {
        defaultValue: '回退到此版本：会回退对话，但有部分文件或资源无法自动恢复',
      }),
      disabledTooltip: t('checkpoint.semantic.degradedGenericTooltip', {
        defaultValue: '回退到此版本：会回退对话，但有部分文件或资源无法自动恢复',
      }),
    }
  }

  if (capabilityScope.resource_restore) {
    return {
      badgeLabel: t('checkpoint.semantic.unavailableWithResourceBadge', {
        defaultValue: '回退对话和资源',
      }),
      title: t('checkpoint.semantic.unavailableWithResourceTitle', {
        defaultValue: '这个位置缺少文件版本点',
      }),
      summary: t('checkpoint.semantic.unavailableWithResourceSummary', {
        defaultValue: '可以回退对话并恢复可用资源，但不能恢复工作区文件。',
      }),
      inlineHint: t('checkpoint.semantic.unavailableWithResourceInline', {
        defaultValue: '可回退对话和资源，不能恢复文件',
      }),
      rollbackTooltip: t('checkpoint.semantic.unavailableWithResourceTooltip', {
        defaultValue: '回退到此位置：会回退对话并恢复可用资源，但不会恢复工作区文件',
      }),
      disabledTooltip: t('checkpoint.semantic.unavailableWithResourceTooltip', {
        defaultValue: '回退到此位置：会回退对话并恢复可用资源，但不会恢复工作区文件',
      }),
    }
  }

  return {
    badgeLabel: t('checkpoint.semantic.unavailableBadge', { defaultValue: '仅回退对话' }),
    title: t('checkpoint.semantic.unavailableTitle', { defaultValue: '这个位置没有完整版本点' }),
    summary: t('checkpoint.semantic.unavailableSummary', {
      defaultValue: '这次只能回退对话，不能恢复工作区文件或文档、表格等资源。',
    }),
    inlineHint: t('checkpoint.semantic.unavailableInline', {
      defaultValue: '只能回退对话，不能恢复文件或资源',
    }),
    rollbackTooltip: t('checkpoint.semantic.unavailableTooltip', {
      defaultValue: '回退到此位置：只会回退对话，不会恢复文件或资源',
    }),
    disabledTooltip: t('checkpoint.semantic.unavailableTooltip', {
      defaultValue: '回退到此位置：只会回退对话，不会恢复文件或资源',
    }),
  }
}

export function buildCheckpointSemanticFeedback(
  input: CheckpointSemanticInput,
  t: Translate,
): CheckpointSemanticFeedback {
  const reasons = dedupeReasons(input.checkpointRecord, input.degradedReasons)
  const status = getStatus(input.checkpointRecord, reasons, input.status)
  const capabilityScope = getCapabilityScope(input.checkpointRecord, input.capabilityScope)
  const reasonsWithText = reasons.map(reason => ({
    id: reason,
    text: getReasonText(reason, capabilityScope, t),
  }))
  const copy = buildStatusCopy(status, capabilityScope, reasons, t)

  return {
    status,
    tone: getTone(status),
    badgeLabel: copy.badgeLabel,
    title: copy.title,
    summary: copy.summary,
    inlineHint: copy.inlineHint,
    rollbackTooltip: copy.rollbackTooltip,
    disabledTooltip: copy.disabledTooltip,
    reasons: reasonsWithText,
    capabilities: buildCapabilityFeedback(capabilityScope, t),
    capabilityScope,
  }
}

/* ─── 回退复杂度判断 ──────────────────────────────────────────── */

/**
 * 判断是否为「简单回退」（仅影响消息，无文件/资源变更）。
 * 用于按风险等级分层展示不同的 UI。
 *
 * - preview 模式：RewindPreviewPanel 在 API 返回后调用
 * - rollbackState 模式：RevertBanner / ChatContent 用会话持久化数据调用
 */
export function isSimpleRollback(
  preview?: { checkpoint_hash?: string | null; resource_changes?: unknown[]; resource_restore_plan?: unknown[]; unrestorable_items?: unknown[] } | null,
  rollbackState?: {
    target_checkpoint_id?: string | null
    safety_snapshot_ref?: string | null
    resource_restore_state?: unknown[] | null
    cleanup_status?: string | null
    last_apply_result?: string | null
  } | null,
): boolean {
  if (preview) {
    return !preview.checkpoint_hash
      && (preview.resource_changes?.length ?? 0) === 0
      && (!preview.resource_restore_plan?.length)
      && (!preview.unrestorable_items?.length)
  }
  if (rollbackState) {
    const abnormalCleanup = rollbackState.cleanup_status === 'failed'
      || rollbackState.cleanup_status === 'pending_retry'
      || rollbackState.cleanup_status === 'abandoned'
    return !rollbackState.target_checkpoint_id
      && !rollbackState.safety_snapshot_ref
      && (!rollbackState.resource_restore_state?.length)
      && !abnormalCleanup
      && rollbackState.last_apply_result !== 'failed'
      && rollbackState.last_apply_result !== 'partial_success'
  }
  return true
}
