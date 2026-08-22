/**
 * query-session-mutate.ts — 每次 handleQuery 入口对 session 持有的可变
 * `agentConfigV3.security` / `policyContext` / `workspaceSnapshot` 做 PD-13
 * 就地 mutate 的 SSoT，抽自两端 host 原本 inline 复读的段落
 * （Electron `ElectronAgentHost.handleQueryInternal` L4226–L4307 / Daemon
 * `DaemonAgentHost.handleQueryInternal` L2801–L2864）。
 *
 * PD-13（授权策略 v3 §5.5.2）核心不变量：
 *   - `session.agentConfigV3` / `session.workspaceSnapshot` 由 buildJudgePolicy
 *     工厂闭包按引用持有；本 mutate 必须**就地改写**已有对象，绝不能替换引用，
 *     否则下一轮 judge 看到的仍是旧策略。
 *   - 权威源来自 Django `agent-config-client.fetchAuthoritativeAgentConfig`（在
 *     进入本函数前已归一），wire / IPC payload 的 `yoloMode` / `approvalMode`
 *     只作 telemetry 比对，不参与 gate 决策——重复写在两端 host 里 bug-prone。
 *
 * 参考：
 *   - `packages/security-policy/src/types-v3.ts`（AgentConfigV3 / WorkspaceSnapshot）
 */

import type {
  AgentConfigV3,
  ApprovalMode,
  WorkspaceSnapshot,
  WorkspaceSources,
} from '@tabtin/security-policy'
import { isDangerouslyBroadPath } from '@tabtin/security-policy'
import {
  isApprovalModeName,
  type AgentModeName,
  type ApprovalModeName,
} from '@tabtin/agent-modes'

/**
 * 与两端 host `HostState.policyContext` 结构类型兼容的最小接口。
 * `requestedApprovalMode` 仅为旧 HostState 结构兼容， 后始终清空。
 */
export interface QuerySessionPolicyContextLike {
  currentAgentMode: AgentModeName
  isGroupSpace: boolean
  requestedApprovalMode?: ApprovalMode
}

/**
 * 每次 handleQuery 入口调本 mutate 时需要的最小 session 视图——不依赖
 * platform 特化字段，只碰 `agentConfigV3.security` + `policyContext`。
 */
export interface QuerySessionSecurityView {
  agentConfigV3?: AgentConfigV3 | null
  policyContext: QuerySessionPolicyContextLike
}

/**
 * PD-13 就地 mutate 需要触碰的完整 session 视图——在 security view 之上补上
 * `workspaceSnapshot`（工作区快照就地刷新）与 `appContext`（本轮写入）。两端
 * host 把真实 session `as unknown as QueryPipelineSession` 后交给 mutate 调用点。
 */
export interface QueryPipelineSession extends QuerySessionSecurityView {
  workspaceSnapshot?: QuerySessionWorkspaceSnapshotLike | null
  appContext?: unknown
  /** ：本轮 Agent 档案（agent-profile hook 读取）。 */
  agentProfile?: {
    agentName?: string
    customRules?: string
    /** ：Workspace.custom_rules */
    workspaceRules?: string
  } | null
}

export interface ApplyAuthoritativeSecurityMutateInput {
  /** Django 权威 `agent_config.security.allow_yolo_mode`（归一后的 boolean）。 */
  allowYolo: boolean
  /**
   * Django 权威 `agent_config.security.approval_grant`（agent-config-client
   * 已做枚举归一）；非法或缺失时写 undefined，让 build-policy 回落 legacy
   * allow_yolo_mode → grant 映射。
   */
  approvalGrant?: ApprovalMode | string | null
  /** 本轮 wire / IPC 归一后的 agentMode。 */
  agentMode: AgentModeName
  /**
   * 本轮 wire / IPC 声明的 approvalMode（未归一原始值）。undefined 也会写入
   * `policyContext.requestedApprovalMode`——清掉上一条消息的粘滞。
   */
  requestedApprovalMode?: string
  /** 分层规则 · 群协作运行时闸门；缺省 false（fail-open 安全侧）。 */
  isGroupSpace?: boolean
}

/**
 * 就地 mutate `session.agentConfigV3.security` + `session.policyContext`。
 * 与 handleQueryInternal 里原 inline 代码逐字等价（含 undefined 清粘滞 /
 * === true 判定 / grant 枚举归一）。
 */
export function applyAuthoritativeSecurityMutate(
  session: QuerySessionSecurityView,
  input: ApplyAuthoritativeSecurityMutateInput,
): void {
  if (session.agentConfigV3) {
    session.agentConfigV3.security.allow_yolo_mode = input.allowYolo === true
    session.agentConfigV3.security.approval_grant = normalizeApprovalGrant(
      input.approvalGrant,
    )
  }
  session.policyContext.currentAgentMode = input.agentMode
  session.policyContext.requestedApprovalMode = undefined
  session.policyContext.isGroupSpace = input.isGroupSpace === true
}

/**
 * 与两端 host `session.workspaceSnapshot` 结构类型兼容的最小接口。
 * `allowedPaths` / `allowedFiles` 用 mutable 数组以支持 splice-style 就地改写。
 */
export interface QuerySessionWorkspaceSnapshotLike {
  sources: WorkspaceSources
  allowedPaths: string[]
  allowedFiles?: string[]
  /** 冗余字段（如 spaceSessionId 等），mutate 不动它们。 */
  [extra: string]: unknown
}

/**
 * wire / IPC 上行的可能不完整快照——`sources.*` 全部可选，`allowedPaths` /
 * `allowedFiles` 只在有内容时读，允许 host 侧传 `WorkspaceSnapshot | undefined`
 * 前预筛。
 */
export interface QueryWorkspaceSnapshotIncoming {
  sources?: Partial<WorkspaceSources>
  allowedPaths?: readonly string[]
  allowedFiles?: readonly string[]
}

export interface ApplyWorkspaceSnapshotMutateOptions {
  /**
   * Electron 侧可注入 `workspaceBoundary.reconcileSnapshot`——按 tracker 状态
   * 全量刷新 `dst.allowedPaths`（含 sessionApprovedPaths 等状态外源）。
   * 缺省则用 sandbox+workingDir+sessionApprovedPaths 从 sources re-derive，与
   * Daemon 侧原 inline 代码等价（Daemon 没有 tracker）。
   */
  reconcileAllowedPaths?: (dst: QuerySessionWorkspaceSnapshotLike) => void
}

/**
 * 就地 mutate `session.workspaceSnapshot`——**空数组 / 空字符串视作 omit**，
 * 保护"wire payload shape 合法但数组全空 → 清空真实工作区"的坏路径（W6 M3
 * 三视角 review 第二轮 P0 修复）。
 *
 * 单根契约（`docs/single-root-space-prd.md` §2.2）：
 *   - `sources.workingDir` 是真相单源
 *   - `allowedPaths` 始终从 sources re-derive，不信任 wire 上的 allowedPaths
 *     数组（老主控端可能上传"多 root 并集"形态）
 */
export function applyWorkspaceSnapshotMutate(
  dst: QuerySessionWorkspaceSnapshotLike,
  incoming: QueryWorkspaceSnapshotIncoming,
  options: ApplyWorkspaceSnapshotMutateOptions = {},
): void {
  if (incoming.sources) {
    if (
      typeof incoming.sources.sandbox === 'string'
      && incoming.sources.sandbox.length > 0
    ) {
      dst.sources.sandbox = incoming.sources.sandbox
    }
    if (
      typeof incoming.sources.workingDir === 'string'
      && incoming.sources.workingDir.length > 0
    ) {
      dst.sources.workingDir = incoming.sources.workingDir
    }
    if (
      Array.isArray(incoming.sources.attachedFiles)
      && incoming.sources.attachedFiles.length > 0
    ) {
      dst.sources.attachedFiles = [...incoming.sources.attachedFiles]
    }
  }
  if (options.reconcileAllowedPaths) {
    options.reconcileAllowedPaths(dst)
  } else {
    deriveAllowedPathsFromSources(dst)
  }
  if (
    Array.isArray(incoming.allowedFiles)
    && incoming.allowedFiles.length > 0
  ) {
    dst.allowedFiles = [...incoming.allowedFiles]
  }
}

/**
 * Daemon 侧 fallback 用的 allowedPaths derive——与 DaemonAgentHost 原 inline
 * 代码逐字等价。sandbox + workingDir + sessionApprovedPaths 去重 + 过滤过宽
 * 路径（`isDangerouslyBroadPath`）。
 */
function deriveAllowedPathsFromSources(
  dst: QuerySessionWorkspaceSnapshotLike,
): void {
  const set = new Set<string>()
  if (dst.sources.sandbox && !isDangerouslyBroadPath(dst.sources.sandbox)) {
    set.add(dst.sources.sandbox)
  }
  if (
    dst.sources.workingDir
    && !isDangerouslyBroadPath(dst.sources.workingDir)
  ) {
    set.add(dst.sources.workingDir)
  }
  for (const path of dst.sources.sessionApprovedPaths ?? []) {
    if (
      typeof path === 'string'
      && path.length > 0
      && !isDangerouslyBroadPath(path)
    ) {
      set.add(path)
    }
  }
  dst.allowedPaths = [...set]
}

/**
 * `WorkspaceSnapshot` 派生视图——把 mutable 视图窄化到实际 SSoT 类型，方便调用
 * 方在拿到 mutate 结果后当只读快照传给下游。
 */
export function asReadOnlyWorkspaceSnapshot(
  snapshot: QuerySessionWorkspaceSnapshotLike,
): Pick<WorkspaceSnapshot, 'sources' | 'allowedPaths' | 'allowedFiles'> {
  return {
    sources: snapshot.sources,
    allowedPaths: snapshot.allowedPaths,
    allowedFiles: snapshot.allowedFiles ?? [],
  }
}

function normalizeApprovalGrant(
  raw: ApprovalMode | string | null | undefined,
): ApprovalMode | undefined {
  return isApprovalModeName(raw) ? raw : undefined
}

function normalizeRequestedApproval(
  raw: string | undefined,
): ApprovalModeName | undefined {
  return isApprovalModeName(raw) ? raw : undefined
}
