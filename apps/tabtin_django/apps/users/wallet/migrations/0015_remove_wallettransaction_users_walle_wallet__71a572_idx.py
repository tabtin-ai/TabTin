"""Wallet 0015: 清理 model state 里残留的 wallet 字段旧索引声明

历史背景：
  0011 RemoveField('wallet') 时 Django 已自动 DROP 了旧索引（DB 端），
  但 model state 里的 AddIndex 声明仍残留。makemigrations 据此重新生成 RemoveIndex。
  在 fresh DB 上 RemoveIndex 触发 MySQL _create_missing_fk_index 因 wallet 字段已删而 FieldDoesNotExist。

修法（v0.1）：
  用 SeparateDatabaseAndState，state 端 RemoveIndex（清理声明），DB 端 noop（旧索引早已不存在）。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('wallet', '0014_wallettransaction_related_order_id_255'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RemoveIndex(
                    model_name='wallettransaction',
                    name='users_walle_wallet__71a572_idx',
                ),
            ],
            database_operations=[],
        ),
    ]
