import { plannedStep, scenario } from "../runner/scenario";

export default scenario({
  id: "workspace.basic",
  title: "用户能进入个人 Space 工作台",
  intent: "验证测试用户进入个人 Space 后，可以看到基础工作台、会话区和可用 App。",
  priority: "P0",
  profiles: ["smoke", "regression", "data-seeding", "p0-plus"],
  tags: ["electron", "workspace", "space"],
  sourceCapability: "Space / 工作台入口",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: ["创建或复用测试用户和测试个人 Space。"],
  },
  interactionContract: {
    requiredUserActions: ["启动/连接 Electron 后进入测试个人 Space。"],
    allowedAutomationHelpers: ["可用后端准备测试用户、Organization、Space 和 membership。"],
    forbiddenShortcuts: ["不得只查后端 Space 存在就判定工作台可用。"],
  },
  automationStatus: "planned",
  fixtures: ["test-user", "personal-space", "clean-browser-state", "run-marker"],
  steps: [
    plannedStep(
      "workspace.open-personal-space",
      "进入测试个人 Space",
      "待接入 Playwright Electron 启动和登录态 fixture。"
    ),
    plannedStep(
      "workspace.assert-home-visible",
      "断言工作台基础 UI 可见",
      "待补稳定 data-testid 和工作台 UI expectation。"
    ),
    plannedStep(
      "workspace.assert-backend-space",
      "断言后端可查测试 Space",
      "待补 Django/API 查询 expectation。"
    ),
  ],
});
