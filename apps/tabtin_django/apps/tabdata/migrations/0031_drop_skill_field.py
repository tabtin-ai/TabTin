"""下架 TabData AI 字段（field_type='skill'）

产品决策（2026-05-01）：
表格 AI 字段彻底下架，未来由 chat 模块对话 + Tracker watch 能力替代。
本 migration 是数据层最终清理：

1. 删除所有 ``field_type='skill'`` 的 TableField（连同其 cell 数据通过外键级联清理）。
2. 删除 ``FieldExecutionRecord`` 模型（执行历史不再需要）。
3. 同步更新 ``TableField.field_type`` choices（去掉 ``skill``）。

不可逆：``field_type='skill'`` 的字段一旦删除，就没了。spec 早已声明"产品未上
线，不考虑向后兼容"——见 ``support/app/specs/skill-spec.md``。

依赖：上一个迁移 ``0030_delete_checkpointrollbacksaga_and_more``。
"""

from django.db import migrations, models


_DROP_SKILL_FIELDS_SQL = """
-- Step 1: 删除所有 field_type='skill' 的字段记录。
-- TableField 行删除会通过 FK on_delete=CASCADE 把 LinkRecord / FieldReference / etc
-- 一并清理；TableRecord 中 _meta:<field_uuid> JSON 残留无害可忽略。
DELETE FROM tabdata_field WHERE field_type = 'skill';
"""

_NOOP_REVERSE_SQL = "SELECT 1;"  # 不可逆


def _drop_skill_fields(apps, schema_editor):
    """通过 ORM 删除 skill 字段（让 Django 处理 FK 级联）。"""
    if schema_editor.connection.alias != 'postgresql':
        return
    TableField = apps.get_model('tabdata', 'TableField')
    deleted_count, _ = TableField.objects.using('postgresql').filter(
        field_type='skill',
    ).delete()
    if deleted_count:
        print(f"  [tabdata 0031] 删除 {deleted_count} 条 field_type='skill' 字段")


def _noop_reverse(apps, schema_editor):
    """无回滚——产品已下线，旧字段不可能恢复。"""
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0030_delete_checkpointrollbacksaga_and_more'),
    ]

    operations = [
        # 必须先用 Python 函数走 ORM 删除（让外键级联生效），再 drop 表。
        migrations.RunPython(_drop_skill_fields, _noop_reverse),

        # 删除 FieldExecutionRecord 模型（对应 db_table=tabdata_field_execution_record）
        migrations.DeleteModel(
            name='FieldExecutionRecord',
        ),

        # 更新 TableField.field_type choices（去掉 'skill'）
        migrations.AlterField(
            model_name='tablefield',
            name='field_type',
            field=models.CharField(
                choices=[
                    ('text', '文本字段'),
                    ('long_text', '多行文本'),
                    ('number', '数字'),
                    ('rating', '评分'),
                    ('auto_number', '自动标识'),
                    ('select', '单选'),
                    ('multi_select', '多选'),
                    ('checkbox', '复选框'),
                    ('date', '日期'),
                    ('datetime', '日期时间'),
                    ('created_time', '创建时间'),
                    ('last_modified_time', '最后修改时间'),
                    ('url', 'URL链接'),
                    ('email', '邮箱'),
                    ('phone', '手机号'),
                    ('user', '用户'),
                    ('created_by', '创建者'),
                    ('last_modified_by', '最后修改者'),
                    ('attachment', '附件'),
                    ('media', '媒体'),
                    ('formula', '公式'),
                    ('rollup', '汇总'),
                    ('link', '关联'),
                    ('lookup', '查找'),
                    ('button', '按钮'),
                    ('nested_list', '嵌套列表'),
                ],
                max_length=50,
                verbose_name='字段类型',
            ),
        ),
    ]
