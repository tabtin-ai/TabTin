/**
 * LLM 调用快照构造（Phase 2 · Debug Observability）。自 query.ts 抽出——
 * 把 llmRequest + section registry 折叠成可观测的 LLMCallSnapshot，与主循环解耦。
 */
import {
  SYSTEM_SECTION_NAMES,
} from '../contracts/wire-protocol.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
} from '../contracts/conversation.js';
import type {
  LLMCallMessageSummary,
  LLMCallSectionSummary,
  LLMCallSnapshot,
  LLMCallToolSummary,
  SystemSection,
} from '../contracts/wire-protocol.js';
import type {
  ContentBlock,
  InternalMessageMarker,
  Message,
} from '../contracts/conversation.js';
import type {
  LLMRequest,
  LLMRequestMetadata,
} from '../contracts/model-llm.js';
import { firstMessageText } from '../context/injection-position.js';
import { flattenSystemPrompt } from '../context/system-prompt-text.js';

export const CONTENT_PREVIEW_LIMIT = Infinity;

const INTERNAL_MARKER_SOURCES: ReadonlyArray<readonly [
  InternalMessageMarker,
  LLMCallMessageSummary['source'],
]> = [
  [INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION, 'context_injection'],
  [INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT, 'context_injection'],
  [INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION, 'memory_recall'],
  [INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION, 'agent_profile'],
  [INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE, 'agent_profile'],
  [INTERNAL_MESSAGE_MARKERS.LSP_DIAGNOSTICS_INJECTION, 'lsp_diagnostics'],
  [INTERNAL_MESSAGE_MARKERS.TOOL_EVICTION_NOTICE, 'tool_eviction_notice'],
  [INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION, 'mode_reminder'],
  [INTERNAL_MESSAGE_MARKERS.MODE_TRANSITION_REMINDER, 'mode_transition_reminder'],
  [INTERNAL_MESSAGE_MARKERS.TODO_STATE_INJECTION, 'active_todos'],
  [INTERNAL_MESSAGE_MARKERS.RELEVANT_RECALL_INJECTION, 'relevant_recall'],
  [INTERNAL_MESSAGE_MARKERS.TODO_COMPLETION_NUDGE, 'todo_completion_nudge'],
  [INTERNAL_MESSAGE_MARKERS.PROJECT_RULES_INJECTION, 'project_rules'],
  [INTERNAL_MESSAGE_MARKERS.CONTINUATION, 'continuation'],
  [INTERNAL_MESSAGE_MARKERS.TOOL_INJECTED, 'tool_injected'],
];

const SYSTEM_AUTHORED_SOURCES = new Set<LLMCallMessageSummary['source']>([
  ...INTERNAL_MARKER_SOURCES.map(([, source]) => source),
  'compaction_summary',
]);

export function classifyMessageSource(
  msg: Message,
  index: number,
  messages: Message[],
): LLMCallMessageSummary['source'] {
  // marker 优先：in-memory marker 在 snapshot 构建时仍挂在 llmRequest.messages 上，
  // 比文本启发式稳，且不受注入位置影响（ 后 context/memory 不再在 messages[0]
  // 而是注入到当前 user 之前）。旧的 `text.includes('<context>')` 启发式因 wrapper
  // 早已升级为 `<context type="environment">` 而失效——会把注入块错标成 history。
  for (const [marker, source] of INTERNAL_MARKER_SOURCES) {
    if (hasInternalMarker(msg, marker)) return source;
  }

  const blocks = Array.isArray(msg.content) ? msg.content as ContentBlock[] : [];

  if (blocks.some((b) => b.type === 'tool_result')) return 'tool_result';

  if (msg.role === 'user') {
    // context / memory / rules / historical 已在上文按 in-memory marker 判定；compaction
    // summary 无 marker，靠落库文本特征 `[对话摘要]` 识别（沿用 release）。用合并后的
    // 共享 firstMessageText（旧 extractTextFromMessage 已在  删除）。旧 `<context>`
    // 文本启发式弃用——wrapper 已升级为 `<context type="environment">` 且走 marker。
    if (firstMessageText(msg)?.includes('[对话摘要]')) return 'compaction_summary';
    // 历史里丢了 in-memory marker 的旧注入块（持久化→重载后 marker 不在）走 history
    // 兜底。真用户锚点：最后一条非 tool_result 的 user 当 user_input，其余当 history。
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      const mBlocks = Array.isArray(m.content) ? m.content as ContentBlock[] : [];
      if (mBlocks.some((b) => b.type === 'tool_result')) continue;
      return i === index ? 'user_input' : 'history';
    }
    return 'history';
  }

  return 'history';
}

/**
 * 把 base system prompt 按顶级 XML tag（<identity>, <custom_rules> 等）拆分成独立 section。
 * 未被任何 XML tag 包裹的文本归入 "preamble"（通常不存在）。
 */
export function parseBasePromptSections(text: string): LLMCallSectionSummary[] {
  const sections: LLMCallSectionSummary[] = [];
  const tagPattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let lastIndex = 0;

  for (const match of text.matchAll(tagPattern)) {
    if (match.index != null && match.index > lastIndex) {
      const gap = text.slice(lastIndex, match.index).trim();
      if (gap.length > 0) {
        sections.push({ name: 'preamble', source: 'base-prompt', charCount: gap.length, contentPreview: gap.slice(0, CONTENT_PREVIEW_LIMIT) });
      }
    }
    const tagName = match[1];
    const content = match[2];
    sections.push({
      name: tagName,
      source: 'base-prompt',
      charCount: content.length,
      contentPreview: content.slice(0, CONTENT_PREVIEW_LIMIT),
    });
    lastIndex = (match.index ?? 0) + match[0].length;
  }

  if (sections.length === 0) {
    sections.push({ name: 'base_prompt', source: 'config', charCount: text.length, contentPreview: text.slice(0, CONTENT_PREVIEW_LIMIT) });
  }
  return sections;
}

export function buildLLMCallSnapshot(
  llmRequest: LLMRequest,
  iteration: number,
  runId: string,
  sectionRegistry: SystemSection[],
  requestMetadata?: LLMRequestMetadata,
): LLMCallSnapshot {
  const systemFullText = flattenSystemPrompt(llmRequest.system);

  const sectionSummaries: LLMCallSectionSummary[] = [];

  // base_prompt 条目拆分为独立 XML section
  for (const s of sectionRegistry) {
    if (s.name === SYSTEM_SECTION_NAMES.base_prompt) {
      sectionSummaries.push(...parseBasePromptSections(s.content));
    } else {
      sectionSummaries.push({
        name: s.name,
        source: s.source,
        charCount: s.charCount,
        contentPreview: s.content.slice(0, CONTENT_PREVIEW_LIMIT),
      });
    }
  }

  const messages: LLMCallMessageSummary[] = llmRequest.messages.map((msg, i) => {
    const source = classifyMessageSource(msg, i, llmRequest.messages);
    const isText = typeof msg.content === 'string';
    const raw = isText
      ? (msg.content as string)
      : JSON.stringify(msg.content);
    return {
      // snapshots.jsonl 是持久化审计，不是 provider wire payload。内部注入在这里
      // 记录真实作者 system；仅 llmRequest 送 provider 时保留协议要求的 user。
      role: SYSTEM_AUTHORED_SOURCES.has(source) ? 'system' : msg.role,
      source,
      format: isText ? 'text' : 'blocks',
      contentPreview: raw.slice(0, CONTENT_PREVIEW_LIMIT),
      charCount: raw.length,
    };
  });

  const tools: LLMCallToolSummary[] = (llmRequest.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  }));

  return {
    timestamp: Date.now(),
    timestampISO: new Date().toISOString(),
    runId,
    iterationId: `${runId}:${iteration}`,
    phase: 'request',
    iteration,
    model: llmRequest.model,
    ...requestMetadata,
    maxTokens: llmRequest.maxTokens,
    temperature: llmRequest.temperature,
    requestSource: llmRequest.requestSource,
    system: {
      sections: sectionSummaries,
      charCount: systemFullText.length,
    },
    messages,
    messageCount: messages.length,
    tools,
    toolCount: tools.length,
  };
}
