"""Convert the retired media field into the unified attachment field."""

from copy import deepcopy

from django.db import migrations, models


def _convert_nested_field_types(value, *, remove_allowed_types=False):
    if isinstance(value, list):
        return [
            _convert_nested_field_types(
                item,
                remove_allowed_types=remove_allowed_types,
            )
            for item in value
        ]
    if not isinstance(value, dict):
        return value

    is_media_field = value.get("field_type") == "media"
    should_remove_allowed_types = remove_allowed_types or is_media_field
    converted = {
        key: _convert_nested_field_types(
            item,
            remove_allowed_types=should_remove_allowed_types,
        )
        for key, item in value.items()
        if not (key == "allowed_types" and should_remove_allowed_types)
    }
    if converted.get("field_type") == "media":
        converted["field_type"] = "attachment"
    return converted


def convert_media_fields_to_attachments(apps, schema_editor):
    database = schema_editor.connection.alias
    TableField = apps.get_model("tabdata", "TableField")

    changed_fields = []
    for field in TableField.objects.using(database).all().iterator():
        original_config = deepcopy(field.config or {})
        converted_config = _convert_nested_field_types(
            original_config,
            remove_allowed_types=field.field_type == "media",
        )
        changed = converted_config != original_config

        if field.field_type == "media":
            field.field_type = "attachment"
            changed = True

        if changed:
            field.config = converted_config
            changed_fields.append(field)

    if changed_fields:
        TableField.objects.using(database).bulk_update(
            changed_fields,
            ["field_type", "config"],
            batch_size=500,
        )


class Migration(migrations.Migration):
    dependencies = [
        ("tabdata", "0054_remove_required_field_contract"),
    ]

    operations = [
        migrations.RunPython(
            convert_media_fields_to_attachments,
            migrations.RunPython.noop,
        ),
        migrations.AlterField(
            model_name="tablefield",
            name="field_type",
            field=models.CharField(
                choices=[
                    ("text", "文本字段"),
                    ("long_text", "多行文本"),
                    ("number", "数字"),
                    ("percent", "百分比"),
                    ("currency", "货币"),
                    ("rating", "评分"),
                    ("auto_number", "自动标识"),
                    ("select", "单选"),
                    ("multi_select", "多选"),
                    ("checkbox", "复选框"),
                    ("date", "日期"),
                    ("datetime", "日期时间"),
                    ("created_time", "创建时间"),
                    ("last_modified_time", "最后修改时间"),
                    ("url", "URL链接"),
                    ("email", "邮箱"),
                    ("phone", "手机号"),
                    ("user", "用户"),
                    ("created_by", "创建者"),
                    ("last_modified_by", "最后修改者"),
                    ("attachment", "附件"),
                    ("formula", "公式"),
                    ("rollup", "汇总"),
                    ("link", "关联"),
                    ("lookup", "查找"),
                    ("nested_list", "嵌套列表"),
                ],
                max_length=50,
                verbose_name="字段类型",
            ),
        ),
    ]
