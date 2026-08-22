/**
 * @tabtin/agent-runtime/permissions — Runtime 工具调用权限层（清退后）
 *
 * 模块清单：
 *   - `types`：HITL 通道 + 审批记忆接口（ApprovalMemo* / UserInteractiveChannel /
 *     BatchAction* / BatchApproval*）
 *   - `approval-key`：legacy memoization-layer key + shouldSkipMemoize
 *     （pattern_key fallback 重建已迁宿主 ToolRiskPolicyPort）
 *   - `memo-store` / `memo-sync-client`：v3 judge memo 存储 + 跨设备同步
 *     （JudgeMemoStoreAdapter 在宿主 policy 包出口）
 *   - `subagent-hitl`：子 Agent fork 透传 HITL channel
 *   - `user-interactive-bridge`：UserInteractiveChannel → LocalPermissionHandler 桥
 *   - `os-error-blacklist`：Organization 级 OS 错误黑名单
 *
 * Plan / Ask / Study 受限模式软拒 SSoT 在产品 modes 包；经宿主 ToolGate 注入
 * （ Stage 4）。历史 6 层 PermissionPipeline 已在 W7 / B1 后整体清退。
 */

// ── HITL cancel (Phase 3 mode switch) ──
export {
  cancelAllPendingHitlRequests,
  cancelAllSessionsHitlRequests,
} from './hitl-cancel.js';
export type {
  CancelAllPendingHitlOptions,
  PendingHitlEntry,
  PendingHitlMap,
} from './hitl-cancel.js';

// ── HITL 通道 + 审批记忆类型 ──
export type {
  UserInteractiveChannel,
  ApprovalMemoStore,
  ApprovalMemoEntry,
  BatchActionRequest,
  BatchApprovalResponse,
  BatchApprovalDecision,
} from './types.js';

// ── Host-injected HITL hooks ──
export {
  getHumanInteractionContext,
  requestPlatformApproval,
  runWithHumanInteractionContext,
  setHumanInteractionHooks,
} from './human-interaction-hooks.js';
export type {
  HumanInteractionContext,
  HumanInteractionHooks,
  PlatformApprovalRequest,
  PlatformApprovalResult,
} from './human-interaction-hooks.js';

// ── ApprovalMemoStore 实装 (W2-轮 1) ──
export {
  InMemoryApprovalMemoStore,
  createApprovalMemoStore,
  // W3-轮 1 (PRD §7.6.2 接口 B): host envelope handler helper
  applyCancelledByRollbackToHitl,
} from './memo-store.js';
export type {
  CommitAlwaysCallback,
  RefetchAllCallback,
  InMemoryApprovalMemoStoreOptions,
  // W3-轮 1: cancel client 回调 + envelope helper input/output
  CancelPendingApprovalsCallback,
  CancelledByRollbackDecision,
  ApplyCancelledByRollbackInput,
  ApplyCancelledByRollbackResult,
} from './memo-store.js';

// ── Approval Memo 跨设备同步客户端 (W2-轮 2) ──
export {
  createApprovalMemoCommitClient,
  createApprovalMemoRefetchClient,
  parseApprovalMemoSnapshot,
} from './memo-sync-client.js';
export type {
  AuthTokenProvider,
  CommitClientOptions,
  RefetchClientOptions,
  MemoSyncLogger,
} from './memo-sync-client.js';

// ── Legacy approval_key helpers（历史测试对照；pattern_key 重建见宿主 port） ──
export { buildApprovalKey, shouldSkipMemoize } from './approval-key.js';

// ── Sub-agent HITL (W1b legacy waitForUserInput + v0.4 W1.5-轮 4 channel) ──
export {
  createSubagentWaitForUserInput,
  createChildWaitForUserInputStub,
  createSubagentUserInteractiveChannel,
  getPendingHitlCount,
  __resetPendingHitlCountForTests,
} from './subagent-hitl.js';
export type {
  WaitForUserInputFn,
  CreateSubagentChannelOptions,
} from './subagent-hitl.js';

// ── UserInteractiveChannel Bridge (W3) ──
export { bridgeUserInteractiveToLocalPermissionHandler } from './user-interactive-bridge.js';
export type { BridgeOptions } from './user-interactive-bridge.js';

// ──  agent_run_id fail-closed ──
export { requireAgentRunId } from './hitl-persist.js';

// ── OS Error Blacklist (Organization 级共享 + 进程内生命周期) ──
export {
  getSharedOSErrorBlacklist,
  OSErrorBlacklist,
  OS_ERROR_DEFAULT_TTL_MS,
} from './os-error-blacklist.js';
export type {
  OSErrorBlacklistEntry,
  OSErrorBlacklistOptions,
} from './os-error-blacklist.js';
