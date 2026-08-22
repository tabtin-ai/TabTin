/**
 * @tabtin/app-shell — 共享应用外壳
 *
 * 统一导出给 Electron、Web 等各端使用。
 */

// ── Runtime ──
export {
  configureAppShell,
  getRuntime,
  type HttpTransport,
  type AuthProvider,
  type PlatformBridge,
  type AppShellRuntime,
} from './runtime.js'

// ── Types ──
export * from './types/space-types.js'
export * from './types/organization.js'
export * from './types/space.js'
export * from './types/common.js'

// ── Constants ──
export { LayoutConstraints, ZIndex } from './constants/layout.js'
export { CONVERSATION_TYPE_DM, CONVERSATION_TYPE_GROUP } from './constants/tabchat.js'

// ── Utils ──
export { cn } from './utils/cn.js'
export {
  logger,
  createLogger,
  setAppShellLogSink,
  type AppShellLogSink,
  type AppShellLogLevel,
} from './utils/logger.js'
export {
  getCapabilityOverride,
  setCapabilityOverride,
  withCapabilityOverride,
  buildCapabilityOverridePatch,
  normalizeExecutionLimitsForCostCap,
  hasNumericExecutionLimits,
  isExecutionLimitsEnabled,
  type ExecutionLimitsShape,
  type NormalizedCostExecutionLimits,
} from './utils/agent-config-v2.js'
export { resolveSessionScopeId } from './utils/resolve-session-scope-id.js'

// ── Services ──
export { OrganizationApiService } from './services/organization-api.js'
export { MemberApiService, type MemberSearchParams } from './services/member-api.js'
export {
  SpaceApiService,
  WorkspaceApiService,
  ProjectApiService,
  AgentApiService,
  ApprovalMemoApiService,
} from './services/space-api.js'
export type {
  TrashedItem,
  TrashedItemsResponse,
  TrashedSpace,
  TrashedSpacesResponse,
  DeactivatedAgent,
  DeactivatedAgentsResponse,
  ContextItem,
  ContextSearchItem,
  ContextSearchResponse,
  ContextItemListResponse,
  SpaceFileUploadRequest,
  SpaceFileDownloadUrlResponse,
  SpaceContextSearchParams,
  KnowledgeTreeNode,
  KnowledgeTreeNodeType,
  KnowledgeTreeResponse,
  KnowledgeTreeParams,
} from './services/space-api.js'
export { authenticatedRequest, apiBaseUrl, getAuthToken } from './services/base.js'
export {
  unifiedSearch,
  UnifiedSearchError,
  type UnifiedSearchParams,
  type UnifiedSearchResponse,
  type SearchResultItem as FtsSearchResultItem,
  type FtsResultType,
  type FtsLogicalIndex,
  type FtsDegradedReason,
  type FtsNotice,
  type FtsCreatorType,
  type FtsRoleFilter,
  type FtsSearchModeRequest,
  type FtsSearchModeResponse,
} from './services/fts-api.js'

// ── Stores ──
export {
  useOrganizationStore,
  setCurrentSpaceOrganizationIdResolver,
  setSpaceClearer,
  type SelectOrganizationOptions,
} from './stores/use-organization-store.js'
export { useAgentStore } from './stores/use-agent-store.js'
export { useSpaceStore } from './stores/use-space-store.js'
export {
  useSpaceListStore,
  setExternalStoreAdapters,
  type ExternalStoreAdapters,
} from './stores/use-space-list-store.js'
export { initAppShellStores } from './stores/init.js'

// ── Store utilities ──
export { onNavigate, emitNavigate, type NavigationTarget, type NavigationListener } from './stores/view-navigation.js'
export { registerResetAction, runAllResetActions, type ResetPhase } from './stores/session-reset-registry.js'
export { onOrganizationSelected, emitOrganizationSelected } from './stores/organization-lifecycle-events.js'
export { resetHostTurnPush } from './stores/host-turn-push.js'
export {
  clearOrganizationSettingsKnown,
  getFrontendContextReady,
  isAgentConfigKnown,
  isFrontendContextReady,
  isFrontendContextReadyFor,
  isFrontendShellContextReady,
  markAgentConfigKnown,
  notifyAgentContextChanged,
  notifyOrganizationSettingsKnown,
  notifyWorkspaceContextChanged,
  resetFrontendContextReady,
  subscribeFrontendContextReady,
  type FrontendContextReadySnapshot,
} from './stores/frontend-context-ready.js'
export { normalizeOrganization, normalizeOrganizationList, normalizeString } from './stores/organization/normalize.js'
export { extractErrorMessage, dedupAsync } from './stores/organization/helpers.js'
export {
  buildSelectionSnapshot,
  EMPTY_SPACE_SELECTION,
  getOrganizationSelection,
  rememberOrganizationSelection,
  resolveSelectionBySpaceId,
  type SpaceSelectionSnapshot,
  type OrganizationSpaceSelectionMap,
  type ResolvedSpaceSelection,
} from './stores/space-list-selection.js'
export {
  resolveDefaultExecutionWorkspaceId,
  resolveShellSelection,
  type ExecutionWorkspaceCandidate,
  type ShellSelection,
} from './stores/resolve-shell-selection.js'
