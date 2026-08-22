/**
 * pushNotificationParse —— 解析「异步任务完成」系统通知的 `<task-notification>` XML。
 *
 * ## 背景
 *
 * 子 Agent / 后台终端命令是异步任务：Agent 派出去后先回正文（turn 结束），任务在
 * 后台跑完后通过 push 通知唤起 Agent 新一轮继续。唤起 Agent 的那条系统消息，content
 * 是 LLM 看的 raw `<task-notification>` XML（由 `packages/terminal-core/src/notification-prompt.ts`
 * 合成），直接渲染给用户又长又丑。本模块把它解析成结构化数据，让 UI 收敛成一句话摘要
 * + 可展开看原文。
 *
 * ## 格式（与 notification-prompt.ts 严格对齐）
 *
 * - **shell 段**：prefix（`A background command completed...` / `N background commands completed...`）
 *   + 一个或多个 `<task-notification>`（**无 kind 属性**），含 `<command>` `<exit-code>`
 *   `<exited-by>`（可选 `<killed-reason>`）`<duration-ms>` `<output-file>` `<cwd>` 等；
 * - **subagent 段**：prefix（`A background sub-agent finished...`）+ 一个或多个
 *   `<task-notification kind="subagent-completed">`，含 `<label>` `<status>` `<summary>` 等；
 * - 两类可同时存在（shell 段在前、subagent 段在后，空行分隔）。
 *
 * 字段值在合成时经过 `escapeXml`（`& < > " '`），解析后需 unescape 还原。
 *
 * ## 设计取向
 *
 * - **纯解析、不依赖 i18n / React**：可直接单测；文案构造交给组件层（用 i18n key）。
 * - **逐块判定类型**（按块自身 `kind` 属性而非 prefix）：混合段也能正确归类，比依赖
 *   prefix 文案更鲁棒。
 * - **解析失败回落**：抓不到任何 `<task-notification>` 块返回 `null`，调用方回落原 raw
 *   渲染（绝不 silent 丢内容）。
 */

/** 子 Agent 完成状态（与 SubagentCompletedPayload.status 对齐）。 */
export type ParsedSubagentStatus = 'completed' | 'failed' | 'cancelled' | 'timeout' | string

/**
 * 任务结果三态（P2-5：用户主动终止不是异常，应中性，与超时被杀区分）：
 * - `'success'`：正常完成——shell normal_exit 且无 killed（退出码非零也算，如 du/grep）；subagent completed。
 * - `'stopped'`：用户/工具主动停止——shell killed_reason ∈ {kill_tool, user_interrupt}；
 *   subagent cancelled。**非异常**，UI 用中性字形/灰色呈现「已停止」。
 * - `'failed'`：非预期失败——shell exec_failure（126/127 起不来）/ signal（被杀）/
 *   hard_timeout / app_exit；subagent failed / timeout。UI 用语义红「已终止 / 失败」。
 */
export type PushTaskOutcome = 'success' | 'stopped' | 'failed'

export interface ParsedPushTask {
  kind: 'shell' | 'subagent'
  /** shell = command；subagent = label。空时回落占位（不影响 outcome 判定）。 */
  title: string
  /** shell 命令的 LLM 意图摘要（run_terminal_command description）；UI 优先展示它而非裸命令。 */
  description?: string
  /** 三态结果（见 PushTaskOutcome）。 */
  outcome: PushTaskOutcome
  /** shell 退出码（数字；XML 里 'null' / 缺失 → undefined）。 */
  exitCode?: number
  /** shell 被杀原因（hard_timeout / kill_tool / user_interrupt / app_exit）。 */
  killedReason?: string
  /** subagent 终态状态原值。 */
  status?: ParsedSubagentStatus
  /** 子 Agent run id；仅 subagent notification 携带。 */
  subagentRunId?: string
  /** 父 assistant tool_use id；仅 subagent notification 可选携带，用于 UI 原位锚定。 */
  parentToolCallId?: string
}

export interface ParsedPushNotification {
  tasks: ParsedPushTask[]
  shellCount: number
  subagentCount: number
  /** outcome === 'failed' 的任务数（异常计数；中性 stopped 不计入）。 */
  failedCount: number
}

/**
 * 用户/工具主动停止的 killed_reason（非异常 → 中性 stopped）。其余被杀原因
 * （hard_timeout 超时、app_exit 应用退出中断）属非预期 → failed（红）。
 */
const NEUTRAL_KILLED_REASONS: ReadonlySet<string> = new Set(['kill_tool', 'user_interrupt'])

/** shell 三态判定。 */
function shellOutcome(
  exitedBy: string | undefined,
  killedReason: string | undefined,
): PushTaskOutcome {
  if (killedReason) return NEUTRAL_KILLED_REASONS.has(killedReason) ? 'stopped' : 'failed'
  // 退出码非零 ≠ 失败：以执行层 exited_by 为准（shell.ts:1704）。exec_failure（126/127
  // 起不来）/ signal（被杀）才是真失败；normal_exit 即正常完成，哪怕退出码非零（du 遇无
  // 权限返 1、grep 无匹配返 1 都属正常结束）。无 exited_by 的老数据兜底视为完成——能发出
  // 完成通知即说明任务已结束，不再凭退出码报红。
  if (exitedBy === 'exec_failure' || exitedBy === 'signal') return 'failed'
  return 'success'
}

/** subagent 三态判定（cancelled = 用户主动取消 → 中性；failed/timeout → 异常）。 */
function subagentOutcome(status: string | undefined): PushTaskOutcome {
  if (status === 'completed') return 'success'
  if (status === 'cancelled') return 'stopped'
  return 'failed'
}

/** XML 实体反转义（与合成端 escapeXml 互逆）。顺序：&amp; 必须最后处理避免二次解码。 */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 从单个 task-notification 块内抽指定标签的文本（首个命中），unescape 后返回。 */
function extractTag(block: string, tag: string): string | undefined {
  // 标签名固定来自本模块常量，无注入风险；non-greedy 抓闭合。
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  if (!m) return undefined
  return unescapeXml(m[1].trim())
}

/**
 * 解析系统通知 content。抓不到任何 `<task-notification>` → 返回 null（调用方回落 raw）。
 */
export function parsePushNotification(content: string | null | undefined): ParsedPushNotification | null {
  if (!content || typeof content !== 'string') return null

  // 全局抓所有 task-notification 块，连同可选 kind 属性。
  const blockRe = /<task-notification(?:\s+kind\s*=\s*["']([^"']*)["'])?\s*>([\s\S]*?)<\/task-notification>/g
  const tasks: ParsedPushTask[] = []
  let shellCount = 0
  let subagentCount = 0
  let failedCount = 0

  let match: RegExpExecArray | null
  while ((match = blockRe.exec(content)) !== null) {
    const kindAttr = match[1]
    const inner = match[2]
    const isSubagent = kindAttr === 'subagent-completed'

    if (isSubagent) {
      const subagentRunId = extractTag(inner, 'subagent-run-id')
      const label = extractTag(inner, 'label') || ''
      const status = extractTag(inner, 'status')
      const parentToolCallId = extractTag(inner, 'parent-tool-call-id')
      const outcome = subagentOutcome(status)
      tasks.push({
        kind: 'subagent',
        title: label,
        outcome,
        status,
        ...(subagentRunId ? { subagentRunId } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
      })
      subagentCount += 1
      if (outcome === 'failed') failedCount += 1
    } else {
      const command = extractTag(inner, 'command') || ''
      const description = extractTag(inner, 'description')
      const exitCodeRaw = extractTag(inner, 'exit-code')
      const exitedBy = extractTag(inner, 'exited-by')
      const killedReason = extractTag(inner, 'killed-reason')
      // exit-code 在合成端是 `p.exit_code ?? 'null'`，故可能是 'null' 或数字串。
      const exitCode =
        exitCodeRaw && exitCodeRaw !== 'null' && Number.isFinite(Number(exitCodeRaw))
          ? Number(exitCodeRaw)
          : undefined
      const outcome = shellOutcome(exitedBy, killedReason)
      tasks.push({ kind: 'shell', title: command, outcome, exitCode, killedReason, ...(description ? { description } : {}) })
      shellCount += 1
      if (outcome === 'failed') failedCount += 1
    }
  }

  if (tasks.length === 0) return null
  return { tasks, shellCount, subagentCount, failedCount }
}
