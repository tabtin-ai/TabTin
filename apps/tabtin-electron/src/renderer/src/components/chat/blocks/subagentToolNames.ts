/**
 * SUBAGENT_TOOL_NAMES — 子 Agent 派发工具名的单一来源
 *
 * 抽成独立叶子模块（无 React / 无重依赖），让纯逻辑模块能引用同一份名单做「顶层
 * 派发」判定，而不必 import 整个 ToolUseBlockView 组件（避免把组件树 + 副作用注册
 * 拖进模块图、也方便单测）。
 *
 * ToolUseBlockView / BlockTimeline 仍从这里取，保持「单源集合、避免双处漂移」。
 */
import {
  normalizeAgentToolIntentInput,
  type AgentToolIntent,
} from '@tabtin/agent-runtime/subagent-intent'

export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['agent', 'task', 'Task'])

export type SubagentToolIntent = AgentToolIntent

function partialJsonHasNonEmptyString(raw: string, key: string): boolean {
  return new RegExp(`(?:^|[,{])\\s*"${key}"\\s*:\\s*"\\s*[^"\\s]`).test(raw)
}

/**
 * 流式 JSON 中数组字段只要出现任意非空字符串元素就视为该字段有效。
 * 实现上用字符串扫描而非完整解析：找到 key 后，在数组闭合前遇到第一个
 * 非空字符串即认为 wait 意图已可确定。允许前面出现空字符串或逗号。
 */
function partialJsonHasNonEmptyStringArray(raw: string, key: string): boolean {
  const match = new RegExp(`(?:^|[,{])\\s*"${key}"\\s*:\\s*\\[`).exec(raw)
  if (!match) return false
  const afterBracket = raw.slice(match.index + match[0].length)
  // 扫描数组内容，忽略空白、逗号、引号内的空串，直到遇到非空字符
  const arrayContent = afterBracket.split(']')[0] ?? ''
  return /"[^"\s]/.test(arrayContent)
}

/**
 * `agent` 是一个多态工具，UI 必须按输入表达的意图路由，不能再用“排除已知控制
 * 字段后都算派发”的方式猜测。否则每新增一个控制模式（例如 wait）都会先被误画
 * 成子任务卡。
 *
 * 完整对象直接复用 runtime 的共享归一化契约：wait → check → resume → spawn。
 * `unknown` 采用 fail-closed，不创建乐观子任务卡。流式 JSON 尚未闭合时，
 * `tryParsePartialJson` 会把原始字符串传到这里；只有看到首个有效值才进入对应视图，
 * 避免 schema 填充的空字段把真实派发误画成等待。
 */
export function classifySubagentToolInput(input: unknown): SubagentToolIntent {
  if (typeof input === 'string') {
    if (partialJsonHasNonEmptyStringArray(input, 'wait_agent_ids')) return 'wait'
    if (partialJsonHasNonEmptyString(input, 'check_agent_id')) return 'check'
    if (partialJsonHasNonEmptyString(input, 'resume_agent_id')) return 'resume'
    if (partialJsonHasNonEmptyString(input, 'prompt')) return 'spawn'
    return 'unknown'
  }
  return normalizeAgentToolIntentInput(input).intent
}

export function isSubagentDispatchInput(input: unknown): boolean {
  const intent = classifySubagentToolInput(input)
  return intent === 'spawn' || intent === 'resume'
}

export function getSubagentCheckId(input: unknown): string | null {
  if (typeof input === 'string') return null
  const normalized = normalizeAgentToolIntentInput(input)
  return normalized.intent === 'check' ? normalized.checkAgentId ?? null : null
}

export function getSubagentWaitIds(input: unknown): string[] | null {
  if (typeof input === 'string') {
    return classifySubagentToolInput(input) === 'wait' ? [] : null
  }
  const normalized = normalizeAgentToolIntentInput(input)
  return normalized.intent === 'wait' ? (normalized.waitAgentIds ?? []) : null
}
