"""补齐 TabData 字段类型 choices: percent + currency

Wave 2 决策（D5 路 B，2026-05-01）：
``FIELD_TYPES`` registry（apps/tabdata/utils/field_types.py）长期注册了
``PercentField`` / ``CurrencyField``（采集场景常融资金额、占比、估值），但
``FIELD_TYPE_CHOICES`` 遗漏了这两个 key——DB 校验拒绝它们，registry / choices /
CLI 描述三线长期不闭合。

用户拍板：补 DB choices（路 B），不删 registry。本迁移把 ``percent`` +
``currency`` 加入 choices，让 registry 与 DB 校验对齐。

Wave 1 独立复核指出：这一差异导致文档有、CLI 会暴露、但 API 实际拒绝创建。修
choices 后，27 种 registry key 与 27 个 choices 项一一对应。

依赖：上一个迁移 ``0032_drop_button_field``。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0032_drop_button_field'),
    ]

    operations = [
        migrations.AlterField(
            model_name='tablefield',
            name='field_type',
            field=models.CharField(
                choices=[
                    ('text', '文本字段'),
                    ('long_text', '多行文本'),
                    ('number', '数字'),
                    ('percent', '百分比'),
                    ('currency', '货币'),
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
