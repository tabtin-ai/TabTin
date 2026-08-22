"""
AI 能力统一宪法 v0.1 — 5 张 RAG embedding 表加追溯字段

每张表加 embedding_model_id (UUIDField) + embedding_model_version (CharField)
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('rag', '0020_alter_skillembedding_source'),
    ]

    operations = [
        # TableEmbedding
        migrations.AddField(
            model_name='tableembedding',
            name='embedding_model_id',
            field=models.UUIDField(null=True, blank=True, db_index=True, verbose_name='LLMModel ID'),
        ),
        migrations.AddField(
            model_name='tableembedding',
            name='embedding_model_version',
            field=models.CharField(max_length=50, blank=True, default='', verbose_name='模型版本号'),
        ),

        # RecordEmbedding
        migrations.AddField(
            model_name='recordembedding',
            name='embedding_model_id',
            field=models.UUIDField(null=True, blank=True, db_index=True, verbose_name='LLMModel ID'),
        ),
        migrations.AddField(
            model_name='recordembedding',
            name='embedding_model_version',
            field=models.CharField(max_length=50, blank=True, default='', verbose_name='模型版本号'),
        ),

        # SkillEmbedding
        migrations.AddField(
            model_name='skillembedding',
            name='embedding_model_id',
            field=models.UUIDField(null=True, blank=True, db_index=True, verbose_name='LLMModel ID'),
        ),
        migrations.AddField(
            model_name='skillembedding',
            name='embedding_model_version',
            field=models.CharField(max_length=50, blank=True, default='', verbose_name='模型版本号'),
        ),

        # DocumentEmbedding
        migrations.AddField(
            model_name='documentembedding',
            name='embedding_model_id',
            field=models.UUIDField(null=True, blank=True, db_index=True, verbose_name='LLMModel ID'),
        ),
        migrations.AddField(
            model_name='documentembedding',
            name='embedding_model_version',
            field=models.CharField(max_length=50, blank=True, default='', verbose_name='模型版本号'),
        ),

        # CodeChunkEmbedding
        migrations.AddField(
            model_name='codechunkembedding',
            name='embedding_model_id',
            field=models.UUIDField(null=True, blank=True, db_index=True, verbose_name='LLMModel ID'),
        ),
        migrations.AddField(
            model_name='codechunkembedding',
            name='embedding_model_version',
            field=models.CharField(max_length=50, blank=True, default='', verbose_name='模型版本号'),
        ),
    ]
