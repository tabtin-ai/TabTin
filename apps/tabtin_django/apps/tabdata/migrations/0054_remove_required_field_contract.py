"""Remove the retired TabData required-field contract from storage."""

from copy import deepcopy

from django.db import migrations


def remove_required_json_keys(apps, schema_editor):
    database = schema_editor.connection.alias
    TableField = apps.get_model("tabdata", "TableField")
    TableView = apps.get_model("tabdata", "TableView")

    changed_fields = []
    for field in TableField.objects.using(database).all().iterator():
        rules = dict(field.validation_rules or {})
        config = deepcopy(field.config or {})
        changed = "allow_blank" in rules
        rules.pop("allow_blank", None)

        nested_schema = config.get("nested_schema")
        if isinstance(nested_schema, dict):
            nested_fields = nested_schema.get("fields")
            if isinstance(nested_fields, list):
                for nested_field in nested_fields:
                    if isinstance(nested_field, dict) and "required" in nested_field:
                        nested_field.pop("required", None)
                        changed = True

        if changed:
            field.validation_rules = rules
            field.config = config
            changed_fields.append(field)

    if changed_fields:
        TableField.objects.using(database).bulk_update(
            changed_fields,
            ["validation_rules", "config"],
        )

    changed_views = []
    for view in TableView.objects.using(database).filter(view_type="form").iterator():
        config = deepcopy(view.config or {})
        field_configs = config.get("field_configs")
        if not isinstance(field_configs, dict):
            continue
        changed = False
        for field_config in field_configs.values():
            if isinstance(field_config, dict) and "required" in field_config:
                field_config.pop("required", None)
                changed = True
        if changed:
            view.config = config
            changed_views.append(view)

    if changed_views:
        TableView.objects.using(database).bulk_update(changed_views, ["config"])


class Migration(migrations.Migration):
    dependencies = [
        ("tabdata", "0053_merge_required_fields_and_recordcomment_status"),
    ]

    operations = [
        migrations.RunPython(remove_required_json_keys, migrations.RunPython.noop),
        migrations.RemoveField(
            model_name="tablefield",
            name="is_required",
        ),
    ]
