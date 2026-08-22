from django.db import migrations, models
import django.db.models.deletion


def backfill_device_role_and_control_device(apps, schema_editor) -> None:
    db_alias = schema_editor.connection.alias
    Device = apps.get_model("tabtinspace", "Device")
    Agent = apps.get_model("tabtinspace", "Agent")
    Space = apps.get_model("tabtinspace", "Space")

    for device in Device.objects.using(db_alias).all().iterator():
        raw_type = (device.device_type or "").lower()
        normalized_type = "mobile" if raw_type in {"ios", "android"} else raw_type or "electron"
        role = "data" if normalized_type in {"mobile", "iot"} else "control"
        updates = {}
        if device.device_type != normalized_type:
            updates["device_type"] = normalized_type
        if getattr(device, "role", None) != role:
            updates["role"] = role
        if updates:
            Device.objects.using(db_alias).filter(id=device.id).update(**updates)

    Agent.objects.using(db_alias).filter(
        control_device_id__isnull=True,
        bound_device_id__isnull=False,
    ).update(control_device_id=models.F("bound_device_id"))

    bot_spaces = Space.objects.using(db_alias).filter(
        type="bot",
        bound_device_id__isnull=False,
    ).values_list("id", "bound_device_id")
    for agent_id, device_id in bot_spaces.iterator():
        Agent.objects.using(db_alias).filter(
            id=agent_id,
            control_device_id__isnull=True,
        ).update(control_device_id=device_id)


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0009_dedupe_spacemembership_and_add_identity_uniques"),
    ]

    operations = [
        migrations.AlterField(
            model_name="device",
            name="device_type",
            field=models.CharField(
                choices=[
                    ("electron", "Electron 桌面端"),
                    ("daemon", "Agent Daemon"),
                    ("cloud", "云实例"),
                    ("mobile", "移动设备"),
                    ("iot", "IoT 设备"),
                ],
                default="electron",
                max_length=20,
                verbose_name="设备类型",
            ),
        ),
        migrations.AddField(
            model_name="device",
            name="role",
            field=models.CharField(
                choices=[("control", "操控设备"), ("data", "数据设备")],
                default="control",
                help_text="control=操控设备，data=数据设备",
                max_length=20,
                verbose_name="设备角色",
            ),
        ),
        migrations.AddField(
            model_name="agent",
            name="control_device",
            field=models.ForeignKey(
                blank=True,
                limit_choices_to={"role": "control"},
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="control_agents",
                to="tabtinspace.device",
                verbose_name="操控设备",
            ),
        ),
        migrations.RunPython(
            backfill_device_role_and_control_device,
            migrations.RunPython.noop,
        ),
    ]
