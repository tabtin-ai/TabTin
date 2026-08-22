/**
 * Tool → ToolParam（LLM 工具 schema）构造 + session 级稳定 memoizer
 * （跨轮 byte-identical 序列化，利于 prompt cache 前缀稳定）。自 query.ts 抽出。
 */
import type {
  ToolParam,
} from '../contracts/conversation.js';
import type {
  Tool,
} from '../contracts/tools.js';

export function buildToolParams(tools: Tool[]): ToolParam[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/**
 * Session-stable tool params memoizer. If the stringified JSON hasn't changed
 * since last call, returns the previous array reference — guaranteeing byte-
 * identical serialization across LLM requests and improving prompt cache hit
 * rate for both explicit (cache_control breakpoint) and implicit (prefix
 * stability) caching strategies.
 */
export function createStableToolParamsMemo(): (params: ToolParam[]) => ToolParam[] {
  let cachedBytes: string | undefined;
  let cachedParams: ToolParam[] | undefined;
  return (params: ToolParam[]): ToolParam[] => {
    const bytes = JSON.stringify(params);
    if (bytes === cachedBytes) return cachedParams!;
    cachedBytes = bytes;
    cachedParams = params;
    return params;
  };
}
