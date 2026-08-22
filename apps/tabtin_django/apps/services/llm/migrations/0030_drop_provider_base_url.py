"""
Phase 2.5 step 4/4 — 删除 ``LLMProvider.base_url``。

应用前置：所有读取 ``provider.base_url`` 的代码必须已经切换到 ``model.base_url``，
否则 0030 上线瞬间会 AttributeError。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('llm', '0029_llmmodel_base_url_required'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='llmprovider',
            name='base_url',
        ),
    ]
