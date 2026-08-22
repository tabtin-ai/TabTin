export { SessionStorage } from './storage.js';
//  message block 权威：消息级 block 存储与重建。
export {
  MessageBlockStorage,
  reconstructMessagesFromBlockRecords,
  blockRecordsToTranscriptMessages,
} from './message-block-storage.js';
export type {
  MessageBlockRecord,
} from './message-block-storage.js';
export {
  reconstructMessagesFromTranscriptEntries,
  findCompactionDoneStartIndex,
  computeRewindCommitPrefixLength,
} from './reconstruct-transcript-messages.js';
export type {
  ReconstructedTranscriptMessage,
  ReconstructTranscriptOptions,
} from './reconstruct-transcript-messages.js';
export { isInTurnPushNotificationUser } from './in-turn-push-notification.js';
export { SnapshotStorage } from './snapshot-storage.js';
export { EventStorage } from './event-storage.js';
export type { EventStorageEntry } from './event-storage.js';
export { SubagentManager } from './subagent-manager.js';
export type {
  SubagentManagerOptions,
  SubagentRunMeta,
  SubagentRunStatus,
  SubagentSchedulerState,
  SubagentRunState,
  SubagentRunUnregister,
  SubagentLiveDeps,
  ResolveLiveDepsResult,
  SubagentCompletionInfo,
  EnqueueSubagentCompletion,
} from './subagent-manager.js';
export { SubagentIndexWriter, foldSubagentRuns, readSubagentIndexEntries, reapOrphanedSubagentRuns } from './subagent-index.js';
export type {
  SubagentIndexEntry,
  SubagentIndexStartEntry,
  SubagentIndexEndEntry,
  SubagentIndexPaths,
  FoldedSubagentRun,
} from './subagent-index.js';
export { SyncQueue, OwnerMismatchError } from './sync.js';
export type { SyncQueueOptions } from './sync.js';
export {
  InMemoryPersistentQueue,
  type PersistentQueue,
  type PersistedEntry,
  type PersistedEntryArchiveReason,
  type PersistedEntryOwner,
} from './persistent-queue.js';
export {
  FilePersistentQueue,
  type FilePersistentQueueOptions,
} from './persistent-queue-file.js';
export {
  buildSyncAccountDir,
  clearSyncAccountDir,
  listSyncAccountOwners,
  assertValidOwner,
  ownersMatch,
} from './sync-account.js';
export { ToolLogWriter, cleanupOldToolLogs, toolOutputToString } from './tool-log-writer.js';
export type { ToolLogEntry, ToolLogWriterOptions } from './tool-log-writer.js';
// ：fork 时本机归档分叉 + tool_use id remap
export {
  createForkToolIdMapper,
  remapToolIdsInValue,
  isTabtinToolUseId,
  FORK_TOOL_USE_TYPES,
  FORK_TOOL_REF_KEYS,
} from './fork-tool-id-remap.js';
export {
  forkLocalSessionArchive,
  trimTrailingUserMessageBlocks,
  truncateMessageBlocksAtForkPoint,
} from './fork-local-session.js';
export type {
  ForkLocalSessionParams,
  ForkLocalSessionResult,
} from './fork-local-session.js';
// W3 (2026-05-10): `tool-log-reader.ts` deleted along with the
// `retrieve_tool_result` tool — no longer needed for level-3 fallback that
// scanned tool-logs/*.md to recover full outputs.
export {
  // 旧 API（deprecated）
  resolveSpaceWorkspaceRoot,
  resolveSpacePlatformDataRoot,
  resolveSpaceSkillsDir,
  resolveSpaceSkillDir,
  resolveSpaceDownloadsDir,
  resolveSpaceSiteDir,
  resolveSpaceConversationsRoot,
  resolveSpaceSessionArchiveDir,
  resolveSpaceToolLogsDir,
  // 新 API
  resolveUserRoot,
  resolveUserSkillsDir,
  resolveUserSkillDir,
  resolveUserCommonDir,
  resolveOrganizationRoot,
  resolveOrganizationSkillsDir,
  resolveOrganizationSkillDir,
  resolveOrganizationPluginsDir,
  resolveOrganizationPluginRegistryFile,
  resolveOrganizationPluginDir,
  resolveOrganizationSharedDir,
  resolveWorkspaceMetadataRoot,
  resolveWorkspaceDownloadsDir,
  resolveWorkspaceConversationsRoot,
  resolveWorkspaceSessionArchiveDir,
  resolveWorkspaceToolLogsDir,
  resolveWorkspaceSiteDir,
} from './session-paths.js';
// ：per-session 串行执行器 + FIFO 队列（runtime 侧 busy 唯一真相源）。
