import type {
  PolicyOverrides,
  SandboxLevel,
  TerminalExecutionPolicy,
  TerminalExecutionPolicyPayload,
  TerminalNetworkMode,
  TerminalRoute,
} from './types';

export type DegradationReason = 'sandbox_not_supported_in_pty' | 'network_restriction_not_supported';

export interface DegradationDecision {
  canDegrade: boolean;
  reason: DegradationReason;
  sandboxConfig: {
    route: TerminalRoute;
    sandboxLevel: SandboxLevel;
    networkMode?: TerminalNetworkMode;
    denyReadPaths?: string[];
    denyWritePaths?: string[];
    relaxedRules?: string[];
  };
}

const POLICY_ROUTES = new Set<TerminalRoute>(['regular', 'sandbox', 'blocked']);
const SANDBOX_LEVELS = new Set<SandboxLevel>(['filesystem', 'complete']);
const NETWORK_MODES = new Set<TerminalNetworkMode>(['allowed', 'blocked', 'custom']);

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeRoute(value: unknown): TerminalRoute | undefined {
  const normalized = normalizeString(value);
  if (!normalized || !POLICY_ROUTES.has(normalized as TerminalRoute)) return undefined;
  return normalized as TerminalRoute;
}

function normalizeSandboxLevel(value: unknown): SandboxLevel | undefined {
  const normalized = normalizeString(value);
  if (!normalized || !SANDBOX_LEVELS.has(normalized as SandboxLevel)) return undefined;
  return normalized as SandboxLevel;
}

function normalizeNetworkMode(value: unknown): TerminalNetworkMode | undefined {
  const normalized = normalizeString(value);
  if (!normalized || !NETWORK_MODES.has(normalized as TerminalNetworkMode)) return undefined;
  return normalized as TerminalNetworkMode;
}

function normalizeRelaxedRules(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules = value
    .map((item) => normalizeString(item))
    .filter((item): item is string => Boolean(item));
  return rules.length > 0 ? rules : undefined;
}

export function normalizeTerminalExecutionPolicy(
  policy?: TerminalExecutionPolicy | TerminalExecutionPolicyPayload | null,
): TerminalExecutionPolicy | undefined {
  if (!policy || typeof policy !== 'object') return undefined;

  const normalized: TerminalExecutionPolicy = {
    route: normalizeRoute(
      'route' in policy ? policy.route : undefined,
    ),
    sandboxLevel: normalizeSandboxLevel(
      'sandboxLevel' in policy ? policy.sandboxLevel : (policy as TerminalExecutionPolicyPayload).sandbox_level,
    ),
    networkMode: normalizeNetworkMode(
      'networkMode' in policy ? policy.networkMode : (policy as TerminalExecutionPolicyPayload).network_mode,
    ),
    approvalRequired:
      typeof ('approvalRequired' in policy ? policy.approvalRequired : (policy as TerminalExecutionPolicyPayload).approval_required) === 'boolean'
        ? Boolean('approvalRequired' in policy ? policy.approvalRequired : (policy as TerminalExecutionPolicyPayload).approval_required)
        : undefined,
    denyReason: normalizeString(
      'denyReason' in policy ? policy.denyReason : (policy as TerminalExecutionPolicyPayload).deny_reason,
    ),
    relaxedRules: normalizeRelaxedRules(
      'relaxedRules' in policy ? policy.relaxedRules : (policy as TerminalExecutionPolicyPayload).relaxed_rules,
    ),
  };

  if (
    normalized.route === undefined &&
    normalized.sandboxLevel === undefined &&
    normalized.networkMode === undefined &&
    normalized.approvalRequired === undefined &&
    normalized.denyReason === undefined &&
    normalized.relaxedRules === undefined
  ) {
    return undefined;
  }

  return normalized;
}

export function toPolicyOverrides(
  policy?: TerminalExecutionPolicy | TerminalExecutionPolicyPayload | null,
): PolicyOverrides | undefined {
  const normalized = normalizeTerminalExecutionPolicy(policy);
  return normalized ? { ...normalized } : undefined;
}

export function getInteractiveTerminalPolicySupportError(
  policy?: TerminalExecutionPolicy | TerminalExecutionPolicyPayload | null,
): string | null {
  const normalized = normalizeTerminalExecutionPolicy(policy);
  if (!normalized) return null;

  if (normalized.route === 'blocked') {
    return normalized.denyReason || 'Command blocked by sandbox policy.';
  }

  if (normalized.route === 'sandbox') {
    return 'Current PTY runtime does not support sandboxed terminal execution yet.';
  }

  if (normalized.networkMode === 'blocked' || normalized.networkMode === 'custom') {
    return 'Current PTY runtime cannot enforce network-restricted terminal policy yet.';
  }

  return null;
}

/**
 * 评估不受 PTY 支持的策略是否可以降级到 CommandExecutor（spawn + OS sandbox）执行。
 * 调用时机：`getInteractiveTerminalPolicySupportError` 返回非 null 错误之后。
 *
 * - route=sandbox → 可降级，reason=sandbox_not_supported_in_pty
 * - networkMode=blocked/custom（route 非 sandbox/blocked）→ 可降级，reason=network_restriction_not_supported
 * - route=blocked → 返回 null（不可降级，命令被彻底禁止）
 * - 无策略 / 无错误 → 返回 null
 */
export function evaluateTerminalPolicyDegradation(
  policy?: TerminalExecutionPolicy | TerminalExecutionPolicyPayload | null,
): DegradationDecision | null {
  const normalized = normalizeTerminalExecutionPolicy(policy);
  if (!normalized) return null;

  if (normalized.route === 'blocked') return null;

  const buildConfig = (reason: DegradationReason): DegradationDecision => ({
    canDegrade: true,
    reason,
    sandboxConfig: {
      route: normalized.route ?? 'sandbox',
      sandboxLevel: normalized.sandboxLevel ?? 'filesystem',
      networkMode: normalized.networkMode,
      relaxedRules: normalized.relaxedRules,
    },
  });

  if (normalized.route === 'sandbox') {
    return buildConfig('sandbox_not_supported_in_pty');
  }

  if (normalized.networkMode === 'blocked' || normalized.networkMode === 'custom') {
    return buildConfig('network_restriction_not_supported');
  }

  return null;
}
