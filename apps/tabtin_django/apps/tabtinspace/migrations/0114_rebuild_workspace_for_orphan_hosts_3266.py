# ：Space 表已 DROP 后，按软 space_id 孤儿宿主重建同 id Workspace。
#
# 背景：0097 跳过无 device/空目录的个人 Space；若库在加固前已跑完 0108–0110，
# Table 等软引用仍指向原 Space.id，但 Workspace 行不存在。本迁移按
# (space_id, organization_id) 重建 Workspace（id-reuse），使资产重新可解析。

from django.db import connection, migrations

from apps.tabtinspace.space_to_workspace import (
    ensure_workspace_for_orphan_host,
    iter_orphan_table_hosts,
)


def forwards_rebuild_orphan_host_workspaces(apps, schema_editor):
    created = 0
    for host_id, organization_id, sample_name, _count in iter_orphan_table_hosts(connection):
        if ensure_workspace_for_orphan_host(
            apps,
            host_id=host_id,
            organization_id=organization_id,
            name=sample_name or '',
        ):
            created += 1
    if created:
        # Django migration 日志看不到 print；用 apps 无额外通道，依赖 preflight 复核。
        pass


def backwards_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0113a_collection_project_indexes_3266'),
        ('tabdata', '0046_merge_0045_link_and_token_3266'),
    ]

    operations = [
        migrations.RunPython(
            forwards_rebuild_orphan_host_workspaces,
            backwards_noop,
        ),
    ]
