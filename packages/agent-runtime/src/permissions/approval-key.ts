/**
 * Approval Key — runtime 侧 legacy helper（ Stage 3b）。
 *
 * - `shouldSkipMemoize`：工具是否显式拒绝 memoize
 * - `buildApprovalKey`（legacy）：旧 memoization-layer 形态，仅保留给历史测试对照
 *
 * wire 缺 pattern_key 时的 security-policy 对齐 key 重建已迁到宿主
 * `ToolRiskPolicyPort.buildMemoPatternKey`。
 */

import type {
  Tool,
} from '../engine/contracts/tools.js';

/**
 * 稳定 JSON stringify（按 key 排序），保证同入参不同 key 顺序产生相同 hash。
 * 兼容嵌套 object / array / primitive；undefined 字段被 JSON 自动剔除。
 */
function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${stableJsonStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * 工具是否显式拒绝 memoize（getApprovalKey 返回 null / 抛错）。
 */
export function shouldSkipMemoize(tool: Tool, toolInput: unknown): boolean {
  if (typeof tool.getApprovalKey !== 'function') return false;
  try {
    const result = tool.getApprovalKey(toolInput);
    return !result || typeof result.key !== 'string' || result.key.length === 0;
  } catch {
    return true;
  }
}

/**
 * @deprecated Legacy memoization-layer key；与 judge.lookup 不对齐。保留供历史测试对照。
 */
export function buildApprovalKey(
  tool: Tool,
  toolInput: unknown,
): string | null {
  let innerKey: string;
  if (typeof tool.getApprovalKey === 'function') {
    let result: { key: string; ttlHint?: number } | null;
    try {
      result = tool.getApprovalKey(toolInput);
    } catch {
      return null;
    }
    if (!result || typeof result.key !== 'string' || !result.key) {
      return null;
    }
    innerKey = result.key;
  } else {
    innerKey = stableJsonStringify(toolInput);
  }
  const ns = tool.toolNamespace ?? '';
  return `${ns}::${tool.name.toLowerCase()}::${innerKey}`;
}
