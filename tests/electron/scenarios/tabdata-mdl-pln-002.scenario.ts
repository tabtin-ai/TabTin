import { executableStep, scenario } from "../runner/scenario";
import { prepareTabDataFirstFive } from "../fixtures/prepare-tabdata-first-five";
import { runTabDataFirstFiveCase } from "../actions/tabdata";

export default scenario({
  id: "tabdata.mdl-pln-002",
  title: "MDL-PLN-002 多实体复用需求建议拆分关联表",
  intent: "验证“管理项目与任务，一个项目多个任务，还要按项目汇总工时”会落成项目表和任务表，并建立任务到项目的关联与项目侧汇总字段。",
  priority: "P1",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "tabdata", "tabdata-first-five", "mdl-pln-002"],
  sourceCapability: "TabData / 建表与数据建模 / 字段规划与形态选择",
  testLayer: "logic",
  dataContract: {
    selfContained: true,
    setup: ["镜像当前 Electron 选择的 Organization/Space，并用 run marker 创建项目/任务建模样例。"],
  },
  automationStatus: "ready",
  fixtures: ["electron-selection", "mirrored-organization-space", "run-marker"],
  prepare: prepareTabDataFirstFive,
  steps: [
    executableStep(
      "tabdata.mdl-pln-002.project-task-model",
      "验证项目任务需求拆成关联表并带汇总字段",
      (context) => runTabDataFirstFiveCase(context, "MDL-PLN-002"),
    ),
  ],
});
