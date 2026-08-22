"""Remove retired TabData capabilities from Django's runtime state only.

Historical rows, cells, native columns, and auxiliary tables are deliberately
left untouched. This migration has no database operations; it only keeps
Django's migration state aligned with the runtime code.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("tabdata", "0055_decommission_media_field"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.DeleteModel(name="ComputedOutboxOverflow"),
                migrations.DeleteModel(name="ComputedOutboxDLQ"),
                migrations.DeleteModel(name="ComputedOutbox"),
                migrations.DeleteModel(name="ShadowComparison"),
                migrations.DeleteModel(name="ShadowLegacySnapshot"),
                migrations.DeleteModel(name="FieldSequence"),
                migrations.RemoveField(model_name="tablefield", name="lookup_options"),
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
                            ("select", "单选"),
                            ("multi_select", "多选"),
                            ("checkbox", "复选框"),
                            ("date", "日期"),
                            ("created_time", "创建时间"),
                            ("last_modified_time", "最后修改时间"),
                            ("url", "URL链接"),
                            ("email", "邮箱"),
                            ("phone", "手机号"),
                            ("user", "用户"),
                            ("created_by", "创建者"),
                            ("last_modified_by", "最后修改者"),
                            ("attachment", "附件"),
                            ("link", "关联"),
                        ],
                        max_length=50,
                        verbose_name="字段类型",
                    ),
                ),
            ],
        ),
    ]
