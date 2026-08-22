import { executableStep, scenario } from "../runner/scenario";
import { prepareChatViewportAnchor } from "../fixtures/prepare-chat-viewport-anchor";
import { runChatViewportAnchorPreservation } from "../actions/chat-viewport";

export default scenario({
  id: "chat.viewport-anchor-preservation",
  title: "用户展开长消息后阅读位置保持稳定",
  intent:
    "验证用户在 Agent 对话时间线中点击「展开全文」阅读长用户消息时，阅读锚点保持稳定（锚点漂移不超过 2px）；随后通过真实点击「回到底部」恢复 follow-latest 跟随。",
  priority: "P0",
  profiles: ["regression", "p0-plus"],
  tags: ["electron", "chat", "viewport", "tier:l1-basic"],
  sourceCapability: "Agent 对话 / 阅读锚点",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: [
      "创建 run-scoped 测试用户、Organization 和个人 Space。",
      "创建至少 20 条历史消息的会话；倒数第二条为 >=2000 字符的用户长消息，末条为 finalized assistant。",
      "fixture 只准备起始世界，不执行展开或写入滚动状态。",
    ],
  },
  interactionContract: {
    requiredUserActions: [
      "通过真实 CDP 鼠标点击长用户消息的展开全文按钮",
      "通过真实 CDP 鼠标点击回到底部按钮恢复跟随",
    ],
    allowedAutomationHelpers: [
      "可用 fixture 准备长历史会话",
      "可用 renderer store 辅助打开目标 Space 和会话",
      "可用只读 probe 采集滚动几何",
    ],
    forbiddenShortcuts: [
      "不得直接调用 CollapsibleMessage 的 React handler",
      "不得直接写 scrollTop 代替用户点击和滚动",
      "不得直接 setPinned 或写 viewport controller 状态",
    ],
  },
  automationContract: [
    "UI 成功证据：展开后锚点漂移 <=2px；点击回到底部后 scroller dataset.viewportMode 为 follow-latest。",
    "证据包包含 snapshots/chat-viewport-anchor-frames.json 与 snapshots/chat-viewport-anchor-metrics.json。",
  ],
  automationStatus: "ready",
  fixtures: ["run-marker", "test-user", "personal-space", "chat-viewport-long-history"],
  prepare: prepareChatViewportAnchor,
  steps: [
    executableStep(
      "chat.viewport-anchor-preservation.expand-and-restore",
      "真实点击展开长消息并断言阅读锚点，再点击回到底部恢复跟随",
      runChatViewportAnchorPreservation,
    ),
  ],
});
