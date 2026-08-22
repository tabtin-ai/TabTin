/**
 * ：后台命令终态 `_terminal_update` tool_result 的**原地更新桥**。
 *
 * **背景**：`run_terminal_command` 前台等待超时（wait_ms 耗尽）返回
 * `status:"running"` 快照转后台；进程终结时 host 经
 * `buildBackgroundTaskTerminalResult`（agent-runtime）合成一条终态
 * mini-message（role=user + 单个 tool_result block，content JSON 含
 * `_terminal_update:true` + 终态 stdout tail + status/exit_code），relay 到
 * Django 落库 supersede 并广播。这条 content_block_start(tool_result) 到达
 * renderer 后，contentBlockHandler 的历史行为是把 tool_result 块直接丢弃
 * （不建 ChatMessage 容器）——live 期间 `toolEventsBySessionId` 里该工具的
 * output 永远是 running 快照，MediaImageInlineCard 一直转圈，只有重载才出图。
 *
 * **本模块**：在丢弃之前识别 `_terminal_update` 终态标记，把终态 content
 * **原地** upsert 进既有 tool event（phase='end' + 新 output + 清 progress）。
 * MediaImageInlineCard 订阅 tool event 自动重解析 output
 * （`parseMediaImageGenerateResult` 递归剥 stdout 层找 result_urls），
 * 普通 TerminalCard 也因此显示真实终态。
 *
 * **边界**（与 design 对齐，勿扩大）：
 *   - 找不到既有 tool event → skip（live 期间没有对应卡片；历史路径由
 *     messages heal 兜底，这里**不**新建裸 event）；
 *   - 不动 agentSteps / runState.completedToolCalls 等任何计数；不建 ChatMessage；
 *   - 不动 input / inputSummary / outputSummary——upsertToolEventForSession
 *     的字段级 merge 会沿用旧值（未传字段保持，详见 useChatRuntimeStore）。
 */

import { createLogger } from '@/utils/logger'
import type { HandlerContext } from './streamHandlerTypes'

const log = createLogger('terminalUpdate')

/**
 * content_block_start 的 block 结构视图——只声明本桥用到的字段。
 * 正常路径 zod parse 后是 ToolResultBlock（tool_use_id/content 已 typed）；
 * degraded fallback 路径 block 是未校验的 Record——这里一律按 unknown 防守读。
 */
type ToolResultBlockLike = {
  tool_use_id?: unknown
  content?: unknown
}

/**
 * 识别并应用后台命令终态 tool_result；非 `_terminal_update` 块 / 无既有
 * tool event / 坏 content 一律 no-op（保持既有 drop 行为由调用方兜底）。
 *
 * 由 `handleContentBlockStart` 在 `ensureAssistantMessageContainer` 的两个
 * early-return **之前**调用（仅 `block.type === 'tool_result'` 时）。
 */
export function applyTerminalToolResultUpdate(
  block: ToolResultBlockLike,
  ctx: HandlerContext,
): void {
  const toolUseId = typeof block.tool_use_id === 'string' && block.tool_use_id
    ? block.tool_use_id
    : undefined
  if (!toolUseId) return

  // 终态 content 恒为 string（host 侧 contentJson）；数组形态（叶子块）不
  // 可能是 terminal update，直接跳过。
  const content = typeof block.content === 'string' ? block.content : undefined
  if (content === undefined) return

  // 快速门槛：不含标记子串的普通 tool_result 块直接返回（保持现有 drop 行为）。
  if (!content.includes('_terminal_update')) return

  let parsed: Record<string, unknown>
  try {
    const raw: unknown = JSON.parse(content)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    parsed = raw as Record<string, unknown>
  } catch {
    return
  }
  if (parsed._terminal_update !== true) return

  const existing = ctx.get().getEffectiveToolEventForSession(ctx.sessionId, toolUseId)
  if (!existing) {
    // live 期间没有对应卡片（譬如会话未挂载时事件到达）——历史路径由
    // messages heal 兜底，这里不新建裸 event。
    log.debug('← terminal_update skip (no existing tool event)', {
      session: ctx.sessionId.slice(0, 8),
      toolUseId: toolUseId.slice(0, 12),
    })
    return
  }

  const durationMs = typeof parsed.duration_ms === 'number' && Number.isFinite(parsed.duration_ms)
    ? parsed.duration_ms
    : existing.durationMs

  ctx.get().upsertToolEventForSession(ctx.sessionId, {
    id: toolUseId,
    toolName: existing.toolName,
    phase: 'end',
    output: content,
    timestamp: Date.now(),
    durationMs,
    startedAt: existing.startedAt,
    // 显式 spread `progress: undefined` —— 与 toolLifecycleNotice P0-3 同款
    // 语义，让 upsert 的 merge 把 running 期间 tool_progress 攒下的中间帧擦掉，
    // 不让过期 progress 与终态 output 并存。
    progress: undefined,
  })

  log.debug('← terminal_update applied', {
    session: ctx.sessionId.slice(0, 8),
    toolUseId: toolUseId.slice(0, 12),
    status: typeof parsed.status === 'string' ? parsed.status : '(none)',
  })
}
