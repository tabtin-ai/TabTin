import { executableStep, scenario } from "../runner/scenario";
import { prepareTabdocTabSwitchPreservesContent } from "../fixtures/prepare-tabdoc-tab-switch-preserves-content";
import { runTabdocTabSwitchPreservesContent } from "../actions/tabdoc-tab-switch-preserves-content";

/**
 * ：来回切换两篇 TabDoc 后，首段结构不得因 Activity 销毁 Y.Doc / 空 hydrate 而增殖空段。
 * 当前 automationStatus=planned：单元层已用 Activity/hydrate/scope claim 钉死；
 * UI 10 次切换需 Electron + CDP 就绪后把 action 补齐并升 ready。
 */
export default scenario({
  id: "tabdoc.tab-switch-preserves-content",
  title: "切换 TabDoc 标签不会在正文上方增殖空段",
  intent:
    "验证用户在同一 scope 打开两篇带固定首段的文档并真实点击切换至少 10 次后，UI 与持久化 PM/Yjs 首段结构前后一致，且同文档只占一个 scope、无 Provider 重建风暴。",
  priority: "P0",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "tabdoc", "collab", "tier:l1-basic", "issue:8021"],
  sourceCapability: "TabDoc / 协作生命周期 / 标签切换",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: [
      "创建两篇带固定首段 marker 的 TabDoc（文档 A / 文档 B）。",
      "两篇文档均在同一 foreground scope 打开，不预写空段。",
    ],
  },
  interactionContract: {
    requiredUserActions: [
      "真实点击打开文档 A 与文档 B 标签。",
      "在两个标签间真实点击切换至少 10 次。",
    ],
    allowedAutomationHelpers: [
      "允许 Django shell 准备两篇带固定首段的文档并做持久化首段断言。",
      "允许 CDP 只读采集编辑器首段结构、scope 数与 collab probe 事件。",
    ],
    forbiddenShortcuts: [
      "不得用 store.setActiveKey 替代真实点击切换。",
      "不得在断言前自动删除已有空段。",
      "不得直接写入 Y.Doc / REST 正文来伪造切换后状态。",
    ],
  },
  automationContract: [
    "UI：切换后文档 A 首段文本与 fixture marker 一致，上方无新增空 paragraph。",
    "持久化：后端 PM/Yjs 首段结构与切换前一致。",
    "Scope：同文档 listScopesForTabKey 长度为 1。",
    "Collab：同文档 ydoc.create 世代在切换过程中不因 Activity cleanup 激增。",
  ],
  automationStatus: "planned",
  fixtures: ["run-marker", "electron-selection", "two-tabdoc-fixed-lead"],
  prepare: prepareTabdocTabSwitchPreservesContent,
  steps: [
    executableStep(
      "tabdoc.switch-ten-times-preserves-lead",
      "真实点击切换两篇文档至少 10 次并断言首段与 scope",
      runTabdocTabSwitchPreservesContent,
    ),
  ],
});
