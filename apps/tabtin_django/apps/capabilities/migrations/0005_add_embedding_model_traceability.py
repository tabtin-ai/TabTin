"""
AI 能力统一宪法 v0.1 — ToolEmbedding 加追溯字段
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('capabilities', '0004_alter_registeredtool_source_ref'),
    ]

    operations = [
        migrations.AddField(
            model_name='toolembedding',
            name='embedding_model_id',
            field=models.UUIDField(null=True, blank=True, db_index=True, verbose_name='LLMModel ID'),
        ),
        migrations.AddField(
            model_name='toolembedding',
            name='embedding_model_version',
            field=models.CharField(max_length=50, blank=True, default='', verbose_name='模型版本号'),
        ),
    ]
