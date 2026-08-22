import type { AllowRule } from './types';
import {
  SENSITIVE_PATH_RULES as GENERATED_SENSITIVE_PATH_RULES,
  type SensitivePathRule as GeneratedSensitivePathRule,
} from './sensitive-paths.generated';

/**
 * W2-F2: 敏感路径黑名单 — 即使命令在 allowlist 中，访问这些路径仍应被拒绝。
 * 覆盖 Linux + macOS 常见敏感文件/目录。
 *
 * 每条规则是一个 { label, pattern } 对，label 用于日志/审计。
 *
 * 路径权限治理 W7 / B2 codegen 接入（2026-05-06 真补做，替代 W7 的"注释明示 +
 * 立项 L65"降级方案）：本 SENSITIVE_PATH_RULES 不再手抄，从
 * `./sensitive-paths.generated.ts`（由 `scripts/codegen-hardline.py` 输出）
 * 派生，与 Python `apps/tabtin_django/apps/services/common/path_safety.py:SENSITIVE_PATH_RULES`
 * 同源（SSoT = `packages/security-policy/src/hardline-v3-rules.json:path_scan_rules`）。
 *
 * 修改流程：改 `hardline-v3-rules.json` 的 `path_scan_rules` 字段 → 跑
 * `python scripts/codegen-hardline.py` → 两端产物自动同步。
 */
export type SensitivePathRule = GeneratedSensitivePathRule;

export const SENSITIVE_PATH_RULES: SensitivePathRule[] = GENERATED_SENSITIVE_PATH_RULES;

/**
 * 规范化命令中的路径片段，消除等价路径绕过：
 *  - 连续斜杠 `//` → `/`
 *  - `/./` 自引用 → `/`
 *  - 尾部 `/.` → `/`
 *  - `/../` 父目录遍历 → 解析为上一级（如 `/etc/security/../shadow` → `/etc/shadow`）
 */
function normalizePathsInCommand(command: string): string {
  let result = command
    .replace(/\/{2,}/g, '/')
    .replace(/\/\.\//g, '/')
    .replace(/\/\.(?=\s|$)/g, '/');

  // 迭代解析 /segment/../ → /，直到不再有变化
  // 例：/etc/security/../shadow → /etc/shadow
  //     /home/user/../../etc/shadow → 第一轮 /home/../etc/shadow → 第二轮 /etc/shadow
  let prev: string;
  do {
    prev = result;
    result = result.replace(
      /\/[^/\s]+\/\.\.(\/|(?=[\s]|$))/g,
      (_, trailing) => trailing || '',
    );
  } while (result !== prev);

  return result;
}

/**
 * 检查命令字符串是否包含敏感路径。
 * 会先对路径做规范化，防止 `/etc/./shadow`、`/etc//shadow` 等等价形式绕过。
 * @returns 匹配到的敏感路径 label，或 null 表示安全。
 */
export function matchSensitivePath(command: string): string | null {
  const normalized = normalizePathsInCommand(command);
  for (const rule of SENSITIVE_PATH_RULES) {
    if (rule.pattern.test(command) || rule.pattern.test(normalized)) {
      return rule.label;
    }
  }
  return null;
}

/**
 * Named allow-rule sets that can be activated by server-side policy.
 * Keys match the `relaxed_rules` identifiers sent from Django.
 */
export const RELAXABLE_ALLOW_RULES: Record<string, AllowRule[]> = {
  'curl-mutating': [
    { name: 'curl-mutating-allowed', pattern: /^\s*curl\b/ },
  ],
  'wget-write': [
    { name: 'wget-write-allowed', pattern: /^\s*wget\b/ },
  ],
  'python-inline': [
    { name: 'python-inline-allowed', pattern: /^\s*python3?\s+-c\b/ },
  ],
  'node-inline': [
    { name: 'node-inline-allowed', pattern: /^\s*node\s+(-e|--eval)\b/ },
  ],
  'python-script': [
    { name: 'python-script-allowed', pattern: /^\s*python3?\b/ },
  ],
  'node-script': [
    { name: 'node-script-allowed', pattern: /^\s*node\b/ },
  ],
  // 网络工具放宽规则 — 服务端可通过 relaxedRules 按需开放
  'curl-basic': [
    { name: 'curl-basic-allowed', pattern: /^\s*curl\b/ },
  ],
  'wget-basic': [
    { name: 'wget-basic-allowed', pattern: /^\s*wget\b/ },
  ],
  'scp': [
    { name: 'scp-allowed', pattern: /^\s*scp\b/ },
  ],
  'rsync': [
    { name: 'rsync-allowed', pattern: /^\s*rsync\b/ },
  ],
  'ftp-sftp': [
    { name: 'ftp-sftp-allowed', pattern: /^\s*(ftp|sftp)\b/ },
  ],
};

export interface ResolvedRelaxedRules {
  rules: AllowRule[];
  /** Rule names that were requested but not recognized (TDS-006: enables upstream reporting) */
  unknowns: string[];
}

/**
 * Resolve named rule sets into AllowRule arrays.
 * Returns both resolved rules and any unrecognized names so callers can
 * propagate unknowns to audit logs / user-facing warnings (TDS-006).
 */
export function resolveRelaxedRules(names: string[]): ResolvedRelaxedRules {
  const rules: AllowRule[] = [];
  const unknowns: string[] = [];
  for (const name of names) {
    const set = RELAXABLE_ALLOW_RULES[name];
    if (set) {
      rules.push(...set);
    } else {
      unknowns.push(name);
    }
  }
  if (unknowns.length > 0) {
    const known = Object.keys(RELAXABLE_ALLOW_RULES).join(', ');
    console.warn(
      `[terminal-core] resolveRelaxedRules: unknown rule name(s): ${unknowns.join(', ')}. ` +
      `Known rules: ${known}. These rules were ignored.`,
    );
  }
  return { rules, unknowns };
}

/**
 * Safe bins — commands that always bypass the denylist.
 * These are trusted platform commands executed by the Agent.
 */
export const DEFAULT_ALLOWLIST: AllowRule[] = [
  {
    name: 'tabtin',
    pattern: /^\s*tabtin\b/,
  },
  {
    name: 'echo',
    pattern: /^\s*echo\b/,
  },
  {
    name: 'cat',
    pattern: /^\s*cat\b/,
  },
  {
    name: 'head',
    pattern: /^\s*head\b/,
  },
  {
    name: 'tail',
    pattern: /^\s*tail\b/,
  },
  {
    name: 'grep',
    pattern: /^\s*grep\b/,
  },
  {
    name: 'wc',
    pattern: /^\s*wc\b/,
  },
  {
    name: 'sort',
    pattern: /^\s*sort\b/,
  },
  {
    name: 'uniq',
    pattern: /^\s*uniq\b/,
  },
  {
    name: 'jq',
    pattern: /^\s*jq\b/,
  },
  {
    name: 'ls',
    pattern: /^\s*ls\b/,
  },
  {
    name: 'pwd',
    pattern: /^\s*pwd\b/,
  },
  {
    name: 'which',
    pattern: /^\s*which\b/,
  },
  {
    name: 'date',
    pattern: /^\s*date\b/,
  },
];
