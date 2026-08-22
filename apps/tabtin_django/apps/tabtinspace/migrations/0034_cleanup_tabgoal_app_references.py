"""清理已废弃的 tabgoal 应用 ID 残留（数据卫生）。

- WorkteamAppInstall：tabgoal 行合并为 tabagenda（已存在 tabagenda 则删 tabgoal）
- SpaceAppSettings.disabled_apps：tabgoal 归一为 tabagenda 并去重

独立 tabgoal manifest 已从 CORE_APPS 移除；本迁移对齐安装表与用户禁用列表。
"""

from django.db import migrations


def forwards(apps, schema_editor):
    WorkteamAppInstall = apps.get_model("tabtinspace", "WorkteamAppInstall")
    SpaceAppSettings = apps.get_model("tabtinspace", "SpaceAppSettings")
    db = schema_editor.connection.alias

    for row in WorkteamAppInstall.objects.using(db).filter(app_id="tabgoal").iterator():
        dup = WorkteamAppInstall.objects.using(db).filter(
            workteam_id=row.workteam_id,
            app_id="tabagenda",
        ).exists()
        if dup:
            row.delete()
        else:
            row.app_id = "tabagenda"
            row.save(update_fields=["app_id", "updated_at"])

    for settings in SpaceAppSettings.objects.using(db).iterator():
        da = settings.disabled_apps
        if not isinstance(da, list) or "tabgoal" not in da:
            continue
        seen: set[str] = set()
        new_da: list = []
        for x in da:
            if not isinstance(x, str):
                new_da.append(x)
                continue
            nid = "tabagenda" if x == "tabgoal" else x
            if nid not in seen:
                seen.add(nid)
                new_da.append(nid)
        if new_da != da:
            settings.disabled_apps = new_da
            settings.save(update_fields=["disabled_apps", "updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0033_remove_primary_agent_binding"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
