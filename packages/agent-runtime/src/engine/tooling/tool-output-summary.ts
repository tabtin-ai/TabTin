/**
 * 工具输出 LLM 上下文整形：fence-aware 截断解析（splitToolOutputFence）+ 超阈值
 * persist+reference 摘要（summarizeToolOutput）+ FR-07 schema 警告追加。自 query.ts
 * 抽出——与 enforceToolOutputBudget 共用同一套 fence 截断器；
 * splitToolOutputFence 由 tool-orchestration 复用，原 query↔tool-orchestration
 * 循环 import 随之收敛到 tooling 内部。
 */
import type {
  ContentBlock,
} from '../contracts/conversation.js';
import type {
  ToolResult,
} from '../contracts/tools.js';
import { stripKeysFromResult } from './tool-system.js';
import { estimateTextTokens } from '../context/token-budget.js';
import {
  persistResult,
  buildPersistMeta,
  truncateWithFenceAwareness,
} from './tool-orchestration.js';
export { FENCE_OPEN_HEAD_RE, FENCE_TAIL, splitToolOutputFence } from './tool-output-fence.js';

/**
 * Threshold for inline tool output summarization —— **以 token 计**（12k tokens）。
 *
 * Tool calls returning more than this are summarized at *write* time
 * (`summarizeToolOutput`) so the LLM sees a fixed-size, deterministic
 * result. W1 之前还有"自创 micro 改写"在每轮 LLM 调用前做"事后改写历史
 * tool_result"截断，已删除——所以这里是 tool result 的"产生即定型"边界，
 * 跨轮保持 byte-identical。
 *
 * **#3234 (2026-07-06) 单位改造 char → token**：旧实现按**字符数**判定
 * （10_000 → 50_000，W4 提到 50KB）。但真正的成本是 **token**：
 * 1 个 CJK 字 ≈ 1 token，1 个 Latin 字 ≈ 0.25 token —— 同一个字符阈值在
 * 中文内容上实际放进 context 的 token 是 ASCII 的 3–4 倍，导致 CJK 场景
 * 系统性绕过卸载（dogfood：27.5K 字符的中文 tool_result 全部原样进 context）。
 * runtime 其余上下文治理（pressure / protect-window / layered-prune）全是
 * token 口径，只有本闸门是字符，本身也不一致。
 *
 * 改用 CJK-aware `estimateTextTokens` 按真实 token 判定，定在 12_000 tokens：
 * 对 ASCII ≈ 36K 字符（≈旧 50K 阈值量级，不误伤代码 / read_file），对 CJK
 * ≈ 12K 字符（正确抓住中文大结果）。read_file 等 `maxResultSizeChars: Infinity`
 * 的 hard opt-out 契约不变；GPT-4o-mini 8K context 的弱模型场景仍由 per-tool
 * `maxResultSizeChars` + Phase 2 per-round budget (150K) 兜底。
 */
export const SUMMARIZE_TOOL_OUTPUT_TOKEN_THRESHOLD = 12_000;

// ─── Fence-aware truncation (L-29) ──────────────────────────────────
//
// `<tool_output>` fence wrap is the FR-09 prompt-injection guardrail
// (see `tool-output-sanitizer.ts`). When `summarizeToolOutput` truncates
// a fence-wrapped payload, the meta annotation
// `[... N lines, M chars total ...]` must NOT land inside the fence
// body — that's the exact place where untrusted bytes live, and an
// LLM scanning the body could in principle mistake the runtime's
// meta line for tool-emitted content ("did the file say it had 1234
// lines, or did the runtime?"). Pushing the meta outside the close
// tag keeps the runtime's voice clearly separated from external data.
//
// Non-fence inputs keep the legacy mid-content meta placement so the
// 95 % of trusted/readonly tools (`todo`, `present_to_user`,
// …) aren't disturbed. The fence open is matched
// strictly: attribute-bearing form (as produced by
// `wrapInToolOutputFence`) plus a trailing newline, so a body
// containing a `<tool_output …>` *literal* in its first line cannot
// trigger fence-aware mode by accident.
/**
 * Prepare tool output for the LLM context: strip internal keys, then
 * apply persist+reference truncation when content exceeds
 * `SUMMARIZE_TOOL_OUTPUT_TOKEN_THRESHOLD` (12k tokens, CJK-aware, ).
 *
 * **W4 (2026-05-12) — calculator.html dogfood 复盘后改造**：从"中间夹断"
 * 改为 "persist+reference" 模式。事故现场（snapshots.jsonl iteration=1）：
 * 12K 字符的 read_file 输出被夹断到 8K（4000 head + meta + 4000 tail），第
 * 121-192 行（按钮样式核心定义）丢失，LLM 凭训练分布幻觉出 button::after
 * 涟漪 / 金色 .btn-equals / grid-column: span 2 等真实文件不存在的内容，
 * 三连 edit_file 失败。
 *
 * **新行为**（与 `enforceToolOutputBudget` Phase 1/2 同套截断器）：
 *   1. 内容 < 阈值（12K token，CJK-aware，）→ 原样返回，零开销。
 *   2. `ctx.perToolMax === Infinity` → hard opt-out，原样返回（"主动读取类"
 *      工具的契约：LLM 让我读多少我就给多少）。
 *   3. 否则：把完整 content 写盘到 `<sessionDir>/tool-results/<id>.txt`，
 *      给 LLM 一个截断后的内容 + 引用 banner（`Full output saved to: <path> —
 *      use read_file ...`），LLM 看到 banner 就能用 read_file 按需读完整。
 *
 * **fence 处理**：交给 `truncateWithFenceAwareness`——fence 内只切 body、meta
 * 放 fence 外（FR-09 prompt-injection 防护边界），非 fence 走 head+tail+meta
 * 中间形态。新 banner 比旧版（`[... N lines, M chars total ...]`）更丰富，包含
 * 写盘路径和"用 read_file 读"的提示，让 LLM 有可恢复路径。
 *
 * **storage 缺省**（headless / 测试 / 老调用方不传 ctx）：fallback 到
 * `MemoryToolResultStorage`，banner 显示"Full output not persisted in this
 * host"——比旧"中间夹断装作没事"诚实，LLM 知道丢了什么。
 *
 * Full output is still forwarded to the frontend via TOOL events; this
 * helper only shapes the LLM-facing context window.
 *
 * Exported for tests.
 */
export interface SummarizeToolOutputContext {
  /** Tool call id — `<persisted-output>` 文件名按此 sanitize（同 storage.save id）。 */
  toolUseId: string;
  /** Tool name — analytics / 日志归因，不影响 banner 文案。 */
  toolName: string;
  /**
   * Disk-backed storage（来自 `EngineConfig.toolResultStorage`，由 query.ts
   * 主循环用 `resolveToolResultStorage` 解析后透传）。缺省时走
   * MemoryToolResultStorage fallback —— banner 显示"未持久化"，LLM 看 head+tail
   * 兜底。
   */
  storage?: import('../tooling/tool-result-storage.js').ToolResultStorage;
  /**
   * 工具自身声明的 `maxResultSizeChars`。值 = `Infinity` 时本函数 hard opt-out
   * （把完整 content 直接交给 LLM，不持久化、不截断）——
   * 用于 read_file 这种
   * "主动读取契约"工具：LLM 让我读多少我就给多少，runtime 不该越权裁剪。
   */
  perToolMax?: number;
}

/**
 * 触发截断后，head / tail 各保留的 token 预算占阈值的比例（head + tail = 0.8，
 * 即保留 ~9.6k tokens 的开头 + 结尾签名，丢弃中段）。与旧版 0.4/0.4 一致。
 */
export const SUMMARIZE_PREVIEW_RATIO = 0.4;

export function summarizeToolOutput(
  result: ToolResult,
  ctx?: SummarizeToolOutputContext,
): string | ContentBlock[] {
  if (result.llmContextContent !== undefined) return result.llmContextContent;
  const content = stripKeysFromResult(result);
  if (typeof content !== 'string') return content;
  // ：按 CJK-aware token 数判定，而非字符数。cost 在 token，字符阈值会在
  // 中文内容上系统性低估 3–4 倍。
  const contentTokens = estimateTextTokens(content);
  if (contentTokens < SUMMARIZE_TOOL_OUTPUT_TOKEN_THRESHOLD) return content;

  // **Hard opt-out 信号**：read_file 等"主动读取类"工具用
  // `maxResultSizeChars: Infinity` 表达"runtime 不该在 summarize 这一层裁剪"。
  // Phase 1 (`enforceToolOutputBudget`) 已经因 `Number.isFinite(Infinity) === false`
  // 自动跳过；此处补齐 summarize 一层，避免出现"Phase 1 放行了 12K 内容，
  // summarize 又给夹断"的双标。
  //
  // 缺省（`ctx?.perToolMax === undefined`）走默认阈值 —— 表示"调用方没声明工具
  // 限额，按 SUMMARIZE_TOOL_OUTPUT_TOKEN_THRESHOLD 兜底"。
  if (ctx?.perToolMax !== undefined && !Number.isFinite(ctx.perToolMax)) {
    return content;
  }

  // head / tail 的 token 预算换算成字符预算：`truncateWithFenceAwareness` 按
  // 字符切，而阈值是 token。用本条内容自身的 chars-per-token 比率换算，保证
  // 保留的 preview 在 *token* 维度恒定（~9.6k），不受 CJK / Latin 混比影响。
  const previewTokens = Math.floor(
    SUMMARIZE_TOOL_OUTPUT_TOKEN_THRESHOLD * SUMMARIZE_PREVIEW_RATIO,
  );
  const charsPerToken = content.length / Math.max(1, contentTokens);
  const previewChars = Math.max(1, Math.floor(previewTokens * charsPerToken));

  // 复用 tool-orchestration.ts 已有的 helper —— 跟 enforceToolOutputBudget
  // 走同一套截断器，banner 文案 / fence 处理 / sanitize 链路保持一致。
  // ctx 缺省时 storage / toolUseId 走"未持久化" fallback：persistResult(undefined
  // storage) 返 null，buildPersistMeta 渲染"Full output not persisted in this
  // host"——降级但诚实。
  const storage = ctx?.storage;
  const toolUseId = ctx?.toolUseId ?? 'unknown';
  const toolName = ctx?.toolName ?? 'unknown';
  const path = persistResult(toolUseId, toolName, content, storage);
  const meta = buildPersistMeta({
    kind: 'summarize',
    original: content.length,
    limit: SUMMARIZE_TOOL_OUTPUT_TOKEN_THRESHOLD,
    limitUnit: 'token',
    absPath: path,
  });
  return truncateWithFenceAwareness(
    content,
    previewChars,
    previewChars,
    meta,
  );
}

export function appendSchemaWarningToContent(
  content: ToolResult['content'],
  annotation: Record<string, unknown>,
): ToolResult['content'] {
  if (typeof content === 'string') {
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify({
          ...(parsed as Record<string, unknown>),
          _schema_validation_warning: annotation,
        });
      }
    } catch {
      // fall through to text envelope
    }
    return JSON.stringify({
      result: content,
      _schema_validation_warning: annotation,
    });
  }

  return [
    ...content,
    {
      type: 'text',
      text: JSON.stringify({ _schema_validation_warning: annotation }),
    },
  ] as ContentBlock[];
}

/**
 * FR-07 — append `_schema_validation_warning` to a tool result so the
 * model gets the same structured feedback regardless of whether the
 * result came from `runTools` or the pre-start fast path. Mirrors
 * `attachSchemaWarning` in `tool-orchestration.ts` but lives here so
 * the pre-start branch in `query.ts` can stay self-contained instead
 * of importing yet another orchestrator helper. Both implementations
 * agree on JSON merge semantics so the model sees one consistent shape.
 */
export function appendSchemaWarningToResult(
  result: ToolResult,
  summary: string,
  errors: import('../tooling/tool-schema-validator.js').SchemaValidationError[],
): ToolResult {
  const annotation = {
    suggested_fix: summary,
    details: errors.map((e) => ({
      path: e.path || '(root)',
      rule: e.rule,
      message: e.message,
      ...(e.details ?? {}),
    })),
    // Mirror of `attachSchemaWarning` in `tool-orchestration.ts` —
    // a short imperative line so weaker models pivot from "noticing"
    // the warning to "acting on" it next turn. Kept identical across
    // both sites so the pre-start vs main path doesn't show two
    // different recovery hints.
    retry_required: true,
    instruction:
      "Your previous tool input did not match the declared schema. " +
      "The output below was produced anyway (warn mode), but it may be " +
      "incomplete or incorrect. Re-issue the SAME tool with the corrected " +
      "fields on your next turn before relying on the result.",
  };

  return {
    ...result,
    content: appendSchemaWarningToContent(result.content, annotation),
    ...(result.llmContextContent !== undefined
      ? { llmContextContent: appendSchemaWarningToContent(result.llmContextContent, annotation) }
      : {}),
  };
}
