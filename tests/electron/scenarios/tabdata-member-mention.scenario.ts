import { plannedStep, scenario } from "../runner/scenario";

export default scenario({
  id: "tabdata.member-mention",
  title: "TabData 成员字段能通过 @ 选择工作空间成员",
  intent:
    "验证用户在 TabData 表格单元格中输入 @ 后，能看到当前 Organization/Space 成员候选，选择成员后单元格保存该成员，并在刷新或重新打开表格后保持正确。",
  priority: "P0",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "tabdata", "member-field", "mention"],
  sourceCapability: "TabData / 成员字段 / @ 选择成员",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: [
      "注入指向 run-scoped 团队 Organization 的本地 e2e 登录态。",
      "创建 run-scoped Team Space、第二个 Organization 成员、成员字段测试表和空记录。",
    ],
  },
  interactionContract: {
    requiredUserActions: [
      "点击 TabData 入口。",
      "点击目标表格资源进入编辑页。",
      "点击负责人单元格。",
      "通过键盘输入 @。",
      "从成员候选列表选择目标成员。",
      "刷新或重新打开表格后观察成员仍显示正确。",
    ],
    allowedAutomationHelpers: [
      "可用后端准备测试用户、Organization 成员、Space、表结构和空记录。",
      "可用后端查询做持久化断言。",
      "可用 CDP/localStorage 辅助把 TabData 入口置前。",
    ],
    forbiddenShortcuts: [
      "不得直接调用 RecordService 写入成员值来代替 @ 输入和候选选择。",
      "不得直接调用 renderer store 选择成员。",
    ],
  },
  automationStatus: "planned",
  fixtures: ["electron-e2e-team-auth", "team-space", "organization-member", "run-marker", "tabdata-user-field-table"],
  steps: [
    plannedStep(
      "tabdata.member-mention.type-at-and-select-member",
      "通过 Electron UI 在成员字段输入 @ 并选择成员",
      "当前 action 仍通过 renderer evaluate/DOM 事件完成核心输入和候选选择；改为 CDP/Playwright 真实输入事件后再标记 ready。",
    ),
  ],
});
