# ：org Collection 私有化数据门禁（无主夹 + 跨创建者嵌套）。
# 仅 RunPython；DDL 见 0132。合入 release 后随 safe_migrate 自动执行。

import logging

from django.db import migrations

from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


def forwards_cleanup_org_collection_privacy(apps, schema_editor):
    if schema_editor.connection.alias != postgres_app_db_alias():
        return

    # 使用现网清理实现：逻辑含树遍历 / 上提有主子夹，历史 models API 表达成本过高。
    from apps.tabtinspace.services.collection_mixed_owner_cleanup import (
        assert_no_null_owner_org_collections,
        cleanup_org_collection_privacy_7657,
    )

    stats = cleanup_org_collection_privacy_7657(dry_run=False)
    logger.info(
        "#7657/0133 privacy cleanup: null_scanned=%s null_deleted=%s "
        "mixed_topmost=%s folders_deleted=%s items_detached=%s "
        "orphan_items_detached=%s owned_reparented=%s skipped=%s",
        stats.null_owner_scanned,
        stats.null_owner_folders_deleted,
        stats.topmost_roots,
        stats.folders_deleted,
        stats.items_detached,
        stats.orphan_items_detached,
        stats.owned_reparented,
        stats.skipped,
    )
    remaining = assert_no_null_owner_org_collections()
    if remaining:
        raise RuntimeError(
            f"#7657/0133: still have {remaining} org Collection rows with "
            "created_by IS NULL after cleanup; refusing to continue migrate."
        )


def backwards_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0132_collection_org_owner_unique_7657'),
    ]

    operations = [
        migrations.RunPython(
            forwards_cleanup_org_collection_privacy,
            backwards_noop,
        ),
    ]
