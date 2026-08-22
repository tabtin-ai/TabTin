export {
  CheckpointService,
  createServiceCacheManager,
  hashWorkingDir,
  fileExists,
  getLfsPatterns,
  parseShadowCoreWorktreeFromConfig,
  readShadowCoreWorktree,
  normalizeWorktreePathForComparison,
  type CheckpointLogger,
  type CheckpointDiffEntry,
  type CheckpointKind,
  type CheckpointCommitPolicy,
  type CheckpointRestoreOptions,
  type NormalizedCheckpointCommitPolicy,
  type DiffSummaryFileEntry,
  type DiffSummaryResult,
  type CheckpointServiceCache,
} from './CheckpointService.js'

export {
  CHECKPOINT_EXCLUDE_PATTERNS,
  buildExcludeContent,
} from './exclusions.js'
