/**
 * Context pruning utilities — token estimation, soft trim, hard trim.
 *
 * Token estimation strategy (three-tier, based on persist+reference pattern + Django hybrid):
 *   1. Usage anchor: if the last LLM response provided an actual input_tokens
 *      count, use that as a precise base and only rough-estimate messages
 *      appended after the anchor.
 *   2. Calibrated rough: CJK-aware chars-per-token estimation (≈1.3 for CJK,
 *      ≈4.0 for Latin), padded by 4/3, adjusted by an EMA calibration factor
 *      fed from real usage data.
 *   3. Full context estimate: messages + system prompt + tool schemas.
 *
 * Image token estimation is model-family aware:
 *   - OpenAI: tile-based (85 + tiles×170)
 *   - Anthropic: pixel-based (width×height / 750)
 *   - Google: fixed 258 per image
 */

import type {
  Message,
  ContentBlock,
  DocumentBlock,
  ImageBlock,
  SystemBlock,
  ToolParam,
} from '../contracts/conversation.js';

// ─── Model Family ────────────────────────────────────────────────────

export type ModelFamily = 'openai' | 'anthropic' | 'google' | 'unknown';

export function detectModelFamily(model: string): ModelFamily {
  if (/claude|anthropic/i.test(model)) return 'anthropic';
  if (/gemini|google/i.test(model)) return 'google';
  if (/gpt|o1-|o3-|o4-|chatgpt/i.test(model)) return 'openai';
  return 'unknown';
}

// ─── Helpers ─────────────────────────────────────────────────────────

const CJK_RANGES = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/u;

function detectCjkRatio(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    if (CJK_RANGES.test(ch)) cjk++;
  }
  const total = [...text].length;
  return total > 0 ? cjk / total : 0;
}

function estimateCharsPerToken(text: string): number {
  const r = detectCjkRatio(text);
  return r * 1.3 + (1 - r) * 4.0;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

// ─── Model-specific image token estimation ───────────────────────────

function estimateImageTokensOpenAI(block: ImageBlock): number {
  const { width, height, detail } = block;
  if (detail === 'low') return 85;
  if (width && height) {
    const scale = Math.min(2048 / Math.max(width, height), 1);
    let w = Math.max(1, Math.round(width * scale));
    let h = Math.max(1, Math.round(height * scale));
    const scale2 = Math.min(768 / Math.min(w, h), 1);
    w = Math.max(1, Math.round(w * scale2));
    h = Math.max(1, Math.round(h * scale2));
    const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
    return 85 + tiles * 170;
  }
  return 765;
}

function estimateImageTokensClaude(block: ImageBlock): number {
  const { width, height } = block;
  if (!width || !height) return 1600;
  const maxDim = 1568;
  let w = width;
  let h = height;
  if (w > maxDim || h > maxDim) {
    const scale = Math.min(maxDim / w, maxDim / h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  const maxPixels = 1_150_000;
  if (w * h > maxPixels) {
    const pixelScale = Math.sqrt(maxPixels / (w * h));
    w = Math.max(1, Math.round(w * pixelScale));
    h = Math.max(1, Math.round(h * pixelScale));
  }
  return Math.max(100, Math.ceil((w * h) / 750));
}

function estimateImageTokensGemini(): number {
  return 258;
}

function estimateImageTokens(block: ImageBlock, family: ModelFamily = 'unknown'): number {
  switch (family) {
    case 'anthropic': return estimateImageTokensClaude(block);
    case 'google': return estimateImageTokensGemini();
    case 'openai':
    case 'unknown':
    default:
      return estimateImageTokensOpenAI(block);
  }
}

/**
 * 视频画面粗估预算（ MVP）。
 * 取 OpenAI high-detail 单图量级上限附近的保守常数；未按时长校准，后续可换。
 * 见 OpenAI vision token 估算（约 765–1105 / 张 high detail）与多帧量级放大。
 */
const VIDEO_FRAME_TOKEN_BUDGET = 2000;

/** 视频 token 粗估：URL 字符开销 + {@link VIDEO_FRAME_TOKEN_BUDGET}。 */
function estimateVideoTokens(block: { source: { type: 'url'; url: string } }): number {
  const url = block.source.url;
  return VIDEO_FRAME_TOKEN_BUDGET + Math.ceil(url.length / estimateCharsPerToken(url));
}

/**
 * 文档原生直传粗估。未按页数/体积校准；取偏保守常数，避免压预算时漏计。
 */
const DOCUMENT_TOKEN_BUDGET = 4000;

function estimateDocumentTokens(block: DocumentBlock): number {
  const urlOrMeta =
    block.source.type === 'url'
      ? block.source.url
      : `${block.source.media_type}:${block.source.data.length}`;
  const title = block.title ?? '';
  const str = `${urlOrMeta}\0${title}`;
  return DOCUMENT_TOKEN_BUDGET + Math.ceil(str.length / estimateCharsPerToken(str));
}

function estimateBlockTokens(block: ContentBlock, family?: ModelFamily): number {
  if (block.type === 'text') return Math.ceil(block.text.length / estimateCharsPerToken(block.text));
  if (block.type === 'thinking') return Math.ceil(block.thinking.length / estimateCharsPerToken(block.thinking));
  if (block.type === 'image') return estimateImageTokens(block, family);
  if (block.type === 'video') return estimateVideoTokens(block);
  if (block.type === 'document') return estimateDocumentTokens(block);
  if (block.type === 'file') {
    // ：file 不进 LLM part；粗估元数据体积即可
    const str = [block.file_id, block.filename, block.url, block.preview_url]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join('\0');
    return Math.max(1, Math.ceil(str.length / estimateCharsPerToken(str || 'f')));
  }
  if (block.type === 'tool_use') {
    const str = block.name + safeStringify(block.input);
    return Math.ceil(str.length / estimateCharsPerToken(str));
  }
  if (block.type === 'tool_result') {
    return estimateContentTokens(block.content, family);
  }
  return 0;
}

function estimateContentTokens(content: string | ContentBlock[], family?: ModelFamily): number {
  if (typeof content === 'string') return Math.ceil(content.length / estimateCharsPerToken(content));
  return content.reduce((sum, b) => sum + estimateBlockTokens(b, family), 0);
}

function rawTokensForMessage(msg: Message, family?: ModelFamily): number {
  let tokens = 4; // per-message overhead (role, separators)
  if (typeof msg.content === 'string') {
    tokens += Math.ceil(msg.content.length / estimateCharsPerToken(msg.content));
  } else {
    for (const block of msg.content) {
      tokens += estimateBlockTokens(block, family);
    }
  }
  return tokens;
}

// ─── Calibration ─────────────────────────────────────────────────────

function getFactor(estimator?: TokenEstimator): number {
  return estimator?.getCalibrationFactor() ?? 1.0;
}

// ─── Session-level Token Estimator ───────────────────────────────────

/**
 * Session-scoped token estimator with its own calibration factor and model family.
 * Use this for accurate per-session pressure calculation without
 * cross-session pollution from module-level globals.
 */
export class TokenEstimator {
  private factor = 1.0;
  private _modelFamily: ModelFamily = 'unknown';

  setModel(model: string): void {
    this._modelFamily = detectModelFamily(model);
  }

  get modelFamily(): ModelFamily {
    return this._modelFamily;
  }

  calibrate(estimatedTokens: number, actualTokens: number): void {
    if (estimatedTokens > 0 && actualTokens > 0) {
      const ratio = actualTokens / estimatedTokens;
      this.factor = this.factor * 0.8 + ratio * 0.2;
    }
  }

  getCalibrationFactor(): number {
    return this.factor;
  }

  estimateMessages(messages: Message[]): number {
    const raw = messages.reduce((sum, msg) => sum + rawTokensForMessage(msg, this._modelFamily), 0);
    return Math.ceil(raw * (4 / 3) * this.factor);
  }

  estimateWithAnchor(messages: Message[], anchor: UsageAnchor | undefined): number {
    if (!anchor || anchor.messageCount <= 0 || anchor.messageCount > messages.length) {
      return this.estimateMessages(messages);
    }
    const newMessages = messages.slice(anchor.messageCount);
    if (newMessages.length === 0) return anchorInputSide(anchor);
    const incrementalRaw = newMessages.reduce((sum, msg) => sum + rawTokensForMessage(msg, this._modelFamily), 0);
    return anchorInputSide(anchor) + Math.ceil(incrementalRaw * (4 / 3) * this.factor);
  }

  estimateFull(
    messages: Message[],
    system?: string | SystemBlock[],
    tools?: ToolParam[],
    anchor?: UsageAnchor,
  ): number {
    // W4.2 Bug 1 修复（与 module-level estimateFullContextTokens 对齐）：
    //
    // `anchor.inputTokens` 是 LLM provider 在上一次请求里实报的 input token 数,
    // 它**已经包含 system + tools + messages 全部贡献**——这是 LLM 计费基准。
    // 因此 anchor 路径下若再叠加 estimateSystemTokens / estimateToolSchemaTokens,
    // 就会对 system + tools 双算（dogfood 实测可虚高 8 倍）。
    //
    // 仅 anchor 真实有效（messageCount 在合法区间）时走 anchor 分支；anchor 失效
    // (messageCount 越界等) estimateWithAnchor 会自动回落"仅 messages"估算 →
    // 此时仍需要叠加 system + tools 否则会低估 → 进 fallback 分支。
    const anchorValid = anchor != null
      && anchor.messageCount > 0
      && anchor.messageCount <= messages.length;
    if (anchorValid) {
      return this.estimateWithAnchor(messages, anchor);
    }
    return this.estimateMessages(messages)
      + estimateSystemTokens(system, this)
      + estimateToolSchemaTokens(tools, this);
  }
}

// ─── Usage Anchor ────────────────────────────────────────────────────

/**
 * Anchor 自最近一次 LLM provider 真实 usage 响应，用于：
 *
 *   1. 上下文压缩 / pruning 估算（`estimateTokensWithAnchor`）—— 已有用法。
 *   2. **UI 端 "当前上下文用量环"**（messages-as-truth，供 UI 上下文用量环使用：
 *      `getCurrentUsage`/`tokenCountWithEstimation`）：runtime 把 anchor 字段
 *      透传到 DONE/assistant final 的 `usage` payload（`last_input_tokens` 等
 *      `last_*` 字段），renderer 端从 `ChatMessage.metadata` 读出后即可在
 *      `TokenUsageRing` 上显示「当前送进 LLM 的真实上下文规模」（而非 turn
 *      累加值——后者会随 tool_use 多轮调用线性虚高 2-3 倍）。
 *
 * `inputTokens` 是 LLM provider 上报的单次完整请求 input token 数（已包含
 * system + tools + messages 全部贡献），不需要再叠加任何 schema overhead。
 *
 * `cacheReadTokens` / `cacheCreationTokens` 是同一次响应的 cache 命中 / 写入分项；
 * 三者之和 = 上下文用量环（context ring）占用的分子
 * （即 input + cache_creation + cache_read，不含 output）。
 */
export interface UsageAnchor {
  inputTokens: number;
  /** 同一次 LLM 响应的 cache 命中 input tokens；provider 不返回时为 undefined。 */
  cacheReadTokens?: number;
  /** 同一次 LLM 响应的 cache 写入 input tokens；provider 不返回时为 undefined。 */
  cacheCreationTokens?: number;
  messageCount: number;
  timestamp: number;
}

/**
 * anchor 的「输入侧」token 总数 = inputTokens + cacheRead + cacheCreation。
 *
 * cache 命中 / 写入的那部分内容**同样占用上下文窗口**（只是计费便宜），所以上下文
 * 压力 / 压缩判定必须把它们算进去。anchor 各字段已由 proxy-provider 归一化成
 * 「inputTokens 不含 cache、cache 独立」的统一语义（OpenAI 的 prompt_tokens 已剥离
 * cache），因此这里直接求和即得完整上下文规模，不会双算，也不会漏算。
 * 计算上下文用量百分比 的分子公式（不含 output）。
 */
export function anchorInputSide(anchor: UsageAnchor): number {
  return anchor.inputTokens + (anchor.cacheReadTokens ?? 0) + (anchor.cacheCreationTokens ?? 0);
}

/**
 * 裁剪后锚的「上界钳制」（ 幻影压力修复核心）。
 *
 * 消息被 trim / 压缩 / 占位改写后，`anchor.messageCount` 与当前 messages 坐标系
 * 不再对齐，「前缀 + 增量」精确估算失效——但 `anchorInputSide`（provider 实报的
 * 上一次整请求 token 数，含 system + tools + messages 全部贡献）仍然是当前上下文
 * 的**有效上界**：裁剪只减不增。此时纯字符估算（CJK 悲观系数 + padding + 校准
 * factor）可能虚高 3-4×（live 取证：实报 30k 被估成 115k），若直接采信会把编排器
 * 逼进 emergency 死循环。取 `min(纯估算, 实报上界)` 消灭幻影压力。
 *
 * 仅当锚曾真实建立（messageCount > 0）且坐标系失效（messageCount > messages.length，
 * 即发生过裁剪）时钳制；锚有效时走精确「前缀 + 增量」路径不经此函数。
 *
 * **已知 tradeoff（上界并非绝对严格）**：`messageCount > messages.length` 只保证
 * 净条数变少，不保证净 token 变少——若锚快照后先追加了大 tool_result、又裁掉
 * 若干旧消息（净条数降但总量可能反升），钳制会**低估**当前上下文，可能漏掉一次
 * 本该做的压缩。此时优雅降级为「让真 413 由 context-overflow-recovery 兜」——
 * 用「偶发漏压缩 + 恢复兜底」换掉「每轮幻影虚高触发 emergency 死循环」，是刻意
 * 取舍：幻影虚高是常态高频、真溢出漏判是罕见低频。
 */
function clampEstimateByStaleAnchor(
  rawEstimate: number,
  messages: Message[],
  anchor: UsageAnchor | undefined,
): number {
  if (!anchor || anchor.messageCount <= 0) return rawEstimate;
  if (anchor.messageCount <= messages.length) return rawEstimate;
  return Math.min(rawEstimate, anchorInputSide(anchor));
}

/**
 * Estimate tokens using an anchor from the last LLM usage response.
 * Only rough-estimates messages appended after the anchor point.
 */
export function estimateTokensWithAnchor(
  messages: Message[],
  anchor: UsageAnchor | undefined,
  estimator?: TokenEstimator,
): number {
  if (!anchor || anchor.messageCount <= 0 || anchor.messageCount > messages.length) {
    return estimateTokens(messages, estimator);
  }

  const newMessages = messages.slice(anchor.messageCount);
  if (newMessages.length === 0) return anchorInputSide(anchor);

  const family = estimator?.modelFamily;
  const incrementalRaw = newMessages.reduce((sum, msg) => sum + rawTokensForMessage(msg, family), 0);
  const incrementalEstimate = Math.ceil(incrementalRaw * (4 / 3) * getFactor(estimator));
  return anchorInputSide(anchor) + incrementalEstimate;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * 估算单段文本的 token 数（CJK-aware，含 4/3 padding，与 estimateTokens 主体口径
 * 一致）。不含 calibration factor 与 per-message overhead（每条消息 role/分隔符
 * 约 +4 token）—— 因此对多条消息逐段累加时，总和会系统性略低于
 * TokenEstimator.estimateMessages。仅供只有裸字符串、且只需阈值粗判的调用方使用
 * （如 proxy-provider 的 cache 断点门控；偏保守延迟命中也不误占断点）。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil((text.length / estimateCharsPerToken(text)) * (4 / 3));
}

/**
 * Estimate token count for a message list.
 * CJK-aware: ≈1.3 chars/token for CJK, ≈4.0 for Latin, padded by 4/3,
 * then adjusted by calibration factor.
 */
export function estimateTokens(messages: Message[], estimator?: TokenEstimator): number {
  const family = estimator?.modelFamily;
  const raw = messages.reduce((sum, msg) => sum + rawTokensForMessage(msg, family), 0);
  return Math.ceil(raw * (4 / 3) * getFactor(estimator));
}

/**
 * Estimate system prompt token overhead.
 * Applies the same 4/3 padding + calibration factor as message estimation.
 */
export function estimateSystemTokens(system: string | SystemBlock[] | undefined, estimator?: TokenEstimator): number {
  if (!system) return 0;
  let raw: number;
  if (typeof system === 'string') {
    raw = Math.ceil(system.length / estimateCharsPerToken(system));
  } else {
    raw = system.reduce((sum, b) => sum + Math.ceil(b.text.length / estimateCharsPerToken(b.text)), 0);
  }
  return Math.ceil(raw * (4 / 3) * getFactor(estimator));
}

/**
 * Estimate tool schema token overhead.
 * Applies the same 4/3 padding + calibration factor as message estimation.
 */
export function estimateToolSchemaTokens(tools: ToolParam[] | undefined, estimator?: TokenEstimator): number {
  if (!tools || tools.length === 0) return 0;
  let raw = 0;
  for (const t of tools) {
    const str = t.name + t.description + safeStringify(t.input_schema);
    raw += Math.ceil(str.length / estimateCharsPerToken(str));
  }
  return Math.ceil(raw * (4 / 3) * getFactor(estimator));
}

/**
 * Full context token estimate.
 *
 * Two paths with **different** semantics:
 *
 *   1. **Anchor path** (`anchor` valid)：`anchor.inputTokens` 是 LLM provider 上次
 *      请求实报的整请求 input token，**已包含 system + tools + messages 全部贡献**
 *      （是 LLM 计费基准）。函数返回 `estimateTokensWithAnchor(...)`——后者本身就是
 *      "anchor.inputTokens + 新增消息增量"，**不再叠加 estimateSystemTokens /
 *      estimateToolSchemaTokens** 否则会对 system + tools 结构性双算
 *      （W4.2 dogfood 实测可虚高 8 倍：47k → 411k，导致虚假 emergency 截断）。
 *
 *   2. **Fallback path** (`anchor` 缺失/失效)：消息估算 `estimateTokens(messages)`
 *      仅算 messages，需补叠 system + tools schema 才得到完整 LLM input 估算。
 *
 * `anchor.messageCount` 越界（消息被回滚后等）也算失效——`estimateTokensWithAnchor`
 * 内部回落 estimateTokens(messages) 仅 messages 估算；此时若仍走 anchor 分支
 * 会低估（漏 system + tools），故 anchor 失效时主动进 fallback 分支。
 */
export function estimateFullContextTokens(
  messages: Message[],
  system?: string | SystemBlock[],
  tools?: ToolParam[],
  anchor?: UsageAnchor,
  estimator?: TokenEstimator,
): number {
  const anchorValid = anchor != null
    && anchor.messageCount > 0
    && anchor.messageCount <= messages.length;
  if (anchorValid) {
    return estimateTokensWithAnchor(messages, anchor, estimator);
  }
  const raw = estimateTokens(messages, estimator)
    + estimateSystemTokens(system, estimator)
    + estimateToolSchemaTokens(tools, estimator);
  // ：锚坐标系失效（裁剪后 messageCount > messages.length）时，实报
  // inputSide 仍是当前上下文的有效上界——用它钳制纯字符估算的结构性虚高。
  return clampEstimateByStaleAnchor(raw, messages, anchor);
}

/**
 * Soft trim: from oldest messages forward, replace tool_result content
 * with a short placeholder until estimated tokens ≤ targetTokens.
 * Protects the last 4 messages from modification.
 */
export function softTrim(messages: Message[], targetTokens: number, estimator?: TokenEstimator): Message[] {
  if (estimateTokens(messages, estimator) <= targetTokens) return messages;

  const result = [...messages];
  const protectedTail = Math.min(4, messages.length);

  for (let i = 0; i < result.length - protectedTail; i++) {
    if (estimateTokens(result, estimator) <= targetTokens) break;

    const msg = result[i];
    if (typeof msg.content === 'string') continue;

    let changed = false;
    const newBlocks = msg.content.map((block): ContentBlock => {
      if (block.type !== 'tool_result') return block;

      const oldTokens = estimateContentTokens(block.content);
      const placeholder = '[对话历史因长度限制已被截断。之前的内容已移除。]';
      const newTokens = Math.ceil(placeholder.length / estimateCharsPerToken(placeholder));
      if (oldTokens - newTokens > 0) {
        changed = true;
        return { ...block, content: placeholder };
      }
      return block;
    });

    if (changed) {
      result[i] = { ...msg, content: newBlocks };
    }
  }

  return result;
}

/**
 * Convert a "full context" target (含 system + tools + messages) 到对应的
 * "messages-only" target，用于 hardTrim caller 校准。
 *
 * **背景**：`hardTrim` 内部用 `estimateTokens(messages)` 仅算 messages 估算
 * 跟 targetTokens 比；caller 如果直接传"full context 目标"（如 `contextWindow * 0.7`),
 * 会因为 system + tools 占 30-100k 而**远高于** messages-only 估算 → hardTrim
 * 直接 return（W4.2 Bug 2：emergency 路径在大窗口模型下静默失败 freed=0）。
 *
 * 修法：caller 处把 full-context-target 减去 system + tools 估算 overhead
 * 得到 messages 真实预算，再传给 hardTrim。floor 保留至少 `minMessagesFloor`
 * (默认 1000) 给 messages 防止 target 退化为 0/负。
 */
export function computeMessagesTargetFromFullTarget(
  fullContextTarget: number,
  system?: string | SystemBlock[],
  tools?: ToolParam[],
  estimator?: TokenEstimator,
  minMessagesFloor = 1000,
): number {
  const overhead = estimateSystemTokens(system, estimator) + estimateToolSchemaTokens(tools, estimator);
  return Math.max(minMessagesFloor, fullContextTarget - overhead);
}

/**
 * Hard trim: drop oldest messages until estimated tokens ≤ targetTokens.
 * Prepends a truncation notice and ensures valid user/assistant alternation.
 *
 * **`targetTokens` 是 messages-only 维度**——只跟 `estimateTokens(messages)` 对齐
 * 比较。如果 caller 持有的是"full context 目标"（含 system + tools），必须先用
 * `computeMessagesTargetFromFullTarget` 转换，否则 hardTrim 会因 system + tools
 * overhead 没扣而比"实际可砍 messages 预算"大很多 → 静默 noop。
 *
 * `taskStateNotice`（ 钉锚截断）：调用方从**被砍前**的完整消息提取的
 * 「当前任务状态」段（活跃待办合并态 + plan 指针，见
 * `prompts/compact/truncation-task-state.ts`）。传入时拼进截断告示——硬删不再
 * 丢任务锚；不传时保持原有裸告示（短会话无锚可钉）。
 */
export function hardTrim(
  messages: Message[],
  targetTokens: number,
  estimator?: TokenEstimator,
  taskStateNotice?: string,
): Message[] {
  if (estimateTokens(messages, estimator) <= targetTokens) return messages;

  const family = estimator?.modelFamily;
  const perMsg = messages.map((msg) => rawTokensForMessage(msg, family));
  const rawTotal = perMsg.reduce((a, b) => a + b, 0);
  const rawTarget = Math.floor(targetTokens * 3 / 4) - 30;

  const minKeepTail = Math.min(4, messages.length);
  let cumDropped = 0;
  let dropCount = 0;

  while (dropCount < messages.length - minKeepTail && rawTotal - cumDropped > rawTarget) {
    cumDropped += perMsg[dropCount];
    dropCount++;
  }

  if (dropCount === 0) return messages;

  const kept = messages.slice(dropCount);
  const noticeText = `[对话历史因长度限制已被截断。之前的 ${dropCount} 条消息已移除。]`
    + (taskStateNotice ? `\n${taskStateNotice}` : '');
  const notice: Message = {
    role: 'user' as const,
    content: noticeText,
  };

  if (kept[0]?.role === 'assistant') {
    return [notice, ...kept];
  }
  const ack: Message = {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: '明白。' }],
  };
  return [notice, ack, ...kept];
}

// ─── API-Round Grouping ──────────────────────────────────────────────

export type ApiRound = Message[];

/**
 * Group messages by API round: each round is a user message followed by
 * any assistant/tool messages before the next user message.
 * A leading assistant message (no preceding user) forms its own group.
 */
export function groupMessagesByApiRound(messages: Message[]): ApiRound[] {
  const groups: ApiRound[] = [];
  let current: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Truncate from the head of conversation to reduce context size.
 * When `tokenGap` is provided, removes the minimum number of head rounds
 * to free at least that many tokens. Otherwise removes 20% of rounds.
 * Guarantees the first message is role=user (API requirement) and
 * at least one round is preserved.
 *
 * `taskStateNotice`（ 钉锚截断）：与 `hardTrim` 同款——调用方从被砍前
 * 消息提取「当前任务状态」段，截断后作为头部告示注入，硬删不丢任务锚。
 * 传入时**不再保护首轮**（R1 取消）：任务真相由任务状态锚承载（活的、随
 * todo merge 更新），首条用户指令是静态起点、可能已被后续修正覆盖，保它
 * 反而会把 Agent 拉回旧目标。
 */
export function truncateHead(
  messages: Message[],
  tokenGap?: number,
  estimator?: TokenEstimator,
  taskStateNotice?: string,
): Message[] {
  const groups = groupMessagesByApiRound(messages);
  if (groups.length <= 1) return messages;

  // R1: 无任务状态锚时保护首轮（首条 user 是仅存的目标载体）；有锚时不保
  // ——锚承载"当前任务状态"，首条指令可能已过时。
  const firstGroupHasUser = groups[0]!.some(m => m.role === 'user');
  const protectFirstRound = firstGroupHasUser && !taskStateNotice;
  const startIdx = protectFirstRound ? 1 : 0;
  const removableGroups = groups.length - startIdx;
  if (removableGroups <= 1) return messages;

  const maxRemovable = removableGroups - 1;

  let removeCount: number;

  if (tokenGap != null && tokenGap > 0) {
    let acc = 0;
    removeCount = 0;
    for (let i = startIdx; i < groups.length; i++) {
      if (acc >= tokenGap || removeCount >= maxRemovable) break;
      acc += estimateTokens(groups[i]!, estimator);
      removeCount++;
    }
  } else {
    removeCount = Math.min(
      Math.max(1, Math.floor(removableGroups * 0.2)),
      maxRemovable,
    );
  }

  if (removeCount === 0) return messages;

  const remaining = [
    ...(startIdx > 0 ? [groups[0]!] : []),
    ...groups.slice(startIdx + removeCount),
  ];
  const flatMessages = remaining.flat();

  if (taskStateNotice) {
    // 保持 user/assistant 交替：首条已是 user 时垫一条 ack（与 hardTrim 同款）。
    if (flatMessages[0]?.role === 'user') {
      flatMessages.unshift({
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: '明白。' }],
      });
    }
    flatMessages.unshift({
      role: 'user' as const,
      content: `[由于上下文过长，之前的对话记录已被移除]\n${taskStateNotice}`,
    });
  } else if (flatMessages[0]?.role !== 'user') {
    flatMessages.unshift({
      role: 'user' as const,
      content: '[由于上下文过长，之前的对话记录已被移除]',
    });
  }

  return flatMessages;
}

export { estimateImageTokens };

/**
 * 统计 messages 中 `tool_use` 块总数（compaction stats 的 `tool_uses_retained`
 * 口径）——纯消息机制，供 compact 各 mode 与 413 recovery 复用，保持计数口径
 * 在所有压缩路径之间一致。每个 `tool_use` 都计 1，不去重 id。
 */
export function countToolUses(messages: Message[]): number {
  let count = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') count++;
    }
  }
  return count;
}
