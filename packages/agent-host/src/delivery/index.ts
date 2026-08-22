/**
 * Delivery surface for agent-host.
 *
 * Public persistence / recovery entry: {@link MessageDeliveryOutbox}.
 * {@link RelayRetryQueue} is an Outbox-owned internal retry implementation —
 * hosts should not wire it directly.
 * {@link reconcileSessionRelay} is reconnect backfill, not persist; do not merge
 * it into Outbox.
 */
export {
  DeliveryBatchBuffer,
  type DeliveryTransport,
} from './delivery-batch-buffer.js'
export {
  CONTENT_BLOCK_DELTA_TYPE,
  RELAY_DELTA_COALESCE_MAX_CHARS,
  coalesceRelayBatch,
  relayDeltaCoalesceKey,
  tryAppendCoalescedDelta,
  type RelayBatchEvent,
} from './relay-delta-coalesce.js'
export {
  CLIENT_BROADCAST_EXCLUDED_STREAM_TYPES,
  isClientBroadcastExcludedStreamType,
} from './client-broadcast-excluded.js'
export { MessageDeliveryOutbox } from './message-delivery-outbox.js'
export type {
  MessageDeliveryLogger,
  MessageDeliveryOptions,
  MessageDeliveryOutboxOptions,
} from './message-delivery-outbox.js'
export { correlateSourceClientEvent } from './source-event-correlation.js'
export {
  capLlmSnapshotForDelivery,
  projectLlmSnapshotDeliveryEvent,
} from './llm-snapshot-projection.js'
export { projectRelayMessageEvent } from './relay-message-projection.js'
export {
  createSubagentStreamRouter,
  type SubagentStreamRouterDeps,
} from './subagent-stream-router.js'
export {
  formatProactiveReportMessage,
  type PendingSubtaskInfo,
} from './proactive-report-message.js'
export {
  RelayRetryQueue,
  type RelayBatch,
  type RelayRetryQueueOptions,
  type RelayRetryTransport,
} from './relay-retry-queue.js'
export {
  SessionMessagesNotFoundError,
  fetchAllServerMessageRefs,
  reconcileSessionRelay,
  resolveRelaySessionIdForReconcile,
  type FetchServerMessageRefsDeps,
  type RelayBackfillEvent,
  type RelayReconcileDeps,
  type RelayReconcileResult,
  type ServerMessageRef,
} from './relay-reconcile.js'
export {
  SingleFlight,
  assertRelayAck,
  buildRelayRequestPayload,
  formatRelayFailureMessage,
  parseRelayFailure,
  parseRelayFailureFromError,
  relayEventsWithRetry,
  type RelayAckResponse,
  type RelayDeliveryLogger,
  type RelayDeliveryMetadata,
  type RelayEvent,
  type RelayFailureInfo,
  type RelayRequestPayload,
  type RelayWithRetryDeps,
} from './relay-transport.js'
export {
  routeDeliveryEvent,
  type DeliveryEventSource,
  type DeliveryRoute,
} from './delivery-event-routing.js'
export {
  filterRelayPersistableEvents,
  isRelayTransientEvent,
} from './relay-transient-events.js'
export {
  RelaySessionOrchestrator,
  type RelaySessionOrchestratorDeps,
  type RelaySessionOrchestratorLogger,
  type RelaySessionStorageView,
} from './relay-session-orchestrator.js'
export {
  NotificationIdleDrain,
  type NotificationDrainContext,
  type NotificationIdleDrainDeps,
  type NotificationIdleDrainLogger,
} from './notification-idle-drain.js'
export {
  formatDocumentAttachmentMetadata,
  formatAttachmentResourceMetadata,
  findAttachmentsMissingResourceIdentity,
  formatGenericAttachmentResourceText,
  formatFallbackAttachmentText,
  resolveFileAttachmentsShell,
  type AttachmentDescriptor,
  type AttachmentPipelineLogger,
  type ResolveAttachmentsOptions,
} from './attachment-pipeline.js'
export { SessionPauseController } from './session-pause-controller.js'
export {
  buildMediaImageArtifactBlocks,
  buildMediaImageArtifactEvents,
  isMediaImageGenerateCommand,
} from './media-image-artifact.js'
export type {
  DeliveryTransportPort,
  RelayTransportAck,
  DurableOutboxStore,
  LocalStreamContext,
  LocalStreamPort,
  RelayContext,
} from './delivery-transport-port.js'
export {
  DefaultDeliveryCoordinator,
  type DeliveryCoordinator,
  type DeliveryCoordinatorConfig,
  type DefaultDeliveryCoordinatorOptions,
  type DeliveryDurableLayer,
  type DeliveryTurn,
  type DeliveryTurnContext,
  type DeliveryPersistenceSinks,
  type HostEventContext,
  type OwnerScope,
} from './delivery-coordinator.js'
//  / ：run_terminal_command 交付物卡（OSS /
// table·doc create platform_resource）—— host afterToolResult hook。
// 业务从 agent-runtime `capability/core` 迁到此处（core 去业务化）。
// Browser→Table / task_episode 自动发卡已随  移除。
export { createTerminalArtifactCardHook } from './terminal-artifact-hook.js'
export {
  createFileEditPatchPersistHook,
  type FileEditPatchPersistHookDeps,
  type FileEditPatchPersistInput,
} from './file-edit-patch-hook.js'
export {
  PLATFORM_RESOURCE_ARTIFACT_KIND,
  buildPlatformResourceArtifactBlock,
  buildPlatformResourceArtifactBlockFromCreate,
  isPlatformResourceCreateCommand,
  parsePlatformResourceCreateResult,
  type ParsedPlatformResourceCreate,
  type PlatformResourceType,
} from './platform-resource-artifact.js'
// ：App context 详情段渲染（按 appType 输出产品字段 + CLI 配方）——
// 业务从 agent-runtime context-injector 迁到此处，经 buildContextInjectorHook
// 的 formatAppMeta option 注入（core 去业务化）。
export { createAppMetaFormatter } from './app-meta-formatter.js'
export {
  buildOssFileArtifactBlock,
  buildOssFileArtifactBlockFromUpload,
  parseOssUploadResult,
  isOssUploadCommand,
  extractOssUploadFilename,
  type ParsedOssUploadResult,
} from './oss-file-artifact.js'
// ：子 run 交付物收集 / enrich —— host 产品语义，不进 agent-runtime。
export {
  CHILD_DELIVERABLES_TAG,
  CHILD_DELIVERABLE_ARTIFACT_KINDS,
  appendDeliverablesToToolResultContent,
  collectChildDeliverables,
  collectDeliverablesFromRecords,
  filterRecordsBySubagentRunId,
  parseDeliverablesFromToolResultContent,
  type ChildDeliverable,
  type ChildDeliverableArtifactKind,
  type CollectChildDeliverablesOptions,
} from './child-deliverables.js'
export {
  collectDeliverablesForChild,
  wrapEnqueueSubagentCompletionWithDeliverables,
  formatSettledChildCompletionLineWithDeliverables,
  type ChildDeliverablesEnricherDeps,
} from './child-deliverables-enrichment.js'
