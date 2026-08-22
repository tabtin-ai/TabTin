/**
 * requestAgentForDoc — 在「文档」首页把示例任务直接交给 Agent 的统一入口
 *
 * 触发场景：用户在 TabDoc 根目录页的「让 AI 帮你处理文档」介绍区点某张示例任务卡片。
 *
 * 行为：
 *   1. 展开右侧 ChatSidePanel（如果折叠）——Agent 在副驾栏开干，用户停留在当前 App
 *   2. 新建一轮会话——「点示例 = 开一个独立任务」，不污染既有对话
 *   3. 直接把示例 prompt 作为用户消息发出去，Agent 立刻开干
 *
 * 律 1「唤起不流放」（principle/workspace-project.md §7.2，）：
 * 唤起 AI 不切走画布——历史版本的 setActiveKey(spaceId, null) 已移除，
 * 理由见 requestAgentForTable 文件头。
 *
 * 设计原则：
 * - 与 requestAgentForSlide 同源：把 store / UI 编排集中在一个 helper，业务组件只管点。
 * - 这里走「直接发送」而非「注入 preset 表单」——文档示例本身就是一条完整可执行的请求。
 */

import { requestAppCollaboration } from '@/services/requestAppCollaboration'

export async function requestAgentForDoc(spaceId: string, prompt: string): Promise<void> {
  requestAppCollaboration({
    sourceLabel: '文档',
    spaceId,
    prompt,
  })
}
