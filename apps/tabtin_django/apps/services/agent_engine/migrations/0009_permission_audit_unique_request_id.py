"""
W2-轮 1 三视角 Review 自修复：PermissionAudit.request_id 加 UniqueConstraint。

背景：localrt_user_response 主动 publish approval_resolved 给 thread mirror +
daemon → runtime → relay 转发同样事件——relay_handler 会重复触发 spawn_audit_writes
导致 ``_persist_approval_resolved`` 二次 bulk_create 双行（技术 Review #1 CRITICAL）。

修复：在 ``request_id`` 上加唯一约束 + bulk_create 用 ``ignore_conflicts=True``
静默去重，保证审计行幂等。

注意 ``existing 0009_alter_cliauditevent_inner_binary``（其他 Wave 待提交的 migration）
不在本仓库 dependencies — 当那个 migration 落地时，框架会自动 merge migration tree
（互不依赖的 leaf 安全合并）。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("agent_engine", "0008_permission_audit"),
    ]

    operations = [
        migrations.AddConstraint(
            model_name="permissionaudit",
            constraint=models.UniqueConstraint(
                fields=["request_id"],
                name="uq_permaudit_request_id",
            ),
        ),
    ]
