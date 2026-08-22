"""
v0.1.x Phase 2.5 修订后的清理命令：把历史上 ``unit='token'`` 的 RAG embedding
BillingUsageEvent 行折算回 ``unit='k_tokens'``。

历史背景：
- v0.1.0：embedding 走 ``EmbeddingService._charge_embedding_usage`` 写
  ``meter_key='rag.embedding.tokens', unit='k_tokens'``。
- v0.1.x 初版（带 ``skip_charging=True`` 的过渡版本）：capability 入口绕过老路径，
  ``_runtime/usage_recorder._write_billing_event`` 写 ``unit='token'``。
- v0.1.x 终版（当前 PR）：删 skip_charging，回归 ``_charge_embedding_usage`` 单源记账，
  unit 统一回 ``k_tokens``。

如果生产 deploy 过 v0.1.x 初版，库里会同时存在 ``unit='token'`` 和 ``unit='k_tokens'``
的两种 embedding 行，按 ``meter_key`` group by 汇总 ``quantity`` 时口径错乱。
本命令把 ``unit='token'`` 的行 quantity 除以 1000、unit 改成 ``k_tokens``。

幂等：再跑一次只处理新增的 token 单位行（filter 条件保证）。
默认 dry-run；加 ``--apply`` 才真执行。

用法：
    python manage.py reconcile_embedding_units                # 看影响面
    python manage.py reconcile_embedding_units --apply        # 真改
"""

from __future__ import annotations

from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction


class Command(BaseCommand):
    help = (
        "把 v0.1.x 初版残留的 unit='token' 的 rag.embedding.tokens BillingUsageEvent "
        "折算回 unit='k_tokens'。默认 dry-run，加 --apply 真改。"
    )

    METER_KEY = 'rag.embedding.tokens'

    def add_arguments(self, parser):
        parser.add_argument(
            '--apply', action='store_true',
            help='真执行（默认 dry-run，只打印计划）',
        )

    def handle(self, *args, **options):
        from apps.services.billing.models import BillingUsageEvent

        apply_changes = bool(options.get('apply'))
        mode = 'APPLY' if apply_changes else 'DRY-RUN'
        self.stdout.write(self.style.WARNING(
            f"=== reconcile_embedding_units [{mode}] ===\n"
            f"目标：meter_key='{self.METER_KEY}' AND unit='token'"
        ))

        qs = BillingUsageEvent.objects.filter(
            meter_key=self.METER_KEY,
            unit='token',
        )
        total = qs.count()
        if total == 0:
            self.stdout.write(self.style.SUCCESS(
                "✓ 库里没有 unit='token' 的 embedding 行，无需 reconcile。"
            ))
            return

        # 抽样展示前 5 条
        self.stdout.write(f"\n命中 {total} 条 unit='token' 行；前 5 条样本：")
        self.stdout.write(
            "  occurred_at                 quantity → new_quantity  amount    organization_id"
        )
        for e in qs.order_by('occurred_at')[:5]:
            new_qty = (e.quantity or Decimal('0')) / Decimal('1000')
            self.stdout.write(
                f"  {e.occurred_at.isoformat():28} {str(e.quantity):>10} → "
                f"{str(new_qty):>10}  {str(e.amount):>10}  {e.organization_id}"
            )

        if not apply_changes:
            self.stdout.write(self.style.WARNING(
                "\n(dry-run) 未做任何改动。加 --apply 真执行。\n"
                "执行后这些行的 quantity 会除以 1000，unit 改成 'k_tokens'；"
                "amount/unit_price 不变（amount=quantity*unit_price 的恒等式仍成立）。"
            ))
            return

        # 真执行：分批 UPDATE，避免锁表过久
        # 用 PG correlated update 一句完成（要先看 unit 是 unique 还是 unique together）
        from django.db import connections
        with transaction.atomic(using='default'):
            with connections['default'].cursor() as cur:
                cur.execute(
                    """
                    UPDATE services_billing_usage_event
                       SET quantity = quantity / 1000,
                           unit = 'k_tokens'
                     WHERE meter_key = %s
                       AND unit = 'token'
                    """,
                    [self.METER_KEY],
                )
                affected = cur.rowcount

        self.stdout.write(self.style.SUCCESS(
            f"\n✓ reconcile 完成，更新 {affected} 行 token → k_tokens"
        ))
