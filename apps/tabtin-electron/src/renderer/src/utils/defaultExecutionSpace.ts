/**
 * 默认执行 Workspace 解析 — 与 app-shell 单一算法对齐。
 * 侧栏挂会话列表与 ensureActiveSelection 共用同一实现，避免双轨分叉。
 */
export {
  resolveDefaultExecutionWorkspaceId,
  type ExecutionWorkspaceCandidate,
} from '@tabtin/app-shell'
