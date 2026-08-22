"""W1a: LLMModel WireAdapter 控制字段 schema migration。

新增两个字段(harness LLM WireAdapter 总控 § D10):

- ``wire_adapter_disabled``(BooleanField, default=False):True 时 LLMProxy
  路径回退到 W0 临时 normalizer,用于 W1+ 单 model 灰度回滚。
- ``wave_status``(CharField, default='ready'):Electron model picker 标灰提示
  用,值为 ``ready`` / ``w2_pending`` / ``w3_pending``。

migration 同步把 MiniMax provider 下所有 model 的 ``wave_status`` 初始化为
``'w2_pending'`` — W2 完整适配前 model picker 标灰,避免用户切到 MiniMax 直接
挂(总控 § 1.3 dogfood 暴露的双路径分裂场景之一)。

DB:LLMModel 在 default DB(MySQL),不需要 ``--database=postgresql``。
"""

from django.db import migrations, models


def init_minimax_wave_status(apps, schema_editor):
    """MiniMax provider 下所有 LLMModel 初始化 wave_status='w2_pending'。

    W1a 仅落数据模型 + Request 适配框架,W2 才完整覆盖 MiniMax 的 anthropic
    SDK 路径(总控 § 3 wave 划分),期间 model picker 应该提示用户该模型
    "适配中"。
    """
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")
    minimax_providers = LLMProvider.objects.filter(name="minimax")
    if not minimax_providers.exists():
        return
    LLMModel.objects.filter(provider__in=minimax_providers).update(
        wave_status="w2_pending"
    )


def reverse_minimax_wave_status(apps, schema_editor):
    """回滚:全部回到 ready。"""
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")
    minimax_providers = LLMProvider.objects.filter(name="minimax")
    if not minimax_providers.exists():
        return
    LLMModel.objects.filter(provider__in=minimax_providers).update(wave_status="ready")


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0013_widen_llmrequest_request_id"),
    ]

    operations = [
        migrations.AddField(
            model_name="llmmodel",
            name="wire_adapter_disabled",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "True 时 LLMProxy 路径回退到 W0 临时 normalizer(不走 wire_adapter)。"
                    "用于 W1+ 单 model 灰度回滚。"
                ),
                verbose_name="WireAdapter 禁用",
            ),
        ),
        migrations.AddField(
            model_name="llmmodel",
            name="wave_status",
            field=models.CharField(
                choices=[
                    ("ready", "可用"),
                    ("w2_pending", "W2 适配中"),
                    ("w3_pending", "W3 适配中"),
                ],
                default="ready",
                help_text=(
                    "ready=可用;w2_pending/w3_pending=Electron model picker "
                    "标灰提示用户该模型尚未完整适配。"
                ),
                max_length=16,
                verbose_name="Wave 状态",
            ),
        ),
        migrations.AddIndex(
            model_name="llmmodel",
            index=models.Index(
                fields=["wave_status", "is_active"],
                name="ll_model_wave_active_idx",
            ),
        ),
        migrations.RunPython(
            init_minimax_wave_status,
            reverse_minimax_wave_status,
        ),
    ]
