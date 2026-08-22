import { executableStep, scenario } from "../runner/scenario";
import { prepareFileDragMoveBetweenFolders } from "../fixtures/prepare-file-drag-move-between-folders";
import { runFileDragMoveBetweenFoldersCase } from "../actions/file-drag-move-between-folders";

export default scenario({
  id: "file.drag-move-between-folders",
  title: "目录中的文件可以通过拖拽移动到另一个文件夹",
  intent:
    "验证用户在 Electron 目录/云盘列表中，可以通过真实鼠标拖拽把一个 run-scoped 文件从源文件夹移动到目标文件夹；移动后源目录不再显示该文件，目标目录显示该文件，并且持久化位置已更新。",
  priority: "P0",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "file", "drag-drop", "tier:l1-basic"],
  sourceCapability: "File / 目录文件拖拽移动",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: [
      "创建或复用测试用户、测试 Organization 和目标个人 Space。",
      "在目标 Space 的云盘根目录下准备 run-scoped 源文件夹。",
      "在源文件夹内准备 run-scoped 目标文件夹和一个带 run marker 的测试 TabDoc 资源；prepare 只负责初始位置，不能提前移动资源。",
      "测试数据名称都带 run marker，便于 UI 定位和持久化断言。",
    ],
  },
  interactionContract: {
    requiredUserActions: [
      "通过真实鼠标点击打开目标 Space 的目录/云盘入口。",
      "通过真实鼠标点击进入源文件夹，确认待移动文件和目标文件夹在源文件夹中可见。",
      "通过真实鼠标 drag start / drag over / drop 把待移动文件资源行或卡片拖到目标文件夹行或卡片上并释放。",
      "通过真实鼠标点击打开目标文件夹，确认待移动文件在目标文件夹中可见。",
      "通过真实鼠标回到源文件夹，确认源文件夹中不再显示该文件。",
    ],
    allowedAutomationHelpers: [
      "允许后端准备测试用户、Organization、Space、源文件夹、目标文件夹和初始 TabDoc 资源。",
      "允许 Electron 本地 auth bootstrap 和目标 Space 选择态 bootstrap。",
      "允许在真实点击云盘入口后仍未进入云盘页时，只做云盘 apphome 导航恢复；不得借此移动资源或改目录状态。",
      "允许 CDP/Playwright 只读定位源文件、目标文件夹和目录列表元素坐标。",
      "允许后端或本地持久化查询验证文件最终 collection_id 已更新到目标文件夹。",
    ],
    forbiddenShortcuts: [
      "不得在 prepare 阶段或 action 阶段直接调用后端 move API、service、DB 更新 collection_id 来替代拖拽。",
      "不得用 renderer store/localStorage 直接修改目录树或选中状态来替代可见 UI 操作。",
      "不得用 DOM dispatchEvent 伪造 dragstart/dragover/drop 来替代 CDP/Playwright 真实鼠标拖拽事件。",
      "不得只用后端位置查询证明通过；必须同时有 Electron UI 中源目录消失、目标目录出现的可见证据。",
    ],
  },
  automationContract: [
    "UI 成功证据：拖拽后目标文件夹中显示待移动文件，源文件夹中不再显示该文件。",
    "持久化成功证据：ContextItem.collection_id 指向目标文件夹，且 run marker、资源标题和资源 ID 与拖拽前一致。",
  ],
  automationStatus: "ready",

  fixtures: ["run-marker", "test-user", "personal-space", "file-tree-drag-move"],
  prepare: prepareFileDragMoveBetweenFolders,
  steps: [
    executableStep(
      "file.drag-move-between-folders.drag-file-into-target-folder",
      "通过真实拖拽把源文件夹中的文件移动到目标文件夹并断言 UI 与持久化位置",
      runFileDragMoveBetweenFoldersCase,
    ),
  ],
});
