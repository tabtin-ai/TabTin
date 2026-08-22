"""开发环境一键模拟充值（手动执行，多重硬校验，不挂自动启动链路）。

对余额低于 100 点券的 Organization 钱包赠送 1000 点券，走正规 ``grant_credits()`` 留流水。

用法：
    python manage.py dev_mock_recharge           # dry-run，只打印计划
    python manage.py dev_mock_recharge --yes     # 实际写库
"""
from __future__ import annotations

from decimal import Decimal

from django.core.management.base import BaseCommand

from apps.maintenance.dev_guards import assert_dev_mock_recharge_allowed
from apps.tabtinspace.models import Organization
from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService

BALANCE_THRESHOLD = Decimal('100')
GRANT_AMOUNT = Decimal('1000')
GRANT_DESCRIPTION = 'dev mock recharge'


class Command(BaseCommand):
    help = '开发环境：为低余额 Organization 钱包模拟充值（须 --yes 才写库）。'

    def add_arguments(self, parser):
        parser.add_argument(
            '--yes',
            action='store_true',
            help='确认执行充值（缺省仅 dry-run）',
        )

    def handle(self, *args, **options):
        db_info = assert_dev_mock_recharge_allowed()
        apply_changes = bool(options.get('yes'))
        wallet_svc = OrganizationWalletService()

        self.stdout.write(self.style.MIGRATE_HEADING('=== dev_mock_recharge ==='))
        self.stdout.write(
            f'  数据库: {db_info["host"]}/{db_info["name"]}  '
            f'模式: {"执行" if apply_changes else "dry-run（加 --yes 才写库）"}'
        )
        self.stdout.write('')

        organizations = Organization.objects.filter(
            status=Organization.Status.ACTIVE,
        ).order_by('created_at')
        if not organizations.exists():
            self.stdout.write(self.style.WARNING('无活跃 Organization，结束。'))
            return

        to_grant: list[tuple[Organization, Decimal]] = []
        skipped = 0
        for wt in organizations:
            wallet = wallet_svc.get_or_create_wallet(str(wt.id))
            balance = wallet.get_available_credits_precise()
            if balance >= BALANCE_THRESHOLD:
                skipped += 1
                continue
            to_grant.append((wt, balance))

        if not to_grant:
            self.stdout.write(
                self.style.SUCCESS(
                    f'✓ 全部 {organizations.count()} 个 Organization 钱包余额 ≥ {BALANCE_THRESHOLD}，跳过'
                )
            )
            return

        self.stdout.write(
            f'将充值 {len(to_grant)} 个钱包（各 +{GRANT_AMOUNT} 点券），'
            f'跳过 {skipped} 个（余额已 ≥ {BALANCE_THRESHOLD}）：'
        )
        for wt, balance in to_grant:
            self.stdout.write(
                f'  • {wt.name} ({wt.id})  当前余额={balance}'
            )

        if not apply_changes:
            self.stdout.write('')
            self.stdout.write(
                self.style.WARNING('[dry-run] 未写库。确认后执行：python manage.py dev_mock_recharge --yes')
            )
            return

        granted: list[tuple[str, str, str]] = []
        for wt, _balance in to_grant:
            tx = wallet_svc.grant_credits(
                str(wt.id),
                GRANT_AMOUNT,
                description=GRANT_DESCRIPTION,
            )
            granted.append((wt.name, str(wt.id), str(tx.id)))

        self.stdout.write('')
        self.stdout.write(self.style.SUCCESS(f'✓ 已充值 {len(granted)} 个钱包：'))
        for name, wt_id, tx_id in granted:
            self.stdout.write(f'  • {name} ({wt_id})  tx={tx_id}')

        if skipped:
            self.stdout.write(f'  跳过 {skipped} 个（余额已充足）')
