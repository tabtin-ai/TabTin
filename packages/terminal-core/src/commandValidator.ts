import { CRITICAL_DENYLIST, DEFAULT_DENYLIST, HARDLINE_COMMAND_DENYLIST } from './denylist';
import { DEFAULT_ALLOWLIST, matchSensitivePath } from './allowlist';
import type { CommandValidationResult, DenyRule, AllowRule } from './types';
import { t } from './i18n';

// ── Unicode 不可见字符防护 ────────────────────────────────────
// 统一实现位于 unicodeSecurity.ts，此处 re-export 保持 API 兼容
export {
  DANGEROUS_INVISIBLE_CODEPOINTS,
  stripInvisibleUnicode,
  containsInvisibleUnicode,
  normalizeForMatching,
  stripDangerousUnicode,
  containsDangerousUnicode,
  detectDangerousUnicode,
} from './unicodeSecurity';
import { normalizeForMatching } from './unicodeSecurity';

// ── 命令替换检测 ──────────────────────────────────────────────

/**
 * Detects shell command substitution / process substitution syntax that could
 * smuggle arbitrary commands through an allowlisted binary.
 *
 * Matched patterns: $( ), `backticks`, <( ), >( )
 */
const COMMAND_SUBSTITUTION_RE = /\$\s*\(|`[^`]*`|<\s*\(|>\s*\(/;

export function containsCommandSubstitution(command: string): boolean {
  return COMMAND_SUBSTITUTION_RE.test(command);
}

/**
 * TC-1 修复：检测环境变量展开模式 ($VAR, ${VAR}) 和 ANSI-C 引号 ($'...')
 * TC-5 修复：增强对 ANSI-C 引号（$'\xNN', $'\NNN'）和本地化引号（$"..."）的检测
 *
 * 这些模式可以在运行时展开为任意命令，绕过 denylist 的静态正则匹配。
 * 例如：$'\x72\x6d' 在 bash 中等价于 'rm'，但静态正则匹配看到的是原始编码字符串。
 *
 * 排除已由 COMMAND_SUBSTITUTION_RE 覆盖的 $() 模式。
 * 匹配：$VAR, ${VAR}, $'...'（ANSI-C 引号）, $"..."（本地化引号）
 */
const ENV_VAR_EXPANSION_RE = /\$(?!\s*\()(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*|'|")/;

export function containsEnvVarExpansion(command: string): boolean {
  return ENV_VAR_EXPANSION_RE.test(command);
}

/**
 * TC-5 修复：专门检测 ANSI-C 引号和十六进制/八进制编码。
 * 这些编码可以绕过基于明文的 denylist：
 * - $'\x72\x6d' → rm
 * - $'\162\155' → rm（八进制）
 * - $'\u0072\u006d' → rm（Unicode）
 *
 * 此函数作为 containsEnvVarExpansion 的补充，用于更精确的检测日志。
 */
const ANSI_C_QUOTE_RE = /\$'[^']*(?:\\x[0-9a-fA-F]{1,2}|\\[0-7]{1,3}|\\u[0-9a-fA-F]{1,4}|\\U[0-9a-fA-F]{1,8})[^']*'/;

export function containsAnsiCQuoting(command: string): boolean {
  return ANSI_C_QUOTE_RE.test(command);
}

/**
 * TC-2 / F2 修复：将命令字符串按 shell 命令链运算符拆分为子命令。
 * 拆分符：; && || 以及管道 |
 *
 * 引号感知：双引号、单引号内的运算符不会被拆分。
 * 例如 `echo "hello | world"` 中的 `|` 不会被拆分。
 *
 * 对于安全检测，宁可过度拆分（误报）也不要漏拆（漏报）。
 */
export function splitCommandChain(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    // 处理转义字符（仅在双引号内或无引号时）
    if (ch === '\\' && !inSingleQuote && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }

    // 引号状态切换
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      i++;
      continue;
    }

    // 在引号内，不做拆分
    if (inSingleQuote || inDoubleQuote) {
      current += ch;
      i++;
      continue;
    }

    // 检测运算符（按优先级：先匹配多字符运算符）
    // && 运算符
    if (ch === '&' && i + 1 < command.length && command[i + 1] === '&') {
      parts.push(current);
      current = '';
      i += 2;
      continue;
    }

    // || 运算符
    if (ch === '|' && i + 1 < command.length && command[i + 1] === '|') {
      parts.push(current);
      current = '';
      i += 2;
      continue;
    }

    // 单管道 |（不是 || 的一部分，上面已处理 ||）
    if (ch === '|') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }

    // 分号 ;
    if (ch === ';') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }

    // 换行符 \n — shell 将其视为命令分隔符
    if (ch === '\n') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // 添加最后一段
  parts.push(current);

  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * F2 补充修复：从命令名中剥离引号，用于匹配 denylist。
 * 例如 `r"m"` → `rm`、`'r'm` → `rm`、`"rm"` → `rm`
 * 这可以防止通过引号拆词绕过 \b 正则匹配。
 *
 * 采用 token-aware 策略：按空白分词（尊重引号配对），
 * 仅剥离内部无空格的引号段（即命令名拆词用的内联引号），
 * 保留包裹带空格参数的引号（如 "hello world"）。
 */
export function stripQuotesFromCommand(command: string): string {
  // Phase 1: 移除空引号对（cu""rl → curl, r''m → rm）
  let input = command.replace(/""|''/g, '');

  // Phase 2: Token-aware 引号剥离
  const parts: string[] = [];
  let i = 0;

  while (i < input.length) {
    if (input[i] === ' ' || input[i] === '\t') {
      let ws = '';
      while (i < input.length && (input[i] === ' ' || input[i] === '\t')) {
        ws += input[i];
        i++;
      }
      parts.push(ws);
      continue;
    }

    let token = '';
    let hasQuotedSection = false;
    let quotedHasSpaces = false;

    while (i < input.length && input[i] !== ' ' && input[i] !== '\t') {
      const c = input[i];

      if (c === '"' || c === "'") {
        const quote = c;
        let j = i + 1;
        let innerSpaces = false;

        while (j < input.length && input[j] !== quote) {
          if (input[j] === ' ' || input[j] === '\t') innerSpaces = true;
          j++;
        }

        if (j < input.length) {
          hasQuotedSection = true;
          if (innerSpaces) quotedHasSpaces = true;
          token += input.substring(i, j + 1);
          i = j + 1;
        } else {
          token += c;
          i++;
        }
        continue;
      }

      token += c;
      i++;
    }

    const shouldStrip = hasQuotedSection && !quotedHasSpaces;
    parts.push(shouldStrip ? token.replace(/["']/g, '') : token);
  }

  return parts.join('');
}

export class CommandValidator {
  private criticalDenyRules: DenyRule[];
  private denyRules: DenyRule[];
  private allowRules: AllowRule[];
  private requireApproval: boolean;

  constructor(
    denyRules: DenyRule[] = DEFAULT_DENYLIST,
    allowRules: AllowRule[] = DEFAULT_ALLOWLIST,
    options?: { requireApproval?: boolean },
  ) {
    this.criticalDenyRules = [...HARDLINE_COMMAND_DENYLIST, ...CRITICAL_DENYLIST];
    this.denyRules = denyRules;
    this.allowRules = allowRules;
    this.requireApproval = options?.requireApproval ?? false;
  }

  /**
   * Validate a single sub-command (no command chain splitting).
   * Used internally by validate() after chain splitting.
   */
  private validateSingle(
    trimmed: string,
    effectiveDenyRules: DenyRule[],
    effectiveAllowRules: AllowRule[],
  ): CommandValidationResult {
    // F2 补充：对命令做 quote stripping，用于检测引号拆词绕过
    // 例如 r"m" 在 bash 中等价于 rm，但 \brm\b 不会匹配 r"m"
    const stripped = stripQuotesFromCommand(trimmed);

    // Critical deny rules — checked BEFORE allowlist, cannot be bypassed
    // 同时对原始命令和 quote-stripped 版本进行检测
    for (const rule of this.criticalDenyRules) {
      if (rule.pattern.test(trimmed) || rule.pattern.test(stripped)) {
        const reason = rule.reasonKey ? t(rule.reasonKey) : rule.reason;
        return {
          allowed: false,
          decision: 'deny',
          reason: reason ?? t('errors.commandDenied'),
          ruleName: rule.name
        };
      }
    }

    const hasSubstitution = containsCommandSubstitution(trimmed);
    // TC-1: 检测环境变量展开
    const hasEnvExpansion = containsEnvVarExpansion(trimmed);

    // Allowlist — safe bins (bypassed when command substitution or env expansion detected)
    if (!hasSubstitution && !hasEnvExpansion) {
      for (const rule of effectiveAllowRules) {
        if (rule.pattern.test(trimmed)) {
          // W2-F2: allowlist 通过后仍需检查敏感路径
          const sensitiveHit = matchSensitivePath(trimmed);
          if (sensitiveHit) {
            return {
              allowed: false,
              decision: 'deny',
              reason: t('errors.commandDenied'),
              ruleName: 'sensitive-path',
            };
          }
          return { allowed: true, decision: 'allow', ruleName: rule.name };
        }
      }
    }

    // Standard denylist — 同时对原始命令和 quote-stripped 版本进行检测
    for (const rule of effectiveDenyRules) {
      if (rule.pattern.test(trimmed) || rule.pattern.test(stripped)) {
        const reason = rule.reasonKey ? t(rule.reasonKey) : rule.reason;
        return {
          allowed: false,
          decision: 'deny',
          reason: reason ?? t('errors.commandDenied'),
          ruleName: rule.name
        };
      }
    }

    // Command with substitution that wasn't caught by denylist still needs approval
    if (hasSubstitution) {
      return { allowed: false, decision: 'deny', reason: t('errors.commandDenied'), ruleName: 'command-substitution' };
    }

    // TC-1: 环境变量展开需要审批 → 改为拒绝（配合 TC-3 的 ask→deny 策略）
    if (hasEnvExpansion) {
      return { allowed: false, decision: 'deny', reason: t('errors.commandDenied'), ruleName: 'env-var-expansion' };
    }

    // Not in allowlist or denylist
    if (this.requireApproval) {
      return { allowed: false, decision: 'deny', reason: t('errors.commandDenied') };
    }

    return { allowed: true, decision: 'allow' };
  }

  /**
   * Validate a command against allow/deny rules.
   * Evaluation order:
   *   0. (P0-F2) Pre-split: check FULL command against CRITICAL_DENYLIST
   *      — catches pipe patterns (curl|sh) that split would destroy
   *   1. Split command chain (;, &&, ||, |) and validate each sub-command
   *   2. Critical deny rules per sub-command (cannot be bypassed by allowlist)
   *   3. Allowlist (safe bins) — skipped when command contains substitution/env-expansion
   *   4. Standard deny rules
   *   5. Require approval fallback (now denies instead of silent allow)
   */
  validate(
    command: string,
    extraDenyRules?: DenyRule[],
    extraAllowRules?: AllowRule[],
  ): CommandValidationResult {
    const normalized = normalizeForMatching(command);
    const trimmed = normalized.trim();
    if (!trimmed) {
      return {
        allowed: false,
        decision: 'deny',
        reason: t('errors.commandRequired'),
        ruleName: 'empty'
      };
    }

    // P0-F2: pre-split CRITICAL_DENYLIST 检测。
    // pipe-to-shell / hardline curl pipe to shell 等规则依赖完整管道形式（如 curl.*\|.*bash），
    // splitCommandChain 会在 | 处拆分命令，拆分后这些模式永远匹配不到。
    // 必须在拆分前对完整命令做一轮 critical 检测。
    const strippedFull = stripQuotesFromCommand(trimmed);
    for (const rule of this.criticalDenyRules) {
      if (rule.pattern.test(trimmed) || rule.pattern.test(strippedFull)) {
        const reason = rule.reasonKey ? t(rule.reasonKey) : rule.reason;
        return {
          allowed: false,
          decision: 'deny',
          reason: reason ?? t('errors.commandDenied'),
          ruleName: rule.name,
        };
      }
    }

    const effectiveAllowRules = extraAllowRules
      ? [...this.allowRules, ...extraAllowRules]
      : this.allowRules;

    const effectiveDenyRules = extraDenyRules
      ? [...this.denyRules, ...extraDenyRules]
      : this.denyRules;

    // TC-2: 拆分命令链，对每个子命令分别验证
    const subCommands = splitCommandChain(trimmed);

    // 如果命令包含链式运算符（拆分出多个子命令），逐个验证
    // 只要有一个子命令被拒绝，整条命令就被拒绝
    for (const sub of subCommands) {
      const result = this.validateSingle(sub, effectiveDenyRules, effectiveAllowRules);
      if (!result.allowed) {
        return result;
      }
    }

    // 所有子命令都通过了验证
    return { allowed: true, decision: 'allow', ruleName: subCommands.length > 1 ? 'command-chain-all-allowed' : undefined };
  }

  isDenied(command: string): boolean {
    return !this.validate(command).allowed;
  }
}
