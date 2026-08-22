"""修复 services_payment_refund_record 表的 collation 不一致问题（幂等版）。

== 历史背景 ==

该表在 2026-03-19 创建时跟了 MySQL server 默认的 utf8mb4_0900_ai_ci，
而生产数据库和其余 109 张表均为 utf8mb4_unicode_ci。
collation 不一致导致 select_related('payment_order') JOIN 时
MySQL 报 "Illegal mix of collations" 错误（1267）。

== 为什么改成 RunPython 而不是直接 ALTER ==

原版本是 ``RunSQL("ALTER TABLE ... CONVERT TO ... utf8mb4_unicode_ci")``。

它在「生产数据库 + 0006 创建 FK 静默失败」的真实场景下能跑通——因为
``services_payment_order`` 已经是 utf8mb4_unicode_ci，且 refund_record
上没有 FK 指向它，ALTER 顺利完成。

但是 Layer B CI 走的是全新 MySQL 8.0 service container，server 默认
collation 是 ``utf8mb4_0900_ai_ci``。这种环境下：

  1. ``services_payment_order`` 和 ``services_payment_refund_record``
     在 0001-0006 都被建为 ``utf8mb4_0900_ai_ci``（继承 server 默认）
  2. 0006 创建 FK 没失败（两边 collation 一致）
  3. 0007 试图把 refund_record 转成 utf8mb4_unicode_ci → 与 services_payment_order.id
     的 utf8mb4_0900_ai_ci collation 不兼容 → FK 校验 fail with
     ``OperationalError 3780: foreign key ... incompatible``

== 修复思路 ==

幂等对齐：把 ``services_payment_refund_record`` 的 collation 对齐到
``services_payment_order`` 当前的 collation（不再硬编码 utf8mb4_unicode_ci）。

  - 两表已一致 → no-op（CI 全 0900_ai_ci 走这里；后续若手动统一过的库也走这里）
  - 不一致：
    a. 先 DROP 现存的 FK 指向 ``services_payment_order``（如有）——
       否则 CONVERT 会因 collation 兼容性失败
    b. CONVERT TO 与 services_payment_order 一致的 collation
    c. 不重建 FK——0008 会幂等补上

只在 MySQL default 库上执行；SQLite（Layer A 兜底）/ PostgreSQL 直接跳过。
"""

from django.db import migrations


REFUND_TABLE = "services_payment_refund_record"
ORDER_TABLE = "services_payment_order"


def _table_collation(cursor, table: str) -> str | None:
    cursor.execute(
        """
        SELECT TABLE_COLLATION
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
        """,
        [table],
    )
    row = cursor.fetchone()
    return row[0] if row else None


def _drop_fk_on_column(cursor, table: str, column: str) -> None:
    cursor.execute(
        """
        SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = %s AND COLUMN_NAME = %s
          AND REFERENCED_TABLE_NAME IS NOT NULL
        """,
        [table, column],
    )
    for (cname,) in cursor.fetchall():
        cursor.execute(f"ALTER TABLE `{table}` DROP FOREIGN KEY `{cname}`")


def align_refund_collation(apps, schema_editor):
    # 仅 default 库（payment 路由）
    if schema_editor.connection.alias != "default":
        return
    # 仅 MySQL；SQLite 没有该问题
    if schema_editor.connection.vendor != "mysql":
        return

    with schema_editor.connection.cursor() as cursor:
        refund_coll = _table_collation(cursor, REFUND_TABLE)
        order_coll = _table_collation(cursor, ORDER_TABLE)

        # 任一表缺失（上游 migration 链路异常）→ 让后续 ORM 自己暴露
        if not refund_coll or not order_coll:
            return

        # 已对齐 → 无须修复（CI 全 0900_ai_ci / 已手动统一过的库走这里）
        if refund_coll == order_coll:
            return

        # 不一致：先 DROP FK，再 CONVERT 对齐到 order_coll
        _drop_fk_on_column(cursor, REFUND_TABLE, "payment_order_id")

        # order_coll 来自 INFORMATION_SCHEMA，可信内联；MySQL collation 名只含 a-z0-9_
        cursor.execute(
            f"ALTER TABLE `{REFUND_TABLE}` "
            f"CONVERT TO CHARACTER SET utf8mb4 COLLATE {order_coll}"
        )


def noop_reverse(apps, schema_editor):
    # 修复型 migration：原始 collation 已无法精确还原；no-op 接受回滚
    return


class Migration(migrations.Migration):

    dependencies = [
        ("payment", "0006_alter_paymentorder_workteam_id_refundrecord"),
    ]

    operations = [
        migrations.RunPython(align_refund_collation, noop_reverse),
    ]
