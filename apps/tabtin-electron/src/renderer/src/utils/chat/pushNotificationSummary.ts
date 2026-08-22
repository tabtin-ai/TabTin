/**
 * pushNotificationSummary —— A「系统通知收敛」的展示层逻辑：一句话摘要文案 + 三态视觉 tone。
 *
 * 从 MessageBubble 抽出（与 pushNotificationParse 解析层分离），以便独立单测：
 *   - 摘要文案**全走 i18n key**（zh/en 双语，P2-1）——无硬编码中文进入最终展示；
 *   - 三态 tone（P2-5）：success（正常完成）/ neutral（用户主动停止，非异常）/ failure（异常）。
 *
 * 视觉映射（tone → 图标 / 颜色 token）留在 MessageBubble（依赖 lucide + chatDesignTokens），
 * 本模块只产「文案」与「tone 判定」两个纯逻辑，便于喂 mock t 断言。
 */

import type { ParsedPushNotification } from '@utils/chat/pushNotificationParse'
import { getShellFailureReason } from '@utils/chat/shellFailureReason'

/** 与 i18next t 兼容的最小翻译函数签名（带 defaultValue 兜底 + 插值 options）。 */
type Translate = (key: string, options?: Record<string, unknown>) => string

/** 摘要三态视觉 tone：success 绿 / neutral 灰（用户主动停止）/ failure 红（异常）。 */
export type PushSummaryTone = 'success' | 'neutral' | 'failure'

/** 取命令首行 + 截断——摘要里命令只占一行，过长省略号收尾。 */
function compactCommand(value: string, limit = 48): string {
  const firstLine = value.split('\n')[0]?.trim() ?? ''
  return firstLine.length > limit ? `${firstLine.slice(0, limit - 1)}…` : firstLine
}

/**
 * 把解析结果收成一句话摘要。文案全走 i18n key（无硬编码中文进入最终展示，P2-1：
 * exit-code / status 兜底也走 i18n）。三态文案（P2-5）：
 * success → 完成；stopped → 已停止（用户主动，中性）；failed → 失败 / 已终止（异常）。
 */
export function buildPushSummary(parsed: ParsedPushNotification, t: Translate): string {
  const { tasks, failedCount } = parsed
  if (tasks.length === 1) {
    const task = tasks[0]
    if (task.kind === 'shell') {
      // 优先展示 LLM 的命令意图摘要（description），比裸命令可读；缺失才回落命令。
      const command = compactCommand(task.description || task.title) || t('pushNotification.unnamedCommand', { defaultValue: '后台命令' })
      if (task.outcome === 'success') {
        return t('pushNotification.shellDone', { command, defaultValue: `后台命令完成：${command}` })
      }
      if (task.outcome === 'stopped') {
        return t('pushNotification.shellStopped', { command, defaultValue: `后台命令已停止：${command}` })
      }
      // failed：被杀（hard_timeout/app_exit）显「已终止」，否则按退出码映射成用户可读原因。
      if (task.killedReason) {
        return t('pushNotification.shellKilled', { command, defaultValue: `后台命令已终止：${command}` })
      }
      const reason = getShellFailureReason(t, task.exitCode)
        ?? t('pushNotification.unknownFailureReason', { defaultValue: '原因未知' })
      return t('pushNotification.shellFailed', { command, reason, defaultValue: `后台命令失败：${command}（${reason}）` })
    }
    const label = compactCommand(task.title) || t('pushNotification.subagentFallback', { defaultValue: '子 Agent' })
    if (task.outcome === 'success') {
      return t('pushNotification.subagentDone', { label, defaultValue: `子 Agent 完成：${label}` })
    }
    if (task.outcome === 'stopped') {
      return t('pushNotification.subagentStopped', { label, defaultValue: `子 Agent 已停止：${label}` })
    }
    // failed：status 短词走 i18n（缺失回落 subagentAbnormal，仍是 i18n，不让硬编码中文进展示）。
    const statusText = task.status
      ? t(`pushNotification.subagentStatus.${task.status}`, {
          defaultValue: t('pushNotification.subagentAbnormal', { defaultValue: '异常结束' }),
        })
      : t('pushNotification.subagentAbnormal', { defaultValue: '异常结束' })
    return t('pushNotification.subagentFailed', { label, status: statusText, defaultValue: `子 Agent ${statusText}：${label}` })
  }
  if (failedCount > 0) {
    return t('pushNotification.multiWithFailure', {
      count: tasks.length,
      failed: failedCount,
      defaultValue: `${tasks.length} 个后台任务完成（${failedCount} 个异常）`,
    })
  }
  return t('pushNotification.multiDone', { count: tasks.length, defaultValue: `${tasks.length} 个后台任务完成` })
}

/** 整体摘要 tone：有异常 → failure；单任务用户主动停止 → neutral（不报红）；其余 → success。 */
export function pickPushSummaryTone(parsed: ParsedPushNotification): PushSummaryTone {
  if (parsed.failedCount > 0) return 'failure'
  if (parsed.tasks.length === 1 && parsed.tasks[0].outcome === 'stopped') return 'neutral'
  return 'success'
}
