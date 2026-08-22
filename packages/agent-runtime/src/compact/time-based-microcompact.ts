/**
 * Time-based micro-compaction —— "历史 tool_result 按事实默认过期" 的本地实现。
 *
 * 按约定实现 `src/services/compact/microCompact.ts:422-530`：
 *   - `evaluateTimeBasedTrigger(messages, config, now?)` — 按"最后一条 assistant
 *     消息到现在的 gap 分钟数"判定是否触发。
 *   - `maybeTimeBasedMicrocompact(messages, config, ...)` — 触发时，把
 *     `COMPACTABLE_TOOLS` 白名单工具的**旧** tool_result block 的 `content`
 *     替换为 `TIME_BASED_MC_CLEARED_MESSAGE`，保留最近 `keepRecent` 条不清。
 *
 * **关键不变量**：
 *   1. 不动 `tool_use_id`：tool_use 与 tool_result 的配对 Id 永不改写；
 *   2. 不删 tool_result block：块仍然存在，只是 `content` 字符串换了；
 *   3. 不动 tool_use 块：tool_use 的 `id` / `name` / `input` 一字不改；
 *   4. 只动白名单工具：`FILE_READ / SHELL / GREP / WEB / FILE_EDIT` 这类"结果
 *      可以重新获取"的工具；非白名单（如 Task agent / todo）的 result
 *      是决策/指令，清了就真丢东西。
 *
 * ## 白名单 SSoT（Single Source of Truth）
 *
 * 本地 TS / 云端 Python 的 `COMPACTABLE_TOOLS` 集合统一以本文件的
 * `COMPACTABLE_TOOLS_DEFAULT` 为准（调研："harness_对话成熟化_tool跨轮语义" §4.4
 * 指出两端 20+ vs 9 项不一致）。云端
 * `apps/tabtin_django/apps/services/agent_engine/middleware/context_pruning/microcompact.py`
 * 的 `COMPACTABLE_TOOLS` frozenset **必须与本常量每项工具名对齐**（见该文件
 * 顶部 SSoT 注释），任何新增工具需同时改两端。
 *
 * 不把 SSoT 放 `packages/action-tools/manifest.json` 或类似产物的理由：
 *   - manifest 结构目前只描述"工具的 action 定义"而非"工具 result 是否可重新
 *     获取"——后者是 compact 层的语义，与工具定义解耦；
 *   - 跨仓库（Python 无法直接读 TS 模块），现阶段让云端 Python 手动对齐 + 注释
 *     互指是开销最低的办法（调研方案 a）。
 */

import type {
  ContentBlock,
  Message,
  ToolResultBlock,
} from '../engine/contracts/conversation.js';

// ─── 白名单（SSoT） ──────────────────────────────────────────────────

/**
 * `COMPACTABLE_TOOLS` —— 结果可被 time-based microcompact 清理的工具集合。
 *
 * 与云端 `apps/tabtin_django/apps/services/agent_engine/middleware/context_pruning/microcompact.py`
 * 的 `COMPACTABLE_TOOLS` frozenset **保持对齐**（两端都以本常量为真相源）。
 *
 * 判定依据：这些工具的 result 是
 * "可重新获取"的（文件可以重读、shell 可以重跑、搜索可以重查），所以清掉不会
 * 让 Agent 失去不可逆信息。Edit/Write 类工具的 result 是"改动已发生"的事实，
 * 本来不该被清——但实践上仍列入可清白名单（`FILE_EDIT_TOOL_NAME`/
 * `FILE_WRITE_TOOL_NAME`），原因是"执行副作用已落盘，再读文件即可重建 result"。
 * 这里保留同样的策略（避免模型发现"已经改了但 history 丢了 result 字符串"
 * 导致的"要不要重做"的误判，直接清 content 让模型自觉回读）。
 */
export const COMPACTABLE_TOOLS_DEFAULT: ReadonlySet<string> = new Set([
  // File reads
  'file_read', 'read_file', 'Read', 'FileRead', 'ReadFile',
  'document_read', 'parse_document', 'read',
  // Shell / terminal. `bash` / `shell` are legacy transcript or external-agent
  // names; current TabTin command tool is `run_terminal_command`.
  'shell', 'bash', 'terminal', 'Shell', 'execute_command', 'run_terminal_command', 'Bash',
  'execute_in_terminal', 'ssh_execute',
  // Search tools
  'grep', 'Grep', 'search', 'glob', 'Glob', 'find', 'SemanticSearch',
  'code_grep', 'grep_search', 'code_glob', 'glob_search',
  // Web tools — `web_fetch` Wave 4a 后已删除（D4 全删 FC），但保留在压缩
  // 名单里：旧 conversation 历史里仍可能有 web_fetch 输出，压缩逻辑应能
  // 安全处理。
  'web_search', 'web_fetch', 'WebSearch', 'WebFetch',
  // File edit outputs (the result, not the operation)
  'file_edit', 'edit_file', 'file_write', 'write_file', 'Edit', 'Write', 'FileEdit', 'FileWrite',
  // W13c data-tools —— RAG / memory / credential / conversation
  'rag_search', 'memory_search',
  'list_conversations', 'read_conversation',
  'credential_lookup',
  // TabDesktop / Device snapshot（对齐云端 `request_snapshot`）
  'request_snapshot',
]);

/**
 * `COMPACTABLE_TOOL_PREFIXES` —— 前缀匹配可压缩工具（云端 `web_scraper_*`
 * 家族）。本地暂不用，但为保持两端 API 对称（SSoT）一并导出。
 *
 * **2026-04-30 dogfood P0 改名**：旧前缀 `web_scraper.` / `web-scraper.`
 * 在工具名改下划线后永远不命中。新增 `web_scraper_` 前缀；保留旧前缀
 * 兜底跨轮历史里残留的旧工具名（被 sanitize 替换为 `web_scraper_xxx` 后
 * 仍能命中）。
 */
export const COMPACTABLE_TOOL_PREFIXES_DEFAULT: readonly string[] = [
  'web_scraper_',
  // 兜底：旧 session 历史里残留的点号 / 连字符形式，sanitize 后会
  // 全部归一为 `web_scraper_xxx`；前缀全部命中。保留这两条是 defense-in-depth。
  'web_scraper.',
  'web-scraper.',
];

/** 白名单判定（大小写不敏感，与云端一致） */
export function isCompactableTool(
  toolName: string,
  compactableTools: ReadonlySet<string> = COMPACTABLE_TOOLS_DEFAULT,
  compactablePrefixes: readonly string[] = COMPACTABLE_TOOL_PREFIXES_DEFAULT,
): boolean {
  if (!toolName) return false;
  if (compactableTools.has(toolName)) return true;
  const lower = toolName.toLowerCase();
  if (compactableTools.has(lower)) return true;
  for (const prefix of compactablePrefixes) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

// ─── 配置 ────────────────────────────────────────────────────────────

/**
 * Time-based microcompact 配置。
 *
 * 字段：
 * - `enabled`：总开关。默认 `false`——time-based 是"过期事实默认"，需要调用
 *   方（宿主或 engine config）**显式开启**才生效。这是因为：
 *   (1) 开启后老 tool_result 会被替换成占位字符串，对不了解该机制的消费者
 *       可能意外；
 *   (2) 与 system prompt "工具结果可能被清" 提示（事 4）是配套功能，需要两侧
 *       一起开；事 3 仅实装"引擎能力"，开关由 Wave 后续动作决定。
 * - `gapThresholdMinutes`：距最后一条 assistant 消息超过此分钟数即触发。
 *   默认 `30`：常见落点 10-60min；
 *   30 是中间保守值，"一小段喝咖啡 + 回来继续聊"不会误触发。
 * - `keepRecent`：保留最近 N 个 tool_result 不清理。默认 `4`：与云端
 *   `DEFAULT_KEEP_RECENT=4` 对齐。过小（如 1）会让刚刚查完立刻被清掉；
 *   过大（如 10）让 time-based 几乎没实际效果。
 *
 * 阈值不写死在代码里——`runCompactionPhase` 按 `EngineConfig.timeBasedMicroCompact`
 * 覆盖本默认；测试可在单测里按场景注入。
 */
export interface TimeBasedMCConfig {
  enabled: boolean;
  gapThresholdMinutes: number;
  keepRecent: number;
}

export const DEFAULT_TIME_BASED_MC_CONFIG: TimeBasedMCConfig = {
  enabled: false,
  gapThresholdMinutes: 30,
  keepRecent: 4,
};

/**
 * 用户场景下"替换字符串"必须足够**具有自解释性**，让模型在一轮后自行判断
 * 是否重新调工具（而非盲目地把占位字符串当真结果继续推理）。
 *
 * E1 资源化：SSoT 已迁到 `packages/agent-runtime/src/prompts/compact/time-based-cleared.ts`；
 * 本处 import + 同名 re-export，让模块内部和历史消费者都能继续使用。
 */
import { TIME_BASED_MC_CLEARED_MESSAGE } from '../prompts/compact/time-based-cleared.js';
export { TIME_BASED_MC_CLEARED_MESSAGE };

// ─── Evaluation ──────────────────────────────────────────────────────

/**
 * 触发判定输入。`messages` 是常规消息数组；`lastAssistantTimestamp` 若未传
 * 则由本函数从 message metadata 推断（当前 TabTin `Message` 类型不带时间戳
 * 字段，故需要调用方显式传入——通常从 session / transcript 侧拿到）。
 *
 * 若调用方**既不传 `lastAssistantTimestamp` 也没 `options.now`**，evaluate
 * 判定无可靠信号，返回 `null`（不触发）。这是**保守默认**——漏触发好于
 * 错触发把老结果清了。
 */
export interface EvaluateTimeBasedTriggerInput {
  messages: Message[];
  config: TimeBasedMCConfig;
  /**
   * 距"最后一条 assistant 消息"的时间戳（ms epoch）。typ. 由宿主从 session
   * 元数据 / transcript 末条 assistant timestamp 读出注入。
   */
  lastAssistantTimestamp?: number;
  /** 当前时间（测试可覆盖，默认 `Date.now()`）。 */
  now?: number;
}

export interface EvaluateTimeBasedTriggerResult {
  triggered: boolean;
  gapMinutes: number;
  config: TimeBasedMCConfig;
  /** 用于埋点的诊断字段 */
  reason:
    | 'disabled'
    | 'no_timestamp'
    | 'below_threshold'
    | 'no_compactable_tools'
    | 'triggered';
}

/**
 * 判定是否应触发 time-based microcompact。
 *
 * 语义约定 `evaluateTimeBasedTrigger`（microCompact.ts:422-475）：
 *   - 需要有最后 assistant 消息时间戳
 *   - 距今 gap > `gapThresholdMinutes`
 *   - 消息里确实含 compactable 工具的 tool_result（否则跑也没东西清）
 */
export function evaluateTimeBasedTrigger(
  input: EvaluateTimeBasedTriggerInput,
): EvaluateTimeBasedTriggerResult {
  const { messages, config, lastAssistantTimestamp } = input;
  const now = input.now ?? Date.now();

  if (!config.enabled) {
    return { triggered: false, gapMinutes: 0, config, reason: 'disabled' };
  }

  if (typeof lastAssistantTimestamp !== 'number' || !Number.isFinite(lastAssistantTimestamp)) {
    return { triggered: false, gapMinutes: 0, config, reason: 'no_timestamp' };
  }

  const gapMs = Math.max(0, now - lastAssistantTimestamp);
  const gapMinutes = gapMs / 60_000;

  if (gapMinutes < config.gapThresholdMinutes) {
    return { triggered: false, gapMinutes, config, reason: 'below_threshold' };
  }

  // 确认消息里有 compactable tool_result 再触发，避免空跑
  const hasCandidate = messages.some((msg) => {
    if (typeof msg.content === 'string') return false;
    return msg.content.some((block) => block.type === 'tool_result');
  });
  if (!hasCandidate) {
    return { triggered: false, gapMinutes, config, reason: 'no_compactable_tools' };
  }

  return { triggered: true, gapMinutes, config, reason: 'triggered' };
}

// ─── Apply ───────────────────────────────────────────────────────────

export interface MaybeTimeBasedMicrocompactOptions {
  config: TimeBasedMCConfig;
  lastAssistantTimestamp?: number;
  now?: number;
  /** 可覆盖白名单（测试 / 宿主扩展）。默认 `COMPACTABLE_TOOLS_DEFAULT`。 */
  compactableTools?: ReadonlySet<string>;
  compactablePrefixes?: readonly string[];
}

export interface TimeBasedMicrocompactResult {
  messages: Message[];
  /** 是否触发 */
  triggered: boolean;
  /** 实际被清 content 的 tool_result 条数 */
  clearedCount: number;
  /** 诊断（用于埋点 / 日志） */
  gapMinutes: number;
  reason: EvaluateTimeBasedTriggerResult['reason'];
}

/**
 * 执行 time-based microcompact。
 *
 * 策略：
 *   1. 收集所有 tool_result block（按消息位置顺序）——每个 result 的"位置"
 *      即"自消息数组开头第几个 tool_result 块"。
 *   2. 判定白名单：result 对应的 `tool_use_id` 找到 tool_use，检查 name 是否
 *      在 `COMPACTABLE_TOOLS_DEFAULT`。
 *   3. 除最后 `keepRecent` 条**compactable** result 外，其余 content 替换为
 *      `TIME_BASED_MC_CLEARED_MESSAGE`。非 compactable 的 result 永不动。
 *   4. tool_use block 一律不动；tool_use_id 不变；block.type 不变。
 *
 * 返回**新数组 + 新消息对象**（保持 Messages 读只约定的 immutable 模式）。
 */
export function maybeTimeBasedMicrocompact(
  messages: Message[],
  options: MaybeTimeBasedMicrocompactOptions,
): TimeBasedMicrocompactResult {
  const evaluated = evaluateTimeBasedTrigger({
    messages,
    config: options.config,
    lastAssistantTimestamp: options.lastAssistantTimestamp,
    now: options.now,
  });

  if (!evaluated.triggered) {
    return {
      messages,
      triggered: false,
      clearedCount: 0,
      gapMinutes: evaluated.gapMinutes,
      reason: evaluated.reason,
    };
  }

  const compactableTools = options.compactableTools ?? COMPACTABLE_TOOLS_DEFAULT;
  const compactablePrefixes = options.compactablePrefixes ?? COMPACTABLE_TOOL_PREFIXES_DEFAULT;

  // 先 scan：收集所有 tool_use（id → name）与 tool_result（index 对）
  const toolUseNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolUseNameById.set(block.id, block.name);
      }
    }
  }

  // 收集所有 compactable tool_result 的 "(msgIdx, blockIdx)" 出现顺序
  const compactableLocations: Array<{ msgIdx: number; blockIdx: number }> = [];
  messages.forEach((msg, msgIdx) => {
    if (typeof msg.content === 'string') return;
    msg.content.forEach((block, blockIdx) => {
      if (block.type !== 'tool_result') return;
      const toolName = toolUseNameById.get(block.tool_use_id) ?? '';
      if (isCompactableTool(toolName, compactableTools, compactablePrefixes)) {
        compactableLocations.push({ msgIdx, blockIdx });
      }
    });
  });

  if (compactableLocations.length === 0) {
    return {
      messages,
      triggered: true,
      clearedCount: 0,
      gapMinutes: evaluated.gapMinutes,
      reason: 'no_compactable_tools',
    };
  }

  const keepRecent = Math.max(0, options.config.keepRecent | 0);
  // 保留最后 keepRecent 条：要清的 = 前 N - keepRecent 条
  const clearCount = Math.max(0, compactableLocations.length - keepRecent);
  if (clearCount === 0) {
    return {
      messages,
      triggered: true,
      clearedCount: 0,
      gapMinutes: evaluated.gapMinutes,
      reason: 'triggered',
    };
  }

  const toClear = new Set(
    compactableLocations.slice(0, clearCount).map((loc) => `${loc.msgIdx}#${loc.blockIdx}`),
  );

  // 实际产生变化的 tool_result 数（排除已是占位字符串的幂等情形）
  let actualClearedCount = 0;

  const newMessages = messages.map((msg, msgIdx) => {
    if (typeof msg.content === 'string') return msg;

    let mutated = false;
    const newContent: ContentBlock[] = msg.content.map((block, blockIdx) => {
      if (block.type !== 'tool_result') return block;
      const key = `${msgIdx}#${blockIdx}`;
      if (!toClear.has(key)) return block;

      // 已经是 cleared 占位字符串就不再改（幂等）
      const existing = typeof block.content === 'string' ? block.content : '';
      if (existing === TIME_BASED_MC_CLEARED_MESSAGE) return block;

      mutated = true;
      actualClearedCount++;
      const cleared: ToolResultBlock = {
        ...block,
        content: TIME_BASED_MC_CLEARED_MESSAGE,
      };
      return cleared;
    });

    return mutated ? { ...msg, content: newContent } : msg;
  });

  // 全部都是已 cleared 的占位字符串——返回原 messages 引用（未 mutate）
  const outputMessages = actualClearedCount > 0 ? newMessages : messages;

  return {
    messages: outputMessages,
    triggered: true,
    clearedCount: actualClearedCount,
    gapMinutes: evaluated.gapMinutes,
    reason: 'triggered',
  };
}

// ─── Helpers (for message-normalizer / tests) ────────────────────────

/**
 * 从消息数组末尾反向找最后一条 assistant 消息的"最接近的时间戳提示"。
 *
 * 当前 `Message` 接口无 timestamp 字段——运行中的消息是内存结构，时间戳信息
 * 通常留在宿主的 session/transcript 侧。但为了让 `evaluateTimeBasedTrigger`
 * 在 host 没注入 `lastAssistantTimestamp` 时能做"轻量兜底"（例如 host 追加了
 * 自定义 `_timestamp` 字段），此函数用 `as unknown as Record<string, unknown>`
 * 后做 duck-type 探测——与云端 `_last_assistant_timestamp` 的 duck-typed 思路
 * 一致。读不到则返回 undefined，调用方回落到 reason='no_timestamp'。
 */
export function inferLastAssistantTimestamp(messages: Message[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const any = msg as unknown as Record<string, unknown>;
    const ts = any._timestamp ?? any.timestamp ?? any.created_at;
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    if (typeof ts === 'string') {
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined; // 找到 assistant 但没时间戳就直接返回 undefined
  }
  return undefined;
}
