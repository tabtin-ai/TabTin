/**
 * ToolRiskPolicyPort 宿主适配器（ Stage 3a / 3b）。
 *
 * 包装 `@tabtin/security-policy` 的 EffectivePolicy + judge + MemoStore，
 * 对外只暴露 runtime 中立端口。
 */

import {
  judge as judgeV3,
  normalize as normalizePolicyPath,
  type EffectivePolicy,
  type MemoStore,
  type Decision,
} from '@tabtin/security-policy'
import type {
  BuildMemoPatternKeyInput,
  RiskDecision,
  ToolRiskJudgeInput,
  ToolRiskPolicyPort,
  ToolRiskPolicySnapshot,
  WorkspaceBoundary,
} from '@tabtin/agent-runtime/engine'
import { buildMemoPatternKey } from './build-memo-pattern-key.js'

export interface CreateToolRiskPolicyPortDeps {
  buildEffectivePolicy: () => EffectivePolicy | undefined
  memoStore: MemoStore
  homeDir?: string
}

function toWorkspaceBoundary(workspace: EffectivePolicy['workspace']): WorkspaceBoundary {
  return {
    allowedPaths: workspace.allowedPaths,
    allowedFiles: workspace.allowedFiles,
    spaceSessionId: workspace.spaceSessionId,
  }
}

function toRiskDecision(decision: Decision): RiskDecision {
  return {
    behavior: decision.behavior,
    reason: decision.reason as RiskDecision['reason'],
    approvalKey: decision.approvalKey,
    userVisibleReason: decision.userVisibleReason,
    resolutionHints: decision.resolutionHints as RiskDecision['resolutionHints'],
  }
}

export function createToolRiskPolicyPort(
  deps: CreateToolRiskPolicyPortDeps,
): ToolRiskPolicyPort {
  type PolicyMapper = (policy: EffectivePolicy) => EffectivePolicy
  const make = (
    mapPolicy?: PolicyMapper,
  ): ToolRiskPolicyPort => {
    const resolveEffective = (): EffectivePolicy | undefined => {
      const base = deps.buildEffectivePolicy()
      if (!base) return undefined
      return mapPolicy ? mapPolicy(base) : base
    }

    const remap = (next: PolicyMapper): ToolRiskPolicyPort =>
      make((policy) => next(mapPolicy ? mapPolicy(policy) : policy))

    return {
      resolveSnapshot(): ToolRiskPolicySnapshot | undefined {
        const policy = resolveEffective()
        if (!policy) return undefined
        return { workspace: toWorkspaceBoundary(policy.workspace) }
      },

      judge(input: ToolRiskJudgeInput): RiskDecision {
        const policy = resolveEffective()
        if (!policy) {
          return {
            behavior: 'deny',
            reason: {
              type: 'plan_blocked',
              mode: input.agentMode,
              message: 'tool risk policy unavailable',
            },
            userVisibleReason: '安全策略未就绪，已拒绝本次工具调用。',
          }
        }
        return toRiskDecision(
          judgeV3({
            tool: {
              name: input.tool.name,
              policyActionKind: input.tool.policyActionKind as
                | 'shell'
                | 'file'
                | 'object'
                | 'object_write'
                | 'mcp'
                | 'device'
                | undefined,
              deviceActionRisk: input.tool.deviceActionRisk,
              isReadOnly: input.tool.isReadOnly,
              riskLevel: input.tool.riskLevel as 'safe' | 'review' | 'strict' | undefined,
              planTargetWriteGuarded: input.tool.planTargetWriteGuarded,
              extractPath: input.tool.extractPath,
              extractSubcmd: input.tool.extractSubcmd,
              isWriteOp: input.tool.isWriteOp,
            },
            input: input.input,
            effectivePolicy: policy,
            memoStore: deps.memoStore,
            homeDir: input.homeDir ?? deps.homeDir,
            agentMode: input.agentMode,
          }),
        )
      },

      buildMemoPatternKey(input: BuildMemoPatternKeyInput): string {
        return buildMemoPatternKey(input)
      },

      forWorkspaceRoot(workspaceRoot: string): ToolRiskPolicyPort {
        const normalizedWorkspaceRoot = normalizePolicyPath(workspaceRoot, deps.homeDir).path
        return remap((policy) => ({
          ...policy,
          workspace: {
            ...policy.workspace,
            sources: {
              ...policy.workspace.sources,
              sandbox: normalizedWorkspaceRoot,
            },
            allowedPaths: policy.workspace.allowedPaths.includes(normalizedWorkspaceRoot)
              ? policy.workspace.allowedPaths
              : [normalizedWorkspaceRoot, ...policy.workspace.allowedPaths],
          },
        }))
      },

      forReadonlyChild(): ToolRiskPolicyPort {
        return remap((policy) => policy)
      },
    }
  }

  return make()
}

export { buildMemoPatternKey } from './build-memo-pattern-key.js'
