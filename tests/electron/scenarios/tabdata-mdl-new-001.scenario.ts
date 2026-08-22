import { executableStep, scenario } from "../runner/scenario";
import { prepareTabDataFirstFive } from "../fixtures/prepare-tabdata-first-five";
import { runTabDataFirstFiveCase } from "../actions/tabdata";

export default scenario({
  id: "tabdata.mdl-new-001",
  title: "MDL-NEW-001 从 Space 新建空白表并立即进入编辑",
  intent: "验证用户从 Space 的 TabData 入口新建空白表时，可以按用例填写表名“客户清单”，确认后直接进入编辑态，且资源列表可见。",
  priority: "P0",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "tabdata", "tabdata-first-five", "mdl-new-001"],
  sourceCapability: "TabData / 建表与数据建模 / 新建空白表",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: ["镜像当前 Electron 选择的 Organization/Space，用 run marker 隔离新建表数据。"],
  },
  interactionContract: {
    requiredUserActions: [
      "打开 TabData 入口。",
      "点击可见的“新建表格”按钮。",
      "输入或确认新表名称。",
      "观察新表进入编辑态并出现在资源列表。",
    ],
    allowedAutomationHelpers: [
      "可用 CDP/localStorage 辅助把 TabData 入口置前。",
      "可用 Django shell 查询新表是否持久化。",
    ],
    forbiddenShortcuts: ["不得直接调用 TableService 创建被测新表。"],
  },
  automationStatus: "planned",
  fixtures: ["electron-selection", "mirrored-organization-space", "run-marker"],
  prepare: prepareTabDataFirstFive,
  steps: [
    executableStep(
      "tabdata.mdl-new-001.create-named-table",
      "通过真实 Electron TabData 入口新建“客户清单”并断言编辑态",
      (context) => runTabDataFirstFiveCase(context, "MDL-NEW-001"),
    ),
  ],
});
