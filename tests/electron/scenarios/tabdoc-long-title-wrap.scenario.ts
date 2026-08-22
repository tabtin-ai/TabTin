import { executableStep, scenario } from "../runner/scenario";
import { prepareTabdocLongTitleWrap } from "../fixtures/prepare-tabdoc-long-title-wrap";
import { runTabdocLongTitleWrapCase } from "../actions/tabdoc-long-title-wrap";

export default scenario({
  id: "tabdoc.long-title-wrap",
  title: "TabDoc 文档长标题会在容器内软换行",
  intent:
    "验证用户从云盘打开一篇超长标题 TabDoc 时，标题在编辑器标题容器内软换行显示，不产生横向溢出；同时确认打开的是后端准备的同一篇文档。",
  priority: "P0",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "tabdoc", "layout", "tier:l1-basic"],
  sourceCapability: "TabDoc / 文档标题 / 长标题软换行",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: [
      "创建 run-scoped 测试用户、Organization 和个人 Space，并 bootstrap Electron 登录态。",
      "在目标 Space 根目录准备一篇标题包含 run marker 且含长无空格片段的 TabDoc 文档。",
      "fixture 只准备初始文档和标题，不通过 DOM、store 或 service 修改被测页面布局状态。",
    ],
  },
  interactionContract: {
    requiredUserActions: [
      "通过真实鼠标点击打开目标 Space 的云盘入口。",
      "通过真实鼠标点击云盘中的目标 TabDoc 资源，打开文档编辑器。",
    ],
    allowedAutomationHelpers: [
      "允许后端准备 run-scoped 测试用户、Organization、Space 和初始 TabDoc 文档。",
      "允许 Electron 本地 auth bootstrap 和目标 Space 选择态 bootstrap。",
      "允许在真实点击云盘入口后仍未进入云盘页时，只做云盘 apphome 导航恢复；不得借此打开目标文档或修改标题布局。",
      "允许 CDP/Playwright 只读定位云盘入口、目标文档资源和标题 textarea 的几何信息。",
      "允许后端查询验证文档 ID、标题和 ContextItem 仍与准备数据一致。",
    ],
    forbiddenShortcuts: [
      "不得用 service/store/DB/localStorage 直接打开目标文档来替代云盘点击。",
      "不得用 DOM dispatchEvent 伪造 click/input 来替代 CDP/Playwright 用户输入事件。",
      "不得在 action 阶段直接改 textarea class/style/value 或 renderer state 来制造软换行结果。",
      "不得只用后端标题存在证明通过；必须采集 Electron UI 中标题 textarea 的换行和横向溢出证据。",
    ],
  },
  automationContract: [
    "UI 成功证据：目标 TabDoc 打开后，标题 textarea 的 value 等于准备标题、可测得多行高度，且 scrollWidth 不超过 clientWidth。",
    "持久化成功证据：后端 Document 与 ContextItem 的标题、Space 和 Organization 与准备数据一致。",
  ],
  automationStatus: "ready",

  fixtures: ["run-marker", "test-user", "personal-space", "tabdoc-long-title"],
  prepare: prepareTabdocLongTitleWrap,
  steps: [
    executableStep(
      "tabdoc.long-title-wrap.open-and-measure-title",
      "通过真实点击打开长标题文档并断言标题软换行",
      runTabdocLongTitleWrapCase,
    ),
  ],
});
