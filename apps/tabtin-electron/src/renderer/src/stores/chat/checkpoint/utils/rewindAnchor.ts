/**
 * resolveRewindAnchorId — per-file 回退锚点解析（纯函数，无运行时依赖）。
 *
 * 单独成模块（不放 `checkpointSlice.ts`）的理由：回退编排（checkpointSlice）依赖一大堆
 * 重模块（API / IPC / i18n / toast），而回退**预览面板**（RewindPreviewPanel）也要用
 * 这个纯函数做 per-file 本地文件能力判定（Bug 2）。抽到只依赖 `ChatMessage` 类型的纯
 * util，两边都能 import，避免把 checkpointSlice 的重依赖拖进面板（及其单测）。
 */
import type { ChatMessage } from '@tabtin/chat-client'

/**
 * 解析 per-file 回退锚点。
 *
 * **anchorId = 所点 assistant 自己的 `agent_run_id`**。per-file 引擎 `beginSnapshot`
 * 在轮**开始前**建基线，故锚到该 run → 文件恢复到「这轮 Agent 开始前」的世界。
 *
 * - **assistant 目标**（点某条回复「回退到此位置」， 起**保留该轮**、仅撤销其后）→
 *   取**其后第一条属于「不同 run」的顶层 assistant** 的 `agent_run_id`（= 回退到该轮
 *   **之后**那一轮开始前，保留本轮文件；对齐消息层「保留 assistant 目标」）。本轮之后
 *   没有新 run（含末条 assistant）→ `null`（无后续文件可回退）。
 * - **user 目标**（编辑 + 恢复并发送，**移除**该消息）→ 取它**之后第一条** assistant
 *   的 `agent_run_id`（= 该 user 触发的那一轮）；user 本身不改文件。
 *
 * 返回 `null`：目标之后尚无「更晚的 run」、命中 assistant 缺 `agent_run_id`
 *（老消息 / 流式占位）、或子 Agent 主消息（per-file 只认顶层父轮）。调用方据此跳过文件
 * 恢复；对话截断仍可进行。
 */
export function resolveRewindAnchorId(messages: ChatMessage[], targetIdx: number): string | null {
  const target = messages[targetIdx]
  if (!target) return null

  if (target.role === 'assistant') {
    if (target.subagent_run_id) return null
    //  方向 B：保留该轮，锚到其后第一条「不同 run」的顶层 assistant（回退其后各轮
    // 文件、保留本轮）。无法确定本轮 run（空 run id）→ null，跳过文件回退（不瞎猜）。
    const targetRun = target.agent_run_id || null
    if (!targetRun) return null
    for (let i = targetIdx + 1; i < messages.length; i++) {
      const m = messages[i]
      if (m.role !== 'assistant' || m.subagent_run_id) continue
      if (m.agent_run_id && m.agent_run_id !== targetRun) return m.agent_run_id
    }
    return null
  }

  for (let i = targetIdx + 1; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && !messages[i].subagent_run_id) {
      return messages[i].agent_run_id || null
    }
  }
  return null
}
