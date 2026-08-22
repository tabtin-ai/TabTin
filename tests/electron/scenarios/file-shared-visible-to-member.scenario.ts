import { executableStep, scenario } from "../runner/scenario";
import { prepareFileSharedVisibleToMember } from "../fixtures/prepare-file-shared-visible-to-member";
import { runFileSharedVisibleToMemberCase } from "../actions/file-shared-visible-to-member";

export default scenario({
  id: "file.shared-visible-to-member",
  title: "团队成员能看到其他成员分享的文件",
  intent:
    "验证 owner 在测试团队文件共享-0706 内通过 Electron 云盘真实点击创建并分享一个 TabDoc 后，成员B登录 Electron 打开目标 Space 的云盘，能在“分享给我”中看到该资源，点击打开并停留在共享文档页。",
  priority: "P0",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", "file", "sharing", "organization", "tabdoc"],
  sourceCapability: "File / 团队成员可见共享文件",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: [
      "创建 run-scoped Organization，名称包含“测试团队文件共享-0706”。",
      "创建 owner、成员A、成员B、成员C，并加入同一个 Organization 和目标团队 Space。",
      "创建 owner workspace 和目标团队 Space；prepare 不预创建 TabDoc 资源。",
      "action 中先注入 owner 的 Electron 本地登录态，owner 通过云盘真实点击“新建资源→文档”创建 TabDoc。",
      "owner 通过 CDP 真实点击标题输入框和正文编辑区，并输入共享文档标题和正文。",
      "后端仅在 owner UI 创建并编辑文档后识别该 TabDoc、校验标题已落库，并补齐 DocumentPermission 分享关系。",
      "再注入成员B的 Electron 本地登录态，选中目标团队 Space 作为成员侧 host Space。",
    ],
  },
  interactionContract: {
    requiredUserActions: [
      "owner 登录后通过真实鼠标点击打开云盘。",
      "owner 通过真实鼠标点击“新建资源”菜单，并点击“文档”创建 TabDoc。",
      "owner 通过真实鼠标点击标题输入框并输入共享文档标题。",
      "owner 通过真实鼠标点击正文编辑区并输入共享文档正文。",
      "成员B登录后通过真实鼠标点击打开云盘文件/资源列表。",
      "成员B通过真实鼠标点击“分享给我”筛选入口。",
      "在文件/资源列表中确认 owner 分享的资源标题可见。",
      "确认该资源的位置/所有者信息显示为由 owner 分享。",
      "成员B通过真实鼠标点击共享资源行打开 TabDoc，最终停留在打开的文档页并看到 owner 输入的正文。",
    ],
    allowedAutomationHelpers: [
      "可用后端准备测试用户、Organization、Space 和成员关系。",
      "可用后端识别 owner 刚通过 UI 创建和编辑的 TabDoc，并补齐协作者分享关系。",
      "可用后端 shared-with-me 查询做结果双断言。",
      "可用 Electron 本地 auth bootstrap 切换 owner/成员B 登录态和目标 Space。",
    ],
    forbiddenShortcuts: [
      "不得在 prepare 阶段直接创建 TabDoc 资源来替代 owner 的云盘创建点击。",
      "不得由后端直接写入标题或正文来替代 owner 在 Electron 编辑器里的输入。",
      "不得用 renderer store/localStorage 直接打开云盘或资源详情来替代可见 UI 点击。",
      "不得直接查询 DocumentPermission 或 shared-with-me 来替代 Electron 列表可见性断言。",
      "不得直接调用 renderer store 注入共享资源列表。",
      "不得把成员加入 owner 私有 workspace 来绕过协作者分享链路。",
    ],
  },
  automationStatus: "ready",
  fixtures: ["run-marker", "organization", "team-space", "owner-member-file-share", "electron-owner-member-auth", "tabdoc-ui-create"],
  prepare: prepareFileSharedVisibleToMember,
  steps: [
    executableStep(
      "file.shared-visible-to-member.verify-shared-file-list",
      "通过 Electron UI 验证成员能看到 owner 分享的文件并打开",
      runFileSharedVisibleToMemberCase,
    ),
  ],
});
