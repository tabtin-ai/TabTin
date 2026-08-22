"""
合并 v0.1.0 的 8 个 placeholder LLMProvider 到 v0.1.x 的 2 个多 capability_domains Provider。

v0.1.0 模型：
  qwen_default_chat / qwen_default_embedding / qwen_default_vision /
  qwen_default_image_gen / qwen_default_video_gen / qwen_default_audio_gen
  bytedance_default_asr / bytedance_default_tts
  （每个 Provider 单一 capability_domain）

v0.1.x 目标：
  qwen_default       capability_domains=[chat, embedding, vision, image_gen, video_gen, audio_gen]
  bytedance_default  capability_domains=[asr, tts]

迁移策略（幂等 + 安全）：
  1. 若目标 Provider 已存在 → 直接收编旧 Provider 的下属 LLMModel（重指向 provider_id）
     - 同时合并旧 Provider 的 capability_domains 到目标 Provider（unions）
  2. 若目标 Provider 不存在 → "挑选最具完整 api_key 的旧 Provider 作为种子"
     升级它的 capability_domains 为合并集，rename provider_key 到 v0.1.x 目标 key
  3. SceneBinding 不动（它们指向 LLMModel.id，而 LLMModel.provider_id 已被重指向）
  4. 删除剩余的旧 placeholder Provider（确认它们已无下属 LLMModel）
  5. 关键：单事务执行，失败可回滚

使用：
  python manage.py merge_legacy_providers           # 默认 dry-run，打印计划
  python manage.py merge_legacy_providers --apply   # 真执行
  python manage.py merge_legacy_providers --apply --keep-orphans  # 不删旧 Provider
"""

from __future__ import annotations

import logging
from typing import Optional

from django.core.management.base import BaseCommand
from django.db import transaction
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


# 与 seed_scene_bindings.py 的 LEGACY_PROVIDER_KEY_MAP 保持一致
QWEN_LEGACY_KEYS = [
    "qwen_default_chat",
    "qwen_default_embedding",
    "qwen_default_vision",
    "qwen_default_image_gen",
    "qwen_default_video_gen",
    "qwen_default_audio_gen",
]
BYTEDANCE_LEGACY_KEYS = [
    "bytedance_default_asr",
    "bytedance_default_tts",
]

# 合并后的能力域
QWEN_TARGET_DOMAINS = [
    "chat", "embedding", "vision", "image_gen", "video_gen", "audio_gen",
]
BYTEDANCE_TARGET_DOMAINS = ["asr", "tts"]

QWEN_TARGET_KEY = "qwen_default"
BYTEDANCE_TARGET_KEY = "bytedance_default"


class Command(BaseCommand):
    help = (
        "合并 v0.1.0 的 8 个 placeholder Provider 到 v0.1.x 的 2 个多 capability_domains Provider。"
        "默认 dry-run，加 --apply 才真执行。"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--apply", action="store_true",
            help="真执行（默认 dry-run，只打印计划）",
        )
        parser.add_argument(
            "--keep-orphans", action="store_true",
            help="迁移后不删除旧 placeholder Provider（默认会删，需确认无 LLMModel 引用）",
        )
        parser.add_argument(
            "--force-merge-divergent", action="store_true",
            help=(
                "允许在 base_url / api_key 不一致时强制合并（默认会 abort 让运营手动决策）。"
                "强制合并会按 api_key 完整度排序，挑选最完整的 Provider 作为种子，"
                "其它 Provider 的 base_url 和 api_key 会被丢弃（仅保留 capability_domains union）。"
            ),
        )

    def handle(self, *args, **options):
        from apps.services.llm.models import LLMProvider, LLMModel

        apply_changes = bool(options.get("apply"))
        keep_orphans = bool(options.get("keep_orphans"))
        force_merge_divergent = bool(options.get("force_merge_divergent"))

        mode = "APPLY" if apply_changes else "DRY-RUN"
        self.stdout.write(self.style.WARNING(f"=== merge_legacy_providers [{mode}] ==="))

        # 用户级 Provider 不动；只迁全局 placeholder
        qwen_legacy = list(
            LLMProvider.objects
            .filter(provider_key__in=QWEN_LEGACY_KEYS, organization_id__isnull=True, user_id__isnull=True)
            .order_by("provider_key")
        )
        byte_legacy = list(
            LLMProvider.objects
            .filter(provider_key__in=BYTEDANCE_LEGACY_KEYS, organization_id__isnull=True, user_id__isnull=True)
            .order_by("provider_key")
        )

        qwen_target = LLMProvider.objects.filter(
            provider_key=QWEN_TARGET_KEY, organization_id__isnull=True, user_id__isnull=True,
        ).first()
        byte_target = LLMProvider.objects.filter(
            provider_key=BYTEDANCE_TARGET_KEY, organization_id__isnull=True, user_id__isnull=True,
        ).first()

        self.stdout.write(f"qwen legacy: {len(qwen_legacy)}, target exists: {qwen_target is not None}")
        self.stdout.write(f"bytedance legacy: {len(byte_legacy)}, target exists: {byte_target is not None}")

        if not qwen_legacy and not byte_legacy and qwen_target and byte_target:
            self.stdout.write(self.style.SUCCESS("✓ 数据已是 v0.1.x，无需迁移"))
            return

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                if qwen_legacy or qwen_target:
                    qwen_target = self._merge_group(
                        legacy=qwen_legacy,
                        target=qwen_target,
                        target_key=QWEN_TARGET_KEY,
                        target_name="qwen",
                        target_display_name="阿里云 Qwen",
                        target_domains=QWEN_TARGET_DOMAINS,
                        keep_orphans=keep_orphans,
                        apply_changes=apply_changes,
                        force_merge_divergent=force_merge_divergent,
                    )
                if byte_legacy or byte_target:
                    byte_target = self._merge_group(
                        legacy=byte_legacy,
                        target=byte_target,
                        target_key=BYTEDANCE_TARGET_KEY,
                        target_name="bytedance",
                        target_display_name="字节 Speech",
                        target_domains=BYTEDANCE_TARGET_DOMAINS,
                        keep_orphans=keep_orphans,
                        apply_changes=apply_changes,
                        force_merge_divergent=force_merge_divergent,
                    )

                if not apply_changes:
                    # dry-run 模式：事务始终回滚
                    raise _DryRunRollback()
        except _DryRunRollback:
            self.stdout.write(self.style.WARNING("(dry-run rolled back, no changes persisted)"))
            return
        except _DivergentConfigError as exc:
            self.stdout.write(self.style.ERROR(f"\n✗ {exc}"))
            self.stdout.write(self.style.WARNING(
                "  abort：未传 --force-merge-divergent，已回滚所有未提交改动。\n"
                "  请运营手动决策后再执行：\n"
                "    a) 把多个 legacy Provider 的 api_key 在 AdminDash 改成一致；\n"
                "    b) 或者跑 --force-merge-divergent 接受丢弃非种子 Provider 的 api_key。"
            ))
            return

        self.stdout.write(self.style.SUCCESS("✓ merge_legacy_providers done"))

    def _merge_group(
        self,
        *,
        legacy: list,
        target,
        target_key: str,
        target_name: str,
        target_display_name: str,
        target_domains: list[str],
        keep_orphans: bool,
        apply_changes: bool,
        force_merge_divergent: bool = False,
    ):
        """单组（qwen 或 bytedance）合并逻辑。返回最终的 target Provider。"""
        from apps.services.llm.models import LLMProvider, LLMModel

        # 0. 先打印当前组所有 legacy + target 的状态（dry-run 体验改进）
        # v0.1.x Phase 2.5：Provider.base_url 已删；base_url 下沉到 model，
        # 合并时不再有 base_url 冲突问题（每个 model 自带 endpoint）。
        all_providers = [p for p in legacy] + ([target] if target is not None else [])
        if all_providers:
            self.stdout.write(f"\n[{target_key} group] 当前 Provider 状态：")
            self.stdout.write("  provider_key                          api_key             models")
            for p in all_providers:
                key = (p.api_key or '')
                if key.startswith('<INSERT'):
                    key_preview = '<placeholder>'
                elif len(key) > 12:
                    key_preview = key[:6] + '...' + key[-4:]
                else:
                    key_preview = key or '<empty>'
                model_count = LLMModel.objects.filter(provider=p).count()
                self.stdout.write(
                    f"  {p.provider_key:38} {key_preview:18} models={model_count}"
                )

        # 0.5 冲突检测：仅检查 api_key 不一致（v0.1.x Phase 2.5 之后不再有 base_url 冲突）
        self._check_divergence(
            all_providers, target_key=target_key,
            force_merge_divergent=force_merge_divergent,
        )

        # 1. 决定 target：已存在直接用；不存在则从 legacy 挑一个 api_key 最完整的作为种子
        target = self._ensure_target_provider(
            target=target,
            legacy=legacy,
            target_key=target_key,
            target_name=target_name,
            target_display_name=target_display_name,
            target_domains=target_domains,
        )

        # 2. 合并 capability_domains（unions）
        merged_domains = sorted(set(target.capability_domains or []) | set(target_domains))
        if list(target.capability_domains or []) != merged_domains:
            self.stdout.write(
                f"  target {target_key}: capability_domains {target.capability_domains} -> {merged_domains}"
            )
            target.capability_domains = merged_domains
            if apply_changes:
                target.save(update_fields=["capability_domains", "updated_at"])

        # 3. 旧 Provider 的 LLMModel 重指向到 target
        remaining_legacy = [p for p in legacy if p.id != target.id]
        for old in remaining_legacy:
            count = LLMModel.objects.filter(provider=old).count()
            self.stdout.write(
                f"  {old.provider_key} ({old.id}): {count} models -> {target_key} ({target.id})"
            )
            if apply_changes and count > 0:
                LLMModel.objects.filter(provider=old).update(provider=target)

        # 4. 删除旧 Provider（确认无 LLMModel 引用）
        for old in remaining_legacy:
            still_used = LLMModel.objects.filter(provider=old).exists()
            if still_used:
                self.stdout.write(self.style.ERROR(
                    f"  ! {old.provider_key} still has LLMModel referrers, skipping delete"
                ))
                continue
            if keep_orphans:
                self.stdout.write(f"  - {old.provider_key} kept (--keep-orphans)")
                continue
            self.stdout.write(self.style.WARNING(
                f"  - {old.provider_key} delete"
            ))
            if apply_changes:
                old.delete()

        return target

    def _ensure_target_provider(
        self,
        *,
        target,
        legacy: list,
        target_key: str,
        target_name: str,
        target_display_name: str,
        target_domains: list[str],
    ):
        """确保 target Provider 存在，必要时从 legacy 选种子升级。"""
        from apps.services.llm.models import LLMProvider

        if target is not None:
            return target

        # 从 legacy 中选 api_key 不是占位符且最长的作为种子
        # （保留运营手动填好的真实 key）
        candidates = sorted(
            legacy,
            key=lambda p: (
                0 if (p.api_key or "").startswith("<INSERT") else 1,
                len(p.api_key or ""),
            ),
            reverse=True,
        )
        if not candidates:
            # 没有任何 legacy，直接新建空壳
            self.stdout.write(self.style.WARNING(
                f"  no legacy and no target, create empty placeholder {target_key}"
            ))
            # v0.1.x Phase 2.5：Provider.base_url 已删；fresh deploy 时如有需要，
            # 运营在 AdminDash 给每个 Model 单独配 endpoint。
            target = LLMProvider(
                provider_key=target_key,
                name=target_name,
                display_name=target_display_name,
                capability_domains=list(target_domains),
                scope="global",
                routing_enabled=False,
                rate_limit=60,
                priority=0,
            )
            target.api_key = "<INSERT_VIA_ADMIN>"
            target.save()
            return target

        seed = candidates[0]
        self.stdout.write(
            f"  seed target from {seed.provider_key} (api_key valid: "
            f"{not (seed.api_key or '').startswith('<INSERT')})"
        )
        seed.provider_key = target_key
        seed.display_name = target_display_name
        seed.save(update_fields=["provider_key", "display_name", "updated_at"])
        return seed


    def _check_divergence(
        self,
        providers: list,
        *,
        target_key: str,
        force_merge_divergent: bool,
    ) -> None:
        """检测同组 Provider 之间是否存在 api_key 冲突。

        v0.1.x Phase 2.5：base_url 已下沉到 Model，本检查只剩 api_key 一项。
        合并后只会保留一份 api_key，如果有多份真实 key 意味着会丢数据。
        默认 abort，运营须手动决策；--force-merge-divergent 才允许继续。
        """
        if len(providers) < 2:
            return

        real_keys = {
            (p.api_key or '')
            for p in providers
            if p.api_key and not p.api_key.startswith('<INSERT')
        }

        problems: list[str] = []
        if len(real_keys) > 1:
            key_previews = sorted({(k[:6] + '...' + k[-4:]) for k in real_keys})
            problems.append(
                f"api_key 不一致（共 {len(real_keys)} 个真实 key）：{key_previews}"
            )

        if not problems:
            return

        if force_merge_divergent:
            self.stdout.write(self.style.WARNING(
                f"⚠ [{target_key}] 检测到冲突但 --force-merge-divergent 已开启："
            ))
            for p in problems:
                self.stdout.write(f"    {p}")
            self.stdout.write(
                "  非种子 Provider 的 base_url / api_key 将被丢弃，仅保留 capability_domains 的 union。"
            )
            return

        raise _DivergentConfigError(
            f"[{target_key} group] 检测到配置冲突：" + "；".join(problems) +
            "。合并会丢失非种子 Provider 的配置。"
        )


class _DryRunRollback(Exception):
    """内部信号：dry-run 完成后强制回滚事务。"""
    pass


class _DivergentConfigError(Exception):
    """检测到 base_url / api_key 不一致，需要运营手动决策。"""
    pass
