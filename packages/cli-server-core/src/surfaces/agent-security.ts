/**
 * agent-security 模块 — 3 个 PlatformSurface。
 *
 * 将原 `ElectronAgentHost.ts:1246-1291` 中的三个只读查询 handler 迁移：
 *   - agent-security:get-workspace-snapshot — 遍历 sessions 查找匹配 spaceId 的快照
 *   - agent-security:build-approval-key    — 调 @tabtin/security-policy 构建审批 key
 *   - agent-security:build-scope-description — 调 @tabtin/security-policy 构建 scope 描述
 *
 * 这三个都是只读操作（D-6 注释确认"保留的只读查询"），不发 HTTP、无 URL bug 隐患。
 *
 * 设计：工厂模式 `createAgentSecuritySurfaces(deps)`，通过闭包捕获
 * ElectronAgentHost 的 sessions 查询能力和 security-policy 函数。
 * cli-server-core 不直接依赖 @tabtin/security-policy，由宿主传入。
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'
import { SurfaceError } from '../surface/types.js'

// ─── 依赖接口 ─────────────────────────────────────────────────────

/**
 * WorkspaceSnapshot 简化接口（与 @tabtin/security-policy WorkspaceSnapshot 对齐）。
 *
 * surface 仅透传整个 snapshot，不消费 `sources` 内部字段，所以这里把
 * `sources` 放宽成 `unknown`，避免对宿主的 `WorkspaceSources` 结构化类型
 * 强加 `Record<string, unknown>` 索引签名约束（导致 TS2322）。
 */
export interface WorkspaceSnapshotLike {
  sources: unknown
  allowedPaths: readonly string[]
  allowedFiles: readonly string[]
}

/**
 * agent-security 模块的外部依赖。
 *
 * 宿主（Electron / Daemon）在启动时传入：
 *   - findWorkspaceSnapshot: 从 AgentHost sessions Map 中查找匹配 spaceId 的快照
 *   - buildApprovalKey: @tabtin/security-policy 的 buildApprovalKey 函数
 *   - buildScopeDescription: @tabtin/security-policy 的 buildScopeDescription 函数
 */
export interface AgentSecurityDeps {
  findWorkspaceSnapshot(spaceId: string): WorkspaceSnapshotLike | null
  buildApprovalKey(
    toolName: string,
    subcmd: string,
    input: unknown,
    inWorkspace: boolean,
    opts: { scope: 'exact' | 'scoped' | 'wildcard'; kind?: string },
  ): string | Promise<string>
  buildScopeDescription(
    toolName: string,
    subcmd: string,
    scope: string,
  ): string | Promise<string>
}

// ─── 输入 / 输出类型 ──────────────────────────────────────────────

export interface GetWorkspaceSnapshotInput {
  spaceId: string
}

export interface GetWorkspaceSnapshotOutput {
  snapshot: WorkspaceSnapshotLike | null
}

export interface BuildApprovalKeyInput {
  toolName: string
  subcmd: string
  input: unknown
  inWorkspace: boolean
  scope: 'exact' | 'scoped' | 'wildcard'
  kind?: string
}

export interface BuildScopeDescriptionInput {
  toolName: string
  subcmd: string
  scope: string
}

// ─── 工厂 ─────────────────────────────────────────────────────────

/**
 * 创建 agent-security 模块的 3 个 PlatformSurface。
 *
 * 调用时机：ElectronAgentHost.start() 链路或 Daemon 启动链路。
 * 宿主负责把 sessions 查询能力和 security-policy 函数注入进来。
 */
export function createAgentSecuritySurfaces(deps: AgentSecurityDeps) {
  const getWorkspaceSnapshot = definePlatformSurface({
    module: 'agent-security',
    verb: 'get-workspace-snapshot',
    kind: 'local',
    errorCodes: ['VALIDATION_ERROR'] as const,
    bindings: { ipc: true, http: true },

    handler: async (
      input: GetWorkspaceSnapshotInput,
    ): Promise<GetWorkspaceSnapshotOutput> => {
      if (!input?.spaceId) {
        throw new SurfaceError('VALIDATION_ERROR', 'spaceId 是必填参数')
      }
      const snapshot = deps.findWorkspaceSnapshot(input.spaceId)
      return { snapshot }
    },
  })

  const buildApprovalKey = definePlatformSurface({
    module: 'agent-security',
    verb: 'build-approval-key',
    kind: 'local',
    errorCodes: ['VALIDATION_ERROR'] as const,
    bindings: { ipc: true, http: true },

    handler: async (input: BuildApprovalKeyInput): Promise<string> => {
      if (!input?.toolName || !input?.subcmd) {
        throw new SurfaceError(
          'VALIDATION_ERROR',
          'toolName 和 subcmd 是必填参数',
        )
      }
      return deps.buildApprovalKey(
        input.toolName,
        input.subcmd,
        input.input,
        input.inWorkspace,
        { scope: input.scope, kind: input.kind },
      )
    },
  })

  const buildScopeDescription = definePlatformSurface({
    module: 'agent-security',
    verb: 'build-scope-description',
    kind: 'local',
    errorCodes: ['VALIDATION_ERROR'] as const,
    bindings: { ipc: true, http: true },

    handler: async (input: BuildScopeDescriptionInput): Promise<string> => {
      if (!input?.toolName || !input?.subcmd || !input?.scope) {
        throw new SurfaceError(
          'VALIDATION_ERROR',
          'toolName、subcmd 和 scope 是必填参数',
        )
      }
      return deps.buildScopeDescription(
        input.toolName,
        input.subcmd,
        input.scope,
      )
    },
  })

  return { getWorkspaceSnapshot, buildApprovalKey, buildScopeDescription }
}
