import type {
  ToolContext,
} from '../../engine/contracts/tools.js';

/**
 * Build the TabTin runtime env block injected into shell child processes.
 *
 * Exposes runtime metadata (workspace, thread id, per-turn agent run id,
 * agent id, workspace id, organization id) so shell commands can reference
 * `$TABTIN_WORKSPACE/foo.md` etc. without the agent inlining long absolute
 * paths.
 *
 *  RB2：`spaceId` / `organizationId` 由调用方（ShellCap）从 host
 * 装配期烘焙的 deps 传入（per-runtime 常量），不再从 `ToolContext` 读。
 *
 * `ShellCap.run_terminal_command` consumes this and merges it into `ExecOptions.env`,
 * which is layered on top of the backend's base env.
 *
 * The merge order is owned by the call site; this helper just builds the
 * `Record<string, string>` payload. Empty fields are omitted so callers
 * can `Object.keys(...)` to detect "any TabTin env was injected".
 *
 * §17.6 D4.b：env 变量名从 `TABTIN_SESSION_ID` 改名 `TABTIN_THREAD_ID`，
 * 值改用 `context.threadId`（业务对话维度）。命名彻底无歧义；
 * shell 命令脚本能拿到正确的对话身份，配合 jsonl / 通知路径都跟业务对话对齐。
 * 用户脚本侧 0 外部消费者（TabTin 未上线），改名无副作用。
 */
export function buildTabtinRuntimeEnv(
  context: ToolContext,
  spaceId: string | undefined,
  organizationId: string | undefined,
  agentId?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (context.workspaceRoot) env.TABTIN_WORKSPACE = context.workspaceRoot;
  if (context.threadId) env.TABTIN_THREAD_ID = context.threadId;
  if (context.agentRunId) env.TABTIN_AGENT_RUN_ID = context.agentRunId;
  if (context.toolUseId) env.TABTIN_TOOL_USE_ID = context.toolUseId;
  if (agentId) env.TABTIN_AGENT_ID = agentId;
  if (spaceId) env.TABTIN_SPACE_ID = spaceId;
  if (organizationId) env.TABTIN_ORGANIZATION_ID = organizationId;
  return env;
}
