/**
 * pattern-key.ts — 授权记忆 pattern_key 规范实现（附录 B）
 *
 * 三段式：`<tool_name>::<subcmd_or_access>:<scope>`
 *
 * scope 枚举：
 *   - `exact:<hex16>` —— 精确模式：本次调用的唯一 fingerprint
 *   - `workspace-internal` —— 模式：工作区内同类
 *   - `workspace-external` —— 模式：工作区外同类
 *   - `*`                 —— 通配（保留字段，本 wave UI 不开放）
 *
 * specificity 排序（数值越小越具体）：
 *   1. exact:<hash>
 *   2. workspace-internal / workspace-external
 *   3. *
 *
 * 冲突解析：
 *   - 找到第一个匹配（按 specificity 从高到低）即返回
 *   - 同级别 specificity 下 deny 胜出（保守）
 *
 * 跨端一致性：`hex16` 在 TS / Python / Swift / Kotlin 必须产出相同结果。
 * canonical_input 规范同样要跨端对齐（模板由 spec 附录 B 定义）。
 */

import { createHash } from 'node:crypto';

import type {
  ApprovalMemoEntry,
  ApprovalMemoLookupResult,
  MemoSpecificity,
  PolicyActionKind,
} from './types-v3.js';

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/**
 * shell 命令规范化时剥离的 wrappers。
 * 与 Python / Swift / Kotlin 镜像同步。
 */
const SAFE_WRAPPERS: ReadonlyArray<string> = [
  'nice',
  'ionice',
  'chrt',
  'taskset',
  'timeout',
  'nohup',
  'stdbuf',
  'unbuffer',
  'time',
  'env',
];

// ─────────────────────────────────────────────────────────────
// hash16
// ─────────────────────────────────────────────────────────────

/**
 * 取 SHA-256 的前 16 个 hex 字符。
 *
 * 跨端等价（必须）：
 *   - TS: `crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)`
 *   - Python: `hashlib.sha256(s.encode('utf-8')).hexdigest()[:16]`
 *   - Swift: `SHA256.hash(data: s.data(using:.utf8)).map{String(format:"%02x",$0)}.joined().prefix(16)`
 *   - Kotlin: `MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString(""){"%02x".format(it)}.take(16)`
 *
 * 同样的 input 字符串在各端必须产出相同 16 字符 hex。
 */
export function hash16(canonicalInput: string): string {
  return createHash('sha256').update(canonicalInput, 'utf8').digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────
// canonicalInput
// ─────────────────────────────────────────────────────────────

/**
 * 把 input 规范化为字符串，便于 hash 出确定性 fingerprint。
 *
 * 按工具类别分派：
 *   - shell：剥 wrappers + 去多余空格
 *   - file：normalize 后的 path（POSIX + NFC，调用方负责 normalize）
 *   - mcp / object / device：JSON.stringify with sorted keys
 *
 * **注意**：本函数不调 path normalize（避免循环依赖 + 让 file 类的 path 由
 * 调用方提前 normalize），mcp/object 输入则按字段排序确保相同语义不同字段顺序
 * 产出相同 fingerprint。
 *
 * @param kind 工具类别
 * @param input 工具入参（unknown，由本函数按 kind 解释）
 * @param opts.path 已 normalize 的 path（file 类必填；其他可选）
 * @param opts.command shell 类的 command 字符串（其他可选）
 */
export function canonicalInput(
  kind: PolicyActionKind,
  input: unknown,
  opts?: { path?: string; command?: string },
): string {
  switch (kind) {
    case 'shell': {
      const cmd = opts?.command ?? extractFieldString(input, 'command') ?? '';
      return canonicalizeShellCommand(cmd);
    }
    case 'file': {
      // file 类：path 由调用方提前 normalize 传入；fallback 才从 input 抽
      const p = opts?.path
        ?? extractFieldString(input, 'path')
        ?? extractFieldString(input, 'file_path')
        ?? '';
      return p.normalize('NFC');
    }
    case 'mcp':
    case 'object':
    case 'object_read':
    case 'object_write':
    case 'device':
    default:
      return stableStringify(input);
  }
}

/**
 * 规范化 shell 命令字符串：
 *   1. trim
 *   2. 多空白合一（含 tab / 多空格）
 *   3. 剥 SAFE_WRAPPERS（递归剥，允许 `nice timeout 5 cmd` 这种串联）
 *   4. NFC 归一
 */
export function canonicalizeShellCommand(command: string): string {
  if (typeof command !== 'string') return '';
  let s = command.trim().replace(/\s+/g, ' ');
  // 递归剥 wrappers
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tokens = s.split(' ');
    if (tokens.length === 0) break;
    const first = tokens[0] ?? '';
    if (!SAFE_WRAPPERS.includes(first)) break;
    // 跳过 wrapper 自身的参数：常见 `timeout 5s cmd ...` —— 简化策略
    // 对于带参数的 wrapper（timeout / nice -n10 / env KEY=v）我们做最小处理：
    //   - timeout：吃后面一个 token（duration）
    //   - nice / ionice：吃 -n N 这种 flag pair
    //   - env：吃所有 KEY=VALUE 形式 token 直到第一个非 KEY=V
    let consumed = 1;
    if (first === 'timeout' && tokens.length >= 2) {
      consumed = 2;
    } else if ((first === 'nice' || first === 'ionice') && tokens[1]?.startsWith('-')) {
      // -n 10 形式吃 2，-n10 形式吃 1
      consumed = tokens[1] === '-n' ? 3 : 2;
    } else if (first === 'env') {
      let i = 1;
      while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++;
      consumed = i;
    } else if (first === 'stdbuf' || first === 'unbuffer') {
      // stdbuf -oL -eL <cmd> / unbuffer -p <cmd>：吃掉所有 leading flags
      let i = 1;
      while (i < tokens.length && tokens[i]?.startsWith('-')) i++;
      consumed = i;
    }
    if (consumed >= tokens.length) {
      // wrapper 后没有命令了，避免空字符串
      s = tokens.slice(consumed).join(' ');
      break;
    }
    s = tokens.slice(consumed).join(' ');
  }
  return s.normalize('NFC');
}

function extractFieldString(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const v = (input as Record<string, unknown>)[field];
  return typeof v === 'string' ? v : undefined;
}

/**
 * 稳定 JSON 序列化：
 *   - object 字段按 key 字典序排序
 *   - array 保持原顺序（因为 array 本身有语义顺序）
 *   - undefined / function / Symbol 被 JSON.stringify 自然忽略
 *
 * 跨端必须等价：
 *   - Python: `json.dumps(obj, sort_keys=True, separators=(',', ':'))`
 *   - Swift: `JSONSerialization.data(withJSONObject:, options:.sortedKeys + .withoutEscapingSlashes)`
 *   - Kotlin: kotlinx.serialization 的 `Json { encodeDefaults = true }` + custom sort
 *
 * 避免与 Python 默认 `json.dumps` 的空格差异，本端也输出**无空格**形式。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = sortKeysDeep(obj[k]);
  }
  return sorted;
}

// ─────────────────────────────────────────────────────────────
// buildApprovalKey
// ─────────────────────────────────────────────────────────────

/**
 * 构造 exact 级别的 pattern_key（最高 specificity）。
 *
 * 用于：审批卡片"这次允许"/"一直允许（精确）"路径。
 *
 * 注意：
 *   - tool_name 不允许含 `:` 或 `::`（本函数不校验，由 tool 注册侧约束）
 *   - subcmd 同理；空字符串会被规范化为 '_'，避免出现 `tool::` 这种空段
 *   - inWorkspace 仅影响 scoped 等级 key 的生成，**不影响** exact key
 *     （exact 已经是命令本身的 fingerprint，与工作区无关）
 */
export function buildApprovalKey(
  toolName: string,
  subcmd: string,
  input: unknown,
  inWorkspace: boolean,
  opts?: {
    /** 工具类别（决定 canonicalInput 走哪条规范化路径） */
    kind?: PolicyActionKind;
    /** scope 等级；默认 'exact'。也可主动传 'scoped' / 'wildcard' */
    scope?: 'exact' | 'scoped' | 'wildcard';
    /** 已 normalize 的 path（file 类专用） */
    normalizedPath?: string;
    /** 已 normalize 的 command（shell 类专用） */
    normalizedCommand?: string;
  },
): string {
  const t = toolName || 'unknown_tool';
  const s = subcmd || '_';
  const scope = opts?.scope ?? 'exact';

  switch (scope) {
    case 'wildcard':
      return `${t}::${s}:*`;
    case 'scoped':
      return `${t}::${s}:${inWorkspace ? 'workspace-internal' : 'workspace-external'}`;
    case 'exact':
    default: {
      const canon = canonicalInput(opts?.kind ?? 'object', input, {
        ...(opts?.normalizedPath !== undefined ? { path: opts.normalizedPath } : {}),
        ...(opts?.normalizedCommand !== undefined ? { command: opts.normalizedCommand } : {}),
      });
      return `${t}::${s}:exact:${hash16(canon)}`;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// lookupMemo
// ─────────────────────────────────────────────────────────────

/**
 * 按 specificity 顺序查找记忆，含冲突解析。
 *
 * 算法：
 *   1. 先查 exact key：命中即返回
 *   2. 再查 scoped key（按 inWorkspace 选 internal / external）：
 *      - 命中即返回，但若同时存在 wildcard 等级的 deny → deny 胜出
 *   3. 再查 wildcard key：命中即返回
 *
 * 同级别 specificity 下 deny > allow（保守）—— 主要体现在 step 2/3 的相互覆盖：
 * 如果 scoped allow + wildcard deny 同时存在，且当前 scope 命中，按"具体优先 allow"返回。
 * 但若同级别（例如两条 wildcard 因为别名实际不会出现，仅 scoped + scoped 跨范围
 * 不会同时命中），保留语义留给将来扩展。
 *
 * 实际场景：
 *   - 用户批"工作区内允许 rm" + 然后"全局禁止 rm" → 在工作区内 rm 仍 allow（具体优先）
 *   - 用户批"全局允许 rm" + "工作区外禁止 rm" → 工作区外 deny（具体优先）
 *
 * 这跟附录 B §B.5 的规则一致：**specificity 高的优先**；同级别 deny 胜出（在两条
 * scoped 因别名同时命中时才会发生，本实现按构造规则不会出现两条同级别 scoped）。
 *
 * @param entries memo 全量 entries（key=完整 pattern_key）
 * @param params  查询参数
 */
export function lookupMemo(
  entries: Readonly<Record<string, ApprovalMemoEntry>>,
  params: {
    toolName: string;
    subcmd: string;
    input: unknown;
    inWorkspace: boolean;
    /** 工具类别（决定 canonical 怎么算） */
    kind?: PolicyActionKind;
    /** 已 normalize 的 path（提高 hash 一致性） */
    normalizedPath?: string;
    /** 已 normalize 的 command */
    normalizedCommand?: string;
  },
): ApprovalMemoLookupResult | null {
  const opts = {
    ...(params.kind !== undefined ? { kind: params.kind } : {}),
    ...(params.normalizedPath !== undefined ? { normalizedPath: params.normalizedPath } : {}),
    ...(params.normalizedCommand !== undefined ? { normalizedCommand: params.normalizedCommand } : {}),
  };
  const exactKey = buildApprovalKey(
    params.toolName,
    params.subcmd,
    params.input,
    params.inWorkspace,
    { ...opts, scope: 'exact' },
  );
  const scopedKey = buildApprovalKey(
    params.toolName,
    params.subcmd,
    params.input,
    params.inWorkspace,
    { ...opts, scope: 'scoped' },
  );
  const wildKey = buildApprovalKey(
    params.toolName,
    params.subcmd,
    params.input,
    params.inWorkspace,
    { ...opts, scope: 'wildcard' },
  );

  // step 1: exact
  const exactEntry = entries[exactKey];
  if (exactEntry) {
    return makeResult(exactEntry, exactKey, 'exact');
  }

  // step 2: scoped
  const scopedEntry = entries[scopedKey];
  if (scopedEntry) {
    return makeResult(scopedEntry, scopedKey, 'scoped');
  }

  // step 3: wildcard
  const wildEntry = entries[wildKey];
  if (wildEntry) {
    return makeResult(wildEntry, wildKey, 'wildcard');
  }

  return null;
}

function makeResult(
  entry: ApprovalMemoEntry,
  key: string,
  specificity: MemoSpecificity,
): ApprovalMemoLookupResult {
  return {
    decision: entry.decision,
    matchedKey: key,
    specificity,
    entry,
  };
}
