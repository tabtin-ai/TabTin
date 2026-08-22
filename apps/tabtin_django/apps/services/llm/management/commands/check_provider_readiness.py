"""
盘点所有 routing_enabled=True 的 (provider, model)，按 readiness 状态分类，
写 Prometheus Gauge ``llm_provider_readiness_state{reason=...}``，
让运营 Grafana dashboard 实时看到"当前有多少配置不就绪、原因是什么"。

—— 与 `model_resolver._check_provider_readiness` 同源逻辑，但
   - 这里是**周期盘点**（cron / Celery beat），不在请求热路径
   - Counter 是流量驱动（有调用才计数），Gauge 是真值（不依赖流量）

使用：
    # 单次输出 + 写 Gauge（默认）
    python manage.py check_provider_readiness

    # JSON 输出明细（不写 Gauge），用于 CI/审计
    python manage.py check_provider_readiness --format=json --no-update-gauge

    # 周期挂 cron / celery-beat（推荐每 60-300s 一次）
    */5 * * * * cd /app && python manage.py check_provider_readiness >> /var/log/readiness.log

告警建议（PromQL）：
    # 任何 routing 关闭的 provider（运营忘了打开）
    llm_provider_readiness_state{reason="routing_disabled"} > 0

    # 任何 placeholder api_key（部署后忘了填）
    llm_provider_readiness_state{reason="placeholder_api_key"} > 0

    # 任何密钥不可解密（缺失/错误的 CREDENTIAL_ENCRYPTION_KEY）
    llm_provider_readiness_state{reason="credential_decryption_failed"} > 0

    # 任何空 base_url（migration 后没补 endpoint）
    llm_provider_readiness_state{reason="empty_base_url"} > 0
"""
from __future__ import annotations

import json
from typing import Counter as TypingCounter

from django.core.management.base import BaseCommand


READINESS_REASONS = (
    'ready',
    'routing_disabled',
    'placeholder_api_key',
    'credential_decryption_failed',
    'empty_base_url',
    'capability_mismatch',
    'no_models',
)


class Command(BaseCommand):
    help = '盘点所有 routing_enabled=True provider 的 readiness 状态并写 Prometheus Gauge'

    def add_arguments(self, parser):
        parser.add_argument(
            '--format',
            choices=('text', 'json'),
            default='text',
            help='输出格式（默认 text）',
        )
        parser.add_argument(
            '--no-update-gauge',
            action='store_true',
            help='只输出报告，不写 Prometheus Gauge（CI / 一次性审计场景）',
        )

    def handle(self, *args, **options):
        from apps.services.llm.models import (
            LLMCredentialDecryptionError,
            LLMSceneBinding,
            LLMProvider,
            LLMModel,
        )
        from apps.services.llm.services._runtime.model_resolver import resolve_model

        counts: TypingCounter[str] = TypingCounter()
        details: list[dict] = []
        scene_details: list[dict] = []

        def _provider_model_reason(provider, model) -> str:
            if provider is None or model is None:
                return 'missing_primary_model'
            if not provider.routing_enabled:
                return 'routing_disabled'
            try:
                api_key = (provider.api_key or '').strip()
            except LLMCredentialDecryptionError:
                return 'credential_decryption_failed'
            if (not api_key) or api_key.startswith('<INSERT'):
                return 'placeholder_api_key'
            if not (model.base_url or '').strip():
                return 'empty_base_url'
            provider_caps = list(provider.capability_domains or [])
            if model.capability_domain and provider_caps and model.capability_domain not in provider_caps:
                return 'capability_mismatch'
            return 'ready'

        # 包含所有 routing_enabled 的 provider，按 (provider, model) 维度盘点
        providers = LLMProvider.objects.filter(routing_enabled=True).prefetch_related(
            'models'
        )

        for provider in providers:
            credential_decryption_failed = False
            try:
                api_key = (provider.api_key or '').strip()
            except LLMCredentialDecryptionError:
                credential_decryption_failed = True
                api_key = ''
            api_key_bad = (not api_key) or api_key.startswith('<INSERT')
            provider_caps = list(provider.capability_domains or [])

            models = list(provider.models.all())
            if not models:
                # provider 配了但没绑 model，照样算配置不全
                counts['no_models'] += 1
                details.append({
                    'provider': provider.provider_key,
                    'model': None,
                    'reason': 'no_models',
                    'capability_domains': provider_caps,
                })
                continue

            for model in models:
                if credential_decryption_failed:
                    reason = 'credential_decryption_failed'
                elif api_key_bad:
                    reason = 'placeholder_api_key'
                elif not (model.base_url or '').strip():
                    reason = 'empty_base_url'
                elif (
                    model.capability_domain
                    and provider_caps
                    and model.capability_domain not in provider_caps
                ):
                    reason = 'capability_mismatch'
                else:
                    reason = 'ready'

                counts[reason] += 1
                if reason != 'ready':
                    details.append({
                        'provider': provider.provider_key,
                        'model': model.model_name,
                        'capability_domain': model.capability_domain,
                        'provider_capability_domains': provider_caps,
                        'reason': reason,
                    })

        # routing_disabled 是 provider 维度而不是 model 维度，单独再统计一下
        disabled_count = LLMProvider.objects.filter(routing_enabled=False).count()
        counts['routing_disabled'] = disabled_count

        for binding in LLMSceneBinding.objects.select_related(
            'primary_model',
            'primary_model__provider',
        ).all():
            model = binding.primary_model
            provider = model.provider if model else None
            try:
                resolve_model(
                    scene_key=binding.scene_key,
                    capability_domain=binding.capability_domain,
                    capability_requirements=binding.capability_requirements,
                )
                continue
            except Exception as exc:
                reason = _provider_model_reason(provider, model)
                if reason == 'ready':
                    reason = exc.__class__.__name__
            scene_details.append({
                'scene_key': binding.scene_key,
                'capability_domain': binding.capability_domain,
                'model': getattr(model, 'model_name', None),
                'provider': getattr(provider, 'provider_key', None),
                'reason': reason,
            })

        # 写 Gauge
        if not options['no_update_gauge']:
            try:
                from apps.services.llm.services.llm_metrics import (
                    llm_provider_readiness_state,
                )
                # 每个 reason 都 set 一次，包括 0（确保 metric 存在便于告警）
                for reason in READINESS_REASONS:
                    llm_provider_readiness_state.labels(reason=reason).set(
                        counts.get(reason, 0)
                    )
            except Exception as exc:  # pragma: no cover
                self.stderr.write(self.style.WARNING(f'写 Gauge 失败: {exc}'))

        # 输出
        if options['format'] == 'json':
            self.stdout.write(json.dumps({
                'counts': dict(counts),
                'unready_details': details,
                'unready_scene_bindings': scene_details,
            }, ensure_ascii=False, indent=2))
        else:
            self.stdout.write(self.style.SUCCESS('=== Provider Readiness 盘点 ==='))
            for reason in READINESS_REASONS:
                count = counts.get(reason, 0)
                style = self.style.SUCCESS if reason == 'ready' else (
                    self.style.WARNING if count > 0 else self.style.SUCCESS
                )
                self.stdout.write(style(f'  {reason:25s} {count}'))

            if details:
                self.stdout.write('')
                self.stdout.write(self.style.WARNING('=== 未就绪明细 ==='))
                for d in details:
                    self.stdout.write(
                        f"  [{d['reason']}] provider={d['provider']} "
                        f"model={d.get('model') or '(无)'}"
                    )
                self.stdout.write('')
                self.stdout.write(
                    self.style.WARNING(
                        '修复入口：AdminDash → /ai/providers 或 /ai/models'
                    )
                )
            else:
                self.stdout.write('')
                self.stdout.write(self.style.SUCCESS('全部 provider/model 已就绪 ✓'))
            if scene_details:
                self.stdout.write('')
                self.stdout.write(self.style.WARNING('=== 未就绪 SceneBinding ==='))
                for d in scene_details:
                    self.stdout.write(
                        f"  [{d['reason']}] scene={d['scene_key']} "
                        f"provider={d.get('provider') or '(无)'} "
                        f"model={d.get('model') or '(无)'}"
                    )
