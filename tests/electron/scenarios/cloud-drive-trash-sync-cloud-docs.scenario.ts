import { executableStep, scenario } from "../runner/scenario";
import { prepareCloudDriveTrashSyncCloudDocs } from "../fixtures/prepare-cloud-drive-trash-sync-cloud-docs";
import { runCloudDriveTrashSyncCloudDocsCase } from "../actions/cloud-drive-trash-sync-cloud-docs";

export default scenario({
  id: "cloud-drive.trash-sync-cloud-docs",
  title: "云盘删除后云文档列表立即消失",
  intent:
    "验证同一 TabDoc/TabData 资源从云盘删除后，云盘与云文档活跃列表立即收敛，源资源与 ContextItem 同步进回收站，普通打开链路被拒绝。",
  priority: "P1",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "cloud-drive", "tabdoc", "tabdata", "tier:l1-basic", "issue:7437"],
  sourceCapability: "云盘 / 删除与云文档收敛",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: [
      "创建 run-scoped 用户、Organization、Space。",
      "创建带 run marker 的 TabDoc 文档与 TabData 表格（及对应 ContextItem）。",
    ],
  },
  interactionContract: {
    requiredUserActions: [
      "打开云盘并确认文档/表格可见。",
      "对文档右键删除并确认。",
      "对表格右键删除并确认。",
      "切换到云文档，确认两条目均不再出现。",
    ],
    allowedAutomationHelpers: [
      "可用 Django shell 准备文档/表格 fixture，并做回收站/读门禁持久化断言。",
      "可用 CDP 只读定位资源行与菜单项坐标；删除必须通过真实 right-click / click。",
      "云盘入口若 rail 点击失败，允许 localStorage 写入 apphome:cloud-resources 标签后 reload（仅导航 bootstrap，不替代删除动作）。",
    ],
    forbiddenShortcuts: [
      "不得直接调用 trash API / DocumentService.trash / TableService.trash 替代 UI 删除。",
      "不得用 renderer store 或 DOM dispatchEvent 伪造删除。",
    ],
  },
  automationContract: [
    "UI 成功证据：云盘列表与云文档列表 bodyText 均不再包含文档标题与表格名。",
    "持久化成功证据：Document/Table.trashed_at 有值；对应 ContextItem 为 trashed；get_document/get_table 活跃读被拒绝。",
  ],
  automationStatus: "ready",

  fixtures: ["run-marker", "mirrored-organization-space", "tabdoc", "tabdata"],
  prepare: prepareCloudDriveTrashSyncCloudDocs,
  steps: [
    executableStep(
      "cloud-drive.trash-sync-cloud-docs.main",
      "云盘删除文档/表格后云文档列表立即消失，并完成回收站状态断言",
      runCloudDriveTrashSyncCloudDocsCase,
    ),
  ],
});
