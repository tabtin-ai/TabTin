"""新增 Kimi K2.6 模型（Moonshot）。

官方定价（2026-05，Moonshot 平台）：
  - 输入 $0.95/M、输出 $4.00/M、缓存命中 $0.16/M
  - 上下文 262,144 tokens

规格显式写在 specs 里（migration 保持纯数据、可离线重放）；wire_adapter 等能力
声明从同 provider 的 kimi-k2.5 克隆继承。加新模型只需照此再写一个瘦 migration。
"""

from __future__ import annotations

from django.db import migrations

from apps.services.llm.migrations._helpers import remove_llm_model, upsert_llm_model


TAG = "0032_add_kimi_k26_model"
PROVIDER = "moonshot"
MODEL = "kimi-k2.6"

K26_SPECS = {
    "display_name": "Kimi K2.6",
    "context_window_tokens": 262_144,
    "max_input_tokens": 262_144,
    "max_output_tokens": 32_768,
    "input_price_per_1k": "0.00095",
    "output_price_per_1k": "0.004",
    "custom_billing_config": {
        "cache_read_input_price_per_1k": "0.00016",
    },
    # base_url 不传 → 从 kimi-k2.5 继承；没有兄弟模型时由 helper 报错提示。
}


def forwards(apps, schema_editor):
    upsert_llm_model(
        apps,
        PROVIDER,
        MODEL,
        specs=K26_SPECS,
        clone_caps_from="kimi-k2.5",
        tag=TAG,
    )


def backwards(apps, schema_editor):
    remove_llm_model(apps, PROVIDER, MODEL, tag=TAG)


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0031_alter_llmmodel_base_url"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
