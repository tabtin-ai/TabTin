import { plannedStep, scenario } from "../runner/scenario";

/**
 * L3 regression backlog for .
 * Ready automation should: real clicks to create two parent fields, switch
 * active field, and assert view.config.subRecordParentFieldId via persistence probe.
 */
export default scenario({
  id: "tabdata.hierarchy-parent-field-switch",
  title: "用户能连续创建多个父记录字段并切换当前视图层级",
  intent:
    "验证工具栏层级创建走非幂等路径：连续创建两个父字段即时出现，切换后整表树与持久化视图配置一致。",
  priority: "P1",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "tabdata", "tier:l3-canvas", "hierarchy"],
  sourceCapability: "TabData / 多父记录字段与视图层级切换",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: ["创建或复用测试用户、Space 和空测试表（无父记录字段）。"],
  },
  interactionContract: {
    requiredUserActions: [
      "打开测试表格。",
      "打开工具栏「层级」面板。",
      "点击「创建父记录字段」两次。",
      "在候选列表中切换选中另一父字段。",
    ],
    allowedAutomationHelpers: [
      "可用后端准备空表结构；用后端查询断言字段列表与 view.config.subRecordParentFieldId。",
    ],
    forbiddenShortcuts: [
      "不得直接调用 ensure-parent-field / create-parent-field API 代替 UI 创建。",
      "不得直接写 view.config 代替 UI 切换。",
    ],
  },
  automationStatus: "planned",
  fixtures: ["test-user", "personal-space", "clean-browser-state", "run-marker"],
  steps: [
    plannedStep(
      "tabdata.hierarchy.open-table",
      "打开测试表",
      "待补 TabData 开表 action。",
    ),
    plannedStep(
      "tabdata.hierarchy.create-two-parent-fields",
      "连续点击创建两个父记录字段",
      "待补层级面板 create 按钮点击与候选列表即时断言。",
    ),
    plannedStep(
      "tabdata.hierarchy.switch-active-field",
      "切换激活父字段并断言树/配置",
      "待补单选切换 + 持久化探针 view.config.subRecordParentFieldId。",
    ),
  ],
});
