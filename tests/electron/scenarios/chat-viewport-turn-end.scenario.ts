import { executableStep, scenario } from "../runner/scenario";
import { prepareChatViewportTurnEnd } from "../fixtures/prepare-chat-viewport-turn-end";
import { runChatViewportTurnEndStability } from "../actions/chat-viewport-turn-end";

export default scenario({
  id: "chat.viewport-turn-end-stability",
  title: "Agent 轮次结束后 follow-latest 视口跳变可控",
  intent:
    "验证用户在真实 Agent 对话中发送一轮含 thinking、多工具与最终产物的任务后，轮次结束时 follow-latest 视口跳变不超过 24px，且既有 follow 阈值仍成立。",
  priority: "P0",
  profiles: ["external-ai", "regression", "p0-plus"],
  tags: ["electron", "chat", "viewport", "external-ai", "tier:l4-agent"],
  sourceCapability: "Agent 对话 / turn-end 视口稳定性",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: [
      "复用本地数据库中已有可执行个人 Space：active Agent + preferred model + 在线 Device + 非空 working_dir。",
      "优先使用 TABTIN_E2E_LIVE_SPACE_ID；未设置时按 Electron runtime 等 readiness 条件查询 fallback。",
      "优先复用活跃 Organization owner，并幂等确保其 owner/active SpaceMembership；否则复用已有活跃成员。",
      "只创建标题含 runId 的空 ChatSession；不创建或修改用户、Organization、Space 执行绑定、Agent、Device、working_dir，不清理其他会话。",
    ],
    externalDependencies: [
      "本地无满足 readiness 的已有执行 Space 时 step 记 skipped（environment-unavailable），不空等 composer。",
      "依赖外部模型产出 thinking + ≥4 tools + artifact；结构不足时 step 记 skipped（environment-unavailable），不记产品 FAIL。",
      "选中可执行 Space 后 composer 仍 disabled：记产品 FAIL（不 skip），避免掩盖接线回归。",
    ],
  },
  interactionContract: {
    requiredUserActions: [
      "通过真实 CDP composer 输入并发送固定中文 prompt，要求执行一轮可观察任务（thinking + ≥4 tools + final artifact）",
    ],
    allowedAutomationHelpers: [
      "可用 fixture 准备空会话与 run-scoped 用户/org/Space",
      "可用 action 单独取脱敏 auth payload",
      "可用 renderer store 辅助打开目标 Space 和会话",
      "可用只读 probe 采集滚动几何与只读结构检查",
    ],
    forbiddenShortcuts: [
      "不得直接向 store 注入消息 / streaming 状态",
      "不得直接调用 React handler 代替 composer 发送",
      "不得直接写 scrollTop 或 viewport controller 状态",
    ],
  },
  automationContract: [
    "没有已有可执行 Space 候选：写 selection/readiness environment artifact 后立即 skipped，不取 auth、不打开 composer。",
    "有候选：打开 run-scoped session，校验 open 回传 agentId 与 prepare 一致；composer readiness 超时 20s，仍 disabled 记 FAIL。",
    "先等待 streaming true→false + settle，再只读检查本轮结构：thinking>=1、tool steps>=4、artifact>=1。",
    "结构满足才运行 follow-latest assert（含 turnEndJumpMax<=24）并 PASS；证据含 frames/metrics/structure。",
    "结构不满足或可识别的 provider/model 未配置：step status=skipped（environment-unavailable），不得记产品 FAIL。",
  ],
  automationStatus: "ready",
  fixtures: ["run-marker", "test-user", "personal-space", "chat-viewport-empty-session"],
  prepare: prepareChatViewportTurnEnd,
  steps: [
    executableStep(
      "chat.viewport-turn-end-stability.run-and-assert",
      "真实发送 Agent 任务并断言 follow-latest turn-end 视口稳定性",
      runChatViewportTurnEndStability,
    ),
  ],
});
