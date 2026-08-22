"""为支持 1M Beta 长上下文的 Claude 模型自动 seed 档位配置。


  - Claude **Opus 4.6 / Sonnet 4.6** 的 1M 已 GA：标准价覆盖整 1M、不需要 beta header、
    不需要档位机制。这种模型本命令**不会**为它们写档位（避免无意义复杂度）。

  - Claude **Sonnet 4.5 / Sonnet 4** 的 1M 仍是 Beta：
      * 必须在 upstream 请求加 `anthropic-beta: context-1m-2025-08-07`
      * 计费 ≤200K 标准价、>200K input ×2 / output ×1.5
      * **2026-04-30 退役** —— 长期建议运营把流量切到 Sonnet 4.6
    这种模型本命令会自动建 standard + long_1m 双档：
      * standard: max_input_tokens=200000、is_default=True、不配价格 → 回退到模型基础价
      * long_1m:  max_input_tokens=1000000、extra_headers 含 beta header、tags=["beta"]、
                  applies_above_tokens=200000、over_input/over_output 按倍率算
        （倍率写死在 ZENMUX_LONG_CONTEXT_OVER_RATIOS，对齐 ZenMux 文档）

设计选择：
  - **不硬编码绝对单价**：over_*_price_per_1k 用 base_price × 倍率算出，运营改基础价时
    档位自动跟着变，避免双重维护漂移。
  - **幂等**：默认跳过已配置过 tiers 的模型，加 --force 才覆盖（运营手动调过的优先）。
  - **dry-run**：默认只打印将要变更，加 --apply 才写库（与 init_token_limits 一致风格）。
  - **deadline 提醒**：每次跑完都明确打印「Sonnet 4 / 4.5 的 1M Beta 将在 2026-04-30
    退役，建议迁移 Sonnet 4.6」让运营知情。

匹配规则（`_should_seed_model`）：
  - **白名单**：model_name 含 `sonnet-4-5` / `sonnet-4.5` / `sonnet-4-20`
    （兼容 Anthropic native `claude-sonnet-4-5-20250929` 与 ZenMux 包装
    `anthropic/claude-sonnet-4.5` 两种命名）
  - **黑名单**：model_name 含 `sonnet-4-6` / `sonnet-4.6` / `opus-4-6` / `opus-4.6`
    （这些模型 1M 已 GA，强制不 seed 档位即使匹配上）
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any, Optional

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.services.llm.models import LLMModel


# 长上下文 Beta header（ZenMux + Anthropic native 都用这个 key）
LONG_CONTEXT_BETA_HEADER_KEY = "anthropic-beta"
LONG_CONTEXT_BETA_HEADER_VALUE = "context-1m-2025-08-07"

# ZenMux 文档里的「>200K 加价倍率」，对齐 Anthropic 官方
ZENMUX_LONG_CONTEXT_OVER_RATIOS = {
    "input": Decimal("2.0"),
    "output": Decimal("1.5"),
}

# 匹配规则
SEED_INCLUDE_KEYWORDS = ("sonnet-4-5", "sonnet-4.5", "sonnet-4-20")
# 1M 已 GA 的模型，无需档位机制（Opus 4.6 / Sonnet 4.6 / Opus 4.7+ 同理）
SEED_EXCLUDE_KEYWORDS = (
    "sonnet-4-6", "sonnet-4.6", "sonnet-4-7", "sonnet-4.7",
    "opus-4-6", "opus-4.6", "opus-4-7", "opus-4.7",
)

# 退役提醒
DEPRECATION_NOTICE = (
    "⚠️  Claude Sonnet 4 / Sonnet 4.5 的 1M Beta 将在 2026-04-30 退役。\n"
    "    长期建议把流量切到 Sonnet 4.6（1M GA、无需 beta header、标准价覆盖）。"
)


def _should_seed_model(model_name: str) -> bool:
    """判断 model_name 是否需要档位机制。

    白名单 ∩ 非黑名单。模型名不区分大小写。
    """
    name = (model_name or "").lower()
    if any(bad in name for bad in SEED_EXCLUDE_KEYWORDS):
        return False
    return any(good in name for good in SEED_INCLUDE_KEYWORDS)


def _existing_tiers(custom_billing_config: dict[str, Any]) -> list[dict]:
    tp = (custom_billing_config or {}).get("tiered_pricing") or {}
    if not isinstance(tp, dict):
        return []
    tiers = tp.get("tiers")
    return tiers if isinstance(tiers, list) else []


def _build_zenmux_long_context_tiers(model: LLMModel) -> list[dict]:
    """按当前模型的 base 单价生成 standard + long_1m 双档配置。

    - standard 不写价格（resolve_tiered_pricing 命中后会回退到模型 base 单价）
    - long_1m 写 over 单价（base × ratio），quantize 到 6 位小数对齐 DB schema
    """
    base_input = Decimal(str(model.input_price_per_1k or 0))
    base_output = Decimal(str(model.output_price_per_1k or 0))

    over_input = (base_input * ZENMUX_LONG_CONTEXT_OVER_RATIOS["input"]).quantize(
        Decimal("0.000001"),
    )
    over_output = (base_output * ZENMUX_LONG_CONTEXT_OVER_RATIOS["output"]).quantize(
        Decimal("0.000001"),
    )

    return [
        {
            "id": "standard",
            "label": "标准 (200K)",
            "is_default": True,
            "max_input_tokens": 200000,
        },
        {
            "id": "long_1m",
            "label": "长上下文 (1M, Beta)",
            "max_input_tokens": 1000000,
            "tags": ["beta"],
            "extra_headers": {
                LONG_CONTEXT_BETA_HEADER_KEY: LONG_CONTEXT_BETA_HEADER_VALUE,
            },
            "applies_above_tokens": 200000,
            "over_input_price_per_1k": str(over_input),
            "over_output_price_per_1k": str(over_output),
        },
    ]


class Command(BaseCommand):
    help = (
        "为 Claude Sonnet 4 / Sonnet 4.5 等 1M-Beta 模型 seed standard + long_1m "
        "双档配置（Opus/Sonnet 4.6+ 自动跳过：1M 已 GA 不需档位机制）。"
    )

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--apply", action="store_true",
            help="实际写入数据库（默认仅预览，与 init_token_limits 一致）",
        )
        parser.add_argument(
            "--force", action="store_true",
            help="覆盖已配置过 tiers 的模型（默认幂等跳过，保护运营手动调整）",
        )
        parser.add_argument(
            "--model", type=str, default=None,
            help="仅处理匹配的 model_name（支持子串包含，如 'sonnet-4-5'）",
        )
        parser.add_argument(
            "--provider", type=str, default=None,
            help="仅处理指定 provider（如 claude / zenmux），按 provider.name 匹配",
        )

    def handle(self, *args, **options) -> None:
        apply_changes: bool = options["apply"]
        force: bool = options["force"]
        model_filter: Optional[str] = options["model"]
        provider_filter: Optional[str] = options["provider"]

        # v0.1：LLMModel.is_active 字段已删（0022），下线模型直接 DELETE。
        qs = LLMModel.objects.select_related("provider").filter(provider__routing_enabled=True)
        if model_filter:
            qs = qs.filter(model_name__icontains=model_filter)
        if provider_filter:
            qs = qs.filter(provider__name__iexact=provider_filter)

        scanned = 0
        candidates: list[tuple[LLMModel, list[dict], str]] = []
        skipped_existing: list[str] = []
        skipped_excluded: list[str] = []
        for model in qs:
            scanned += 1
            if not _should_seed_model(model.model_name):
                # 不属于本 command 的目标模型——既不算跳过也不算匹配
                continue

            existing = _existing_tiers(model.custom_billing_config or {})
            if existing and not force:
                skipped_existing.append(
                    f"{model.provider.name}/{model.model_name} (已有 {len(existing)} 档)"
                )
                continue

            new_tiers = _build_zenmux_long_context_tiers(model)
            action = "覆盖" if existing else "新建"
            candidates.append((model, new_tiers, action))

        # ─── 输出预览 ───
        self.stdout.write(f"\n扫描 {scanned} 个 active 模型，匹配 {len(candidates) + len(skipped_existing)} 个 1M-Beta 候选。\n")

        if skipped_existing:
            self.stdout.write(self.style.WARNING(
                f"\n跳过 {len(skipped_existing)} 个已配置档位的模型（加 --force 覆盖）：",
            ))
            for line in skipped_existing:
                self.stdout.write(f"  · {line}")

        if not candidates:
            self.stdout.write(self.style.SUCCESS("\n✅ 无待处理模型。"))
            self._print_deprecation_notice()
            return

        self.stdout.write(self.style.NOTICE(
            f"\n将{'覆盖' if force else '新建'} {len(candidates)} 个模型的档位：",
        ))
        for model, tiers, action in candidates:
            self.stdout.write(
                f"\n  📌 {model.provider.name}/{model.model_name} "
                f"(base input={model.input_price_per_1k} / output={model.output_price_per_1k}) — {action}"
            )
            self.stdout.write(self._format_tiers_preview(tiers))

        # ─── 落库 ───
        if not apply_changes:
            self.stdout.write(self.style.WARNING(
                "\nℹ️  预览模式（--apply 才会真正写入数据库）。"
            ))
            self._print_deprecation_notice()
            return

        with transaction.atomic():
            for model, new_tiers, _ in candidates:
                custom = dict(model.custom_billing_config or {})
                tiered_pricing = dict(custom.get("tiered_pricing") or {})
                tiered_pricing["tiers"] = new_tiers
                custom["tiered_pricing"] = tiered_pricing
                model.custom_billing_config = custom
                model.save(update_fields=["custom_billing_config", "updated_at"])

        self.stdout.write(self.style.SUCCESS(
            f"\n✅ 已写入 {len(candidates)} 个模型的档位配置。"
        ))
        self._print_deprecation_notice()

    def _format_tiers_preview(self, tiers: list[dict]) -> str:
        return "      " + json.dumps(tiers, ensure_ascii=False, indent=2).replace(
            "\n", "\n      ",
        )

    def _print_deprecation_notice(self) -> None:
        self.stdout.write("")
        self.stdout.write(self.style.WARNING(DEPRECATION_NOTICE))
