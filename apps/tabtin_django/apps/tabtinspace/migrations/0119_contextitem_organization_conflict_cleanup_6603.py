# ：加三态互斥约束前，防御性清空 organization 与 workspace/project 并存的脏行。
# 只做 RunPython；约束替换见 0120。

import logging

from django.db import migrations

from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


def clear_conflicting_organization_host(apps, schema_editor):
    """新 organization 字段刚由 0118 引入；显式清空冲突行，保证 0120 约束能装上。"""
    if schema_editor.connection.alias != postgres_app_db_alias():
        return

    ContextItem = apps.get_model('tabtinspace', 'ContextItem')
    db_alias = schema_editor.connection.alias

    conflicting = (
        ContextItem.objects.using(db_alias)
        .filter(organization__isnull=False)
        .exclude(workspace__isnull=True, project__isnull=True)
    )
    count = conflicting.count()
    if count:
        logger.warning(
            '#6603/0119: %s ContextItem 行同时持有 organization 与 workspace/project，'
            '清空 organization 后再收口互斥约束。',
            count,
        )
        conflicting.update(organization=None)


def backwards_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0118_contextitem_organization_6603'),
    ]

    operations = [
        migrations.RunPython(
            clear_conflicting_organization_host,
            backwards_noop,
        ),
    ]
