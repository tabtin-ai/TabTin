# Generated manually for capability_domain field

from django.db import migrations, models


_NAME_TO_DOMAIN = {
    "bytedance": "tts",
    "fal": "image_gen",
    "replicate": "image_gen",
    "dashscope": "image_gen",
    "minimax_bgm": "bgm",
}


def backfill_capability_domain(apps, schema_editor):
    LLMProvider = apps.get_model("llm", "LLMProvider")
    for name, domain in _NAME_TO_DOMAIN.items():
        LLMProvider.objects.filter(name=name).update(capability_domain=domain)


def reverse_backfill(apps, schema_editor):
    LLMProvider = apps.get_model("llm", "LLMProvider")
    for name in _NAME_TO_DOMAIN:
        LLMProvider.objects.filter(name=name).update(capability_domain="llm")


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0010_merge_20260331_2202"),
    ]

    operations = [
        migrations.AddField(
            model_name="llmprovider",
            name="capability_domain",
            field=models.CharField(
                choices=[
                    ("llm", "LLM 聊天"),
                    ("tts", "语音合成"),
                    ("asr", "语音识别"),
                    ("image_gen", "图片生成"),
                    ("video_gen", "视频生成"),
                    ("bgm", "背景音乐"),
                ],
                db_index=True,
                default="llm",
                help_text="标识此 Provider 所属的 AI 能力域，用于域隔离查询",
                max_length=20,
                verbose_name="能力域",
            ),
        ),
        migrations.RunPython(backfill_capability_domain, reverse_backfill),
    ]
