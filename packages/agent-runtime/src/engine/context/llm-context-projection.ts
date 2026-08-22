/**
 * LLM 上下文投影 —— 工具结果进入模型前的统一裁剪 + 安全围栏边界。
 *
 * ## 为什么放在这里而不是各条历史链路
 *
 * `run_terminal_command` 的 canonical envelope 同时服务终端卡片、历史回放、
 * 文件回退与诊断（`file_history` / `session_id` / `output_file` / `duration_ms`
 * 等字段）。live 路径靠 `ToolResult.llmContextContent` 分流出 slim 版本，但
 * 历史消息可以从多个来源进入 `state.messages`：
 *
 *   - 本地 transcript 全量重放（`buildReplayHistoryFromTranscript`， 契约
 *     「tool_result 保留 raw」——写盘的是 canonical）；
 *   - renderer 回退历史（`selectRecentHistoryForRuntime`）；
 *   - crash resume 注入、fork resume 读回等。
 *
 * 在每条链路各自补裁剪是分散修补；本模块在 `query.ts` 构造 `llmRequest` 的
 * 最后一刻做一次纯函数投影，对所有来源通用。canonical 的 `state.messages` /
 * persist / transcript 不被修改——只有发给 provider 的 `llmRequest.messages`
 * 与据其构建的 `LLM_REQUEST` debug 快照看到投影结果（两者天然一致）。
 *
 * ## 裁剪语义
 *
 * 与 shell.ts live 路径的 `llmContextContent` 完全同源（本模块即其实现，
 * shell.ts 反向 import）——对 slim 内容重复投影是幂等的（保留字段为子集）。
 * 非 JSON、无 `status` 字段、被 sanitizer `<tool_output>` fence 包裹或
 * ContentBlock[] 形态的内容一律原样保留，避免误裁剪。
 */

import type {
  ContentBlock,
  InternalMessageMarker,
  Message,
  ToolResultBlock,
} from '../contracts/conversation.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
} from '../contracts/conversation.js';
import type {
  LLMRequest,
} from '../contracts/model-llm.js';
import {
  scanForInjectionPatterns,
  shouldFenceToolOutputByName,
  wrapInToolOutputFence,
} from '../tooling/tool-output-sanitizer.js';

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function copyIfPresent(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  if (source[key] !== undefined) {
    target[key] = source[key];
  }
}

function copyIfMeaningful(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (value === undefined || value === null || value === false) return;
  if (Array.isArray(value) && value.length === 0) return;
  target[key] = value;
}

/**
 * Build the exact run_terminal_command result that enters the next LLM call.
 *
 * Canonical `content` intentionally keeps terminal/session/checkpoint metadata for
 * UI, history replay, diagnostics, and file rollback. The LLM only needs the
 * operational fields for the next decision.
 */
export function buildShellLlmContextContent(envelope: Record<string, unknown>): string {
  const status = readStringField(envelope, 'status');
  const llm: Record<string, unknown> = {};
  copyIfPresent(llm, envelope, 'status');

  if (status === 'running') {
    copyIfPresent(llm, envelope, 'session_id');
    copyIfPresent(llm, envelope, 'pid');
    copyIfPresent(llm, envelope, 'stdout_tail');
    copyIfPresent(llm, envelope, 'stdout_byte_count');
    copyIfPresent(llm, envelope, 'elapsed_ms');
    copyIfPresent(llm, envelope, 'output_file');
    copyIfPresent(llm, envelope, 'hard_timeout_ms');
    copyIfPresent(llm, envelope, 'pattern_matched');
    copyIfPresent(llm, envelope, 'hint');
    copyIfMeaningful(llm, envelope, 'dedup_hit');
  } else if (status === 'completed') {
    copyIfPresent(llm, envelope, 'exit_code');
    copyIfPresent(llm, envelope, 'stdout');
    copyIfMeaningful(llm, envelope, 'stdout_truncated');
    copyIfMeaningful(llm, envelope, 'full_output_path');
    copyIfMeaningful(llm, envelope, 'control_signals');
    copyIfMeaningful(llm, envelope, 'pattern_matched');
    copyIfMeaningful(llm, envelope, 'killed_reason');
    copyIfMeaningful(llm, envelope, 'hint');

    const exitedBy = readStringField(envelope, 'exited_by');
    if (exitedBy && exitedBy !== 'normal_exit') {
      llm.exited_by = exitedBy;
    }
  } else {
    copyIfPresent(llm, envelope, 'exit_code');
    copyIfPresent(llm, envelope, 'stdout');
    copyIfPresent(llm, envelope, 'error_kind');
    copyIfPresent(llm, envelope, 'error');
    copyIfPresent(llm, envelope, 'hint');
  }

  copyIfMeaningful(llm, envelope, 'stdout_redirect_warning');
  copyIfMeaningful(llm, envelope, 'ignored_keys');
  copyIfMeaningful(llm, envelope, 'ignored_keys_warning');
  copyIfMeaningful(llm, envelope, 'path_quoting_warnings');
  // FR-07 schema warning 由 orchestration 层事后 merge 进 canonical JSON；
  // 边界投影不能把 retry 指令裁掉。
  copyIfPresent(llm, envelope, '_schema_validation_warning');

  return JSON.stringify(llm, null, 0);
}

/** 与 select-recent-history.ts 同口径的终端工具判定。 */
function isTerminalCommandTool(toolName: string | undefined): boolean {
  return toolName === 'run_terminal_command';
}

/**
 * 尝试把一个 terminal tool_result 的 string content 投影成 LLM-facing slim 版。
 *
 * 返回 `undefined` 表示「不动」：非 JSON（含 sanitizer fence 包裹）、非对象、
 * 非 running/completed envelope（jsonError 失败结果、episode 摘要文本等 live
 * 路径本就不做 slim 的形态）都原样保留，保证边界投影不改变 live 语义。
 */
function projectShellToolResultContent(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.status !== 'running' && envelope.status !== 'completed') return undefined;

  const projected = buildShellLlmContextContent(envelope);
  return projected === content ? undefined : projected;
}

/**
 * FR-09 fence 的 LLM 发送边界施加点（ fence 后移）。
 *
 * 执行期只做 hygiene（Unicode strip + injection scan），canonical 结果不再
 * 带 fence——UI / 落库 / transcript 拿到的是干净内容。这里在每次构造
 * `llmRequest` 前，对「外部不可信字节」工具（web_search / parse_document /
 * mcp_* / `tabtin fetch|browser` 的 run_terminal_command）的 tool_result
 * 统一包 fence：
 *
 *   - live 与历史恢复（transcript / renderer 回退 / crash resume）走同一道闸，
 *     不存在「重放丢 fence」的缺口；
 *   - `wrapInToolOutputFence` 语义与执行期旧行为一致（`</tool_output` 中和、
 *     suspicious 标注）；已 fenced 的历史内容（老 transcript）由调用方的
 *     幂等守卫原样保留，不双包。
 *
 * suspicious 标注在边界即时重扫（`scanForInjectionPatterns`）——注入内容
 * 持久存在于结果字节里，重扫与执行期扫描等价，且不依赖执行期状态跨轮传递。
 *
 * **已知取舍（L-38 后续形态）**：预算截断 banner（`[... 输出已截断 ...]`）
 * 现在落在 fence body 内而非 fence 外。刻意不做「按 banner 模式外提」——
 * 攻击者可以在抓回的页面尾部伪造同形态 banner 行，外提逻辑会把攻击者文本
 * 搬到 fence 外，构成围栏逃逸通道；banner 留在 fence 内只损失「真 banner
 * 的权威性」（LLM 被指示不执行 fence 内指令，可能不主动走 read_file 恢复
 * 路径），安全上反而更保守。
 */
export function applyLlmBoundaryFence(
  content: string,
  toolName: string,
): string {
  if (content.startsWith('<tool_output')) return content;
  const { suspicious } = scanForInjectionPatterns(content);
  return wrapInToolOutputFence(content, toolName, suspicious);
}

const SYSTEM_TO_USER_LLM_MARKERS: ReadonlyArray<InternalMessageMarker> = [
  INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
  INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT,
  INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION,
  INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION,
  INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE,
  INTERNAL_MESSAGE_MARKERS.LSP_DIAGNOSTICS_INJECTION,
  INTERNAL_MESSAGE_MARKERS.TOOL_EVICTION_NOTICE,
  INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION,
  INTERNAL_MESSAGE_MARKERS.MODE_TRANSITION_REMINDER,
  INTERNAL_MESSAGE_MARKERS.TODO_STATE_INJECTION,
  INTERNAL_MESSAGE_MARKERS.RELEVANT_RECALL_INJECTION,
  INTERNAL_MESSAGE_MARKERS.TODO_COMPLETION_NUDGE,
  INTERNAL_MESSAGE_MARKERS.PROJECT_RULES_INJECTION,
  INTERNAL_MESSAGE_MARKERS.CONTINUATION,
];

function firstText(message: Message): string {
  if (typeof message.content === 'string') return message.content.trimStart();
  const first = message.content[0];
  return first?.type === 'text' ? first.text.trimStart() : '';
}

function shouldProjectSystemMessageToUser(message: Message): boolean {
  if (message.role !== 'system') return false;
  if (SYSTEM_TO_USER_LLM_MARKERS.some((marker) => hasInternalMarker(message, marker))) return true;
  const text = firstText(message);
  return text.startsWith('<context type="environment"')
    || text.startsWith("<context type='environment'")
    || text.startsWith('<context type="agent-profile"')
    || text.startsWith("<context type='agent-profile'")
    || text.startsWith('<identity');
}

/**
 * 把 `state.messages` 投影成发给 LLM 的消息序列（纯函数，不改输入）。
 *
 * 三步投影：
 *   1. 内部 system 上下文 → provider 兼容的 user 消息（只在 LLM 边界发生）；
 *   2. `run_terminal_command` canonical envelope → LLM-facing slim；
 *   3. 外部不可信字节工具的 tool_result → `<tool_output>` fence。
 *
 * 只替换有变化的 message / block；未变化的保持对象同一性，让消息上的
 * in-memory marker（`INTERNAL_MESSAGE_MARKERS`，string 属性经 spread 存活）
 * 与 prompt cache 前缀尽量稳定。fence 每轮产出 byte-identical（wrap 是纯函数、
 * scan 结果由内容决定），prompt cache 前缀跨轮稳定。
 */
export interface ProjectMessagesForLlmOptions {
  /**
   * FR-09 开关（`EngineConfig.toolOutputScan`）。false = 运维显式关闭
   * 输出防护，边界不包 fence（与执行期 scan/notice 同一开关语义）。
   */
  fenceEnabled?: boolean;
  /**
   * FR-09 / 中性化：宿主注入的「shell 命令是否返回外部不可信字节」谓词
   * （`EngineConfig.isUntrustedShellCommand`）。用于判定 `run_terminal_command`
   * 的 tool_result 是否在 LLM 边界包 fence；缺省时不 fence。
   */
  isUntrustedShellCommand?: (command: string) => boolean;
}

/**
 * LLM 出口投影单点：把「fenceEnabled 解析（`toolOutputScan ?? true`）
 * + `projectMessagesForLlm` 调用」收进同一函数，投影语义定义只此一处。
 *
 * 两个调用点、同一函数、幂等双过：
 *   1. `query.ts` `buildLlmRequest`——主循环请求在构造时投影，保证
 *      LLM_REQUEST debug 快照与实际入模一致；
 *   2. `query-deps.ts` `guardedCreateStream`——provider 出口再过一次，
 *      兜住 compact / 摘要 / fork 等不经过 buildLlmRequest 的直连出口。
 *
 * 投影幂等（slim 保留字段为子集、fence 有 `startsWith('<tool_output')`
 * 守卫），双过与单过 byte 等价；无变化时保持 req 对象同一性。
 */
export interface ProjectLlmRequestOptions {
  /**
   * `EngineConfig.toolOutputScan`（FR-09 开关）。undefined 视为开启；
   * false = 运维显式关闭输出防护，边界不包 fence。
   */
  toolOutputScan?: boolean;
  /**
   * FR-09 / 中性化：宿主注入的「shell 命令是否返回外部不可信字节」谓词
   * （`EngineConfig.isUntrustedShellCommand`）。透传到 `projectMessagesForLlm`。
   */
  isUntrustedShellCommand?: (command: string) => boolean;
}

export function projectLlmRequest(
  req: LLMRequest,
  options?: ProjectLlmRequestOptions,
): LLMRequest {
  const messages = projectMessagesForLlm(req.messages, {
    fenceEnabled: options?.toolOutputScan ?? true,
    isUntrustedShellCommand: options?.isUntrustedShellCommand,
  });
  return messages === req.messages ? req : { ...req, messages };
}

export function projectMessagesForLlm(
  messages: Message[],
  options?: ProjectMessagesForLlmOptions,
): Message[] {
  const fenceEnabled = options?.fenceEnabled ?? true;
  // tool_use_id → tool name/input 索引（跨 message 全局扫描，历史与 live 同源）。
  const toolUseById = new Map<string, { name: string; input: unknown }>();
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        toolUseById.set(block.id, { name: block.name, input: block.input });
      }
    }
  }

  let anyMessageChanged = false;
  const out = messages.map((message) => {
    const roleProjected = shouldProjectSystemMessageToUser(message);
    const baseMessage = roleProjected ? { ...message, role: 'user' as const } : message;
    if (roleProjected) anyMessageChanged = true;
    if (typeof baseMessage.content === 'string' || toolUseById.size === 0) return baseMessage;

    let blockChanged = false;
    const blocks = baseMessage.content.map((block): ContentBlock => {
      if (block.type !== 'tool_result') return block;
      if (typeof block.content !== 'string') return block;
      const toolUse = toolUseById.get(block.tool_use_id);
      if (!toolUse) return block;

      let content = block.content;
      if (isTerminalCommandTool(toolUse.name)) {
        content = projectShellToolResultContent(content) ?? content;
      }
      if (fenceEnabled && shouldFenceToolOutputByName(toolUse.name, toolUse.input, options?.isUntrustedShellCommand)) {
        content = applyLlmBoundaryFence(content, toolUse.name);
      }
      if (content === block.content) return block;
      blockChanged = true;
      return { ...block, content } satisfies ToolResultBlock;
    });

    if (!blockChanged) return baseMessage;
    anyMessageChanged = true;
    return { ...baseMessage, content: blocks };
  });

  return anyMessageChanged ? out : messages;
}
