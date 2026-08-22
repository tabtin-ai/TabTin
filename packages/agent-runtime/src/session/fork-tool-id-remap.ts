/**
 * Fork 作业：把历史里的上游 / 旧 tool_use id 重写为 TabTin `tu_*`。
 *
 * 与入站 `ToolIdMapper`（每轮 LLM 流独立）不同——fork 作业内对**同一旧 id
 * 字符串**稳定映射到同一个新 id，以保持 tool_use ↔ tool_result 配对。
 *
 *
 */

import {
  ToolIdMapper,
  isTabtinToolUseId,
} from '../engine/context/tool-id-mapper.js';

/**
 * Anthropic content block 类型 + OpenAI tool_calls[].type=function（ConversationState）。
 * 须与 Django `fork_tool_id_remap._TOOL_USE_TYPES` 保持同集（ 双端契约）。
 */
export const FORK_TOOL_USE_TYPES = [
  'tool_use',
  'tool_call',
  'function_call',
  'function',
  'server_tool_use',
  'mcp_tool_use',
] as const;

const TOOL_USE_TYPES = new Set<string>(FORK_TOOL_USE_TYPES);

/** 须与 Django `_TOOL_REF_KEYS` 同集 */
export const FORK_TOOL_REF_KEYS = [
  'tool_use_id',
  'tool_call_id',
  'toolCallId',
] as const;

function isOpenAiToolCallItem(obj: Record<string, unknown>): boolean {
  // ConversationState 的 OpenAI 形态：{ id, type: 'function', function: { name, arguments } }
  // 缺 type 的存量：必须带 function.name，避免误改任意 {id, function} 对象。
  if (typeof obj.id !== 'string' || !obj.id) return false;
  const type = typeof obj.type === 'string' ? obj.type : undefined;
  if (type && TOOL_USE_TYPES.has(type)) return true;
  if (obj.function === null || typeof obj.function !== 'object') return false;
  const name = (obj.function as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0;
}

/**
 * 深度遍历 JSON 结构，重写 tool_use.id / tool_result.tool_use_id /
 * tool_call_id 等字段。返回新对象（不改动入参）。
 */
export function remapToolIdsInValue<T>(value: T, mapper: ToolIdMapper): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => remapToolIdsInValue(item, mapper)) as T;
  }
  if (typeof value !== 'object') return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const remapId = isOpenAiToolCallItem(obj)
    || (typeof obj.type === 'string' && TOOL_USE_TYPES.has(obj.type));

  for (const [key, raw] of Object.entries(obj)) {
    if (key === 'id' && remapId && typeof raw === 'string') {
      out[key] = mapper.allocate(raw);
      continue;
    }
    if (
      (FORK_TOOL_REF_KEYS as readonly string[]).includes(key)
      && typeof raw === 'string'
      && raw.length > 0
    ) {
      out[key] = mapper.allocate(raw);
      continue;
    }
    out[key] = remapToolIdsInValue(raw, mapper);
  }
  return out as T;
}

/** 单次 fork 作业：共享 mapper，保证跨消息配对一致。可种子化云端快照。 */
export function createForkToolIdMapper(
  seed?: Readonly<Record<string, string>>,
): ToolIdMapper {
  return new ToolIdMapper(seed);
}

export { isTabtinToolUseId };
