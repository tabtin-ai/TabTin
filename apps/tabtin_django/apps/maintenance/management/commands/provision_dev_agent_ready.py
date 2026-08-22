"""开发环境自动开通 Agent 所需 LLM Provider（不写钱包、不碰资金）。

从根 ``.env.local`` 读取：

- ``MOONSHOT_API_KEY`` → 全局 ``moonshot`` Provider
- ``ARK_API_KEY`` / ``VOLCENGINE_API_KEY`` → 全局 ``volcengine`` Provider

幂等写入并开启路由。可安全挂在 ``db-prepare.sh`` 启动链路。

用法：
    python manage.py provision_dev_agent_ready
"""
from __future__ import annotations

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import BaseCommand

from apps.maintenance.dev_guards import assert_dev_provision_allowed
from apps.services.llm.models import LLMCredentialDecryptionError, LLMProvider
from apps.users.membership.models import MembershipTier


class Command(BaseCommand):
    help = (
        '开发环境：补齐基线 seed，并将 MOONSHOT_API_KEY / ARK_API_KEY '
        '写入对应 Provider（幂等）。'
    )

    def handle(self, *args, **options):
        assert_dev_provision_allowed()

        self.stdout.write(self.style.MIGRATE_HEADING('=== provision_dev_agent_ready ==='))

        baseline_ran = self._ensure_baseline()
        moonshot_result = self._provision_provider(
            provider_key='moonshot',
            api_key_setting='MOONSHOT_API_KEY',
            missing_key_hint='请在仓库根 .env.local 填写 MOONSHOT_API_KEY 后重启 dev 栈。',
        )
        volcengine_result = self._provision_provider(
            provider_key='volcengine',
            api_key_setting='ARK_API_KEY',
            missing_key_hint='请在仓库根 .env.local 填写 ARK_API_KEY 后重启 dev 栈。',
        )

        self.stdout.write('')
        self.stdout.write(self.style.MIGRATE_HEADING('── 摘要 ──'))
        self.stdout.write(f'  基线补齐: {baseline_ran}')
        self.stdout.write(f'  moonshot: {moonshot_result}')
        self.stdout.write(f'  volcengine: {volcengine_result}')

        self.stdout.write('')
        self.stdout.write(self.style.MIGRATE_HEADING('── Provider 就绪性 ──'))
        call_command('check_provider_readiness', '--no-update-gauge')

    def _ensure_baseline(self) -> str:
        from apps.services.llm.models import LLMSceneBinding

        needs_tiers = not MembershipTier.objects.exists()
        needs_bindings = not LLMSceneBinding.objects.exists()
        if not needs_tiers and not needs_bindings:
            self.stdout.write(self.style.SUCCESS('✓ 基线已存在，跳过 bootstrap_fresh_db'))
            return 'skipped'

        self.stdout.write(
            self.style.WARNING(
                '▶ 基线缺失（'
                f'MembershipTier empty={needs_tiers}, '
                f'LLMSceneBinding empty={needs_bindings}），运行 bootstrap_fresh_db…'
            )
        )
        call_command('bootstrap_fresh_db')
        return 'ran bootstrap_fresh_db'

    def _provision_provider(
        self,
        *,
        provider_key: str,
        api_key_setting: str,
        missing_key_hint: str,
    ) -> str:
        api_key = (getattr(settings, api_key_setting, '') or '').strip()
        if not api_key:
            self.stdout.write(
                self.style.WARNING(f'⚠ 未配置 {api_key_setting}：{missing_key_hint}')
            )
            return 'no_key_configured'

        provider = LLMProvider.objects.filter(
            scope='global',
            provider_key=provider_key,
            organization_id__isnull=True,
            user_id__isnull=True,
        ).first()
        if provider is None:
            self.stdout.write(
                self.style.WARNING(
                    f'⚠ 未找到全局 {provider_key} Provider（migration 可能未跑完）'
                )
            )
            return 'provider_missing'

        current_key, credential_unreadable = self._read_current_api_key(provider)
        if credential_unreadable:
            self.stdout.write(
                self.style.WARNING(
                    f'⚠ {provider_key} 已有密文但无法用当前 CREDENTIAL_ENCRYPTION_KEY 解密，'
                    f'将用 {api_key_setting} 重新写入。'
                )
            )

        already_ready = (
            provider.routing_enabled
            and current_key == api_key
            and current_key
            and not current_key.startswith('<INSERT')
        )
        if already_ready:
            self.stdout.write(
                self.style.SUCCESS(
                    f'✓ {provider_key} 已就绪（相同 Key + routing 已开），跳过'
                )
            )
            return 'skipped'

        provider.api_key = api_key
        provider.routing_enabled = True
        provider.save(update_fields=['encrypted_api_key', 'routing_enabled', 'updated_at'])
        self.stdout.write(
            self.style.SUCCESS(f'✓ {provider_key} Provider 已写入 Key 并开启 routing')
        )
        return 'updated_reencrypted' if credential_unreadable else 'updated'

    @staticmethod
    def _read_current_api_key(provider: LLMProvider) -> tuple[str, bool]:
        """读取当前明文 key；旧密文不可解密时返回 ('', True) 以便 dev 命令直接覆盖。"""
        try:
            return (provider.api_key or '').strip(), False
        except LLMCredentialDecryptionError:
            return '', True
