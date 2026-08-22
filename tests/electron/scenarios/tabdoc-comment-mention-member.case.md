# TabDoc 评论 @ 成员提醒

## 用户目标

用户在一份 TabDoc 的“全文评论”输入框中输入 `@`，从当前 Organization/Space 成员候选中选择成员，提交评论后：

- 评论正文在文档评论区可见。
- 评论保留被 @ 成员的 mention 语义。
- 被 @ 成员收到一条应用内提醒。

## 数据准备

`prepare-tabdoc-comment-mention-member.ts` 通过 Django fixture 准备 run-scoped 数据：

- owner 用户。
- 被 @ 成员。
- 同一个 Organization 和 Team Space。
- 一份用于评论的 TabDoc 文档。
- owner 的 Electron 本地登录态。

这些是前置世界，不替代被测动作。评论输入、候选选择、提交和提醒触发都必须由真实 UI 用户路径完成。

## 真实用户动作契约

本场景为 `ready`，运行时必须覆盖：

1. 真实点击打开目标 TabDoc。
2. 真实点击或滚动到“全文评论”区域。
3. 真实点击评论输入框。
4. 真实输入 `@`。
5. 真实选择成员候选。
6. 真实提交评论。
7. 断言评论可见、mention 持久化、被 @ 成员收到 Notification。

禁止用 `localStorage`、renderer store、DOM `dispatchEvent`、评论 API、`DocumentShareService` 或直接创建 `Notification` 代替这些用户路径。

## 当前 Blocker

截至本用例创建时：

- `DocumentCommentsSection` 只有普通 `Input`，没有成员 mention 候选列表。
- `packages/tabdoc-ui/src/api-client.ts` 的 `createDocumentComment()` 只提交 `{ body }`。
- `DocumentShareComment` 只保存 `body` / `selected_text` / author 信息，没有 mentions 字段。
- `DocumentShareService.create_document_comment()` 不会为 comment mention 创建 Notification。

因此 scenario 当前保持 `automationStatus: "ready"`，但预期失败在真实输入 `@` 后候选成员不出现。产品能力补齐后，继续复用 `tests/electron/actions/real-user-input.ts`，让同一条 action 从候选选择、提交评论走到后端 Notification 断言并变绿。
