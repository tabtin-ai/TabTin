/**
 * notification-prompt —— 把 `NotificationQueue` drain 出来的 envelope 合成
 * 「系统主动注入 LLM」的 user message 文本（XML 包装）。
 *
 * ## 为什么上提到 terminal-core（W4a S0，2026-05-30）
 *
 * 合成逻辑原本在两端 host（`ElectronAgentHost` / `DaemonAgentHost`）各写一份
 * 私有 `composeNotificationPrompt` + 各自一份 `escapeXml`，且 `_tryDrain` 把
 * drain 项**整体 cast** 成 `BackgroundTaskCompletedPayload`（只认 shell 一种
 * kind）。直接往队列塞 subagent payload → 字段全 undefined → 空
 * `<task-notification>`。
 *
 * S0 把它收敛到 terminal-core 单一来源：
 *   1. 按 `env.kind` 分派（`background-task-completed` vs `subagent-completed`），
 *      shell 与 subagent 互不污染；
 *   2. 两端 host 调同一函数 → 天然对称、不会漂移（plan「两端对称」硬约束）；
 *   3. 纯函数，可在 terminal-core 直接单测（enqueue → drain → compose）。
 *
 * ## 格式（PRD run-terminal-command_push通知重构 §6.4）
 *
 *   - 外层：自然语言告诉 LLM "...completed/finished while you were doing other work"；
 *   - 内层：`<task-notification>` XML 含结构化字段（不含正文，只给指针 / 摘要）；
 *   - 末尾：轻引导 LLM 取全文 / 续跑——不强迫。
 *
 * shell 段的输出与上提前两端 host 的私有方法**逐字节一致**（保证「无 LLM 行为
 * 变化」：前台 shell 后台命令完成通知的 prompt 文本不变）。subagent 段是新增。
 */

import type {
  NotificationEnvelope,
  BackgroundTaskCompletedPayload,
  SubagentCompletedPayload,
} from './notification-queue';

/** shell 后台命令完成通知的 kind 字面量。 */
export const SHELL_NOTIFICATION_KIND = 'background-task-completed';
/** 子 Agent 后台完成通知的 kind 字面量（W4a）。 */
export const SUBAGENT_NOTIFICATION_KIND = 'subagent-completed';

/**
 * W4a S5 producer（2026-05-30）：把子 Agent 终态信息构造成入 `NotificationQueue`
 * 的 `subagent-completed` envelope。
 *
 * **两端 host 共用单一来源**：完成回调跨层（producer 在 agent-runtime 的
 * `SubagentManager.notifyCompleted`，队列在 terminal 层），host 在
 * `createRuntimeForSession` 把「本 helper + queue.enqueue」包成
 * `EnqueueSubagentCompletion` 句柄注入 Manager。target 的 `spaceId` / `threadId`
 * 由 host 在 `createRuntimeForSession` 作用域里已知（= 该 session 的 space + thread），
 * 这里作为参数补上，并把 `parent_thread_id` 落进 payload（与 consumer 自洽）。
 *
 * dedup：`dedupKey = subagent_run_id`（childId）——防同一子完成被重复入队
 * （`result.then` 与 catch 边角 race）。priority `'later'`（不饿死用户输入）。
 *
 * 入参 `info` 故意用结构化形参（不 import agent-runtime 的 `SubagentCompletionInfo`，
 * 避免 terminal-core → agent-runtime 反向依赖）；字段与之一一对应。
 */
export function buildSubagentCompletionEnvelope(
  info: Omit<SubagentCompletedPayload, 'parent_thread_id'>,
  target: { spaceId: string; threadId: string; enqueuedAt?: number },
): NotificationEnvelope<SubagentCompletedPayload> {
  return {
    kind: SUBAGENT_NOTIFICATION_KIND,
    target: { spaceId: target.spaceId, threadId: target.threadId },
    priority: 'later',
    enqueuedAt: target.enqueuedAt ?? Date.now(),
    dedupKey: info.subagent_run_id,
    payload: { ...info, parent_thread_id: target.threadId },
  };
}

/**
 * `<task-notification>` XML 转义：把 `&` `<` `>` `"` `'` 转义，避免 LLM 把命令 /
 * 摘要里的特殊字符当成 markdown / XML 边界。与上提前两端 host 的 `escapeXml` /
 * `escapeXmlForNotification` 完全一致（两端原实现逐字符相同）。
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * shell 后台命令完成 → prompt 段。**与上提前两端 host 私有方法逐字节一致**。
 */
function composeShellPrompt(
  items: ReadonlyArray<NotificationEnvelope<BackgroundTaskCompletedPayload>>,
): string {
  const prefix =
    items.length === 1
      ? 'A background command completed while you were doing other work:'
      : `${items.length} background commands completed while you were doing other work:`;

  const xmlBlocks = items
    .map((env) => {
      const p = env.payload;
      const killedReasonLine = p.killed_reason
        ? `<killed-reason>${escapeXml(p.killed_reason)}</killed-reason>\n`
        : '';
      // LLM 写的命令意图摘要——仅在存在时插入（无描述时输出逐字节不变），
      // 供前端 UI 优先向用户展示「描述」而非裸命令。
      const descriptionLine = p.description
        ? `<description>${escapeXml(p.description)}</description>\n`
        : '';
      return [
        '<task-notification>',
        `<agent-session-id>${escapeXml(p.agent_session_id)}</agent-session-id>`,
        descriptionLine + `<command>${escapeXml(p.command)}</command>`,
        `<exit-code>${p.exit_code ?? 'null'}</exit-code>`,
        `<exited-by>${escapeXml(p.exited_by)}</exited-by>`,
        killedReasonLine + `<duration-ms>${p.duration_ms}</duration-ms>`,
        `<output-file>${escapeXml(p.output_file_path)}</output-file>`,
        `<cwd>${escapeXml(p.cwd)}</cwd>`,
        '</task-notification>',
      ].join('\n');
    })
    .join('\n\n');

  return `${prefix}\n\n${xmlBlocks}\n\nRead the output-file path if you need to see the full output.`;
}

/**
 * 子 Agent 后台完成 → prompt 段（W4a 新增）。XML 含
 * subagent-run-id / label / status / duration-ms（+ 可选 step-count /
 * error-kind / parent-tool-call-id / summary / summary-file）。
 */
function composeSubagentPrompt(
  items: ReadonlyArray<NotificationEnvelope<SubagentCompletedPayload>>,
): string {
  const prefix =
    items.length === 1
      ? 'A background sub-agent finished while you were doing other work:'
      : `${items.length} background sub-agents finished while you were doing other work:`;

  const xmlBlocks = items
    .map((env) => {
      const p = env.payload;
      const lines = [
        `<task-notification kind="${SUBAGENT_NOTIFICATION_KIND}">`,
        `<subagent-run-id>${escapeXml(p.subagent_run_id)}</subagent-run-id>`,
        `<label>${escapeXml(p.label)}</label>`,
        `<status>${escapeXml(p.status)}</status>`,
        `<duration-ms>${p.duration_ms}</duration-ms>`,
      ];
      if (p.step_count !== undefined) {
        lines.push(`<step-count>${p.step_count}</step-count>`);
      }
      if (p.error_kind) {
        lines.push(`<error-kind>${escapeXml(p.error_kind)}</error-kind>`);
      }
      if (p.run_id) {
        lines.push(`<run-id>${escapeXml(p.run_id)}</run-id>`);
      }
      if (p.tool_call_id) {
        lines.push(`<tool-call-id>${escapeXml(p.tool_call_id)}</tool-call-id>`);
      }
      if (p.parent_tool_call_id) {
        lines.push(
          `<parent-tool-call-id>${escapeXml(p.parent_tool_call_id)}</parent-tool-call-id>`,
        );
      }
      lines.push(`<summary>${escapeXml(p.summary)}</summary>`);
      if (p.summary_file_path) {
        lines.push(`<summary-file>${escapeXml(p.summary_file_path)}</summary-file>`);
      }
      // ：交付物清单给主 Agent 编排（结构化 JSON，与 agent tool_result 同源）。
      if (Array.isArray(p.deliverables) && p.deliverables.length > 0) {
        lines.push(
          `<deliverables>${escapeXml(JSON.stringify(p.deliverables))}</deliverables>`,
        );
      }
      lines.push('</task-notification>');
      return lines.join('\n');
    })
    .join('\n\n');

  return (
    `${prefix}\n\n${xmlBlocks}\n\n` +
    `The sub-agent's result summary is above. Resume it with its subagent-run-id ` +
    `if you want it to continue, or read the summary-file path for the full output if present. ` +
    `If <deliverables> is present, those are the final artifacts from that sub-agent ` +
    `(attributable to the parent tool call that spawned it).`
  );
}

/** `composeNotificationPrompt` 的可选项。 */
export interface ComposeNotificationPromptOptions {
  /**
   * 遇到未知 kind 的 envelope 时回调（默认静默 skip）。两端 host 接 logger
   * 便于排查「producer 入了一个 consumer 不认识的 kind」的 lifecycle bug。
   */
  onUnknownKind?: (kinds: string[], count: number) => void;
}

/**
 * 把一批 drain 出来的 envelope 按 `kind` 分派合成单条 user message 文本。
 *
 * - `background-task-completed` → shell 段（行为不变）
 * - `subagent-completed` → 子 Agent 段（W4a 新增）
 * - 其它 kind → skip + `onUnknownKind` 回调（防御未来 producer 误入）
 *
 * 两类同时存在时 shell 段在前、subagent 段在后，用空行分隔。空输入返回 ''
 *（调用方 `_tryDrain` 已在 `items.length === 0` 时提前 return，不会走到）。
 */
export function composeNotificationPrompt(
  items: ReadonlyArray<NotificationEnvelope>,
  opts: ComposeNotificationPromptOptions = {},
): string {
  const shellItems: Array<NotificationEnvelope<BackgroundTaskCompletedPayload>> = [];
  const subagentItems: Array<NotificationEnvelope<SubagentCompletedPayload>> = [];
  const unknownKinds = new Set<string>();

  for (const env of items) {
    if (env.kind === SHELL_NOTIFICATION_KIND) {
      shellItems.push(env as NotificationEnvelope<BackgroundTaskCompletedPayload>);
    } else if (env.kind === SUBAGENT_NOTIFICATION_KIND) {
      subagentItems.push(env as NotificationEnvelope<SubagentCompletedPayload>);
    } else {
      unknownKinds.add(env.kind);
    }
  }

  if (unknownKinds.size > 0) {
    const total = items.length - shellItems.length - subagentItems.length;
    opts.onUnknownKind?.([...unknownKinds], total);
  }

  const blocks: string[] = [];
  if (shellItems.length > 0) blocks.push(composeShellPrompt(shellItems));
  if (subagentItems.length > 0) blocks.push(composeSubagentPrompt(subagentItems));

  return blocks.join('\n\n');
}
