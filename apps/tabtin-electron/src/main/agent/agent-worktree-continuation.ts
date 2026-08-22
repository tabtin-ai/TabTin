import type { QueryRequest } from './electron-agent-types.js'

export interface AgentWorktreeContinuationTransition {
  previousRootPath: string
  targetRootPath: string
  branch?: string
}

export type AgentWorktreeContinuationResult =
  | { success: true; rootPath: string; revision: number }
  | { success: false; error: string }

/**
 * 系统状态只展示代码根名称。完整绝对路径仍放在续跑 prompt 中供 Agent 校验，
 * 避免 renderer 把裸绝对路径自动识别成本地文件链接并打开无效的文件预览。
 */
function formatCodeRootLabel(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/u, '')
  const name = trimmed.split(/[\\/]/u).pop() || rootPath
  const longestBacktickRun = Math.max(0, ...Array.from(name.matchAll(/`+/gu), match => match[0].length))
  const fence = '`'.repeat(longestBacktickRun + 1)
  return `${fence} ${name} ${fence}`
}

/**
 * 构造同一对话的系统续跑请求。只继承身份、模型和执行策略；所有属于上一条
 * 用户消息或上一轮恢复现场的字段都显式清空，避免附件/审批/任务 ID 重放。
 */
export function buildAgentWorktreeContinuation(
  sourceRequest: QueryRequest,
  transition: AgentWorktreeContinuationTransition,
  result: AgentWorktreeContinuationResult,
  clientMessageId: string,
): QueryRequest {
  const displayMessage = result.success
    ? `已切换代码根到 ${formatCodeRootLabel(result.rootPath)}，Agent 正在同一对话中继续任务。`
    : `代码根切换失败，Agent 正在同一对话中处理：${result.error}`
  const prompt = result.success
    ? [
        '系统已在安全工具边界完成当前对话的代码根切换。',
        `旧代码根：${transition.previousRootPath}`,
        `新代码根：${result.rootPath}`,
        transition.branch ? `分支：${transition.branch}` : '',
        '这是同一用户任务的自动续跑，不是新任务。请从未完成处继续；执行写操作前先确认当前 cwd 和 Git 分支，不要重复已经完成的动作。',
      ].filter(Boolean).join('\n')
    : [
        '系统未能在安全工具边界提交当前对话的代码根切换。',
        `目标代码根：${transition.targetRootPath}`,
        `原因：${result.error}`,
        '这是同一用户任务的自动续跑。请保持在原代码根，向用户说明失败原因，并在安全范围内继续可完成的工作。',
      ].join('\n')

  return {
    ...sourceRequest,
    prompt,
    displayMessage,
    triggeredBy: 'push-notification',
    clientMessageId,
    runId: undefined,
    taskId: undefined,
    interruptActive: false,
    attachments: undefined,
    userMessageBlocks: undefined,
    contextBlocks: undefined,
    replyTo: undefined,
    skillSlashInvoke: undefined,
    history: undefined,
    senderUserId: undefined,
    pendingApprovalsSerialized: undefined,
    pendingSingleHitlSerialized: undefined,
    workspaceSnapshot: undefined,
    boundCodeRoot: result.success ? result.rootPath : sourceRequest.boundCodeRoot,
    boundCodeRootRevision: result.success
      ? result.revision
      : sourceRequest.boundCodeRootRevision,
    workingDir: result.success ? result.rootPath : sourceRequest.workingDir,
  }
}
