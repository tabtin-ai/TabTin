/**
 * @tabtin/collab-core
 *
 * TabTin 实时协作底座
 * - CollabProvider: 统一连接管理（HocuspocusProvider + IndexedDB + 状态机）
 * - useCollabProvider: React Hook 封装
 * - useStatelessEvents: Stateless 业务事件 Hook
 * - UI 组件: CollabStatusBadge, CollabAvatars, ForceCloseOverlay
 * - 错误码规范 + Fallback 策略
 */

// ── 类型 ──
export {
  CollabConnectionStatus,
  CollabStatus,
  CloseCode,
  INITIAL_COLLAB_STATE,
  type CollabProviderOptions,
  type CollabUser,
  type CollabPeerState,
  type CollabState,
  type ForceCloseMessage,
  type StatelessEvent,
} from "./types.js";

// ── 核心 Provider ──
export {
  CollabProvider,
  isNonRetryableCollabError,
  COLLAB_STUCK_CONNECTING_EVENT,
} from "./provider.js";

// ── React Hooks ──
export {
  useCollabProvider,
  useAwarenessStates,
  CONNECTING_WATCHDOG_TIMEOUT_MS,
  DISCONNECT_TIMEOUT_MS,
  type UseCollabProviderResult,
} from "./useCollabProvider.js";
export {
  useStatelessEvents,
  type UseStatelessEventsOptions,
  type UseStatelessEventsResult,
} from "./useStatelessEvents.js";
export { useOfflineReplay, type UseOfflineReplayOptions } from "./useOfflineReplay.js";

// ── UI 组件 ──
export { CollabStatusBadge, type CollabStatusBadgeProps } from "./components/CollabStatusBadge.js";
export { CollabAvatars, type CollabAvatarsProps } from "./components/CollabAvatars.js";
export { ForceCloseOverlay, type ForceCloseOverlayProps } from "./components/ForceCloseOverlay.js";

// ── 错误码规范 ──
export {
  FallbackStrategy,
  COLLAB_ERROR_SPECS,
  getErrorSpec,
  shouldFallbackToLegacy,
  type CollabErrorSpec,
} from "./errors.js";
export {
  resolveCollabSyncMode,
  shouldConsumeLegacyDomainDelta,
  STUCK_CONNECTING_FALLBACK_THRESHOLD,
  type CollabSyncMode,
  type CollabSyncModeReason,
  type CollabSyncModeState,
  type ResolveCollabSyncModeInput,
  type LegacyDomainDeltaDecisionInput,
} from "./syncMode.js";
export {
  isControlEvent,
  isInvalidationEvent,
  type CollabModuleName,
  type CollabControlEventType,
  type CollabControlEvent,
  type InvalidationPayload,
} from "./controlEvents.js";
export {
  validateCollabApplyOpsRequest,
  type CollabDomainOp,
  type CollabApplyOpsRequest,
  type CollabApplyOpsResult,
} from "./commands.js";
export {
  getShardRefsByKind,
  assertRootManifestIsLightweight,
  type CollabShardKind,
  type CollabShardRef,
  type CollabRootManifest,
} from "./sharding.js";
export {
  COLLAB_SUBDOCS_MAP,
  getSubdocumentsMap,
  ensureManifestSubdocuments,
  loadSubdocuments,
  destroyInactiveSubdocuments,
} from "./subdocuments.js";

// ── 统一版本管理 ──
export {
  useVersionHistory,
  VersionPanel,
  VersionHistoryOverlayShell,
  type VersionPanelProps,
  type VersionHistoryOverlayShellProps,
  type UseVersionHistoryOptions,
  type UseVersionHistoryReturn,
  type VersionAdapter,
  type VersionHistoryItem,
  type VersionPanelLabels,
  type VersionListResponse,
  type AgentRunChangesResponse,
  type OperationResult,
  fetchVersionPreview,
  type VersionPreviewData,
  useVersionPanel,
  type UseVersionPanelOptions,
  type UseVersionPanelReturn,
  type VersionCheckpointContext,
  type SubConversationRef,
  type CheckpointContext,
  type ConversationSegmentMessage,
  type ConversationSegmentResponse,
  type ViewConversationOptions,
  fetchConversationSegment,
  fetchConversationAnchors,
  type ConversationAnchorContext,
  type ConversationAnchorItem,
  type ConversationAnchorsResponse,
  type FetchConversationAnchorsOptions,
  filePathToResourceId,
  ConversationSegmentPopover,
  type ConversationSegmentPopoverProps,
} from "./version/index.js";

// ── 协作者颜色 ──
export { getUserColor, COLLAB_PALETTE } from "./colors.js";

// ── 统一 Presence 协议 ──
export {
  buildPresenceState,
  isPresenceStale,
  extractActivePresence,
  isTabVideoCursor,
  isTabWhiteboardCursor,
  type PresenceUser,
  type PresenceCursor,
  type PresenceCursorData,
  type PresenceState,
  type SpacePresenceEntry,
  type AgentPresenceExtension,
  type TabDocCursorData,
  type TabDataCursorData,
  type TabSlideCursorData,
  type TabVideoCursorData,
  type TabWhiteboardCursorData,
} from "./presence-protocol.js";
