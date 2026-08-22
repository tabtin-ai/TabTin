export {
  AgentHost,
  type AgentHostStartOptions,
} from './agent-host.js'
export {
  StateRoot,
  createStateRoot,
  OwnerStore,
  DeviceIdentityStore,
  HostTurnStore,
  SkillsStore,
  type SkillAvailabilitySnapshot,
  type SkillRunSnapshotOptions,
  type StateRootOptions,
  type StateDomainName,
  type ApprovalGrantName,
  type HostAgentTurnState,
  type HostTurnBundle,
  type HostTurnExecutionLimits,
  type HostTurnProfile,
  type HostWorkspaceTurnState,
  type UpsertHostAgentTurnStateInput,
  type UpsertHostWorkspaceTurnStateInput,
} from './state/index.js'
export {
  ApprovalGate,
  approvalGateSessionId,
  createApprovalGate,
  type ApprovalActionDescriptor,
  type ApprovalGateDeps,
  type ApprovalGateMemoPort,
  type ApprovalGateResult,
} from './interaction/approval-gate.js'
export type {
  AgentCancelCommand,
  AgentHostCommandHandlers,
  AgentHostLogger,
  AgentOwnerAdapter,
  AgentPermissionCommand,
  AgentPlatformAdapter,
  AgentQueryExecutor,
  AgentSubagentCancelCommand,
  AgentUserResponseCommand,
  RegisterApprovalMemoInput,
} from './agent-platform-adapter.js'
export type { ConversationLifecycleIdentity } from './conversation/conversation-identity.js'
export { ConversationRunCancelledError } from './conversation/conversation-run-coordinator.js'
export { MessageDeliveryOutbox } from './delivery/message-delivery-outbox.js'
export type {
  MessageDeliveryOutboxOptions,
  MessageDeliveryLogger,
  MessageDeliveryOptions,
} from './delivery/message-delivery-outbox.js'
export {
  RuntimeSessionFactory,
  RuntimeOwnerQuiescedError,
  canSoftReconfigureByShellTier,
  isShellRestrictedAgentMode,
  resolveRuntimeModeAgainstSticky,
  disabledAppsExtraKeysMatch,
  normalizeDisabledAppsExtraKey,
  executionOwnerScopeId,
  resolveSubagentCarryForward,
  resolveSubagentCompletionSpaceId,
  buildCostCapConfig,
  type BuildCostCapConfigInput,
  type BuildCostCapConfigResult,
  type ResolveSubagentCarryForwardInput,
  type ResolveSubagentCarryForwardResult,
  type ResolveSubagentCompletionSpaceIdInput,
  type SubagentManagerLike,
  type RuntimeDisabledAppsExtraKey,
  type RuntimeSessionRequest,
  type RuntimeSessionResolution,
  type RuntimeSessionFactoryAdapter,
  type RuntimeBuildContext,
} from './runtime/index.js'
export {
  applyAuthoritativeSecurityMutate,
  applyWorkspaceSnapshotMutate,
  type ApplyAuthoritativeSecurityMutateInput,
  type ApplyWorkspaceSnapshotMutateOptions,
  type QuerySessionSecurityView,
  type QuerySessionWorkspaceSnapshotLike,
} from './conversation/index.js'

// ─── Deep-module contract (agent-host-full-migration) ────────────────
// Frozen, platform-neutral seam that Electron/Daemon map into. The three
// deep modules (QueryTurnPipeline / RuntimeSessionLifecycle / DeliveryCoordinator)
// own orchestration; platforms only supply HostQuery + the atomic ports.
export type {
  HostQuery,
  HostQueryIdentity,
  HostQueryPolicyInput,
  HostQueryResult,
  HostQueryOutcome,
  HostTurnInput,
  HostAttachment,
  HostHistoryMessage,
  HostTriggerSource,
} from './conversation/host-query.js'
export {
  DefaultQueryTurnPipeline,
  type QueryTurnPipeline,
  type QueryAbortResult,
  type QueryTurnDataPort,
  type QueryTurnSessionView,
  type DefaultQueryTurnPipelineOptions,
} from './conversation/query-turn-pipeline.js'
export {
  DefaultRuntimeSessionLifecycle,
  type RuntimeSessionLifecycle,
  type RuntimeSessionLifecycleOptions,
  type LivePolicyUpdate,
  type LivePolicyApplier,
} from './runtime/runtime-session-lifecycle.js'
export type {
  RuntimeResourceFactory,
  RuntimeSessionHandle,
} from './runtime/runtime-resource-factory.js'
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
} from './delivery/delivery-coordinator.js'
export type {
  DeliveryTransportPort,
  RelayTransportAck,
  DurableOutboxStore,
  LocalStreamContext,
  LocalStreamPort,
  RelayContext,
} from './delivery/delivery-transport-port.js'
export {
  HostTrackerScheduler,
  HOST_TRACKER_SCHEDULE_REFRESH_MS,
  HOST_TRACKER_WORK_POLL_MS,
  HOST_TRACKER_TIMER_MAX_DELAY_MS,
  HOST_TRACKER_FIRE_RETRY_MS,
  HOST_TRACKER_MISFIRE_GRACE_MS,
  planHostSchedule,
  type HostScheduleItem,
  type HostWorkItem,
  type HostTrackerSchedulerPorts,
} from './tracker/index.js'
