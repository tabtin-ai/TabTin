/**
 * @tabtin/agent-runtime — Proactive Report Message Formatter
 *
 * PRD 06 §5.5.3：后台子 Agent 完成后生成的汇报消息文本格式化。
 *
 * **本模块当前的唯一活路径**：
 *   `apps/tabtin-electron/src/main/agent/ElectronAgentHost.ts:244` import
 *   `formatProactiveReportMessage` + `PendingSubtaskInfo`，`:1618` 在
 *   `initProactivePoller.triggerColdStartReport` 里把数据库查出的 pending
 *   `SubtaskRun` 列表格式化成 `[SYSTEM NOTIFICATION] ...` 文本，再通过
 *   `webContents.send('agent-engine:proactive-report-ready', ...)` 推给
 *   Renderer 拼装到对话流。整条路径在 Electron Main 进程，runtime 自己只
 *   负责"如何写一段汇报文本"。
 *
 * **阶段 2.1 清理（2026-05-20）**：以下符号已物理下线（0 production caller）：
 *   - `PROACTIVE_REPORT_RULES` 常量（hook 注入路径从未接通）
 *   - `createProactiveReportHook` / `checkAndConsumePending`（runtime 内
 *     hook 路径从未被 ElectronAgentHost / DaemonAgentHost 接入）
 *   - `createThrottleState` / `shouldCheck` / `markChecked` /
 *     `DEFAULT_THROTTLE_MS` / `ThrottleState`（仅服务于上面的 hook）
 *   - `buildReportMessage`（仅服务于上面的 hook；Electron 路径直接拿
 *     `formatProactiveReportMessage` 返回的字符串通过 IPC 发出，不需要 Message 封装）
 *   - `ProactiveReportHookConfig` / `ProactiveReportResult` /
 *     `ProactiveReportHost`（同上）
 *   清理依据：rg 全仓显示这些符号只在自身文件 + tests 里出现，apps/ 0 caller。
 */

// ─── Pending Subtask Info ───────────────────────────────────────────

export interface PendingSubtaskInfo {
  runId: string;
  /** 子 Agent 的 display_name（e.g. "数据分析员 · 4f2a · 分析昨销售"） */
  displayName: string;
  /** 子 Agent 的 short_id（speaker_id 前 4 位） */
  shortId: string;
  /** 终态：completed / failed / error / crashed */
  status: 'completed' | 'failed' | 'error' | 'crashed';
  /** 子 Agent 执行的任务描述 */
  task: string;
  /** 成功时的摘要文本 */
  summary?: string;
  /** 失败时的错误信息 */
  errorMessage?: string;
  /** 发起者 speaker_id */
  initiatorSpeakerId?: string;
  /** 完成时间 */
  completedAt?: number;
}

// ─── Message Formatting (PRD §5.5.3) ────────────────────────────────

function formatStatusTag(status: PendingSubtaskInfo['status']): string {
  switch (status) {
    case 'completed': return 'OK';
    case 'failed': return 'FAILED';
    case 'error': return 'FAILED';
    case 'crashed': return 'CRASHED';
    default: {
      const _exhaustive: never = status;
      return String(_exhaustive);
    }
  }
}

function formatSubtaskLine(info: PendingSubtaskInfo): string {
  const tag = formatStatusTag(info.status);
  const base = `- [${tag}] ${info.displayName}`;

  if (info.status === 'completed' && info.summary) {
    return `${base}\n  Summary: ${info.summary}`;
  }
  if ((info.status === 'failed' || info.status === 'error' || info.status === 'crashed') && info.errorMessage) {
    return `${base}\n  Error: ${info.errorMessage}`;
  }
  return base;
}

function formatHeader(successCount: number, failureCount: number): string {
  if (failureCount === 0) {
    return '[SYSTEM NOTIFICATION] The following background tasks have completed:';
  }
  if (successCount === 0) {
    return '[SYSTEM NOTIFICATION] The following background tasks have finished, all encountered issues:';
  }
  return '[SYSTEM NOTIFICATION] The following background tasks have finished, some encountered issues:';
}

function formatSummaryLine(total: number, successCount: number, failureCount: number): string {
  if (failureCount === 0) {
    return `Total: ${total} task(s), all completed successfully.`;
  }
  if (successCount === 0) {
    return `Total: ${total} task(s), all failed.`;
  }
  return `Total: ${total} task(s) — ${successCount} succeeded, ${failureCount} failed.`;
}

/**
 * 将一组 pending SubtaskRun 格式化为汇报消息文本（PRD §5.5.3）。
 *
 * 空输入返回空字符串，调用方负责跳过推送。
 */
export function formatProactiveReportMessage(tasks: PendingSubtaskInfo[]): string {
  if (tasks.length === 0) return '';

  const successCount = tasks.filter(t => t.status === 'completed').length;
  const failureCount = tasks.length - successCount;

  const lines: string[] = [];
  lines.push(formatHeader(successCount, failureCount));
  lines.push('');

  for (const task of tasks) {
    lines.push(formatSubtaskLine(task));
  }

  lines.push('');
  lines.push(formatSummaryLine(tasks.length, successCount, failureCount));

  return lines.join('\n');
}
