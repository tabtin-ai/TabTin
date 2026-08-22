"""
Phase 2.5 step 1/4 — 给 ``LLMModel`` 新增 ``base_url`` 字段（可空，待回填）。

背景：dashscope 同账号下 chat/embedding/vision 走 ``/compatible-mode/v1``、
image_gen/video_gen/audio_gen 走 ``/api/v1``。原先 base_url 存在 Provider 上
只能存 1 个值，"1 Provider 多 capability_domain" 合并后必出现 endpoint 错位。
本系列 migration 把 base_url 下沉到 Model。

四段拆分（不删旧字段不并入新字段，避免 v0.1.x app 上线那一瞬间数据不一致）：
- 0027（本文件）AddField LLMModel.base_url，blank/default=''
- 0028 RunPython 把 provider.base_url 复制到下属每个 model.base_url
- 0029 AlterField 把 LLMModel.base_url 改成非空（业务上必填）
- 0030 RemoveField LLMProvider.base_url
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('llm', '0026_drop_capability_domain'),
    ]

    operations = [
        migrations.AddField(
            model_name='llmmodel',
            name='base_url',
            field=models.URLField(
                blank=True, default='',
                help_text=(
                    'HTTP/WS 调用拼装时使用的端点。每个 Model 必须有自己的 base_url'
                    '（v0.1.x 不再回退到 Provider.base_url——Provider.base_url 已删）。'
                ),
                verbose_name='端点 URL',
            ),
        ),
    ]
