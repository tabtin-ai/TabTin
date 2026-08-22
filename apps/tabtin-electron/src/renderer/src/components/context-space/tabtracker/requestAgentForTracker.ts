/**
 * requestAgentForTracker — 自动化页把自然语言请求交给 Agent 的统一入口
 *
 * 触发场景：
 *   - 「新建自动化」弹窗 · Agent 创建页签（输入后进右侧对话）
 *   - 「全部能力」弹窗里对某条 CLI 能力点「交给 Tin」（开发/回归用）
 *
 * 行为：
 *   1. 展开右侧 ChatSidePanel（如果折叠）——Agent 在副驾栏开干，用户停留在当前 App
 *   2. 新建一轮会话——不污染既有对话
 *   3. 直接把 prompt 作为用户消息发出去，Agent 立刻开干
 *
 * 律 1「唤起不流放」（principle/workspace-project.md §7.2，）：
 * 唤起 AI 不切走画布——历史版本的 setActiveKey(spaceId, null) 已移除。
 */

import { requestAppCollaboration } from '@/services/requestAppCollaboration'

/** Agent 创建自动化任务的系统开场 */
const TRACKER_CREATE_VIA_AGENT_PREFIX = '帮我创建一个自动化任务。'

/** 把用户在「Agent 创建」页签里写的需求包成发给右侧对话的完整 prompt */
export function buildTrackerCreateViaAgentPrompt(userRequest: string): string {
  const body = userRequest.trim()
  if (!body) return TRACKER_CREATE_VIA_AGENT_PREFIX
  return `${TRACKER_CREATE_VIA_AGENT_PREFIX}\n\n我的需求：\n${body}`
}

/** @deprecated 使用 buildTrackerCreateViaAgentPrompt；保留别名避免旧引用断裂 */
export const TRACKER_CREATE_VIA_CHAT_PROMPT = TRACKER_CREATE_VIA_AGENT_PREFIX

export async function requestAgentForTracker(spaceId: string, prompt: string): Promise<boolean> {
  const body = prompt.trim()
  if (!spaceId || !body) return false
  requestAppCollaboration({
    sourceLabel: '自动化',
    spaceId,
    prompt: body,
  })
  return true
}
