import type { ContentBlockEnvelopeHint } from '../contracts/model-llm.js';
import type { ToolCallMetadata } from '../contracts/tools.js';

const RESERVED_TOOL_CALL_METADATA_KEYS = new Set(['intent', 'explanation']);

function schemaDeclaresProperty(
  schema: Record<string, unknown> | undefined,
  key: string,
): boolean {
  const properties = schema?.properties;
  return Boolean(
    properties
    && typeof properties === 'object'
    && !Array.isArray(properties)
    && Object.prototype.hasOwnProperty.call(properties, key),
  );
}

function normalizeIntent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasToolCallMetadata(metadata: ToolCallMetadata): boolean {
  return typeof metadata.intent === 'string' && metadata.intent.length > 0;
}

export function stripToolCallMetadata(
  input: unknown,
  toolInputSchema?: Record<string, unknown>,
): {
  toolInput: unknown;
  toolCallMetadata?: ToolCallMetadata;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { toolInput: input };
  }

  const source = input as Record<string, unknown>;
  const metadata: ToolCallMetadata = {};
  const runtimeOwnsIntent = !schemaDeclaresProperty(toolInputSchema, 'intent');
  const runtimeOwnsExplanation = !schemaDeclaresProperty(toolInputSchema, 'explanation');
  const intent = (runtimeOwnsIntent ? normalizeIntent(source.intent) : undefined)
    ?? (runtimeOwnsExplanation ? normalizeIntent(source.explanation) : undefined);
  if (intent) metadata.intent = intent;

  let stripped: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(source)) {
    if (
      RESERVED_TOOL_CALL_METADATA_KEYS.has(key)
      && !schemaDeclaresProperty(toolInputSchema, key)
    ) continue;
    stripped ??= {};
    stripped[key] = value;
  }

  return {
    toolInput: stripped ?? {},
    ...(hasToolCallMetadata(metadata) ? { toolCallMetadata: metadata } : {}),
  };
}

export function stripToolCallMetadataFromEnvelopeHint(
  hint: ContentBlockEnvelopeHint,
  toolInputSchema?: Record<string, unknown>,
): ContentBlockEnvelopeHint {
  if (hint.kind !== 'agent.stream.content_block_start') return hint;
  if (!('input' in hint.block)) return hint;
  const { toolInput } = stripToolCallMetadata(hint.block.input, toolInputSchema);
  return {
    ...hint,
    block: {
      ...hint.block,
      input: toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
        ? toolInput as Record<string, unknown>
        : {},
    },
  };
}

export function buildToolCallMetadataLifecycleMeta(
  metadata: ToolCallMetadata | undefined,
): Record<string, unknown> {
  if (!metadata || !hasToolCallMetadata(metadata)) return {};
  return { tool_call_metadata: metadata };
}

export function buildToolCallMetadataContract(): string {
  return [
    '<tool_call_metadata>',
    '当你调用任何工具时，可以在工具入参顶层附带一次运行时元数据字段 `intent`，用一句话说明这次调用要达成的用户可见目的。',
    '这个字段由 agent runtime 原生接收，不属于任何单个工具的业务参数；runtime 会在校验和执行前移除它，工具实现不会收到它。',
    '不要为每个工具重复声明类似 explanation / purpose / rationale 字段；除非工具 schema 自身明确要求，业务入参只填写该工具真正需要的数据。',
    '</tool_call_metadata>',
  ].join('\n');
}
