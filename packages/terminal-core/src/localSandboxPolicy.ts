/**
 * LocalSandboxPolicy — 主进程本地安全策略执行器
 *
 * 核心原则：渲染进程不可信，主进程是安全边界。
 * 渲染进程传来的 sandbox_policy 只能使安全策略更严格，不能放松。
 *
 * 主进程维护一个安全底线（security floor）：
 * - 文件删除 / 敏感文件写入始终需要审批
 * - 高风险 shell 命令始终需要审批
 * - 即使渲染进程传来 { approval_required: false }，主进程也会覆盖
 */

import { CommandValidator } from './commandValidator'
import { HARDLINE_COMMAND_DENYLIST } from './denylist'
import { normalizeTerminalExecutionPolicy } from './policy'
import { resolveRelaxedRules } from './allowlist'
import type { TerminalExecutionPolicyPayload } from './types'

const HIGH_RISK_FILE_ACTIONS = ['file_delete']
const SENSITIVE_FILE_ACTIONS = ['file_write', 'file_edit', 'file_delete']

const SENSITIVE_FILE_PATTERNS = [
  /\.(sh|bash|zsh|bat|cmd|ps1)$/i,
  /dockerfile/i,
  /docker-compose\.(yml|yaml)$/i,
  /\.env(\.|$)/i,
  /(^|[/\\])\.ssh[/\\]/,
  /(^|[/\\])\.gnupg[/\\]/,
  /(^|[/\\])\.aws[/\\]/,
]

const localValidator = new CommandValidator()
const AGENT_SPAWN_CATASTROPHIC_RULES = new Set([
  'rm -rf system root',
  'fork bomb',
  'dd to raw device',
  'mkfs format',
  'format disk windows',
  'redirect to raw disk',
])
const OPAQUE_POWERSHELL_COMMAND_RE = [
  /(?:^|[;&|]\s*)(?:cmd(?:\.exe)?\s+\/[ck]\s+)?(?:[A-Za-z]:[^\s;&|]*[\\/])?(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s-(?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?=$|\s)/i,
  /(?:^|[;&|]\s*)(?:invoke-expression|iex)(?=$|\s)/i,
  /(?:^|[;&|]\s*)(?:cmd(?:\.exe)?\s+\/[ck]\s+)?(?:[A-Za-z]:[^\s;&|]*[\\/])?(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s-(?:c|command)\b[^\r\n]*\b(?:invoke-expression|iex)\b/i,
] as const

function normalizeOpaquePowerShellSpelling(command: string): string {
  return command
    .replace(
      /(["'])(?:[A-Za-z]:)?[^"'\r\n]*[\\/](powershell|pwsh)(?:\.exe)?\1/gi,
      '$2.exe',
    )
    .replace(/[`^"'“”‘’]/g, '')
}

const TERMINAL_WRITE_AUTO_APPROVE_RE =
  /^(\x03|\x04|\r?\n|[yYnN]\r?\n?|yes\r?\n?|no\r?\n?|[0-9]\r?\n?)$/

/**
 * Determines if a write_to_terminal payload is safe to auto-approve without user confirmation.
 * Allows: Ctrl+C, Ctrl+D, Enter, y/n, yes/no, single digits.
 */
export function isAutoApprovedTerminalWrite(rawData: string): boolean {
  const unescaped = rawData
    .replace(/\\x03/g, '\x03')
    .replace(/\\x04/g, '\x04')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
  return TERMINAL_WRITE_AUTO_APPROVE_RE.test(unescaped)
}

export interface LocalPolicyDecision {
  blocked: boolean
  approvalRequired: boolean
  /**
   * approvalRequired 来自主进程安全底线（security floor）：relaxed rule 放行的
   * 高危 shell、file_delete、敏感文件写。#5520 审批档旁路时此类仅 full_access
   * 可跳过（auto 仍须确认）；不带此标记的 approvalRequired 是 server policy
   * 的普通 confirm，auto / full_access 均可跳过。
   */
  securityFloor?: boolean
  denyReason?: string
  ruleName?: string
}

/**
 * Agent 一次性 shell 在宿主进程真正 spawn 前的不可绕过底线。
 *
 * 上游 judge 负责“允许 / 询问 / 阻止”的产品判决；这里仅拒绝两类无法通过
 * 审批安全放宽的操作：
 * - 灾难级磁盘 / 系统根破坏；
 * - 无法审计真实载荷的 PowerShell 编码执行或动态求值。
 *
 * 不在这里按 `Remove-Item` / `ri` 等动词一刀切，避免用户批准后仍被拒绝，
 * 也避免在 Unix 环境误伤 Ruby `ri`。
 */
export function evaluateAgentShellSecurityFloor(command: string): LocalPolicyDecision {
  const comparable = normalizeOpaquePowerShellSpelling(command)
  if (OPAQUE_POWERSHELL_COMMAND_RE.some((pattern) => pattern.test(comparable))) {
    return {
      blocked: true,
      approvalRequired: false,
      securityFloor: true,
      denyReason:
        'Opaque PowerShell execution is blocked. Use a visible plain-text command instead.',
      ruleName: 'opaque-powershell-execution',
    }
  }

  for (const rule of HARDLINE_COMMAND_DENYLIST) {
    if (!AGENT_SPAWN_CATASTROPHIC_RULES.has(rule.name)) continue
    if (rule.pattern.test(command) || rule.pattern.test(comparable)) {
      return {
        blocked: true,
        approvalRequired: false,
        securityFloor: true,
        denyReason: rule.reason,
        ruleName: rule.name,
      }
    }
  }

  return { blocked: false, approvalRequired: false }
}

export function evaluateLocalFilePolicy(
  actionType: string,
  filePath?: string,
  serverPolicy?: TerminalExecutionPolicyPayload,
): LocalPolicyDecision {
  const normalizedPolicy = normalizeTerminalExecutionPolicy(serverPolicy)
  if (normalizedPolicy?.route === 'blocked') {
    return { blocked: true, approvalRequired: false, denyReason: normalizedPolicy.denyReason || 'Action blocked by sandbox policy.' }
  }

  if (HIGH_RISK_FILE_ACTIONS.includes(actionType)) {
    return { blocked: false, approvalRequired: true, securityFloor: true }
  }

  if (SENSITIVE_FILE_ACTIONS.includes(actionType) && filePath) {
    const basename = filePath.split(/[/\\]/).pop() || ''
    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      if (pattern.test(basename) || pattern.test(filePath)) {
        return { blocked: false, approvalRequired: true, securityFloor: true }
      }
    }
  }

  if (normalizedPolicy?.approvalRequired) {
    return { blocked: false, approvalRequired: true }
  }

  return { blocked: false, approvalRequired: false }
}

export function evaluateLocalTerminalPolicy(
  command: string,
  serverPolicy?: TerminalExecutionPolicyPayload,
): LocalPolicyDecision {
  const normalizedPolicy = normalizeTerminalExecutionPolicy(serverPolicy)
  if (normalizedPolicy?.route === 'blocked') {
    return { blocked: true, approvalRequired: false, denyReason: normalizedPolicy.denyReason || 'Command blocked by sandbox policy.' }
  }

  const resolved = normalizedPolicy?.relaxedRules?.length
    ? resolveRelaxedRules(normalizedPolicy.relaxedRules)
    : null
  const relaxedRules = resolved?.rules
  const baselineValidation = localValidator.validate(command)
  if (!baselineValidation.allowed && baselineValidation.decision === 'deny') {
    const relaxedValidation = relaxedRules?.length
      ? localValidator.validate(command, undefined, relaxedRules)
      : baselineValidation
    if (relaxedValidation.allowed) {
      return { blocked: false, approvalRequired: true, securityFloor: true }
    }
    return {
      blocked: true,
      approvalRequired: false,
      denyReason: baselineValidation.reason || 'Command is not allowed.',
      ruleName: baselineValidation.ruleName,
    }
  }

  if (normalizedPolicy?.approvalRequired) {
    return { blocked: false, approvalRequired: true }
  }

  return { blocked: false, approvalRequired: false }
}
