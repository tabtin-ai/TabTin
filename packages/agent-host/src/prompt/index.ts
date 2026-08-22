/**
 * `@tabtin/agent-host/prompt` —— 宿主侧系统提示词装配（ Stage 2）。
 *
 * 引擎只消费已烘焙的 systemPrompt 字符串，或经 SystemPromptProvider 请求重烘焙。
 */

export {
  assembleSystemPrompt,
  type BakedSystemPromptInputs,
} from './system-prompt-assembler.js'
export {
  resolveSubagentSystemPrompt,
  resolveReadonlySubagentSystemPrompt,
  createSystemPromptProvider,
} from './subagent-system-prompt.js'
export { createTodoCompletionNudgeProvider } from './todo-completion-nudge.js'
