import { executableStep, scenario } from "../runner/scenario";
import { prepareTabDataFirstFive } from "../fixtures/prepare-tabdata-first-five";
import { runTabDataFirstFiveCase } from "../actions/tabdata";

export default scenario({
  id: "tabdata.mdl-new-002",
  title: "MDL-NEW-002 新建表的默认结构与命名处理",
  intent: "验证空名创建时使用默认命名，并验证含特殊字符的表名“客户/2026 版”能保存和展示，不破坏资源列表。",
  priority: "P1",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "tabdata", "tabdata-first-five", "mdl-new-002"],
  sourceCapability: "TabData / 建表与数据建模 / 新建空白表",
  testLayer: "logic",
  dataContract: {
    selfContained: true,
    setup: ["镜像当前 Electron 选择的 Organization/Space，并用 run marker 创建默认命名和特殊字符表名样例。"],
  },
  automationStatus: "ready",
  fixtures: ["electron-selection", "mirrored-organization-space", "run-marker"],
  prepare: prepareTabDataFirstFive,
  steps: [
    executableStep(
      "tabdata.mdl-new-002.default-and-special-names",
      "验证默认命名与特殊字符表名展示",
      (context) => runTabDataFirstFiveCase(context, "MDL-NEW-002"),
    ),
  ],
});
