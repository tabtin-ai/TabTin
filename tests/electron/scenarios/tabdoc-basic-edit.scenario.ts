import { executableStep, scenario } from "../runner/scenario";
import { prepareTabDocBasicEdit } from "../fixtures/prepare-tabdoc-basic-edit";
import { runTabDocBasicEditProbe } from "../actions/tabdoc";

export default scenario({
  id: "tabdoc.basic-edit",
  title: "用户能在 TabDoc 创建并保存一段内容",
  intent: "验证用户打开 TabDoc 后能创建文档、编辑内容，并在重开后看到持久化结果。",
  priority: "P0",
  profiles: ["smoke", "regression", "data-seeding", "p0-plus"],
  tags: ["electron", "tabdoc", "persistence"],
  sourceCapability: "TabDoc / 编辑保存",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: ["镜像当前 Electron 选择的 Organization/Space，并创建带 run marker 的测试文档。"],
  },
  interactionContract: {
    requiredUserActions: [
      "打开目标 TabDoc 文档。",
      "通过编辑器可见输入面模拟键盘输入正文。",
      "触发真实保存链路并观察保存成功状态。",
    ],
    allowedAutomationHelpers: [
      "可用 Django shell 准备测试文档和做持久化断言。",
      "可用 CDP 读取编辑器状态和保存状态。",
    ],
    forbiddenShortcuts: [
      "不得用 TabDoc probe intent 直接替代编辑器输入。",
      "不得直接调用后端 DocumentService 写入被测编辑内容。",
    ],
  },
  automationStatus: "planned",
  fixtures: ["electron-selection", "mirrored-organization-space", "run-marker"],
  prepare: prepareTabDocBasicEdit,
  steps: [
    executableStep("tabdoc.edit-and-save-through-probe", "通过真实 Electron TabDoc probe 编辑并保存", runTabDocBasicEditProbe),
  ],
});
