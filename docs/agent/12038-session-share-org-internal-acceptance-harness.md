# #12038 新建会话共享给组织内同事 503 — 验收 harness

## 验到哪

- 现象：Agent 窗把新建任务「数字11」共享给组织内同事「沈 @user_1976」，三次
  `POST /chat/session-shares` 都是 503 `SessionShareDeliveryUnconfirmed`。
- 对照：同一对用户、旧任务在已打开的组织内私聊 `01a04147-…` 上带
  conversation hint 发卡，`server_receipt` 成功。
- 分叉：`ShareSessionDialog` 以前不传 `conversation_id`；IM 窗
  `SessionSharePickerDialog` 会传。无 hint 时服务端另走 `POST /dm`，投递未确认。
- 投递组织钉在任务组织 / 当前组织，不换外部 C2C 托管组织。
- 诊断包：`tabtin-diag-preprod-1.1.3-beta.4-20260827-142028.zip`
  （同内容 `(1)` / `(3)`）。preprod `1.1.3-beta.4` / `de59b902a6`。

## 复跑

支线不装依赖。用主目录 `node_modules` 软链。

```bash
ln -sfn /Users/tabtin-work/tabtin/node_modules \
  /Users/tabtin-work/worktrees/tabtin/fix/12038-session-share-external-unconfirmed/node_modules
ln -sfn /Users/tabtin-work/tabtin/apps/tabtin-electron/node_modules \
  /Users/tabtin-work/worktrees/tabtin/fix/12038-session-share-external-unconfirmed/apps/tabtin-electron/node_modules

cd /Users/tabtin-work/worktrees/tabtin/fix/12038-session-share-external-unconfirmed/apps/tabtin-electron
./node_modules/.bin/vitest run \
  src/renderer/src/components/chat/composer/resolveOrgInternalShareConversation.test.ts \
  src/renderer/src/components/chat/composer/ShareSessionDialog.test.tsx
```

权限回归（确认未放宽跨组织授权）：

```bash
cd apps/tabtin_django
USE_SQLITE_FOR_TESTS=0 TABTIN_DATABASE_MODE=single_pg \
  python manage.py test \
  apps.chat.conversation.tests.test_session_share.SessionShareTestCase.test_cross_org_grantee_rejected \
  apps.chat.conversation.tests.test_session_share.SessionShareTestCase.test_share_to_self_rejected \
  --keepdb --noinput -v 2
```

## 上次结果（2026-08-27）

- `resolveOrgInternalShareConversation.test.ts` + `ShareSessionDialog.test.tsx`：8 passed
- 跨组织授权拒绝 / 分享给自己拒绝：未改权限模型

## 没覆盖

- 未做 preprod 双人 live：新建 Agent 会话共享给组织内同事，看卡片是否确认
- ACK 上当时 IM 5xx 原文这次没取到完整 request id 对照
- 跨组织 grantee 仍 400「接收人不是该组织成员」
