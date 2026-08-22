# ：Collection Project 侧去重（约束装上前）。
#
# 索引与 UniqueConstraint 见 0113a（与 DELETE 去重拆开，避免同事务
# pending trigger events）。

from django.db import migrations
from django.db.models import Count


def forwards_dedupe_project_collections(apps, schema_editor):
    """约束装上前去掉 Project 侧重名 / 重复 system_key（保留最早创建的一行）。"""
    Collection = apps.get_model('tabtinspace', 'Collection')

    def _drop_dupes(filters, group_fields):
        dup_groups = (
            Collection.objects.filter(**filters)
            .values(*group_fields)
            .annotate(cnt=Count('id'))
            .filter(cnt__gt=1)
        )
        for group in dup_groups.iterator():
            lookup = {field: group[field] for field in group_fields}
            keep_id = (
                Collection.objects.filter(**lookup)
                .order_by('created_at', 'id')
                .values_list('id', flat=True)
                .first()
            )
            if keep_id is None:
                continue
            Collection.objects.filter(**lookup).exclude(id=keep_id).delete()

    _drop_dupes(
        {'project_id__isnull': False, 'parent_id__isnull': True},
        ['project_id', 'name'],
    )
    _drop_dupes(
        {'project_id__isnull': False, 'parent_id__isnull': False},
        ['project_id', 'parent_id', 'name'],
    )
    _drop_dupes(
        {'project_id__isnull': False, 'system_key__isnull': False},
        ['project_id', 'system_key'],
    )


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0112_merge_0104_workspace_home_and_0111_3266'),
    ]

    operations = [
        migrations.RunPython(
            forwards_dedupe_project_collections,
            migrations.RunPython.noop,
        ),
    ]
