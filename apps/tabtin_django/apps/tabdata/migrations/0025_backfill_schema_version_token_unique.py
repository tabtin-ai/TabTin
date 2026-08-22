"""C3 / Wave 1.3 P0 修复(Review §4):给每张现存 Table 分配独立 schema_version_token。

业务背景
--------

Migration 0024 通过 ``AddField + default=uuid.uuid4`` 添加字段时，Django 4.2
的行为是"对所有现存行只调用 default **一次**" → 所有现存表共享同一 UUID。

这违反 C3 的"每张表独立生命周期"承诺：
- 旧任务校验 token 时,A 表 trash 后,B 表残留任务仍可能 freeze 到 A 表 trash 前
  那个共享的旧 token,worker 校验时 B 表 token = A 表 trash 前的共享 token,
  实际上 A、B token 也是同一个 → 校验**通过**(漏防御)。
- W3 D1 灰度对账"按 token 反查 historical state"会因初始所有表共 token 失败。

修复:本 migration 用 RunPython 给每张现存 Table 独立 UPDATE uuid.uuid4()。

幂等性
- 重复 apply 不会破坏数据(只是再次 UPDATE 一次新 UUID),但理论上一次就够。
- 如果生产已经 apply 过 0024 但还没 apply 本 migration,有 race window：
  这期间任何 trash 操作 bump token 后,本 migration UPDATE 又会覆盖 → 但
  trash 后正在 trash 的表 token 已 bump,很快又会被本 migration 重置为新 UUID,
  下次任何 task 校验都会失败 no-op,**结果与"重新 trash 一次"等价**,行为正确。

数据库
- 必须 ``--database=postgresql``。
"""
import uuid

from django.db import migrations


def _backfill_unique_tokens(apps, schema_editor):
    """给每张现存 Table 单独 UPDATE 一个独立 UUID。"""
    Table = apps.get_model('tabdata', 'Table')
    db_alias = schema_editor.connection.alias
    table_ids = list(
        Table.objects.using(db_alias).values_list('id', flat=True)
    )
    for table_id in table_ids:
        Table.objects.using(db_alias).filter(id=table_id).update(
            schema_version_token=uuid.uuid4(),
        )


def _noop_reverse(apps, schema_editor):
    """data migration 反向不需要做事;字段本身由 0024 反向 DROP 处理。"""
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0024_table_add_schema_version_token'),
    ]

    operations = [
        migrations.RunPython(
            _backfill_unique_tokens,
            reverse_code=_noop_reverse,
        ),
    ]
