import { plannedStep, scenario } from "./runner/scenario";

export default scenario({
  id: "domain.behavior",
  title: "用户能完成某条产品链路",
  intent: "说明这个场景验证的用户任务、成功状态和为什么重要。",
  priority: "P0",
  profiles: ["smoke", "regression", "p0-plus"],
  tags: ["electron"],
  sourceCapability: "模块 / 能力名",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: ["说明这个场景如何自己准备测试用户、Space 和业务数据。"],
  },
  interactionContract: {
    requiredUserActions: [
      "默认所有用户可感知步骤都必须经过真实模拟用户操作：点击、输入、选择、拖拽或提交。",
      "逐条列出本场景必须由 CDP/Playwright 用户输入事件触发的动作。",
    ],
    allowedAutomationHelpers: [
      "允许后端准备自包含测试数据、登录态 bootstrap、只读 DOM/store 观察和持久化断言。",
      "允许用 CDP/Playwright 定位元素并派发真实输入事件；不允许用 evaluate 直接改 UI 状态。",
    ],
    forbiddenShortcuts: [
      "不得用 service/store/DB/localStorage 直写替代任何用户可感知步骤。",
      "不得用 DOM dispatchEvent 伪造 click/input 来替代 CDP/Playwright 用户输入事件。",
    ],
  },
  automationStatus: "planned",
  fixtures: ["test-user", "personal-space", "clean-browser-state", "run-marker"],
  steps: [
    plannedStep(
      "domain.first-step",
      "第一步用户动作",
      "说明需要补哪个 action 或 expectation。"
    ),
  ],
});
