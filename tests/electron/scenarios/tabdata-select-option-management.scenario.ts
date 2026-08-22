import { executableStep, scenario } from "../runner/scenario";
import { prepareTabDataFirstFive } from "../fixtures/prepare-tabdata-first-five";
import { runTabDataFirstFiveCase } from "../actions/tabdata";

export default scenario({
  id: "tabdata.select-option-management",
  title: "选项类字段重命名已用选项后记录同步显示新名",
  intent:
    "验证用户通过 Electron 字段设置面板重命名已被使用的 TabData 单选项后，所有使用该选项的记录同步显示并持久化为新名称。",
  caseFile: "tests/electron/scenarios/tabdata-select-option-management.case.md",
  userFlow: [
    "打开 TabTin Electron 并进入目标 Space。",
    "点击左侧“多维表”入口。",
    "在多维表资源列表中打开测试表“选项管理验收表”。",
    "确认进入表格编辑页，可以看到“客户名称”和“状态”字段。",
    "打开“状态”字段的字段设置或选项管理入口。",
    "将已被使用的选项“进行中”重命名为“处理中”。",
    "确认所有原来使用“进行中”的记录现在都显示为“处理中”。",
    "刷新或重新打开该表，再次确认最终状态保持一致。",
  ],
  automationContract: [
    "必须打开 Electron 中的具体 TabData 表格编辑页，而不是停留在多维表资源列表页。",
    "必须通过 Electron 字段设置面板修改选项输入框并点击保存，不能用后端 service 直接改字段配置。",
    "重命名已用选项后，必须验证至少两条原使用记录都显示新名称。",
    "未达到上述最低覆盖时，即使后端数据断言通过，也只能视为后端语义验收，不能标记为完整 Electron UI E2E。",
  ],
  priority: "P0",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "tabdata", "select-field", "option-management"],
  sourceCapability: "TabData / 字段管理 / 选项类字段选项管理",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: ["创建带单选字段和多条已使用选项记录的测试表，所有数据带 run marker。"],
  },
  interactionContract: {
    requiredUserActions: [
      "点击 TabData 入口。",
      "点击目标表格资源进入编辑页。",
      "点击“状态”字段设置或选项管理入口。",
      "聚焦“进行中”选项输入框并输入“处理中”。",
      "点击“保存”。",
    ],
    allowedAutomationHelpers: [
      "可用 CDP/localStorage 辅助把 TabData 入口置前。",
      "可用 Django shell 准备测试表/记录并验证持久化结果。",
    ],
    forbiddenShortcuts: [
      "不得直接调用字段设置 store 打开被测字段面板。",
      "不得直接调用后端 service 修改字段配置或记录值。",
    ],
  },
  automationStatus: "planned",
  fixtures: ["electron-selection", "mirrored-organization-space", "run-marker", "select-field-with-used-options"],
  prepare: prepareTabDataFirstFive,
  steps: [
    executableStep(
      "tabdata.select-option-management.option-lifecycle",
      "通过 Electron UI 自动验证已用选项重命名会同步到记录",
      (context) => runTabDataFirstFiveCase(context, "SELECT-OPTION-MANAGEMENT"),
    ),
  ],
});
