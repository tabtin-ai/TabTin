"""C3 / Wave 1.3：Table 增加 schema_version_token 字段。

业务背景
--------

PRD §C3 P0：管理员废弃旧表后，Celery 持续报 "table not found"，因为还有未执行
完的 computed / connector / link_integrity 等任务。本字段引入 token 校验防御
机制：

1. ``trash_table`` / ``delete_table`` / ``restore_table_from_trash`` 调用时
   bump（重新生成 UUID）。
2. 关键 Celery task 在执行前对比任务发布时 freeze 的 token 与当前
   ``Table.schema_version_token``，不一致则 no-op + 日志，避免无效报错刷屏。

字段类型选择
- ``UUIDField``：与 W0-1 ``ChangeLog.id`` / ``RecordHistory.id`` 一致，
  随机生成无碰撞，长度短（16 字节）。
- ``default=uuid.uuid4``：所有新创建的表会自动获得唯一 token。
- 不加索引：本字段只在按 ``id`` 查到 Table 后做相等比较，不参与 WHERE 过滤。

⚠️ Django 4.2 ``AddField + default=uuid.uuid4`` 行为说明
------------------------------------------------------

Django 4.2 的 AddField + ``default=uuid.uuid4`` 行为是"对所有现存行只调用 default
**一次**"，导致迁移前的现存表共享同一 UUID（详见
https://docs.djangoproject.com/en/4.2/howto/writing-migrations/#migrations-that-add-unique-fields）。

→ 后续 migration ``0025_backfill_schema_version_token_unique`` 通过 RunPython
data migration 给每张现存表 UPDATE 独立 UUID,保证"每张表独立生命周期"承诺。

数据库
- tabdata 模块属 PostgreSQL（AGENTS.md 双库架构表），apply 时**必须**带
  ``--database=postgresql``：

  ::

     python manage.py migrate tabdata --database=postgresql
"""
import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0023_recordhistory_add_agent_run_id_session_id'),
    ]

    operations = [
        migrations.AddField(
            model_name='table',
            name='schema_version_token',
            field=models.UUIDField(
                default=uuid.uuid4,
                verbose_name='Schema 版本 Token',
                help_text=(
                    'C3：trash/delete/restore 时 bump，'
                    'Celery worker 校验过期 task 跳过。'
                    '与 schema_version 互补：前者覆盖生命周期，'
                    '后者覆盖字段结构变更。'
                ),
            ),
        ),
    ]
