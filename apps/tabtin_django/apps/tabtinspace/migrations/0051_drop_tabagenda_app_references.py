"""Tracker 模块收敛波次 1（2026-05-20）：清理 tabagenda app_id 残留数据。

== 背景 ==

Tracker 模块收敛 plan 波次 1：tabagenda 模块整体下线（packages/apps/tabagenda
manifest 已删）。本 migration 清理 WorkteamAppInstall / SpaceApp /
SpaceAppSettings.disabled_apps 表里的 tabagenda 数据行——产品未上线，直接 delete
不做合并到 tabtracker（用户的 tabtracker 装机状态默认 enabled，无需迁移）。
"""

from django.db import migrations


def forwards(apps, schema_editor):
    db = schema_editor.connection.alias

    # WorkteamAppInstall
    try:
        WorkteamAppInstall = apps.get_model("tabtinspace", "WorkteamAppInstall")
        WorkteamAppInstall.objects.using(db).filter(app_id="tabagenda").delete()
    except LookupError:
        pass

    # SpaceApp
    try:
        SpaceApp = apps.get_model("tabtinspace", "SpaceApp")
        SpaceApp.objects.using(db).filter(app_id="tabagenda").delete()
    except LookupError:
        pass

    # SpaceAppSettings.disabled_apps（JSONField list）
    try:
        SpaceAppSettings = apps.get_model("tabtinspace", "SpaceAppSettings")
        for sas in SpaceAppSettings.objects.using(db).all():
            da = sas.disabled_apps or []
            if not isinstance(da, list) or "tabagenda" not in da:
                continue
            sas.disabled_apps = [x for x in da if x != "tabagenda"]
            sas.save(update_fields=["disabled_apps"])
    except LookupError:
        pass


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0050_alter_spaceadminactionlog_action_type"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
