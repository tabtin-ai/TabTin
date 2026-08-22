import { createHash, randomUUID } from 'node:crypto';
import type {
  ContentBlock,
  MessageParam,
  SystemBlock,
  ToolParam,
} from '../engine/contracts/conversation.js';
import { AgentError } from '../engine/contracts/kernel.js';
import type {
  ContentBlockEnvelopeHint,
  LLMProvider,
  LLMRequest,
  LLMRequestMetadata,
  LLMResponseChunk,
} from '../engine/contracts/model-llm.js';
import { ContentBlockEvents } from '../engine/contracts/stream-events.js';
import type { WireContentBlock } from '../engine/contracts/wire-payloads.js';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../prompts/engine/dynamic-boundary.js';

export type CodexAuthResolver = () => Promise<{
  accessToken: string;
  accountId: string;
}>;

export type LocalCodexParamOverrides = Record<string, string | number | boolean | null>;

export type PromptCacheFallbackDiagnostic = {
  model: string;
  status: number;
  errorCode?: string;
  errorMessage: string;
  requestId?: string;
};

/** 与 Django / Electron LLM 图改写默认单图上限对齐。 */
export const LOCAL_CODEX_IMAGE_DATA_URL_MAX_BYTES = 5 * 1024 * 1024;

export type LocalCodexResponsesProviderOptions = {
  resolveAuth: CodexAuthResolver;
  baseUrl?: string;
  originator?: string;
  fetchImpl?: typeof fetch;
  /**
   * 把非 data: 的图片 URL 拉成本机可达内容再转 data URL。
   * Codex 上游会自行 GET image_url；本机 local-object / 私网图对它不可达（常见 407），
   * 必须在 Electron 侧内联后再出网。
   */
  resolveRemoteImageUrl?: (url: string) => Promise<string>;
  /** Session 级 runtime profile（thinking_mode / reasoning_effort）；与 Proxy 同源 Map。 */
  requestParamOverrides?:
    | LocalCodexParamOverrides
    | (() => LocalCodexParamOverrides | undefined);
  /** 业务对话标识；Codex provider 内部负责映射到上游传输头。 */
  threadId?: string;
  /** Reports cache-parameter rejection without exposing prompt or credential content. */
  onPromptCacheFallback?: (diagnostic: PromptCacheFallbackDiagnostic) => void;
};

type ResponsesContentPart =
  | {
    type: 'input_text' | 'output_text';
    text: string;
  }
  | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' };

type ResponsesInputItem =
  | { role: 'user' | 'assistant' | 'developer'; content: ResponsesContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

type ResponsesEvent = {
  type?: unknown;
  message?: unknown;
  delta?: unknown;
  name?: unknown;
  item_id?: unknown;
  arguments?: unknown;
  item?: unknown;
  response?: unknown;
  error?: unknown;
};

/**
 * ：LocalCodex 必须经 `onContentBlockEvent` 推 content_block_*，
 * 前端 BlockTimeline 才有字；仅 yield text_delta 会空气泡。
 */
type BlockEnvelopeState = {
  onEvent: ((hint: ContentBlockEnvelopeHint) => void) | undefined;
  blockIndex: number;
  activeKind: 'text' | 'thinking' | 'tool_use' | null;
};

type StreamState = {
  sawToolUse: boolean;
  stopReason: NonNullable<LLMResponseChunk['stopReason']>;
  usage?: LLMResponseChunk['usage'];
  emittedToolIds: Set<string>;
  envelope: BlockEnvelopeState;
};

export class LocalCodexResponsesProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly originator: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: LocalCodexResponsesProviderOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://chatgpt.com/backend-api').replace(/\/+$/, '');
    this.originator = options.originator ?? 'tabtin';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
    const auth = await this.options.resolveAuth();
    const requestId = randomUUID();
    const sessionId = this.options.threadId ?? requestId;
    const materialized = await materializeRemoteImagesInRequest(
      request,
      this.options.resolveRemoteImageUrl
        ?? ((url) => fetchUrlAsDataUrl(url, this.fetchImpl, request.signal)),
    );
    const overrides = this.resolveParamOverrides();
    const cachedBody = buildRequestBody(
      materialized,
      overrides,
      auth.accountId,
    );
    const post = (body: Record<string, unknown>): Promise<Response> => this.fetchImpl(
      resolveResponsesUrl(this.baseUrl),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          'chatgpt-account-id': auth.accountId,
          'OpenAI-Beta': 'responses=experimental',
          accept: 'text/event-stream',
          'content-type': 'application/json',
          originator: this.originator,
          'session-id': sessionId,
          'x-client-request-id': requestId,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      },
    );

    let response: Response;
    try {
      response = await post(cachedBody);
      if (!response.ok && hasPromptCacheFields(cachedBody) && response.status === 400) {
        const responseBody = await response.text().catch(() => '');
        if (!isPromptCacheCompatibilityError(responseBody)) {
          throw await buildHttpError(response, responseBody);
        }
        this.options.onPromptCacheFallback?.({
          model: materialized.model,
          status: response.status,
          ...readPromptCacheFallbackError(responseBody),
          ...readRequestId(response.headers),
        });
        response = await post(buildRequestBody(materialized, overrides));
      }
    } catch (error) {
      throw mapCodexTransportError(error);
    }

    if (!response.ok) {
      throw await buildHttpError(response);
    }
    if (!response.body) {
      throw new AgentError('Codex 未返回响应内容', 'LLM_ERROR');
    }

    const state: StreamState = {
      sawToolUse: false,
      stopReason: 'end_turn',
      emittedToolIds: new Set(),
      envelope: {
        onEvent: request.onContentBlockEvent,
        blockIndex: -1,
        activeKind: null,
      },
    };

    for await (const data of readSseData(response.body, request.signal)) {
      if (data === '[DONE]') break;
      const event = parseEvent(data);
      if (!event) continue;
      for (const chunk of processEvent(event, state)) yield chunk;
    }

    closeActiveBlock(state.envelope);
    state.envelope.onEvent?.({
      kind: ContentBlockEvents.MESSAGE_DELTA,
      delta: { stop_reason: state.sawToolUse ? 'tool_use' : state.stopReason },
    });
    if (state.usage) yield { type: 'usage', usage: state.usage };
    yield { type: 'stop', stopReason: state.sawToolUse ? 'tool_use' : state.stopReason };
  }

  private resolveParamOverrides(): LocalCodexParamOverrides | undefined {
    const raw = this.options.requestParamOverrides;
    if (typeof raw === 'function') return raw();
    return raw;
  }

  getRequestMetadata(_request: LLMRequest): LLMRequestMetadata {
    return {
      providerChannel: 'local_codex',
      ...metadataFromParamOverrides(this.resolveParamOverrides()),
    };
  }
}

function resolveResponsesUrl(baseUrl: string): string {
  return `${baseUrl}${baseUrl.endsWith('/codex') ? '' : '/codex'}/responses`;
}

function buildRequestBody(
  request: LLMRequest,
  overrides?: LocalCodexParamOverrides,
  promptCacheScope?: string,
): Record<string, unknown> {
  const messageInput = request.messages.flatMap(convertMessage);
  const system = stringifySystem(request.system) || 'You are a helpful assistant.';
  const tools = convertTools(request.tools);
  const cachePlan = promptCacheScope
    ? buildPromptCachePlan(promptCacheScope, request.model, system, tools)
    : undefined;
  const input = cachePlan
    ? [...cachePlan.inputPrefix, ...messageInput]
    : messageInput;
  // ChatGPT Codex Responses 拒绝 store:true（Pi：Store must be set to false）。
  // 同样拒绝 max_output_tokens / temperature（上游自管输出预算）。
  const body: Record<string, unknown> = {
    model: request.model,
    store: false,
    stream: true,
    input: input.length > 0 ? input : [{ role: 'user', content: [{ type: 'input_text', text: '.' }] }],
    parallel_tool_calls: true,
  };
  body.instructions = cachePlan?.stableInstructions ?? system;
  if (cachePlan) {
    body.prompt_cache_key = cachePlan.key;
  }
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = request.toolChoice ?? 'auto';
  }
  const effort = resolveReasoningEffort(overrides);
  if (effort) {
    body.reasoning = { effort };
  }
  // Fast 与思考强度独立。ChatGPT Codex 后端只认 wire 值 priority
  //（config/UI 侧的 fast 是别名；裸传 fast 会 400 Unsupported service_tier）。
  const serviceTier = resolveServiceTier(overrides);
  if (serviceTier) {
    body.service_tier = serviceTier;
  }
  return body;
}

const PROMPT_CACHE_ANCHOR = 'Apply the preceding instructions throughout this response.';

type PromptCachePlan = {
  key: string;
  stableInstructions: string;
  inputPrefix: ResponsesInputItem[];
};

function buildPromptCachePlan(
  scope: string,
  model: string,
  system: string,
  tools: Array<Record<string, unknown>>,
): PromptCachePlan {
  const { stable, dynamic } = splitSystemPrompt(system);
  const stableInstructions = stable || 'You are a helpful assistant.';
  const digest = createHash('sha256')
    .update(scope)
    .update('\0')
    .update(model)
    .update('\0')
    .update(stableInstructions)
    .update('\0')
    .update(JSON.stringify(tools))
    .digest('hex');
  const inputPrefix: ResponsesInputItem[] = [{
    role: 'developer',
    content: [{
      type: 'input_text',
      text: PROMPT_CACHE_ANCHOR,
    }],
  }];
  if (dynamic) {
    inputPrefix.push({
      role: 'developer',
      content: [{ type: 'input_text', text: dynamic }],
    });
  }
  return {
    // Keep the routing key within the Responses API's 64-character string limit.
    key: digest,
    stableInstructions,
    inputPrefix,
  };
}

function splitSystemPrompt(system: string): { stable: string; dynamic?: string } {
  const marker = SYSTEM_PROMPT_DYNAMIC_BOUNDARY.trim();
  const boundaryIndex = system.indexOf(marker);
  const stableCandidate = boundaryIndex < 0
    ? system
    : system.slice(0, boundaryIndex).trimEnd();
  const markerDynamic = boundaryIndex < 0
    ? ''
    : system.slice(boundaryIndex + marker.length).trimStart();
  const { stable, runtimeEnvironment } = extractRuntimeEnvironment(stableCandidate);
  const dynamic = [runtimeEnvironment, markerDynamic].filter(Boolean).join('\n\n');
  return { stable, ...(dynamic ? { dynamic } : {}) };
}

function extractRuntimeEnvironment(system: string): {
  stable: string;
  runtimeEnvironment?: string;
} {
  const match = /(?:^|\n)(<environment>\n[\s\S]*?\n<\/environment>)(?=\n|$)/.exec(system);
  if (!match || match.index === undefined) return { stable: system };
  const before = system.slice(0, match.index).trimEnd();
  const after = system.slice(match.index + match[0].length).trimStart();
  return {
    stable: [before, after].filter(Boolean).join('\n\n'),
    runtimeEnvironment: match[1],
  };
}

function hasPromptCacheFields(body: Record<string, unknown>): boolean {
  return typeof body.prompt_cache_key === 'string';
}

function isPromptCacheCompatibilityError(body: string): boolean {
  return /prompt_cache|cache breakpoint|developer.*role|role.*developer/i.test(body);
}

function readPromptCacheFallbackError(body: string): Pick<
  PromptCacheFallbackDiagnostic,
  'errorCode' | 'errorMessage'
> {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = readRecord(parsed.error);
    const errorMessage = stringValue(error?.message)
      ?? stringValue(parsed.message)
      ?? stringValue(parsed.detail)
      ?? 'Codex rejected prompt cache parameters';
    const errorCode = stringValue(error?.code) ?? stringValue(parsed.code);
    return { errorMessage, ...(errorCode ? { errorCode } : {}) };
  } catch {
    return { errorMessage: 'Codex rejected prompt cache parameters' };
  }
}

function readRequestId(headers: Headers): Pick<PromptCacheFallbackDiagnostic, 'requestId'> {
  const requestId = headers.get('x-request-id')
    ?? headers.get('openai-request-id')
    ?? headers.get('cf-ray');
  return requestId ? { requestId } : {};
}

/**
 * 将 session 意图映射为 Responses `reasoning.effort`。
 * off / none → none（关推理，不是 Fast）；standard→medium；deep→high；
 * 显式 reasoning_effort 按官方档位透传（low / medium / high / xhigh / max）。
 */
export function resolveReasoningEffort(
  overrides?: LocalCodexParamOverrides,
): string | undefined {
  if (!overrides) return undefined;

  if (typeof overrides.reasoning_effort === 'string') {
    const effort = overrides.reasoning_effort.trim().toLowerCase();
    if (effort === 'off' || effort === 'none' || effort === 'disabled') return 'none';
    if (
      effort === 'low'
      || effort === 'medium'
      || effort === 'high'
      || effort === 'xhigh'
      || effort === 'max'
    ) {
      return effort;
    }
  }

  if (typeof overrides.thinking_mode === 'string') {
    const mode = overrides.thinking_mode.trim().toLowerCase();
    if (mode === 'off') return 'none';
    if (mode === 'standard') return 'medium';
    if (mode === 'deep') return 'high';
  }

  return undefined;
}

/**
 * Fast 开关 → Codex 出网 `service_tier`。
 * UI/overrides 可写 `fast` 或 `priority`；打到 chatgpt.com Codex 时统一发 `priority`
 *（与官方 Codex CLI 一致；传 `fast` 会被拒）。
 */
export function resolveServiceTier(
  overrides?: LocalCodexParamOverrides,
): 'priority' | undefined {
  if (!overrides) return undefined;
  if (typeof overrides.service_tier !== 'string') return undefined;
  const tier = overrides.service_tier.trim().toLowerCase();
  if (tier === 'fast' || tier === 'priority') return 'priority';
  return undefined;
}

function metadataFromParamOverrides(
  overrides?: LocalCodexParamOverrides,
): Pick<LLMRequestMetadata, 'reasoningEffort' | 'serviceTier'> {
  const reasoningEffort = resolveReasoningEffort(overrides);
  const serviceTier = resolveServiceTier(overrides);
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

function convertMessage(message: MessageParam): ResponsesInputItem[] {
  const role = message.role === 'system' ? 'user' : message.role;
  const blocks = typeof message.content === 'string'
    ? [{ type: 'text' as const, text: message.content }]
    : message.content;
  const input: ResponsesInputItem[] = [];

  if (role === 'assistant') {
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      input.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
      });
    }
  } else {
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      input.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: stringifyContent(block.content),
      });
    }
  }

  const contentParts = collectMessageContentParts(role, blocks);
  if (contentParts.length > 0 || input.length === 0) {
    input.push({
      role,
      content: contentParts.length > 0
        ? contentParts
        : [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: '' }],
    });
  }
  return input;
}

function collectMessageContentParts(
  role: MessageParam['role'],
  blocks: ContentBlock[] | Array<{ type: 'text'; text: string }>,
): ResponsesContentPart[] {
  const parts: ResponsesContentPart[] = [];
  const textType = role === 'assistant' ? 'output_text' as const : 'input_text' as const;

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) parts.push({ type: textType, text: block.text });
      continue;
    }
    // 仅 user 侧发图；assistant 历史图忽略（Responses 出网契约）。
    if (role === 'user' && block.type === 'image') {
      const imageUrl = resolveImageUrl(block);
      if (imageUrl) {
        parts.push({
          type: 'input_image',
          image_url: imageUrl,
          detail: block.detail ?? 'auto',
        });
      }
    }
  }
  return parts;
}

function resolveImageUrl(block: Extract<ContentBlock, { type: 'image' }>): string | null {
  if (block.source.type === 'url') {
    const url = block.source.url?.trim();
    return url || null;
  }
  if (block.source.type === 'base64') {
    const data = block.source.data?.trim();
    const mediaType = block.source.media_type?.trim() || 'image/png';
    if (!data) return null;
    return `data:${mediaType};base64,${data}`;
  }
  return null;
}

async function materializeRemoteImagesInRequest(
  request: LLMRequest,
  resolveRemoteImageUrl: (url: string) => Promise<string>,
): Promise<LLMRequest> {
  const cache = new Map<string, Promise<string>>();
  const resolveOnce = (url: string): Promise<string> => {
    const existing = cache.get(url);
    if (existing) return existing;
    const pending = resolveRemoteImageUrl(url).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AgentError(
        `Codex 无法读取本机图片（请确认附件仍可打开后再试）：${detail}`,
        'LLM_ERROR',
      );
    });
    cache.set(url, pending);
    return pending;
  };

  const messages = await Promise.all(request.messages.map(async (message) => {
    if (!Array.isArray(message.content)) return message;
    const content = await Promise.all(message.content.map(async (block) => {
      if (block.type !== 'image' || block.source.type !== 'url') return block;
      const url = block.source.url?.trim();
      if (!url || url.startsWith('data:')) return block;
      return {
        ...block,
        source: { type: 'url' as const, url: await resolveOnce(url) },
      };
    }));
    return { ...message, content };
  }));

  return { ...request, messages };
}

async function fetchUrlAsDataUrl(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > LOCAL_CODEX_IMAGE_DATA_URL_MAX_BYTES) {
    throw new Error(
      `图片过大（${buffer.byteLength} bytes，上限 ${LOCAL_CODEX_IMAGE_DATA_URL_MAX_BYTES}）`,
    );
  }
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
  const mime = contentType && contentType.startsWith('image/')
    ? contentType
    : 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function stringifyContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

function stringifySystem(system: string | SystemBlock[] | undefined): string | undefined {
  if (typeof system === 'string') return system || undefined;
  const text = system?.map(block => block.text).filter(Boolean).join('\n\n');
  return text || undefined;
}

function convertTools(tools: ToolParam[] | undefined): Array<Record<string, unknown>> {
  return (tools ?? []).map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }));
}

async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new AgentError('Run aborted', 'ABORT');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('\n');
        if (data) yield data;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
    reader.releaseLock();
  }
}

function parseEvent(data: string): ResponsesEvent | null {
  try {
    const event = JSON.parse(data);
    return event && typeof event === 'object' ? event as ResponsesEvent : null;
  } catch {
    return null;
  }
}

function processEvent(event: ResponsesEvent, state: StreamState): LLMResponseChunk[] {
  const eventType = stringValue(event.type);
  if (eventType === 'response.output_text.delta') {
    const delta = stringValue(event.delta);
    if (!delta) return [];
    ensureTextBlock(state.envelope);
    emitBlockDelta(state.envelope, { type: 'text_delta', text: delta });
    return [{ type: 'text_delta', text: delta }];
  }
  if (eventType === 'response.function_call_arguments.done') {
    return emitToolUse(event, state);
  }
  if (eventType === 'response.output_item.done') {
    return emitToolUse(event.item, state);
  }
  if (eventType === 'response.incomplete') {
    state.stopReason = 'max_tokens';
    state.usage = readResponseUsage(event.response) ?? state.usage;
    return [];
  }
  if (eventType === 'response.completed') {
    state.usage = readResponseUsage(event.response) ?? state.usage;
    return [];
  }
  if (eventType === 'response.failed' || eventType === 'error') {
    throw buildStreamError(event);
  }
  return [];
}

function emitToolUse(value: unknown, state: StreamState): LLMResponseChunk[] {
  const toolUse = readToolUse(value);
  if (!toolUse || state.emittedToolIds.has(toolUse.id)) return [];
  state.emittedToolIds.add(toolUse.id);
  state.sawToolUse = true;
  const input = coerceToolInput(toolUse.input);
  startBlock(state.envelope, 'tool_use', {
    type: 'tool_use',
    id: toolUse.id,
    name: toolUse.name,
    input,
  });
  closeActiveBlock(state.envelope);
  return [{ type: 'tool_use', toolUse }];
}

function ensureTextBlock(envelope: BlockEnvelopeState): void {
  if (envelope.activeKind === 'text') return;
  startBlock(envelope, 'text', { type: 'text', text: '' });
}

function closeActiveBlock(envelope: BlockEnvelopeState): void {
  if (envelope.activeKind === null) return;
  const idxToClose = envelope.blockIndex;
  envelope.onEvent?.({ kind: ContentBlockEvents.CONTENT_BLOCK_STOP, index: idxToClose });
  envelope.activeKind = null;
}

function startBlock(
  envelope: BlockEnvelopeState,
  kind: 'text' | 'thinking' | 'tool_use',
  block: WireContentBlock,
): void {
  if (envelope.activeKind !== null) closeActiveBlock(envelope);
  envelope.blockIndex += 1;
  envelope.activeKind = kind;
  envelope.onEvent?.({
    kind: ContentBlockEvents.CONTENT_BLOCK_START,
    index: envelope.blockIndex,
    block_id: `blk_${randomUUID()}`,
    block,
  });
}

function emitBlockDelta(
  envelope: BlockEnvelopeState,
  delta: Extract<ContentBlockEnvelopeHint, { kind: 'agent.stream.content_block_delta' }>['delta'],
): void {
  if (envelope.activeKind === null || envelope.blockIndex < 0) return;
  envelope.onEvent?.({
    kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
    index: envelope.blockIndex,
    delta,
  });
}

function coerceToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { value: input };
}

function readResponseUsage(response: unknown): LLMResponseChunk['usage'] | undefined {
  return response && typeof response === 'object'
    ? readUsage((response as Record<string, unknown>).usage)
    : undefined;
}

function readToolUse(value: unknown): LLMResponseChunk['toolUse'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (item.type !== 'function_call' && !stringValue(item.name)) return undefined;
  const name = stringValue(item.name);
  const id = stringValue(item.call_id) ?? stringValue(item.item_id) ?? stringValue(item.id) ?? name;
  if (!name || !id) return undefined;
  const argumentsText = stringValue(item.arguments) ?? '{}';
  let input: unknown = argumentsText;
  try { input = JSON.parse(argumentsText); } catch { /* preserve malformed arguments */ }
  return { id, name, input };
}

function readUsage(value: unknown): LLMResponseChunk['usage'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = numberValue(usage.input_tokens);
  const outputTokens = numberValue(usage.output_tokens);
  const totalTokens = numberValue(usage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  // ：Responses API 把缓存/推理明细放在 *_details 子对象里；丢弃它们会让
  // 缓存命中完全不可观测（ 根因 2）。归一化到 UsageReport 既有字段。
  //
  // 口径对齐（与 proxy-provider readSSECacheTokens 同语义）：内部 UsageReport
  // 是 Anthropic 口径——input_tokens **不含**缓存读。OpenAI Responses 的
  // input_tokens **已含** cached_tokens（明细是子集），因此明细形态要从
  // input 里减掉，否则下游 calibrateUsageAnchor 按 input+cacheRead 求和会
  // 重复计数（缓存命中高时 input 侧虚高 ~2x）。顶层 cache_read_input_tokens
  // 形态视为 Anthropic 口径，不减。
  const inputDetails = readRecord(usage.input_tokens_details);
  const outputDetails = readRecord(usage.output_tokens_details);
  const detailsCached = numberValue(inputDetails?.cached_tokens);
  const detailsCreated = numberValue(inputDetails?.cache_write_tokens);
  const topCached = numberValue(usage.cache_read_input_tokens);
  const topCreated = numberValue(usage.cache_creation_input_tokens);
  const cachedTokens = topCached ?? detailsCached;
  const createdTokens = topCreated ?? detailsCreated;
  const includedCached = topCached === undefined ? (detailsCached ?? 0) : 0;
  const includedCreated = topCreated === undefined ? (detailsCreated ?? 0) : 0;
  const normalizedInput = inputTokens !== undefined
    ? Math.max(inputTokens - includedCached - includedCreated, 0)
    : inputTokens;
  const reasoningTokens = numberValue(outputDetails?.reasoning_tokens)
    ?? numberValue(usage.reasoning_tokens);
  return {
    ...(normalizedInput !== undefined ? { input_tokens: normalizedInput } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
    ...(cachedTokens !== undefined ? { cache_read_input_tokens: cachedTokens } : {}),
    ...(createdTokens !== undefined ? { cache_creation_input_tokens: createdTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
  };
}

function mapCodexTransportError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (isAbortLikeError(error)) {
    return new AgentError('Codex 请求已取消', 'LLM_ERROR', { retryable: false });
  }
  const detail = formatTransportErrorDetail(error);
  return new AgentError(
    `连接 ChatGPT Codex 失败，请检查网络后重试${detail ? `（${detail}）` : ''}`,
    'LLM_ERROR',
    {
      retryable: true,
      details: {
        networkError: true,
        stage: 'codex_responses_transport',
      },
    },
  );
}

function formatTransportErrorDetail(error: unknown): string {
  const chain: unknown[] = [error];
  const nested = error && typeof error === 'object' && 'cause' in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  if (nested) chain.push(nested);
  for (const item of chain) {
    if (!item || typeof item !== 'object') continue;
    const code = 'code' in item && typeof item.code === 'string' ? item.code : '';
    if (code) return code;
  }
  if (error instanceof Error && error.message && error.message !== 'fetch failed') {
    return error.message.slice(0, 120);
  }
  return '';
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('name' in error && (error as { name?: string }).name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /aborted|AbortError/i.test(message);
}

async function buildHttpError(response: Response, responseBody?: string): Promise<AgentError> {
  const body = responseBody ?? await response.text().catch(() => '');
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 240);
  const message = response.status === 401
    ? 'ChatGPT 登录已失效，请重新登录后继续。'
    : isQuotaError(response.status, body)
      ? 'Codex 额度已用尽'
      : detail
        ? `Codex 请求失败（${response.status}）：${detail}`
        : `Codex 请求失败（${response.status}）`;
  return new AgentError(message, 'LLM_ERROR', {
    statusCode: response.status,
    retryable: false,
  });
}

function buildStreamError(event: ResponsesEvent): AgentError {
  const response = event.response && typeof event.response === 'object'
    ? event.response as Record<string, unknown>
    : undefined;
  const nestedResponseError = response?.error;
  const details: Record<string, unknown> = event.error && typeof event.error === 'object'
    ? event.error as Record<string, unknown>
    : nestedResponseError && typeof nestedResponseError === 'object'
      ? nestedResponseError as Record<string, unknown>
      : event as Record<string, unknown>;
  const message = stringValue(details.message) ?? 'Codex 响应失败';
  const errorType = stringValue(details.type);
  const providerErrorCode = stringValue(details.code);
  const isServerError = errorType === 'server_error'
    || providerErrorCode === 'internal_error'
    || providerErrorCode === 'server_error';
  return new AgentError(
    isQuotaError(undefined, message) ? 'Codex 额度已用尽' : message,
    'LLM_ERROR',
    {
      ...(isServerError ? { statusCode: 500 } : {}),
      retryable: isServerError,
      details: {
        stage: 'codex_responses_stream',
        ...(errorType ? { error_type: errorType } : {}),
        ...(providerErrorCode ? { provider_error_code: providerErrorCode } : {}),
      },
    },
  );
}

function isQuotaError(status: number | undefined, message: string): boolean {
  if (status === 402 || status === 429) return true;
  return /(quota|usage limit|rate limit|credit|额度|限额)/i.test(message);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
