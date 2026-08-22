/**
 * 测试用 ToolRiskPolicyPort——包装 @tabtin/security-policy（与宿主适配器同形）。
 * 不可放进 src（会进 baseline）；亦不可引用宿主包（AH-003）。
 */

import {
  judge as judgeV3,
  buildApprovalKey as buildSecurityPolicyApprovalKey,
  normalize as normalizePolicyPath,
  type EffectivePolicy,
  type MemoStore,
  type PolicyActionKind,
} from '@tabtin/security-policy';
import type {
  BuildMemoPatternKeyInput,
  RiskDecision,
  RiskDecisionReason,
  ToolRiskPolicyPort,
} from '../../src/engine/contracts/tool-risk-policy.js';

function extractShellSubcmd(input: unknown): string {
  if (input === null || input === undefined || typeof input !== 'object') return '';
  const inp = input as Record<string, unknown>;
  const cmd = (inp.command ?? inp.cmd ?? inp.shell_command) as string | undefined;
  if (typeof cmd !== 'string' || cmd.trim().length === 0) return '';
  const tokens = cmd.trim().split(/\s+/);
  return tokens[0] ?? '';
}

function extractNormalizedPath(input: BuildMemoPatternKeyInput): string | undefined {
  let rawPath: string | undefined;
  if (typeof input.extractPolicyParams === 'function') {
    const p = input.extractPolicyParams(input.toolInput);
    const path = (p as Record<string, unknown>).file_path ?? (p as Record<string, unknown>).path;
    if (typeof path === 'string' && path.length > 0) rawPath = path;
  }
  if (rawPath === undefined && input.toolInput !== null && typeof input.toolInput === 'object') {
    const inp = input.toolInput as Record<string, unknown>;
    const path = inp.file_path ?? inp.path ?? inp.cwd;
    if (typeof path === 'string' && path.length > 0) rawPath = path;
  }
  if (rawPath === undefined) return undefined;
  const norm = normalizePolicyPath(rawPath).path;
  return typeof norm === 'string' && norm.length > 0 ? norm : rawPath;
}

function extractNormalizedCommand(input: unknown): string | undefined {
  if (input === null || input === undefined || typeof input !== 'object') return undefined;
  const inp = input as Record<string, unknown>;
  const cmd = inp.command ?? inp.cmd ?? inp.shell_command ?? inp.shell ?? inp.script;
  return typeof cmd === 'string' && cmd.trim().length > 0 ? cmd.trim() : undefined;
}

function inferInWorkspaceFromReason(reason: RiskDecisionReason | undefined): boolean | undefined {
  if (!reason) return undefined;
  switch (reason.type) {
    case 'workspace_in':
      return true;
    case 'workspace_out':
      return false;
    case 'sensitive_in_ask':
      return true;
    case 'sensitive_out_deny':
      return false;
    default:
      return undefined;
  }
}

function testBuildMemoPatternKey(input: BuildMemoPatternKeyInput): string {
  const kind: PolicyActionKind = (input.policyActionKind ?? 'object') as PolicyActionKind;
  const subcmd = extractShellSubcmd(input.toolInput);
  const inWorkspace = inferInWorkspaceFromReason(input.decisionReason) ?? false;
  const normalizedPath = extractNormalizedPath(input);
  const normalizedCommand = extractNormalizedCommand(input.toolInput);
  return buildSecurityPolicyApprovalKey(input.toolName, subcmd, input.toolInput, inWorkspace, {
    kind,
    ...(normalizedPath !== undefined ? { normalizedPath } : {}),
    ...(normalizedCommand !== undefined ? { normalizedCommand } : {}),
  });
}

export function createTestToolRiskPolicyPort(deps: {
  buildEffectivePolicy: () => EffectivePolicy | undefined;
  memoStore: MemoStore;
  homeDir?: string;
}): ToolRiskPolicyPort {
  type PolicyMapper = (policy: EffectivePolicy) => EffectivePolicy;
  const make = (
    mapPolicy?: PolicyMapper,
  ): ToolRiskPolicyPort => {
    const resolveEffective = (): EffectivePolicy | undefined => {
      const base = deps.buildEffectivePolicy();
      if (!base) return undefined;
      return mapPolicy ? mapPolicy(base) : base;
    };

    const remap = (next: PolicyMapper): ToolRiskPolicyPort =>
      make((policy) => next(mapPolicy ? mapPolicy(policy) : policy));

    return {
      resolveSnapshot() {
        const policy = resolveEffective();
        if (!policy) return undefined;
        return {
          workspace: {
            allowedPaths: policy.workspace.allowedPaths,
            allowedFiles: policy.workspace.allowedFiles,
            spaceSessionId: policy.workspace.spaceSessionId,
          },
        };
      },
      judge(input): RiskDecision {
        const policy = resolveEffective();
        if (!policy) {
          return {
            behavior: 'deny',
            reason: { type: 'plan_blocked', message: 'policy unavailable' },
          };
        }
        const decision = judgeV3({
          tool: {
            name: input.tool.name,
            policyActionKind: input.tool.policyActionKind as never,
            deviceActionRisk: input.tool.deviceActionRisk,
            isReadOnly: input.tool.isReadOnly,
            riskLevel: input.tool.riskLevel as never,
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
        });
        return {
          behavior: decision.behavior,
          reason: decision.reason as RiskDecision['reason'],
          approvalKey: decision.approvalKey,
          userVisibleReason: decision.userVisibleReason,
          resolutionHints: decision.resolutionHints as RiskDecision['resolutionHints'],
        };
      },
      buildMemoPatternKey: testBuildMemoPatternKey,
      forWorkspaceRoot(workspaceRoot: string) {
        const normalizedWorkspaceRoot = normalizePolicyPath(workspaceRoot, deps.homeDir).path;
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
        }));
      },
      forReadonlyChild() {
        return remap((policy) => policy);
      },
    };
  };

  return make();
}

/** 测试用：与 port.buildMemoPatternKey 同算法，便于断言 expected key。 */
export { testBuildMemoPatternKey as buildTestMemoPatternKey };
