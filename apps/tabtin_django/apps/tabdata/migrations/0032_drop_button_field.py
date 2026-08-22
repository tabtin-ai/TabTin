"""下架 TabData 按钮字段（field_type='button'）

产品决策（2026-05-01 扫尾轮）：
按钮字段曾通过 SkillFieldApiService.executeField 触发执行——这条端点随
TabData AI 字段一起下架后，按钮字段在 UI 上仅剩"可创建但点击 noop"的
半成品形态。Tracker 后续覆盖 watch 能力 + chat + Agent 操作可以替代
"点击触发动作"的语义，所以一并下架。

依赖：上一个迁移 ``0031_drop_skill_field``。

不可逆：``field_type='button'`` 的字段一旦删除，就没了。
"""

from django.db import migrations, models


def _drop_button_fields(apps, schema_editor):
    """删除所有 field_type='button' 的字段（让 Django 处理 FK 级联）。"""
    if schema_editor.connection.alias != 'postgresql':
        return
    TableField = apps.get_model('tabdata', 'TableField')
    deleted_count, _ = TableField.objects.using('postgresql').filter(
        field_type='button',
    ).delete()
    if deleted_count:
        print(f"  [tabdata 0032] 删除 {deleted_count} 条 field_type='button' 字段")


def _noop_reverse(apps, schema_editor):
    """无回滚——产品已下线，旧字段不可能恢复。"""
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0031_drop_skill_field'),
    ]

    operations = [
        migrations.RunPython(_drop_button_fields, _noop_reverse),
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
                    ('nested_list', '嵌套列表'),
                ],
                max_length=50,
                verbose_name='字段类型',
            ),
        ),
    ]
