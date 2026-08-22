"""
Data migration: 为所有现存 Workteam 初始化 CORE_APPS 安装记录。

使用分块批量插入 + ignore_conflicts 保证幂等，防止大数据量场景下的内存溢出。
CORE_APP_IDS 列表在迁移中硬编码（而非引用 app_registry），确保迁移文件自包含且不受
后续 CORE_APPS 变更影响。
"""

import uuid

from django.db import migrations


CORE_APP_IDS = [
    'tabdata', 'tabdoc', 'tabdesign', 'tabslide', 'tabcode',
    'tabvideo', 'tabweb', 'tabfolder', 'terminal', 'orchestration',
    'tabgoal', 'tabwhiteboard', 'tabmemo', 'tabsite', 'tabphone',
]

BATCH_SIZE = 1000


def forward(apps, schema_editor):
    """为所有现存 Workteam 批量创建 CORE_APPS 安装记录。"""
    Workteam = apps.get_model('tabtinspace', 'Workteam')
    WorkteamAppInstall = apps.get_model('tabtinspace', 'WorkteamAppInstall')

    batch = []
    for workteam in Workteam.objects.iterator(chunk_size=500):
        for app_id in CORE_APP_IDS:
            batch.append(WorkteamAppInstall(
                id=uuid.uuid4(),
                workteam=workteam,
                app_id=app_id,
                app_source='core',
                installed_by_id=workteam.owner_id,
            ))
        if len(batch) >= BATCH_SIZE:
            WorkteamAppInstall.objects.bulk_create(batch, ignore_conflicts=True)
            batch = []
    if batch:
        WorkteamAppInstall.objects.bulk_create(batch, ignore_conflicts=True)


def backward(apps, schema_editor):
    """回滚：删除所有 core 来源的安装记录。"""
    WorkteamAppInstall = apps.get_model('tabtinspace', 'WorkteamAppInstall')
    WorkteamAppInstall.objects.filter(app_source='core').delete()


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0018_workteam_app_install'),
    ]

    operations = [
        migrations.RunPython(forward, backward, hints={'target_db': 'postgresql'}),
    ]
