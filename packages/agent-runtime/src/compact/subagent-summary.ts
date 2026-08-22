/**
 * 子 Agent summary 微压缩 —— 父 Agent 收到子 Agent 完成时返回的 summary
 * 字符串后，做"保头部 + 保尾部 + 中间省略"的轻量压缩，避免长子任务结果
 * 把父 context 拉爆。
 *
 * 与既有约定 microcompact 完全无关：
 *   - microcompact 改的是父 Agent 自身 message 数组里的
 *     tool_result content，本函数处理的是 fork-query 子 Agent 完成时的
 *     单 string 报告。
 *   - 这是 TabTin 自有功能（`fork-query` 是 TabTin 特定产物），与父对话
 *     历史的"跨 turn byte-identical"约束不冲突——父 Agent 拿到的是子
 *     Agent 一次性 final summary，本身就是 first-time decision。
 *
 * 设计原则：
 *   - **不调 LLM**——保 summary 拿到瞬间就能落到父 tool_result，不引入
 *     额外延迟 / 算力。
 *   - **保最终答案**：子 Agent 报告的结论 / 交付物通常落在尾部（先过程后结论
 *     是自然语言的常见结构），所以尾部预算 (6KB) 显著大于头部 (2KB)。这是
 *     **格式无关**的通用启发式——不依赖任何固定输出模板（子 Agent 回报格式
 *     由主 Agent 的任务指令逐场景决定，见 fork-query.ts BOILERPLATE_ZH）。
 *   - **CJK 放大**：检测中文比例 > 30% 时头尾预算自动 ×1.5。CJK 字符
 *     token 密度是英文的 2x，相同字符数承载语义量减半；不放大就等于
 *     在中文场景下挤掉关键决策段。
 *   - **可禁用**：通过 `EngineConfig.subagentResultCompact = false` 关闭
 *     做 A/B；`agent-tool` 在 host 关闭时直接返回 `{ summary, truncated: false }`。
 *   - **不动 isError 路径**：子 Agent 失败时 summary 通常是错误消息（短），
 *     `agent-tool` 调本函数前已判断；但本函数对 isError summary 也是
 *     幂等安全的——< maxChars 时原样返回。
 */

/**
 * 默认子 Agent summary 微压缩阈值（字符数）。
 *
 * 选择 `10_000` 字符的依据：
 *   - 大多数子 Agent 任务（"分析 X / 调研 Y / 建一张表"）在 prompt 引导下输出
 *     < 3KB 文本（boilerplate 默认"尽量简洁"），10KB 留 3 倍裕度。
 *   - 父 context 容忍度：父 Agent 200K context window 下 10KB 单条 tool_result
 *     占用 < 5%，即使叠加 5-8 个子 Agent 也不至于打爆 context。
 *
 * 阈值之上的 summary 走"保头部 + 保尾部 + 中间省略"模式：
 *   - 头部 `HEAD_CHARS = 2000`：保留开篇（任务范围 / 起手交代）
 *   - 尾部 `TAIL_CHARS = 6000`：保留结论 / 交付物 / 问题（父 Agent 最关心的
 *     "子 Agent 干了什么 / 出了什么"通常在结尾）
 *   - 中间用 `... [N characters truncated by microCompactSubagentSummary] ...`
 *     占位
 *
 * 头尾分配 2:6 偏尾部是**格式无关**的通用启发式：自然语言报告先过程后结论，
 * 关键交付通常落在尾部，开篇少量字符即可覆盖范围交代。不依赖任何固定模板
 * （子 Agent 回报格式由主 Agent 任务指令逐场景决定）。
 */
export const SUBAGENT_SUMMARY_DEFAULT_MAX_CHARS = 10_000;
const SUBAGENT_SUMMARY_HEAD_CHARS = 2_000;
const SUBAGENT_SUMMARY_TAIL_CHARS = 6_000;

export interface SubagentSummaryCompactResult {
  /** 压缩（或原样透传）后的 summary 字符串 */
  summary: string;
  /** 是否真做了截断（false 表示原样返回） */
  truncated: boolean;
  /** 原始字符数 */
  originalLength: number;
  /** 输出字符数（truncated=false 时等于 originalLength） */
  newLength: number;
  /** 实际生效的 maxChars（便于 telemetry / 调试） */
  maxChars: number;
}

export interface MicroCompactSubagentSummaryOptions {
  /** 自定义阈值；缺省走 `SUBAGENT_SUMMARY_DEFAULT_MAX_CHARS`。≤0 / 非有限值视为缺省（防御）。 */
  maxChars?: number;
}

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x3040 && cp <= 0x30ff) || // 日文假名
    (cp >= 0xac00 && cp <= 0xd7af)    // 韩文
  );
}

/**
 * 检测 summary 中文（CJK）比例，超过 30% 自动放大头尾预算 50%（让中文场景
 * 下"Scope/Result/Files changed/Issues"关键决策段不被挤压）。
 *
 * 阈值 30% 与 token-estimation 一致；返回 1.0（无放大）/ 1.5（放大）二档
 * 而非线性放大，避免极端比例下头尾预算超过 maxChars 触发兜底压缩路径。
 */
function getCjkScaleFactor(text: string): number {
  let total = 0;
  let cjk = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total++;
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) {
      cjk++;
    }
  }
  if (total === 0) return 1.0;
  return cjk / total > 0.3 ? 1.5 : 1.0;
}

/**
 * 对子 Agent 完成时返回的 summary 字符串做轻量压缩。
 *
 * 短 summary（≤ maxChars）原样返回；长 summary 走"保头部 + 保尾部 + 中间
 * 省略"模式。
 */
export function microCompactSubagentSummary(
  summary: string,
  options?: MicroCompactSubagentSummaryOptions,
): SubagentSummaryCompactResult {
  const rawMax = options?.maxChars;
  const baseMaxChars =
    typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
      ? Math.floor(rawMax)
      : SUBAGENT_SUMMARY_DEFAULT_MAX_CHARS;

  // CJK 检测决定头尾放大因子（用户未显式覆盖 maxChars 时才放大默认；
  // 显式 maxChars 视为"我知道我在做什么"，不再二次放大干扰）。
  const cjkScale = rawMax === undefined ? getCjkScaleFactor(summary) : 1.0;
  const maxChars = Math.floor(baseMaxChars * cjkScale);

  const originalLength = summary.length;

  if (originalLength <= maxChars) {
    return {
      summary,
      truncated: false,
      originalLength,
      newLength: originalLength,
      maxChars,
    };
  }

  // 极端小阈值兜底：head + tail 分配按比例缩放，至少各保 100 字符。
  // 只有当 maxChars 显著小于默认 8000 头尾总和时才会触发。
  const overhead = '\n\n... [由 microCompactSubagentSummary 省略字符] ...\n\n'.length + 32;
  const usable = Math.max(maxChars - overhead, 200);
  let headBudget = Math.floor(SUBAGENT_SUMMARY_HEAD_CHARS * cjkScale);
  let tailBudget = Math.floor(SUBAGENT_SUMMARY_TAIL_CHARS * cjkScale);
  if (headBudget + tailBudget > usable) {
    const ratio = usable / (headBudget + tailBudget);
    headBudget = Math.max(100, Math.floor(headBudget * ratio));
    tailBudget = Math.max(100, Math.floor(tailBudget * ratio));
  }

  const head = summary.slice(0, headBudget);
  const tail = summary.slice(-tailBudget);
  const omitted = originalLength - head.length - tail.length;

  // 兜底：head + tail 重叠或超过 originalLength（极端小 summary + 极端小 maxChars
  // 组合）—— 直接返回原文避免输出比 summary 还长。
  if (head.length + tail.length >= originalLength) {
    return {
      summary,
      truncated: false,
      originalLength,
      newLength: originalLength,
      maxChars,
    };
  }

  const compacted =
    head +
    `\n\n... [由 microCompactSubagentSummary 省略 ${omitted} 个字符] ...\n\n` +
    tail;

  return {
    summary: compacted,
    truncated: true,
    originalLength,
    newLength: compacted.length,
    maxChars,
  };
}
