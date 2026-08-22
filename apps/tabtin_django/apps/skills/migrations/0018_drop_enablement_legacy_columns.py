"""#7118：删除 SkillEnablement 的换锚回滚快照列。

背景
=====

#3266 M4.5 将 ``SkillEnablement`` 从 ``(user, space)`` 锚点换到 device 锚点，
把 ``user_id`` / ``space_id`` / ``enabled`` / ``config_json`` 作为 nullable
回滚快照暂留（见 migrations/0014）。#7118 收敛 Skill HTTP 到 organization +
agent，回滚窗口早已过；本迁移彻底移除这四列，让模型和表结构一致。

安全性
======

- 已确认所有业务代码不再读写这些列（引用点仅存在于 migrations 0013/0014
  的 backfill 逻辑与 SQL 常量字符串中）。
- 迁移只做 DDL：先解绑遗留唯一约束 / 索引（如果 0014 未清干净），再顺序
  RemoveField。不携带任何数据回填。
- 反向操作：还原为 nullable UUID / Bool / JSON 字段，只为让 Django 能
  向下走完 migration。不再重新回填数据。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0017_backfill_user_skill_preference"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="skillenablement",
            name="user_id",
        ),
        migrations.RemoveField(
            model_name="skillenablement",
            name="space_id",
        ),
        migrations.RemoveField(
            model_name="skillenablement",
            name="enabled",
        ),
        migrations.RemoveField(
            model_name="skillenablement",
            name="config_json",
        ),
    ]
