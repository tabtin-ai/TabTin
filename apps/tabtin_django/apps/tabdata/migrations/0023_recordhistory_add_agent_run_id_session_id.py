"""D8 / Wave 1.1：RecordHistory 增加 agent_run_id / session_id 字段。

背景与决策
----------

- 来源：Harness D8（2026-04-17 sign-off），W0-2 audit §3.2.2 推荐方案。
- 目的：让 RecordHistory 与 ChangeLog 一样支持精确按 agent_run_id 反查
  本 turn 的字段级变更，给 TableResourceContributor / TableAdapter 的
  fallback 反向回放路径提供精确定位能力（C5.1 / Charter §3.1）。

字段类型选择（与 ChangeLog 完全对齐，避免 join / IN 时的 UUID cast）
- ``agent_run_id``：``CharField(max_length=64, blank=True, default='')``
- ``session_id``  ：``CharField(max_length=64, blank=True, default='')``

索引设计
- ``agent_run_id`` 单字段：``db_index=True``，支持 ``WHERE agent_run_id=X`` 快速查询。
- ``session_id``  单字段：``db_index=True``，支持 anchor session 按 session 过滤。
- ``(agent_run_id, created_at)`` 联合索引（``th_run_cre_idx``）：支持
  ``WHERE agent_run_id=X ORDER BY created_at`` 的高效范围扫描，
  fallback 反向回放主查询。
- 单字段与联合索引**非冗余**：单字段为等值/IN 优化，联合为有序范围优化。

数据库
- tabdata 模块属 PostgreSQL（AGENTS.md 双库架构表），apply 时**必须**带
  ``--database=postgresql``：

  ::

     python manage.py migrate tabdata --database=postgresql

向后兼容
- 历史 RH 行 ``agent_run_id='' / session_id=''``：W0-2 audit §3.2.6 已确认
  历史 turn 已结束，回填空串语义合理。
- 旧 caller 不传两个新字段：函数签名是 keyword-only，默认值 ``""``
  保证不破坏。
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0022_alter_tablepermission_granted_by_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='recordhistory',
            name='agent_run_id',
            field=models.CharField(
                max_length=64, blank=True, default='',
                db_index=True,
                verbose_name='Agent Run ID',
                help_text='关联 ChangeLog.agent_run_id / get_current_run_id()，'
                          '支持精确定位本 turn 的 RH（D8）',
            ),
        ),
        migrations.AddField(
            model_name='recordhistory',
            name='session_id',
            field=models.CharField(
                max_length=64, blank=True, default='',
                db_index=True,
                verbose_name='Session ID',
                help_text='关联 ChatSession（QC-05 一致性，D8）',
            ),
        ),
        migrations.AddIndex(
            model_name='recordhistory',
            index=models.Index(
                fields=['agent_run_id', 'created_at'],
                name='th_run_cre_idx',
            ),
        ),
    ]
