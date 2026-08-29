# #11993 恢复共享后历史卡要刷新才更新 — 验收 harness

## 现象

同一任务先发查看卡 a1、再发协作卡 b1。统一收回后再恢复，只有 b1 实时更新，a1 仍显示无权限，刷新会话才变。

诊断包 `tabtin-diag-preprod-1.1.3-beta.3-20260827-105522.zip` 的 git 是 `88b118c06cdc`，已含 #11974。刷新后能变，说明详情叠卡已生效。

## 根因

停权后详情把 `session_id` 置空。`session.collaboration.changed` 只按缓存 `session_id` 找兄弟卡，对不上 a1。

## 修法

- 详情增加 `shared_session_id`，停权后仍保留任务 id。
- 前端用 `session_id` / `shared_session_id` / `effective_share_id` 找同任务卡并重拉。
- 发起人恢复 / 停止时也重拉同任务缓存卡。
- 查看 / 协作档位仍按发卡时（#11972）；开关状态跟最新授权。

## 复跑

```bash
cd apps/tabtin_django
USE_SQLITE_FOR_TESTS=0 python manage.py test \
  apps.chat.conversation.tests.test_session_share.SessionShareTestCase.test_v2_detail_projects_latest_state_onto_older_cards \
  apps.chat.conversation.tests.test_session_share.SessionShareTestCase.test_v2_share_stays_inactive_until_recipient_joins \
  --keepdb --noinput -v 1

cd ../../apps/tabtin-electron
pnpm exec vitest run \
  src/renderer/src/services/sessionCollaborationEventHandler.test.ts \
  src/renderer/src/components/chat/session/SessionCollaborators.test.tsx
```

本地 Django 无 venv 时可用：

`/Users/tabtin-work/worktrees/tabtin/fix-byok-multi-site-connection/apps/tabtin_django/venv/bin/python`

前端单测若在 linked worktree，用主目录 `apps/tabtin-electron` 的 vitest，指向本分支测试文件。

## 上次结果（2026-08-27）

- Django 3 条：`test_v2_detail_projects_latest_state_onto_older_cards` / `test_v2_share_stays_inactive_until_recipient_joins` / `test_v2_detail_projects_later_pending_restore_onto_revoked_older_card` 绿
- Electron vitest 10 条：`sessionCollaborationEventHandler.test.ts`（5）+ `SessionCollaborators.test.tsx`（5）绿

## 未覆盖

- Live：含本 tip 的包里，同一任务两张卡停后再恢复，a1 应无需刷新就跟上最新开关状态。
