import { plannedStep, scenario } from "../runner/scenario";

export default scenario({
  id: "agent.controlled-command",
  title: "用户能触发 Agent 执行可控低风险命令",
  intent: "验证用户从聊天发起任务后，Agent 执行链路能产生可观察的工具运行记录和结果回传。",
  priority: "P0",
  profiles: ["external-ai", "regression", "p0-plus"],
  tags: ["electron", "agent", "terminal", "external-ai"],
  sourceCapability: "Agent / 终端执行闭环",
  testLayer: "ui",
  dataContract: {
    selfContained: false,
    setup: ["需要测试用户、测试 Space 和可控 Agent 执行通道。"],
    externalDependencies: ["当前默认依赖外部模型或尚未落地的可控执行通道。"],
  },
  interactionContract: {
    requiredUserActions: ["通过聊天 composer 发起可控 Agent 任务。"],
    allowedAutomationHelpers: ["可用后端/日志读取 Agent session、tool run 和终端输出做断言。"],
    forbiddenShortcuts: ["不得直接创建 tool run 或终端记录来冒充用户触发的 Agent 执行。"],
  },
  automationStatus: "planned",
  fixtures: ["test-user", "personal-space", "clean-browser-state", "run-marker"],
  steps: [
    plannedStep(
      "agent.send-controlled-command",
      "发送可控 Agent 任务",
      "待确认是否存在不依赖外部模型的可控 Agent 执行通道。"
    ),
    plannedStep(
      "agent.assert-tool-run",
      "断言 terminal/tool run 出现",
      "待补 Agent session 和工具运行记录 expectation。"
    ),
    plannedStep(
      "agent.assert-result-visible",
      "断言结果在 UI 或执行记录里可见",
      "待补运行结果回传观察点。"
    ),
  ],
});
