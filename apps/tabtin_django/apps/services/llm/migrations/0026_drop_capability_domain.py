"""
Phase 2.1 step 3/3 — 删除 ``LLMProvider.capability_domain`` 单值字段及其索引。

应用前置：必须已应用 0025（数据已回填到 capability_domains）。
所有读取代码应已切换到 ``capability_domains`` / ``has_capability()``，否则会 FieldError。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('llm', '0025_backfill_capability_domains'),
    ]

    operations = [
        migrations.RemoveIndex(
            model_name='llmprovider',
            name='llm_prov_domain_scope_route',
        ),
        migrations.AddIndex(
            model_name='llmprovider',
            index=models.Index(
                fields=['scope', 'routing_enabled'],
                name='llm_prov_scope_route',
            ),
        ),
        migrations.RemoveField(
            model_name='llmprovider',
            name='capability_domain',
        ),
    ]
