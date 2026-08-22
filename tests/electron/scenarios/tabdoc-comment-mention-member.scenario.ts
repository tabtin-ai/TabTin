import { executableStep, scenario } from "../runner/scenario";
import { prepareTabDocCommentMentionMember } from "../fixtures/prepare-tabdoc-comment-mention-member";
import { runTabDocCommentMentionMemberCase } from "../actions/tabdoc-comment-mention-member";

export default scenario({
  id: "tabdoc.comment-mention-member",
  title: "文档评论能通过 @ 选择工作区域成员并提醒对方",
  intent:
    "验证用户在 TabDoc 文档评论输入框输入 @ 后，能从当前 Organization/Space 成员候选中选择成员，提交评论后保留 mention 语义，并给被 @ 成员生成提醒。",
  priority: "P1",
  profiles: ["regression", "p0-plus"],
  tags: ["electron", "tabdoc", "comments", "mention", "notification", "organization-member"],
  sourceCapability: "TabDoc / 评论 @ 成员提醒",
  caseFile: "tests/electron/scenarios/tabdoc-comment-mention-member.case.md",
  testLayer: "ui",
  dataContract: {
    selfContained: true,
    setup: [
      "创建 run-scoped Organization、Team Space、owner 和被 @ 的工作区域成员。",
      "创建一份 run-scoped TabDoc 文档作为评论前置资源；本场景不验证新建文档本身。",
      "准备 owner 的 Electron 本地登录态，用于后续通过真实 UI 打开文档评论区。",
    ],
  },
  interactionContract: {
    requiredUserActions: [
      "owner 通过真实鼠标点击打开目标 TabDoc 文档。",
      "owner 通过真实鼠标点击打开或定位到“全文评论”区域。",
      "owner 通过真实鼠标点击评论输入框。",
      "owner 通过真实键盘输入 @ 触发成员候选列表。",
      "owner 通过真实鼠标或键盘从候选列表选择目标成员。",
      "owner 继续输入评论正文并通过真实提交动作发送评论。",
      "被 @ 成员收到提醒，后端通知记录与 UI/接口可见状态一致。",
    ],
    allowedAutomationHelpers: [
      "可用后端准备 run-scoped 用户、Organization、Space、成员关系和前置 TabDoc 文档。",
      "可用 Electron 本地 auth bootstrap 切换 owner 登录态和目标 Space。",
      "可用只读 DOM/store 观察定位评论区、候选列表和通知入口。",
      "可用 Django shell 查询评论持久化和 Notification 记录做双断言。",
    ],
    forbiddenShortcuts: [
      "不得直接调用评论 API 或 DocumentShareService 创建带 @ 的评论来替代评论输入框输入和提交。",
      "不得直接创建 Notification 来替代被 @ 成员提醒链路。",
      "不得用 renderer store/localStorage 直接打开文档、注入候选成员或写入评论内容。",
      "不得用 DOM dispatchEvent 伪造 @ 输入、候选选择或提交动作。",
    ],
  },
  automationStatus: "ready",
  expectedFailure: {
    reason: "评论输入框 @ 后尚未弹出 Organization 成员候选，mentions payload 和 Notification 链路也未实现。",
    stepId: "tabdoc.comment-mention-member.type-at-select-and-notify",
    messagePattern: "typing @ in the comment input did not show a Organization member candidate",
  },
  fixtures: [
    "run-marker",
    "electron-owner-auth",
    "team-space",
    "organization-member",
    "tabdoc-comment-target-document",
  ],
  prepare: prepareTabDocCommentMentionMember,
  steps: [
    executableStep(
      "tabdoc.comment-mention-member.type-at-select-and-notify",
      "通过 Electron UI 在文档评论输入 @ 选择成员并发送提醒",
      runTabDocCommentMentionMemberCase,
    ),
  ],
});
