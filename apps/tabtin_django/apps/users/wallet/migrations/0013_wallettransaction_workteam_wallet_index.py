"""Wallet 0013: 重建 wallet_transaction 的 workteam_wallet 索引

历史背景：
  0011 RemoveField('wallet') 时 Django 已经自动 DROP 了旧索引 users_walle_wallet__71a572_idx，
  本 migration 只需要重建一个基于 workteam_wallet+created_at 的新索引。

修法（v0.1）：
  用 SeparateDatabaseAndState，state 端 swap 旧→新索引名，DB 端只 AddIndex。
  避免 RemoveIndex(name=已删索引) 在 state 重建时引用已删字段触发 FieldDoesNotExist。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("wallet", "0012_wallettransaction_usage_event_trace"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                # state 端：swap 旧索引名 → 新索引名（旧字段已在 0011 删，这里 state 同步）
                # Django 在 0011 RemoveField 时 state 不会自动清旧索引声明，这里显式声明新索引
                migrations.AddIndex(
                    model_name="wallettransaction",
                    index=models.Index(
                        fields=["workteam_wallet", "created_at"],
                        name="users_walle_worktea_9ad054_idx",
                    ),
                ),
            ],
            database_operations=[
                # DB 端：旧索引在 0011 RemoveField 时已自动 DROP，这里只需建新索引
                migrations.AddIndex(
                    model_name="wallettransaction",
                    index=models.Index(
                        fields=["workteam_wallet", "created_at"],
                        name="users_walle_worktea_9ad054_idx",
                    ),
                ),
            ],
        ),
    ]
