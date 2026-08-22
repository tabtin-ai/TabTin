"""数据迁移共享工具：声明式地往运行库里加 / 改 LLM 模型。

为什么放在 migrations 包内、且刻意不 import 任何 app 代码（models / services /
provider_profiles 等）：

* migration 必须**自包含、确定性、可离线重放**。如果 import 了 app 代码，等那段
  代码后续被改 / 删，老 migration 就会在新代码上重放失败。所以这里只用
  ``apps.get_model(...)`` 拿历史模型，规格全部由调用方显式传入。

* 自动补规格（查 LiteLLM 公开库等）是**运行时 / AdminDash** 的便利，不进 migration
  ——migration 里跑网络请求会让 CI / 离线部署变得不确定。在"加模型"这件事上，
  写 migration 的那个人（现在是 AI）就是 auto-fill：把查到的规格直接写进
  ``specs`` 字典。AI 即 auto-fill，migration 保持纯数据。

典型用法（一个新模型的 migration 缩成几行）::

    from apps.services.llm.migrations._helpers import upsert_llm_model

    def add_kimi_k26(apps, schema_editor):
        upsert_llm_model(
            apps, "moonshot", "kimi-k2.6",
            specs={
                "display_name": "Kimi K2.6",
                "context_window_tokens": 262144,
                "max_output_tokens": 32768,
                "input_price_per_1k": "0.00095",
                "output_price_per_1k": "0.004",
                "custom_billing_config": {"cache_read_input_price_per_1k": "0.00016"},
            },
            clone_caps_from="kimi-k2.5",
        )
"""

from __future__ import annotations

import copy
from decimal import Decimal, InvalidOperation
from typing import Any, Optional


# 允许直接落到 LLMModel 字段的 spec 键（其余键会被忽略并告警）。
_MODEL_FIELDS = frozenset({
    "display_name",
    "description",
    "base_url",
    "capability_domain",
    "context_window_tokens",
    "max_input_tokens",
    "max_output_tokens",
    "billing_type",
    "input_price_per_1k",
    "output_price_per_1k",
    "price_per_request",
    "price_per_second",
    "custom_billing_config",
    "capabilities_config",
    "wave_status",
})

_DECIMAL_FIELDS = frozenset({
    "input_price_per_1k",
    "output_price_per_1k",
    "price_per_request",
    "price_per_second",
})

_DEFAULTS = {
    "capability_domain": "chat",
    "billing_type": "token",
    "wave_status": "ready",
    "description": "",
}


def _coerce_decimal(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:  # noqa: BLE001
        raise ValueError(f"无法转成 Decimal 的定价值: {value!r}") from exc


def upsert_llm_model(
    apps,
    provider_name: str,
    model_name: str,
    *,
    specs: Optional[dict] = None,
    clone_caps_from: Optional[str] = None,
    tag: str = "upsert_llm_model",
) -> dict:
    """给名为 ``provider_name`` 的**每个** provider 幂等地 upsert 一个模型。

    Args:
        apps: migration 注入的历史 app registry。
        provider_name: ``LLMProvider.name``（如 ``"moonshot"``）。同名 provider 可能
            有多个（global / organization / user scope），每个都会处理。
        model_name: 目标 ``LLMModel.model_name``。
        specs: 模型字段。键见 ``_MODEL_FIELDS``。定价可传字符串 / 数字，内部转 Decimal。
            必须能凑出 ``context_window_tokens`` 和 ``base_url``（见 clone 兜底）。
        clone_caps_from: 同 provider 下的兄弟模型名。命中时 deep-copy 它的
            ``capabilities_config`` 和（specs 没给时的）``base_url`` —— 让新模型直接
            继承 wire_adapter 等能力声明，不必裸奔。
        tag: 日志前缀，通常传 migration 名。

    Returns:
        ``{"created": n, "updated": n, "providers": n}`` 统计。

    幂等：已存在则按 specs 做字段级更新（只动有变化的字段）；不存在则创建。
    重放安全：跑两遍结果一致。
    """
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")

    specs = dict(specs or {})

    # 未知键告警（拼写错防呆），但不阻断。
    unknown = set(specs) - _MODEL_FIELDS - {"model_name"}
    if unknown:
        print(f"[{tag}] ⚠ 忽略未知 spec 键: {sorted(unknown)}")

    created = updated = providers_touched = 0

    provider_qs = LLMProvider.objects.filter(name=provider_name)
    if not provider_qs.exists():
        # provider 还没建（fresh DB / 运营后建）——migration 当下补不了，
        # 交给 register.py static_models 兜住"下拉可见"，路由行下次 migration 再补。
        print(
            f"[{tag}] ⚠ 没有 name={provider_name!r} 的 provider，跳过 "
            f"model={model_name}（static_models 声明仍可在 catalog 展示）"
        )
        return {"created": 0, "updated": 0, "providers": 0}

    for provider in provider_qs:
        providers_touched += 1

        # 1) 解析克隆源（同 provider 下的兄弟模型）
        template = None
        if clone_caps_from:
            template = LLMModel.objects.filter(
                provider=provider, model_name=clone_caps_from
            ).first()

        # 2) 组装目标字段值
        resolved: dict[str, Any] = dict(_DEFAULTS)

        if template is not None:
            resolved["base_url"] = getattr(template, "base_url", "") or ""
            resolved["capabilities_config"] = copy.deepcopy(
                getattr(template, "capabilities_config", None) or {}
            )

        for key, value in specs.items():
            if key not in _MODEL_FIELDS:
                continue
            resolved[key] = _coerce_decimal(value) if key in _DECIMAL_FIELDS else value

        resolved.setdefault("display_name", model_name)
        resolved.setdefault("capabilities_config", {})
        resolved.setdefault("custom_billing_config", {})

        # 3) 必填校验
        if not resolved.get("base_url"):
            raise ValueError(
                f"[{tag}] model={model_name} 缺 base_url：specs 没给、"
                f"clone_caps_from={clone_caps_from!r} 也没找到可继承的兄弟模型"
            )
        if not resolved.get("context_window_tokens"):
            raise ValueError(
                f"[{tag}] model={model_name} 缺 context_window_tokens"
            )

        # 4) capability_domain 与 provider 能力域软校验（不阻断 migrate）
        domain = resolved.get("capability_domain")
        provider_domains = list(getattr(provider, "capability_domains", None) or [])
        if provider_domains and domain not in provider_domains:
            print(
                f"[{tag}] ⚠ model={model_name} capability_domain={domain} "
                f"不在 provider.capability_domains={provider_domains} 内，仍按 specs 写入"
            )

        # 5) upsert
        existing = LLMModel.objects.filter(
            provider=provider, model_name=model_name
        ).first()

        if existing is None:
            LLMModel.objects.create(
                provider=provider, model_name=model_name, **resolved
            )
            created += 1
            continue

        changed_fields = []
        for field, new_val in resolved.items():
            if getattr(existing, field) != new_val:
                setattr(existing, field, new_val)
                changed_fields.append(field)
        if changed_fields:
            existing.save(update_fields=changed_fields + ["updated_at"])
            updated += 1

    print(
        f"[{tag}] provider={provider_name} model={model_name} "
        f"created={created} updated={updated} providers={providers_touched}"
    )
    return {"created": created, "updated": updated, "providers": providers_touched}


def remove_llm_model(
    apps,
    provider_name: str,
    model_name: str,
    *,
    tag: str = "remove_llm_model",
) -> int:
    """回滚辅助：删掉某 provider 下指定模型。返回删除条数。"""
    LLMModel = apps.get_model("llm", "LLMModel")
    deleted, _ = LLMModel.objects.filter(
        provider__name=provider_name, model_name=model_name
    ).delete()
    if deleted:
        print(f"[{tag}] reverse deleted={deleted} model={model_name}")
    return deleted
