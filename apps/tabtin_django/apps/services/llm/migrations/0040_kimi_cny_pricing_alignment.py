"""Kimi 定价对齐国内站人民币牌价（1:1 转售，零加价）。

背景：0032/0034 给 kimi-k2.6 写入的单价（0.00095 / 0.004 / cache 0.00016）
抄的是 Moonshot 国际站（platform.kimi.ai）的**美元**牌价数字，而整条计费
链路（CreditsService × CREDITS_PER_YUAN）按**人民币**语义计算，且实际
上游走 api.moonshot.cn 按人民币结算——导致平台向用户收取的费用只有
实付 Kimi 账单的 ~1/7。kimi-k2.7-code 是运营后台手工添加的，照抄了同
样的错误数字；kimi-k2.5 的输入/输出价本来就是人民币口径（正确），仅
缓存价错抄了美元数字。

本 migration 将三个模型的单价统一对齐 Kimi 国内站官方人民币牌价
（来源 https://platform.kimi.com/ 首页，核对日期 2026-07-13）：

  模型              输入/1M   输出/1M   缓存命中/1M
  kimi-k2.5         ¥4.00     ¥21.00    ¥0.70
  kimi-k2.6         ¥6.50     ¥27.00    ¥1.10
  kimi-k2.7-code    ¥6.50     ¥27.00    ¥1.30

存量行只更新价格字段（不碰 capabilities_config / description 等运营可能
调过的字段）；kimi-k2.7-code 不存在时整行创建（能力声明克隆自 k2.6），
使其从"仅存在于个别库的手工数据"转正为有代码基线的模型。

回滚为 noop：不恢复错误的美元价。
"""

from __future__ import annotations

from decimal import Decimal

from django.db import migrations


TAG = "0040_kimi_cny_pricing_alignment"
PROVIDER_NAME = "moonshot"

# 人民币牌价，单位：元 / 1k token
PRICE_ALIGNMENT = {
    "kimi-k2.5": {
        "input_price_per_1k": Decimal("0.004"),
        "output_price_per_1k": Decimal("0.021"),
        "cache_read_input_price_per_1k": "0.0007",
    },
    "kimi-k2.6": {
        "input_price_per_1k": Decimal("0.0065"),
        "output_price_per_1k": Decimal("0.027"),
        "cache_read_input_price_per_1k": "0.0011",
    },
    "kimi-k2.7-code": {
        "input_price_per_1k": Decimal("0.0065"),
        "output_price_per_1k": Decimal("0.027"),
        "cache_read_input_price_per_1k": "0.0013",
    },
}

K27_CODE_CREATE_SPECS = {
    "display_name": "Kimi K2.7 Code",
    "description": "Moonshot Kimi K2.7 Code — 262K 上下文，多模态 + 工具 + 推理，面向编码任务",
    "context_window_tokens": 262_144,
    "max_input_tokens": 262_144,
    "max_output_tokens": 32_768,
}


def _apply_prices(model, prices) -> list:
    """只更新价格相关字段，返回实际变更的字段名列表。"""
    changed = []
    for field in ("input_price_per_1k", "output_price_per_1k"):
        if getattr(model, field) != prices[field]:
            setattr(model, field, prices[field])
            changed.append(field)

    cache_price = prices["cache_read_input_price_per_1k"]
    billing_config = dict(model.custom_billing_config or {})
    if billing_config.get("cache_read_input_price_per_1k") != cache_price:
        billing_config["cache_read_input_price_per_1k"] = cache_price
        model.custom_billing_config = billing_config
        changed.append("custom_billing_config")
    return changed


def forwards(apps, schema_editor):
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")

    from django.db.models import Q

    providers = LLMProvider.objects.filter(
        Q(provider_key=PROVIDER_NAME) | Q(name=PROVIDER_NAME)
    )
    if not providers.exists():
        print(f"[{TAG}] ⚠ 没有 name={PROVIDER_NAME!r} 的 provider，跳过")
        return

    for provider in providers:
        for model_name, prices in PRICE_ALIGNMENT.items():
            model = LLMModel.objects.filter(
                provider=provider, model_name=model_name,
            ).first()

            if model is not None:
                changed = _apply_prices(model, prices)
                if changed:
                    model.save(update_fields=changed + ["updated_at"])
                    print(
                        f"[{TAG}] updated {model_name} "
                        f"(provider id={provider.id}): {changed}"
                    )
                continue

            if model_name != "kimi-k2.7-code":
                # k2.5 / k2.6 由 0034 保证存在；缺失说明该 provider 不是
                # chat 基线（如运营自建的 scope 隔离 provider），不代建。
                print(
                    f"[{TAG}] ⚠ provider id={provider.id} 缺 {model_name}，跳过"
                )
                continue

            # k2.7-code 转正：克隆 k2.6 的能力声明与 base_url 整行创建
            template = LLMModel.objects.filter(
                provider=provider, model_name="kimi-k2.6",
            ).first()
            if template is None:
                print(
                    f"[{TAG}] ⚠ provider id={provider.id} 无 kimi-k2.6 "
                    f"可克隆，跳过创建 kimi-k2.7-code"
                )
                continue

            import copy

            LLMModel.objects.create(
                provider=provider,
                model_name=model_name,
                base_url=template.base_url,
                capability_domain="chat",
                billing_type="token",
                wave_status="ready",
                input_price_per_1k=prices["input_price_per_1k"],
                output_price_per_1k=prices["output_price_per_1k"],
                price_per_request=Decimal("0"),
                price_per_second=Decimal("0"),
                custom_billing_config={
                    "cache_read_input_price_per_1k": prices[
                        "cache_read_input_price_per_1k"
                    ],
                },
                capabilities_config=copy.deepcopy(
                    template.capabilities_config or {}
                ),
                **K27_CODE_CREATE_SPECS,
            )
            print(
                f"[{TAG}] created kimi-k2.7-code (provider id={provider.id})"
            )


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0039_volcengine_doubao_seed_baseline"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
