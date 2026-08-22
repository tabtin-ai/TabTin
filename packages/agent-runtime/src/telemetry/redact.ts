/**
 * 脱敏工具——所有可能含敏感信息的字段必须经此处理。
 *
 * 遗留项 L12 明确要求：persona / custom_rules / user message content
 * **绝对不能**以明文形式出现在埋点记录中。
 *
 * 本模块提供的衍生字段（均不可逆）：
 *   - `*_hash`    FNV-1a 64-bit hex（16 字符，8 字节），可用于去重 / 同步检测，不能还原内容
 *   - `*_len`     长度（字符数），用于体感趋势
 *   - `has_*`     是否为空的布尔标记
 *   - `*_sample`  前 N 字符（仅对**已经是错误响应 / 系统可见**的内容开放，如 API error body）
 *
 * 为什么用 FNV-1a 而非 SHA-256？
 *   - 减少对 node:crypto 的耦合，保留 Runtime 未来跑在 web worker 的空间
 *   - 埋点指纹只用于"区分 A/B 是否相同"，不作为安全哈希
 *   - FNV-1a 64-bit 的生日悖论碰撞规模约 2^32，区分 persona 变化绰绰有余
 */

/**
 * FNV-1a 64-bit（BigInt 实现）。
 *
 * 为什么不用 node:crypto SHA-256？
 *   - 减少对 node 运行时的耦合，保留 Runtime 未来跑在 web worker 的空间
 *   - 埋点指纹只用于"区分 A/B 是否相同"，不作为安全哈希
 *   - FNV-1a 足够分散（雪崩性 OK），碰撞概率 <1/2^30 即可接受
 */
function fnv1a64(input: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;

  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * 对敏感字符串取不可逆指纹。空/未定义返回 `'empty'`。
 */
export function hashSensitive(input: string | undefined | null): string {
  if (!input) return 'empty';
  return fnv1a64(input);
}

/**
 * Custom rules 衍生字段。调用处：ElectronAgentHost / DaemonAgentHost 创建 runtime 时。
 */
export interface CustomRulesFingerprint {
  has_custom_rules: boolean;
  custom_rules_len: number;
  custom_rules_hash: string;
}

export function redactCustomRules(
  rules: string | undefined | null,
): CustomRulesFingerprint {
  return {
    has_custom_rules: Boolean(rules),
    custom_rules_len: rules?.length ?? 0,
    custom_rules_hash: hashSensitive(rules),
  };
}

/**
 * API error body 衍生字段——允许发送前 N 字符样本，因为错误响应本就可见于用户。
 * 默认 200 字符，呼应 PRD §7.3 要求。
 */
export interface ErrorBodyFingerprint {
  error_body_len: number;
  error_body_sample: string;
  error_body_hash: string;
}

export function redactErrorBody(
  body: string | undefined | null,
  sampleLen = 200,
): ErrorBodyFingerprint {
  const text = body ?? '';
  return {
    error_body_len: text.length,
    error_body_sample: text.slice(0, sampleLen),
    error_body_hash: hashSensitive(text),
  };
}

/**
 * 用户消息内容脱敏——只发长度 / 角色 / hash，**绝对不发内容**。
 * 供 FR-04 `message.truncated` 埋点使用。
 */
export interface MessageFingerprint {
  length: number;
  hash: string;
}

export function redactMessageContent(
  content: string | undefined | null,
): MessageFingerprint {
  return {
    length: content?.length ?? 0,
    hash: hashSensitive(content),
  };
}
