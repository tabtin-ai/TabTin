/**
 * Agent Mode 工具过滤策略。
 *
 * 本包独立于 agent-runtime，使用结构化类型 `ToolLike` 替代 engine 的 `Tool`。
 * agent-runtime 传入完整 `Tool` 对象时自动兼容（TS 结构化子类型）。
 */

import {
  AGENT_MODE_CONFIGS,
  type SerializedAgentModeToolPolicy,
} from './contract.js';
import type { AgentModeName, AgentModeToolPolicy } from './types.js';

/**
 * 最小工具接口，仅包含过滤策略所需的字段。
 * agent-runtime 的 `Tool` 类型是它的超集，传入时自动兼容。
 */
export interface ToolLike {
  name: string;
  isReadOnly?: boolean;
}

export function isToolAllowedForMode(tool: ToolLike, mode: AgentModeName): boolean {
  const policy = AGENT_MODE_CONFIGS[mode]?.toolPolicy;
  if (!policy) return true;
  return isToolAllowedByPolicy(tool, policy);
}

export function isToolAllowedByPolicy(
  tool: ToolLike,
  policy: AgentModeToolPolicy,
): boolean {
  if (policy.kind === 'all') return true;

  if (policy.denyToolNames.includes(tool.name)) return false;
  if (policy.allowToolNames.includes(tool.name)) return true;

  if (policy.mcpReadOnlyOnly && tool.name.startsWith('mcp_')) {
    return tool.isReadOnly === true;
  }

  if (policy.defaultAllowReadOnly && tool.isReadOnly === true) return true;

  return false;
}

export function isToolAllowedBySerializedPolicy(
  tool: ToolLike,
  policy: SerializedAgentModeToolPolicy,
): boolean {
  if (policy.kind === 'all') return true;

  if (policy.deny_tool_names.includes(tool.name)) return false;
  if (policy.allow_tool_names.includes(tool.name)) return true;

  if (policy.mcp_read_only_only && tool.name.startsWith('mcp_')) {
    return tool.isReadOnly === true;
  }

  if (policy.default_allow_read_only && tool.isReadOnly === true) return true;

  return false;
}

/**
 * L16 W5.5：获取指定模式的 input 级 shell 白名单设置。
 *
 * 返回 `'tabtin-readonly'` 表示需在 `run_terminal_command.execute` 入口检查命令字符串是否
 * 是 tabtin 只读子命令；返回 `undefined` 表示不限制（agent / group / 未配置）。
 *
 * 消费者：`packages/agent-runtime/src/capability/core/shell.ts`（在 ShellCap 装配时
 * 由宿主把 mode 对应的 allowlist 设置 + checker 一并注入）。
 */
export function getRestrictedShellAllowlist(
  mode: AgentModeName,
): 'tabtin-readonly' | undefined {
  const policy = AGENT_MODE_CONFIGS[mode]?.toolPolicy;
  return policy?.restrictedShellAllowlist;
}

export function listFilteredToolNames(
  tools: ToolLike[],
  mode: AgentModeName,
): { allowed: string[]; denied: string[] } {
  const policy = AGENT_MODE_CONFIGS[mode]?.toolPolicy;
  if (!policy || policy.kind === 'all') {
    return { allowed: tools.map((t) => t.name), denied: [] };
  }

  const allowed: string[] = [];
  const denied: string[] = [];
  for (const tool of tools) {
    if (isToolAllowedByPolicy(tool, policy)) {
      allowed.push(tool.name);
    } else {
      denied.push(tool.name);
    }
  }
  return { allowed, denied };
}
