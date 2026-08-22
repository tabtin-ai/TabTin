import { executableStep, scenario } from "../runner/scenario";
import { prepareTabDataFirstFive } from "../fixtures/prepare-tabdata-first-five";
import { runTabDataFirstFiveCase } from "../actions/tabdata";

export default scenario({
  id: "tabdata.mdl-rel-001",
  title: "MDL-REL-001 两张表建立关联并挂接记录",
  intent: "验证任务表能通过关联字段挂接项目记录，项目表侧能看到反向关联任务，并按项目汇总工时。",
  priority: "P0",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "tabdata", "tabdata-first-five", "mdl-rel-001"],
  sourceCapability: "TabData / 建表与数据建模 / 关联表建模",
  testLayer: "logic",
  dataContract: {
    selfContained: true,
    setup: ["镜像当前 Electron 选择的 Organization/Space，并用 run marker 创建项目/任务关联记录样例。"],
  },
  automationStatus: "ready",
  fixtures: ["electron-selection", "mirrored-organization-space", "run-marker"],
  prepare: prepareTabDataFirstFive,
  steps: [
    executableStep(
      "tabdata.mdl-rel-001.link-records",
      "验证任务记录挂接项目与项目侧反向关联/汇总",
      (context) => runTabDataFirstFiveCase(context, "MDL-REL-001"),
    ),
  ],
});
