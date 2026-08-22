"""
Phase 2.1 step 1/3 — 新增 ``LLMProvider.capability_domains`` (ArrayField)。

本 migration 仅 **新增** 字段（与索引/约束），保留旧的 ``capability_domain`` 单值字段，
让运行中的旧代码继续按单值路径工作。数据回填由 ``0025_backfill_capability_domains``
完成，旧字段删除在 ``0026_drop_capability_domain``。

三段式拆分保证：
- 即使 cutover 时 0024 / 0025 已上线但 0026 尚未应用，旧代码不受影响（旧字段仍在）
- ``capability_domains`` 默认 ``list`` 空数组，避免破坏 not-null 约束
- GIN 索引同步建好，新代码 ``filter(capability_domains__contains=[X])`` 立刻可用
"""

import django.contrib.postgres.fields
import django.contrib.postgres.indexes
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('llm', '0023_alter_llmadminauditlog_options_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='llmprovider',
            name='capability_domains',
            field=django.contrib.postgres.fields.ArrayField(
                base_field=models.CharField(
                    choices=[
                        ('chat', 'Chat'),
                        ('embedding', 'Embedding'),
                        ('vision', 'Vision'),
                        ('asr', 'ASR'),
                        ('tts', 'TTS'),
                        ('image_gen', 'Image Generation'),
                        ('video_gen', 'Video Generation'),
                        ('audio_gen', 'Audio Generation'),
                    ],
                    max_length=20,
                ),
                default=list,
                help_text=(
                    '该 Provider 同时支持的能力域。一个阿里云账号可同时提供 '
                    'chat/embedding/vision 等。'
                ),
                size=None,
                verbose_name='能力域集合',
            ),
        ),
        migrations.AddIndex(
            model_name='llmprovider',
            index=django.contrib.postgres.indexes.GinIndex(
                fields=['capability_domains'],
                name='llm_prov_caps_gin',
            ),
        ),
    ]
