import { executableStep, scenario } from "../runner/scenario";
import { prepareTabDataFirstFive } from "../fixtures/prepare-tabdata-first-five";
import { runTabDataFirstFiveCase } from "../actions/tabdata";

export default scenario({
  id: "tabdata.mdl-pln-001",
  title: "MDL-PLN-001 简单需求落成单表结构",
  intent: "验证“记录团队成员的姓名、岗位、入职日期”这类单实体需求会落成一张可编辑表，字段类型匹配文本、单选和日期，不产生不必要的关联表。",
  priority: "P1",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "tabdata", "tabdata-first-five", "mdl-pln-001"],
  sourceCapability: "TabData / 建表与数据建模 / 字段规划与形态选择",
  testLayer: "logic",
  dataContract: {
    selfContained: true,
    setup: ["镜像当前 Electron 选择的 Organization/Space，并用 run marker 创建单实体字段规划样例。"],
  },
  automationStatus: "ready",
  fixtures: ["electron-selection", "mirrored-organization-space", "run-marker"],
  prepare: prepareTabDataFirstFive,
  steps: [
    executableStep(
      "tabdata.mdl-pln-001.single-flat-table",
      "验证简单团队成员需求落成单表结构",
      (context) => runTabDataFirstFiveCase(context, "MDL-PLN-001"),
    ),
  ],
});
