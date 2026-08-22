"""#7124：首次 migrate 清偿历史 agent_id=NULL 画像。

纯数据迁移（无 DDL）。幂等：第二次跑 NULL 行已清空则 noop。
逻辑见 ``apps.user_portrait.services.legacy_migration``。
"""

from __future__ import annotations

from django.db import migrations


def forwards(apps, schema_editor):
    from apps.user_portrait.services.legacy_migration import run_legacy_portrait_migration

    run_legacy_portrait_migration(
        dry_run=False,
        apps_registry=apps,
        schema_editor=schema_editor,
        reassign_inactive_memories=True,
    )


def backwards(apps, schema_editor):
    # 不可逆：已删除的 NULL 行与已改挂的记忆无法无损还原。
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("user_portrait", "0005_userportrait_agent_id_per_agent"),
        ("agent", "0005_rename_default_agent_to_xiaotin"),
        ("agent_memory", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
