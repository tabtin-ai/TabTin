# #11974 恢复权限后同任务旧共享卡仍显示已停止 — 验收 harness

## 现象

同一任务对同一接收人有多张协作邀请卡。停止后再恢复（或再发一张邀请），只有最新一张变成「待确认」，历史卡仍停在「已停止」。

诊断包 `tabtin-diag-preprod-1.1.2-beta.57-20260826-225121.zip` 的 git 是 `7826841b22a9`，不含 #11972；本 issue 是恢复方向后续，不是把权限按卡叠回最新授权。

## 根因

`get_share_detail` 选生命周期时排除 `pending`。恢复后最新一张是 pending，旧卡继续吃「最新非 pending」的已撤销行。

## 修法

- 最新落地授权仍有效 → 新 pending 不盖已参与的旧卡（#11972 保留）。
- 当前已没有仍有效的落地授权 → 最新 pending/active 叠到旧卡，恢复后不再停死。
- 从旧卡确认加入时激活最新 pending，不直接 activate 已撤销行。
- 恢复 / 再发 v2 邀请后发 `session.collaboration.changed`，兄弟卡重拉详情。

## 复跑

```bash
cd apps/tabtin_django
USE_SQLITE_FOR_TESTS=0 python manage.py test \
  apps.chat.conversation.tests.test_session_share.SessionShareTestCase.test_v2_detail_projects_latest_state_onto_older_cards \
  apps.chat.conversation.tests.test_session_share.SessionShareTestCase.test_v2_detail_keeps_older_card_permission_after_later_collaborate_share \
  apps.chat.conversation.tests.test_session_share.SessionShareTestCase.test_v2_detail_projects_later_pending_restore_onto_revoked_older_card \
  apps.chat.conversation.tests.test_session_share.SessionShareTestCase.test_v2_detail_projects_later_pending_invite_after_latest_revoke \
  apps.chat.conversation.tests.test_session_share.SessionShareTestCase.test_v2_detail_keeps_active_older_card_when_later_share_is_pending \
  apps.chat.conversation.tests.test_session_share.SessionShareTestCase.test_v2_accept_on_older_revoked_card_activates_latest_pending \
  --keepdb --noinput -v 1
```

本地无 venv 时可用：

`/Users/tabtin-work/worktrees/tabtin/fix-byok-multi-site-connection/apps/tabtin_django/venv/bin/python`

## 上次结果（2026-08-26）

7 条相关单测全绿（8.3s，`--keepdb`）：

- `test_v2_detail_projects_latest_state_onto_older_cards`
- `test_v2_detail_keeps_older_card_permission_after_later_collaborate_share`
- `test_v2_detail_projects_later_pending_restore_onto_revoked_older_card`
- `test_v2_detail_projects_later_pending_invite_after_latest_revoke`
- `test_v2_detail_keeps_active_older_card_when_later_share_is_pending`
- `test_v2_accept_on_older_revoked_card_activates_latest_pending`
- `test_v2_share_stays_inactive_until_recipient_joins`

## 未覆盖

- Live：含本 tip 的包里，同一任务两张卡停止后再恢复，两张都应变成待确认；从旧卡确认加入应进入参与中。
- 旧客户端若从不拉详情、只看腾讯投影快照，兄弟卡文案可能仍旧，直到重拉 `get_share_detail`。
