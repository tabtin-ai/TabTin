import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import type * as chatExtraApi from '../../../../services/chatExtraApi'
import {
  getRollbackResourceDetailsFromState,
  hasWorkspaceFilesFailure,
} from '../../../../stores/chat/checkpoint/utils/rollbackResult'
import type { SessionRollbackState } from '@tabtin/chat-client'
import { buildCheckpointSemanticFeedback, isSimpleRollback } from '@utils/chat/checkpointFeedback'
import type { DiffFileEntry } from '../CheckpointDiffSheet'
import { canContinueWithoutFileRestore } from '../../../../services/fileHistoryIpc'

export const MAX_FILE_PREVIEW_COUNT = 15
export const MAX_RESOURCE_PREVIEW_COUNT = 10
export const PREVIEW_TIMEOUT_MS = 15_000

export const RESOURCE_TYPE_KEYS: Record<string, { key: string; fallback: string }> = {
  docs: { key: 'rewind.resourceType.docs', fallback: '文档' },
  design: { key: 'rewind.resourceType.design', fallback: '设计稿' },
  slide: { key: 'rewind.resourceType.slide', fallback: '幻灯片' },
  table: { key: 'rewind.resourceType.table', fallback: '数据表' },
  video: { key: 'rewind.resourceType.video', fallback: '视频' },
  canvas: { key: 'rewind.resourceType.canvas', fallback: '白板' },
}

export const CHANGE_TYPE_KEYS: Record<string, { key: string; fallback: string }> = {
  create: { key: 'rewind.changeType.create', fallback: '新建' },
  update: { key: 'rewind.changeType.update', fallback: '修改' },
  delete: { key: 'rewind.changeType.delete', fallback: '删除' },
  restore: { key: 'rewind.changeType.restore', fallback: '恢复' },
}

export type CheckpointSemanticFeedback = ReturnType<typeof buildCheckpointSemanticFeedback>

export interface FileDiffSummary {
  added: number
  modified: number
  deleted: number
  total: number
}

export interface PerFileImpactDerived {
  daemonAffectedPaths: string[] | null
  effectiveAffectedPaths: string[] | null
  perFileResolved: boolean
  perFileHasFiles: boolean
  showFileImpact: boolean
}

export interface RewindPreviewUiDerived {
  perFile: PerFileImpactDerived
  noImpact: boolean
  isSimpleView: boolean
  checkpointSemanticFeedback: CheckpointSemanticFeedback | null
  estimatedSeconds: number
  usesShadowGitFileDiff: boolean
  hasLatestRollbackOpenIssues: boolean
}

export type EditResendFileImpactStatus = 'will_restore' | 'not_applicable' | 'unavailable'
export type EditResendResourceImpactStatus = 'will_restore' | 'not_applicable' | 'partial' | 'unavailable'

export interface EditResendImpactDerived {
  files: {
    status: EditResendFileImpactStatus
    affectedCount: number | null
    reason: string | null
    canContinueConversationOnly: boolean
    unrestorableFiles?: Array<{ path: string; reason: string }>
  }
  resources: {
    status: EditResendResourceImpactStatus
    affectedCount: number
    restorableCount: number
    reason: string | null
    canContinueConversationOnly: boolean
  }
}

/**
 * ：判定回退 preview/apply 是否因「目标消息在服务端不存在」返回 404。
 */
export function isMissingTargetError(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string } | null
  if (!e) return false
  if (e.status === 404 && e.code === 'NOT_FOUND') return true
  const msg = e.message || ''
  return /消息不存在|message_not_found|target.*not found/i.test(msg)
}

export function deriveDaemonAffectedPaths(
  preview: RollbackPreviewResult | null,
): string[] | null {
  if (!preview) return null
  if (preview.file_restore_host !== 'daemon') return null
  if (preview.file_preview_success === false) return null
  return preview.affected_paths ?? []
}

export function derivePerFileImpact(input: {
  localAffectedPaths: string[] | null
  preview: RollbackPreviewResult | null
  localAnchorId: string | null
  fileCheckpointHash: string | null
}): PerFileImpactDerived {
  const daemonAffectedPaths = deriveDaemonAffectedPaths(input.preview)
  const effectiveAffectedPaths = input.localAffectedPaths ?? daemonAffectedPaths
  const perFileResolved = effectiveAffectedPaths !== null
  const perFileHasFiles = perFileResolved && effectiveAffectedPaths.length > 0
  const showFileImpact = perFileResolved
    ? perFileHasFiles
    : ((input.preview?.impact?.files.available ?? false)
      || !!input.localAnchorId
      || !!input.fileCheckpointHash)

  return {
    daemonAffectedPaths,
    effectiveAffectedPaths,
    perFileResolved,
    perFileHasFiles,
    showFileImpact,
  }
}

const FILE_PREVIEW_UNAVAILABLE_STATUSES = new Set(['failed', 'error', 'unavailable', 'unknown', 'pending'])

function isLocalFileHistoryUnavailable(input: {
  preview: RollbackPreviewResult | null
  localAnchorId: string | null
  fileHistoryAvailable: boolean
}): boolean {
  return input.preview?.file_restore_host === 'local'
    && input.localAnchorId != null
    && !input.fileHistoryAvailable
}

function didLocalFilePreviewFail(input: {
  preview: RollbackPreviewResult | null
  localFilePreviewFailed: boolean
}): boolean {
  return input.preview?.file_restore_host === 'local' && input.localFilePreviewFailed
}

function isUnavailablePreviewStatus(status: string | null): boolean {
  return status != null && FILE_PREVIEW_UNAVAILABLE_STATUSES.has(status)
}

function getEditResendFilePreviewUnavailableReason(input: {
  preview: RollbackPreviewResult | null
  previewStatus: string | null
  localFilePreviewFailed: boolean
  localFilePreviewReason?: string | null
  localUnrestorableFiles?: Array<{ path: string; reason: string }>
  localAnchorId: string | null
  fileHistoryAvailable: boolean
}): string | null {
  const previewReason = input.preview?.file_preview_reason ?? null
  if (input.preview?.file_preview_success === false) return previewReason ?? 'file_preview_unavailable'
  if (isLocalFileHistoryUnavailable(input)) {
    return 'file_history_ipc_unavailable'
  }
  if (didLocalFilePreviewFail(input)) {
    return input.localFilePreviewReason ?? previewReason ?? 'local_file_preview_failed'
  }
  if (isUnavailablePreviewStatus(input.previewStatus)) {
    return previewReason ?? 'file_preview_unavailable'
  }
  return null
}

function deriveResolvedEditResendFileImpact(input: {
  preview: RollbackPreviewResult | null
  perFile: PerFileImpactDerived
}): EditResendImpactDerived['files'] {
  const affectedCount = input.perFile.effectiveAffectedPaths?.length ?? 0
  return {
    status: affectedCount > 0 ? 'will_restore' : 'not_applicable',
    affectedCount,
    reason: input.preview?.file_preview_reason ?? null,
    canContinueConversationOnly: false,
  }
}

function deriveLegacyEditResendFileImpact(input: {
  preview: RollbackPreviewResult | null
  previewStatus: string | null
}): EditResendImpactDerived['files'] {
  const explicitlyNotApplicable = input.previewStatus === 'not_applicable' || input.previewStatus === 'skipped'
  const hasFileVersion = input.previewStatus === 'available'
    || Boolean(input.preview?.impact?.files.available || input.preview?.checkpoint_hash)
  if (!explicitlyNotApplicable && !hasFileVersion) {
    return {
      status: 'unavailable',
      affectedCount: null,
      reason: 'file_preview_contract_unknown',
      canContinueConversationOnly: false,
    }
  }
  return {
    status: explicitlyNotApplicable ? 'not_applicable' : 'will_restore',
    affectedCount: null,
    reason: input.preview?.file_preview_reason ?? null,
    canContinueConversationOnly: false,
  }
}

function deriveEditResendFileImpact(input: {
  preview: RollbackPreviewResult | null
  perFile: PerFileImpactDerived
  localFilePreviewFailed: boolean
  localFilePreviewReason?: string | null
  localUnrestorableFiles?: Array<{ path: string; reason: string }>
  localAnchorId: string | null
  fileHistoryAvailable: boolean
}): EditResendImpactDerived['files'] {
  const { preview, perFile } = input
  const previewStatus = preview?.file_preview_status?.trim().toLowerCase() ?? null
  const unavailableReason = getEditResendFilePreviewUnavailableReason({ ...input, previewStatus })
  if (unavailableReason) {
    const unrestorableFiles = preview?.file_restore_host === 'local'
      ? input.localUnrestorableFiles ?? []
      : (preview?.unrestorable_files ?? []).map(({ path, reason }) => ({ path, reason }))
    return {
      status: 'unavailable',
      affectedCount: null,
      reason: unavailableReason,
      canContinueConversationOnly: canContinueWithoutFileRestore(unavailableReason),
      unrestorableFiles,
    }
  }
  if (perFile.perFileResolved) return deriveResolvedEditResendFileImpact({ preview, perFile })
  return deriveLegacyEditResendFileImpact({ preview, previewStatus })
}

function deriveEditResendResourceImpact(
  preview: RollbackPreviewResult | null,
): EditResendImpactDerived['resources'] {
  const restorePlan = preview?.resource_restore_plan ?? []
  const affectedResourceKeys = new Set<string>()
  for (const item of preview?.resource_changes ?? []) {
    affectedResourceKeys.add(`${item.resource_type}:${item.resource_id}`)
  }
  for (const item of restorePlan) {
    affectedResourceKeys.add(`${item.resource_type}:${item.resource_id}`)
  }
  // impact.change_count 是变更记录数，不是资源数；只在旧响应完全没有
  // 资源标识时才作数量兜底，避免“同一文档改 3 次”被说成 3 个资源。
  const affectedCount = affectedResourceKeys.size > 0
    ? affectedResourceKeys.size
    : preview?.impact?.resources.change_count ?? 0
  const restorableCount = new Set(
    restorePlan
      .filter(item => item.can_restore)
      .map(item => `${item.resource_type}:${item.resource_id}`),
  ).size
  const previewStatus = preview?.resource_preview_status?.trim().toLowerCase() ?? null
  const changedResourceKeys = new Set(
    (preview?.resource_changes ?? []).map(item => `${item.resource_type}:${item.resource_id}`),
  )
  const plannedResourceKeys = new Set(
    restorePlan.map(item => `${item.resource_type}:${item.resource_id}`),
  )
  const hasAffectedEvidence = affectedCount > 0
  const hasOpaqueAffectedResources = affectedResourceKeys.size === 0
    && (preview?.impact?.resources.change_count ?? 0) > 0

  if (previewStatus === 'unavailable' || previewStatus == null) {
    return {
      status: 'unavailable',
      affectedCount,
      restorableCount,
      reason: preview?.resource_preview_reason ?? 'resource_preview_contract_unknown',
      canContinueConversationOnly: false,
    }
  }
  if (previewStatus === 'not_applicable') {
    return hasAffectedEvidence
      ? {
          status: 'unavailable',
          affectedCount,
          restorableCount,
          reason: 'resource_preview_contract_inconsistent',
          canContinueConversationOnly: false,
        }
      : {
          status: 'not_applicable',
          affectedCount,
          restorableCount,
          reason: preview?.resource_preview_reason ?? null,
          canContinueConversationOnly: false,
        }
  }
  if (previewStatus !== 'available' || !hasAffectedEvidence || hasOpaqueAffectedResources) {
    return {
      status: 'unavailable',
      affectedCount,
      restorableCount,
      reason: 'resource_preview_contract_inconsistent',
      canContinueConversationOnly: false,
    }
  }
  const hasIncompletePlan = [...changedResourceKeys].some(key => !plannedResourceKeys.has(key))
  if (hasIncompletePlan) {
    return {
      status: 'unavailable',
      affectedCount,
      restorableCount,
      reason: 'resource_restore_plan_incomplete',
      canContinueConversationOnly: false,
    }
  }

  const hasUnrestorableResource = restorePlan.some(item => !item.can_restore)
  return {
    status: hasUnrestorableResource ? 'partial' : 'will_restore',
    affectedCount,
    restorableCount,
    reason: null,
    canContinueConversationOnly: hasUnrestorableResource,
  }
}

/**
 * 编辑重发是一次时间线重写，确认文案只能描述预览已经证明的影响。
 *
 * 兼容旧 preview：旧端没有 file_preview_status 时，per-file 结果优先；
 * 明确的 preview 失败必须 fail closed，不能再用“文件也会被回退”的固定承诺。
 */
export function deriveEditResendImpact(input: {
  preview: RollbackPreviewResult | null
  perFile: PerFileImpactDerived
  localFilePreviewFailed: boolean
  localFilePreviewReason?: string | null
  localUnrestorableFiles?: Array<{ path: string; reason: string }>
  localAnchorId: string | null
  fileHistoryAvailable: boolean
}): EditResendImpactDerived {
  const preview = input.preview
  return {
    files: deriveEditResendFileImpact({
      preview,
      perFile: input.perFile,
      localFilePreviewFailed: input.localFilePreviewFailed,
      localFilePreviewReason: input.localFilePreviewReason,
      localUnrestorableFiles: input.localUnrestorableFiles,
      localAnchorId: input.localAnchorId,
      fileHistoryAvailable: input.fileHistoryAvailable,
    }),
    resources: deriveEditResendResourceImpact(preview),
  }
}

export function deriveNoImpact(input: {
  preview: RollbackPreviewResult | null
  perFileHasFiles: boolean
}): boolean {
  if (input.perFileHasFiles) return false
  if (input.preview?.no_impact != null) return input.preview.no_impact
  if (!input.preview) return false
  return input.preview.messages_to_remove === 0
    && !input.preview.checkpoint_hash
    && (input.preview.resource_changes?.length ?? 0) === 0
    && (!input.preview.resource_restore_plan || input.preview.resource_restore_plan.length === 0)
}

export function deriveIsSimpleView(input: {
  preview: RollbackPreviewResult | null
  loading: boolean
  perFileHasFiles: boolean
  localFilesPending: boolean
}): boolean {
  return !!input.preview
    && !input.loading
    && isSimpleRollback(input.preview)
    && !input.perFileHasFiles
    && !input.localFilesPending
}

export function deriveCheckpointSemanticFeedback(input: {
  preview: RollbackPreviewResult | null
  noImpact: boolean
  perFileHasFiles: boolean
  t: (key: string, options?: Record<string, unknown> & { defaultValue?: string }) => string
}): CheckpointSemanticFeedback | null {
  const { preview, noImpact, perFileHasFiles, t } = input
  if (!preview || noImpact) return null

  if (preview.effective_checkpoint) {
    return buildCheckpointSemanticFeedback({
      checkpointRecord: preview.effective_checkpoint,
      degradedReasons: preview.degraded_reasons,
    }, t)
  }

  const resourceRestorable = (preview.resource_restore_plan ?? []).some(item => item.can_restore)

  if (perFileHasFiles) {
    const resourceChangeCount = (preview.resource_changes?.length ?? 0)
      + (preview.resource_restore_plan?.length ?? 0)
    if (resourceChangeCount === 0 || resourceRestorable) return null
    return buildCheckpointSemanticFeedback({
      degradedReasons: ['missing_resource_snapshot'],
      status: 'degraded',
      capabilityScope: {
        message_preview: true,
        file_diff: false,
        file_restore: true,
        resource_restore: false,
        unrevert: true,
      },
    }, t)
  }

  if (preview.degraded_reasons && preview.degraded_reasons.length > 0) {
    return buildCheckpointSemanticFeedback({
      degradedReasons: preview.degraded_reasons,
      status: 'unavailable',
      capabilityScope: {
        message_preview: true,
        file_diff: false,
        file_restore: false,
        resource_restore: resourceRestorable,
        unrevert: true,
      },
    }, t)
  }

  return null
}

export function deriveEstimatedSeconds(input: {
  preview: RollbackPreviewResult | null
  showFileImpact: boolean
}): number {
  if (!input.preview) return 0
  let seconds = 1
  if (input.showFileImpact) seconds += 2
  const restorableCount = (input.preview.resource_restore_plan ?? []).filter(r => r.can_restore).length
  seconds += restorableCount * 1.5
  return Math.ceil(seconds)
}

export function deriveUsesShadowGitFileDiff(input: {
  fileCheckpointHash: string | null
  localAnchorId: string | null
  fileHistoryAvailable: boolean
}): boolean {
  return !!(input.fileCheckpointHash && !(input.localAnchorId && input.fileHistoryAvailable))
}

export function deriveFileDiffSummary(fileDiffs: DiffFileEntry[] | null): FileDiffSummary | null {
  if (!fileDiffs) return null
  const added = fileDiffs.filter(f => f.status === 'added').length
  const modified = fileDiffs.filter(f => f.status === 'modified').length
  const deleted = fileDiffs.filter(f => f.status === 'deleted').length
  return { added, modified, deleted, total: fileDiffs.length }
}

export function deriveHasLatestRollbackOpenIssues(
  rollbackState: SessionRollbackState | null | undefined,
): boolean {
  const latestRollbackResourceDetails = getRollbackResourceDetailsFromState(rollbackState)
  const latestRollbackHasFileFailure = hasWorkspaceFilesFailure(rollbackState?.partial_success_details)
  return rollbackState?.last_apply_result === 'partial_success'
    || latestRollbackResourceDetails.retryableItems.length > 0
    || latestRollbackHasFileFailure
    || rollbackState?.cleanup_status === 'pending_retry'
}

export function deriveFilteredRestorePlan(
  preview: RollbackPreviewResult | null,
  excludedResources: Set<string>,
): chatExtraApi.ResourceRestoreInfo[] | undefined {
  if (!preview?.resource_restore_plan) return undefined
  return preview.resource_restore_plan.map(ri => {
    const key = `${ri.resource_type}:${ri.resource_id}`
    if (excludedResources.has(key)) {
      return { ...ri, action: 'skip' as const, can_restore: false }
    }
    return ri
  })
}

export function deriveRewindPreviewUi(input: {
  preview: RollbackPreviewResult | null
  loading: boolean
  localAffectedPaths: string[] | null
  localFilesPending: boolean
  localAnchorId: string | null
  fileCheckpointHash: string | null
  fileHistoryAvailable: boolean
  rollbackState: SessionRollbackState | null | undefined
  t: (key: string, options?: Record<string, unknown> & { defaultValue?: string }) => string
}): RewindPreviewUiDerived {
  const perFile = derivePerFileImpact({
    localAffectedPaths: input.localAffectedPaths,
    preview: input.preview,
    localAnchorId: input.localAnchorId,
    fileCheckpointHash: input.fileCheckpointHash,
  })
  const noImpact = deriveNoImpact({
    preview: input.preview,
    perFileHasFiles: perFile.perFileHasFiles,
  })
  const isSimpleView = deriveIsSimpleView({
    preview: input.preview,
    loading: input.loading,
    perFileHasFiles: perFile.perFileHasFiles,
    localFilesPending: input.localFilesPending,
  })
  const checkpointSemanticFeedback = deriveCheckpointSemanticFeedback({
    preview: input.preview,
    noImpact,
    perFileHasFiles: perFile.perFileHasFiles,
    t: input.t,
  })
  const estimatedSeconds = deriveEstimatedSeconds({
    preview: input.preview,
    showFileImpact: perFile.showFileImpact,
  })
  const usesShadowGitFileDiff = deriveUsesShadowGitFileDiff({
    fileCheckpointHash: input.fileCheckpointHash,
    localAnchorId: input.localAnchorId,
    fileHistoryAvailable: input.fileHistoryAvailable,
  })
  const hasLatestRollbackOpenIssues = deriveHasLatestRollbackOpenIssues(input.rollbackState)

  return {
    perFile,
    noImpact,
    isSimpleView,
    checkpointSemanticFeedback,
    estimatedSeconds,
    usesShadowGitFileDiff,
    hasLatestRollbackOpenIssues,
  }
}
