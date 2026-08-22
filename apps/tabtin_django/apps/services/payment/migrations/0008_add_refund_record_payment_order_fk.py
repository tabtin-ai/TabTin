"""补建 ``services_payment_refund_record.payment_order_id`` 的物理 FK 约束。

== 背景 ==

体检（``manage.py db_check_fk_alignment``）发现 ``[reverse_drift]`` ERROR：

    payment.RefundRecord.payment_order ORM 期望 db_constraint=True 同库 FK
    （指向 services_payment_order.id），但 MySQL 上实际没有 FK 约束。

应该是 0006 创建表时 Django ``schema_editor`` 创建 FK 失败被静默跳过（具体根因
未追到，可能是 0006 跑期间外键检查 race condition 或其他历史并发问题）。

== 实现 ==

``add_mysql_fk_idempotent`` helper 调一次：
- 检查 FK 是否已存在（幂等）
- 检查悬空记录（生产 / dev DB 已确认 0 悬空）
- ADD CONSTRAINT 走 ``ON DELETE CASCADE``——payment 同库 FK 应有完整 cascade 保护

reverse_code DROP FK——回滚到 0007 时移除约束。
"""

from django.db import migrations

from apps.services.common.migration_helpers import add_mysql_fk_idempotent


def add_refund_payment_order_fk(apps, schema_editor):
    # MySQL 标识符长度限 64 字符——helper 默认拼出的
    # ``services_payment_refund_record_payment_order_id_fk_services_payment_order_id`` 超长，
    # 显式指定短名。
    add_mysql_fk_idempotent(
        schema_editor,
        local_table="services_payment_refund_record",
        column="payment_order_id",
        referenced_table="services_payment_order",
        on_delete="CASCADE",
        constraint_name="fk_refund_record_payment_order",
    )


def drop_refund_payment_order_fk(apps, schema_editor):
    if schema_editor.connection.alias != "default":
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
            WHERE CONSTRAINT_SCHEMA = DATABASE()
              AND TABLE_NAME = 'services_payment_refund_record'
              AND COLUMN_NAME = 'payment_order_id'
              AND REFERENCED_TABLE_NAME IS NOT NULL
            """
        )
        for (cname,) in cursor.fetchall():
            cursor.execute(
                f"ALTER TABLE services_payment_refund_record DROP FOREIGN KEY `{cname}`"
            )


class Migration(migrations.Migration):

    dependencies = [
        ("payment", "0007_fix_collation_utf8mb4_unicode_ci"),
    ]

    operations = [
        migrations.RunPython(add_refund_payment_order_fk, drop_refund_payment_order_fk),
    ]
