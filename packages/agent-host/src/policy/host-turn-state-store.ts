/**
 * @deprecated 实现已迁至 `state/turn/HostTurnStore`。
 * 本文件仅再导出类型与类；调用方应改用实例（经 StateRoot.turn）。
 */

export {
  HostTurnStore,
  type ApprovalGrantName,
  type HostAgentDetail,
  type HostOrganizationDetail,
  type HostTurnRuntimeConfig,
  type HostWorkspaceDetail,
  type HostWorkspaceExecutionBinding,
  type HostAgentTurnState,
  type HostTurnBundle,
  type HostTurnExecutionLimits,
  type HostTurnProfile,
  type HostTurnStateSnapshot,
  type HostWorkspaceTurnState,
  type UpsertHostAgentTurnStateInput,
  type UpsertHostWorkspaceTurnStateInput,
} from '../state/turn/host-turn-store.js'
