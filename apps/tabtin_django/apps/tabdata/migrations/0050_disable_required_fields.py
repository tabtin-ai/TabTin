from copy import deepcopy

from django.db import migrations


def _disable_nested_required(config):
    if not isinstance(config, dict):
        return False
    changed = False
    nested_schema = config.get("nested_schema")
    if isinstance(nested_schema, dict):
        fields = nested_schema.get("fields")
        if isinstance(fields, list):
            for field_config in fields:
                if isinstance(field_config, dict) and field_config.get("required") is not False:
                    field_config["required"] = False
                    changed = True
    return changed


def disable_required_fields(apps, schema_editor):
    """清除历史必填状态，同时解除其派生的空值阻断。"""

    database = schema_editor.connection.alias
    TableField = apps.get_model("tabdata", "TableField")
    TableView = apps.get_model("tabdata", "TableView")

    changed_fields = []
    for field in TableField.objects.using(database).all().iterator():
        rules = dict(field.validation_rules or {})
        config = deepcopy(field.config or {})
        nested_changed = _disable_nested_required(config)
        if not field.is_required and rules.get("allow_blank") is not False and not nested_changed:
            continue
        field.is_required = False
        rules["allow_blank"] = True
        field.validation_rules = rules
        field.config = config
        changed_fields.append(field)
    if changed_fields:
        TableField.objects.using(database).bulk_update(
            changed_fields,
            ["is_required", "validation_rules", "config"],
        )

    changed_views = []
    for view in TableView.objects.using(database).filter(view_type="form").iterator():
        config = deepcopy(view.config or {})
        field_configs = config.get("field_configs")
        if not isinstance(field_configs, dict):
            continue
        changed = False
        for field_config in field_configs.values():
            if isinstance(field_config, dict) and field_config.get("required") is not False:
                field_config["required"] = False
                changed = True
        if changed:
            view.config = config
            changed_views.append(view)
    if changed_views:
        TableView.objects.using(database).bulk_update(changed_views, ["config"])


class Migration(migrations.Migration):
    dependencies = [("tabdata", "0049_tablefield_default_value")]

    operations = [
        # This is an intentional product migration: the former required state
        # is not recoverable from the normalized rows. Rollback means reverting
        # application code while keeping the relaxed data contract in place.
        migrations.RunPython(disable_required_fields, migrations.RunPython.noop),
    ]
