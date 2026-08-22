import { plannedStep, scenario } from "../runner/scenario";

export default scenario({
  id: "tabdata.basic-record",
  title: "用户能在 TabData 创建并持久化一条记录",
  intent: "验证用户打开 TabData 后能创建表或使用测试表，新增记录，并在重开后看到持久化结果。",
  priority: "P0",
  profiles: ["smoke", "regression", "data-seeding", "p0-plus"],
  tags: ["electron", "tabdata", "persistence"],
  sourceCapability: "TabData / 表格记录创建与持久化",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: ["创建或复用测试用户、Space 和带 run marker 的测试表。"],
  },
  interactionContract: {
    requiredUserActions: [
      "打开 TabData。",
      "进入测试表格编辑页。",
      "通过表格 UI 新增一条带 run marker 的记录。",
      "刷新或重新打开表格后观察记录仍可见。",
    ],
    allowedAutomationHelpers: ["可用后端准备测试表结构，并用后端查询做持久化断言。"],
    forbiddenShortcuts: ["不得直接调用 RecordService 创建被测记录。"],
  },
  automationStatus: "planned",
  fixtures: ["test-user", "personal-space", "clean-browser-state", "run-marker"],
  steps: [
    plannedStep(
      "tabdata.open-app",
      "打开 TabData",
      "待补 TabData app action。"
    ),
    plannedStep(
      "tabdata.prepare-table",
      "创建或复用测试表",
      "待补幂等前置数据准备脚本。"
    ),
    plannedStep(
      "tabdata.create-record",
      "新增带 run marker 的记录",
      "待复用 TabData probe 或 Playwright grid action。"
    ),
    plannedStep(
      "tabdata.assert-ui-and-backend",
      "断言 UI 可见且后端可查",
      "待补 TabData 后端查询和刷新后 UI expectation。"
    ),
  ],
});
