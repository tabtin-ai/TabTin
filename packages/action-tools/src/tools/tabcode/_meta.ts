import type { AgentTool } from '../../types'
import type { ToolDomain } from '../../types/manifest'

import {
  fileReadTool,
  searchTools,
  tabcodeTools,
  fileOpsTools,
} from './index'

/**
 * TabCode manifest domain — read-only subset only.
 *
 * Write tools (write_file, edit_file, delete_file) are excluded because:
 * - Main Agent uses CLI (`tabtin code *`) via execute_in_terminal
 * - explore/plan subagents are read-only (_READONLY_DENY_TOOLS blocks writes)
 *
 * This domain exists for subagent consumption (action-tools manifest).
 * The main Agent's tool_domains does not include "action-tools".
 *
 * git_status / git_diff removed in W1 — LLM uses run_terminal_command git ...
 */
export const domain: ToolDomain<AgentTool> = {
  meta: {
    appId: 'tabcode',
    capability: 'code',
    riskLevel: 'safe',
    headless: true,
    // 白名单模式（W5 收尾反转）：tabcode 域是底层 IO / 代码搜索能力，opt-in 暴露给 LLM。
    manifestExposed: true,
  },
  groups: [
    { tools: [fileReadTool], riskLevel: 'safe', tags: ['code', 'file', 'readonly'] },
    { tools: searchTools, capability: 'code_search', riskLevel: 'safe', tags: ['code', 'search'] },
  ],
}

export { tabcodeTools, fileOpsTools, searchTools }
