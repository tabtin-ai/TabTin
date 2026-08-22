"""
Add Collection.system_key field + backfill existing planning collections.

Schema change:
  - system_key: CharField(max_length=64, nullable, indexed)
  - UniqueConstraint('space','system_key') WHERE system_key IS NOT NULL

Data migration:
  - All root-level Collection rows with name='规划' get system_key='planning_root'
  - Idempotent: skips rows that already have the correct system_key
"""
import logging

from django.db import migrations, models

logger = logging.getLogger(__name__)

PLANNING_SYSTEM_KEY = "planning_root"
PLANNING_NAME = "规划"


def backfill_planning_system_key(apps, schema_editor):
    """为所有 name='规划' + parent=NULL 的 Collection 设置 system_key='planning_root'。"""
    Collection = apps.get_model("tabtinspace", "Collection")

    updated = Collection.objects.filter(
        parent__isnull=True,
        name=PLANNING_NAME,
        system_key__isnull=True,
    ).update(system_key=PLANNING_SYSTEM_KEY)

    logger.info(
        "[Migration:0042] 回填 system_key='%s' 的 Collection 数量=%d",
        PLANNING_SYSTEM_KEY,
        updated,
    )


def reverse_backfill(apps, schema_editor):
    """回滚：清除 planning_root 的 system_key。"""
    Collection = apps.get_model("tabtinspace", "Collection")
    cleared = Collection.objects.filter(
        system_key=PLANNING_SYSTEM_KEY,
    ).update(system_key=None)
    logger.warning(
        "[Migration:0042:reverse] 清除 system_key='%s' 的 Collection 数量=%d",
        PLANNING_SYSTEM_KEY,
        cleared,
    )


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0041_backfill_planning_collection"),
    ]

    operations = [
        migrations.AddField(
            model_name="collection",
            name="system_key",
            field=models.CharField(
                blank=True,
                db_index=True,
                default=None,
                help_text=(
                    "非空表示系统预置 Collection，同一 Space 内唯一。"
                    "查找系统 Collection 应优先按此字段，而非 name。"
                ),
                max_length=64,
                null=True,
                verbose_name="系统预置标识",
            ),
        ),
        migrations.AddConstraint(
            model_name="collection",
            constraint=models.UniqueConstraint(
                condition=models.Q(("system_key__isnull", False)),
                fields=("space", "system_key"),
                name="ctx_coll_unique_system_key_per_space",
            ),
        ),
        migrations.RunPython(
            backfill_planning_system_key,
            reverse_backfill,
            hints={"target_db": "postgresql"},
        ),
    ]
