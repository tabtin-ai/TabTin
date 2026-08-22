/**
 * HITL result 文案共享 helper（ask-tools 与 pending-single-hitl-restorer 共用）。
 *
 * 抽离原因：两条链路都需要把 tool response
 * 或 crash-resume 兜底文案安全地嵌进 tool_result content 里。原本各自实现的
 * `quote` / `truncate` / `asRecord` 只是文本安全操作，没有工具业务耦合，抽
 * 到本模块避免 copy-paste 漂移。
 *
 * 什么留在调用方：ask-tools 的 `textSnippet`（LLM OUTPUT 折行 + `MAX_LLM_VALUE_CHARS`
 * 上限）是「主循环 formatAnsweredResult」的正向文案格式化，与 restorer 的
 * 「crash-resume 已答复文案」不同语义（前者格式化用户答案给 LLM 继续，后者
 * 生成占位收敛），不合并。
 */

/** HITL 单交互 kind → 面向 LLM 的工具名（用于 restore 兜底文案里替代 tool_name）。 */
export const HITL_TOOL_LABEL_BY_KIND: Record<
  'ask_choice' | 'ask_form' | 'permission_request',
  'ask_user' | 'ask_form' | 'request_approval'
> = {
  ask_choice: 'ask_user',
  ask_form: 'ask_form',
  permission_request: 'request_approval',
};

/** 截断字符串（末尾追加省略号）；空串或短于上限时原样返回。 */
export function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 转义引号后包起来（默认 400 字符上限，与 restore / persist tool_result 文案对齐）。 */
export function quote(s: string, max = 400): string {
  return `"${truncate(String(s).replace(/"/g, '\\"'), max)}"`;
}

/** 若值是非数组对象，返回自身；否则返回空对象（restore payload 与 result 都用同一守卫）。 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 将任意 result 描述为 JSON 摘要（restore 兜底文案）；不可序列化时 fallback String()。 */
export function describeResultSummary(value: unknown, max = 400): string {
  if (value === null || value === undefined) return '（无附加内容）';
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return String(value);
  }
}
