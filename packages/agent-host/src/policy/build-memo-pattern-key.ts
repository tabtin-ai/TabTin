/**
 * wire 缺 pattern_key 时，用 security-policy 同款算法重建 memo 主键
 *（ Stage 3b；自 agent-runtime/approval-key 迁出）。
 */

import {
  buildApprovalKey as buildSecurityPolicyApprovalKey,
  normalize as normalizePolicyPath,
  UNKNOWN_WORKSPACE_OUT_PATH,
  type PolicyActionKind,
} from '@tabtin/security-policy'
import type {
  BuildMemoPatternKeyInput,
  RiskDecisionReason,
} from '@tabtin/agent-runtime/engine'

function extractShellSubcmd(input: unknown): string {
  if (input === null || input === undefined || typeof input !== 'object') return ''
  const inp = input as Record<string, unknown>
  const cmd = (inp.command ?? inp.cmd ?? inp.shell_command) as string | undefined
  if (typeof cmd !== 'string' || cmd.trim().length === 0) return ''
  const tokens = cmd.trim().split(/\s+/)
  return tokens[0] ?? ''
}

function extractPolicyPath(
  extractPolicyParams: BuildMemoPatternKeyInput['extractPolicyParams'],
  input: unknown,
): string | undefined {
  if (typeof extractPolicyParams !== 'function') return undefined
  const p = extractPolicyParams(input)
  const path = (p as Record<string, unknown>).file_path ?? (p as Record<string, unknown>).path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

function extractInputPath(input: unknown): string | undefined {
  if (input === null || input === undefined || typeof input !== 'object') return undefined
  const inp = input as Record<string, unknown>
  const path = inp.file_path ?? inp.path ?? inp.cwd
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

function pathFromDecisionReason(reason: RiskDecisionReason | undefined): string | undefined {
  const raw = typeof reason?.path === 'string' ? reason.path.trim() : ''
  if (!raw || raw === UNKNOWN_WORKSPACE_OUT_PATH) return undefined
  return raw
}

function extractNormalizedPath(input: BuildMemoPatternKeyInput): string | undefined {
  // judge 已按 workspaceRoot 收口；fallback 优先用 decision_reason.path，避免二次提取分叉。
  const rawPath =
    pathFromDecisionReason(input.decisionReason) ??
    extractPolicyPath(input.extractPolicyParams, input.toolInput) ??
    extractInputPath(input.toolInput)
  if (rawPath === undefined) return undefined
  // bugbot 评审  medium：judge.lookupMemo 对 path 会先经 normalize() 再参与
  // canonicalInput 哈希。这里用同一 normalize，保证与 judge 一致。
  const norm = normalizePolicyPath(rawPath).path
  return typeof norm === 'string' && norm.length > 0 ? norm : rawPath
}

function extractNormalizedCommand(input: unknown): string | undefined {
  if (input === null || input === undefined || typeof input !== 'object') return undefined
  const inp = input as Record<string, unknown>
  const cmd = inp.command ?? inp.cmd ?? inp.shell_command ?? inp.shell ?? inp.script
  return typeof cmd === 'string' && cmd.trim().length > 0 ? cmd.trim() : undefined
}

/**
 * 从 judge 透传的 decisionReason 推断 inWorkspace（与 judge step 4 语义对齐）。
 * 缺省返回 undefined，调用方应保守 fallback 到 false。
 */
function inferInWorkspaceFromReason(reason: RiskDecisionReason | undefined): boolean | undefined {
  if (!reason) return undefined
  switch (reason.type) {
    case 'workspace_in':
      return true
    case 'workspace_out':
      return false
    case 'sensitive_in_ask':
      return true
    case 'sensitive_out_deny':
      return false
    default:
      return undefined
  }
}

/**
 * 与 judge.lookupMemo 的 exact key 空间对齐（默认 scope='exact'）。
 * inWorkspace 优先从 decisionReason 推断；无法推断时保守为 false。
 */
export function buildMemoPatternKey(input: BuildMemoPatternKeyInput): string {
  const kind: PolicyActionKind = (input.policyActionKind ?? 'object') as PolicyActionKind
  const subcmd = extractShellSubcmd(input.toolInput)
  const inWorkspace = inferInWorkspaceFromReason(input.decisionReason) ?? false
  const normalizedPath = extractNormalizedPath(input)
  const normalizedCommand = extractNormalizedCommand(input.toolInput)

  return buildSecurityPolicyApprovalKey(input.toolName, subcmd, input.toolInput, inWorkspace, {
    kind,
    ...(normalizedPath !== undefined ? { normalizedPath } : {}),
    ...(normalizedCommand !== undefined ? { normalizedCommand } : {}),
  })
}
