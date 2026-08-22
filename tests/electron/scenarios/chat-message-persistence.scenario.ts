import { executableStep, scenario } from "../runner/scenario";
import { runChatMessagePersistence } from "../actions/chat";
import { prepareChatMessagePersistence } from "../fixtures/prepare-chat-message-persistence";

export default scenario({
  id: "chat.message-persistence",
  title: "用户聊天消息能落库并重开后仍可见",
  intent: "验证 Space 会话里的用户消息能通过 Electron composer 真实提交、由后端持久化、在 Electron UI 中显示，并在刷新或重开 Electron 后恢复；Agent 回复可以出现，但不是本场景的通过条件。",
  priority: "P0",
  profiles: ["smoke", "regression", "data-seeding", "p0-plus"],
  tags: ["electron", "chat", "persistence"],
  sourceCapability: "TabChat / 消息发送与持久化",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: [
      "创建或复用 Electron chat e2e 测试用户和个人 Organization。",
      "创建 run-scoped Space 和会话，并把 Electron 登录态切到本地测试用户。",
    ],
  },
  interactionContract: {
    requiredUserActions: [
      "通过 CDP 鼠标事件聚焦可见聊天 composer。",
      "通过键盘/文本输入事件写入带 run marker 的消息。",
      "通过 Enter 键提交消息。",
    ],
    allowedAutomationHelpers: [
      "可用 renderer store 辅助切到目标 Space/会话和读取 UI 状态。",
      "可用 Django shell 准备测试用户/Space/会话并做持久化断言。",
    ],
    forbiddenShortcuts: [
      "不得直接调用 useChatStore 或后端 service 创建被测用户消息。",
      "不得直接写 ChatMessage 代替 composer 提交链路。",
    ],
  },
  automationStatus: "ready",
  fixtures: ["electron-selection", "chat-composer", "run-marker"],
  prepare: prepareChatMessagePersistence,
  steps: [
    executableStep("chat.send-and-restore-message", "验证用户消息经 composer 提交、落库并在刷新后恢复", runChatMessagePersistence),
  ],
});
