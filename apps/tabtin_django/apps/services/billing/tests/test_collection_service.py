"""
BillingCollectionService 测试

覆盖 6 个核心场景（A8）：
1. collect_invoice 正常扣款成功 — 验证钱包余额扣减、发票状态变更
2. collect_invoice 余额不足 — 验证返回正确状态、不扣款
3. collect_invoice 无钱包 — 验证异常处理
4. collect_invoice force retry — 验证忽略冷却期
5. _is_collection_cooling_down 指数退避 — 验证退避计算正确性
6. _mark_collection_failed 达到上限标记 failed — 验证状态变更和告警
"""

from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

from django.db.models.signals import post_save
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.services.billing.models import BillingInvoice, OrganizationBillingPolicy
from apps.services.billing.services.collection_service import BillingCollectionService
from apps.tabtinspace.signals import create_default_organization
from apps.users.auth.models import User
from apps.users.wallet.models import WalletTransaction, OrganizationWallet
from apps.services.billing.tests.org_test_utils import org_id_for


@override_settings(BILLING_INVOICE_COLLECTION_ENABLED=True)
class BillingCollectionServiceTests(TestCase):
    databases = {"default"}

    def setUp(self):
        post_save.disconnect(create_default_organization, sender=User)
        self.addCleanup(lambda: post_save.connect(create_default_organization, sender=User))

        self.user = User.objects.create_user(
            email="billing_collect@test.com",
            password="test-pass-123",
        )
        OrganizationBillingPolicy.objects.create(
            organization_id=org_id_for("ws_collect_001"),
            storage_billing_mode="package_plus_paygo",
            llm_billing_mode="quota_then_paygo",
            currency="CREDITS",
            is_active=True,
            metadata={"payer_user_id": str(self.user.id)},
        )
        OrganizationWallet.objects.create(
            organization_id=org_id_for("ws_collect_001"),
            credits_precise=Decimal("100.0000"),
            credits_frozen_precise=Decimal("0.0000"),
        )

    def _create_invoice(
        self,
        *,
        invoice_no: str,
        amount: Decimal,
        organization_id: str = None,
        period_start: date = date(2026, 1, 1),
        period_end: date = date(2026, 1, 31),
        status: str = "open",
    ) -> BillingInvoice:
        # 默认参数不能在类定义期调 org_id_for（DB 访问），延迟到调用时
        if organization_id is None:
            organization_id = org_id_for("ws_collect_001")
        return BillingInvoice.objects.create(
            invoice_no=invoice_no,
            organization_id=organization_id,
            period_start=period_start,
            period_end=period_end,
            status=status,
            currency="CREDITS",
            subtotal_amount=amount,
            discount_amount=Decimal("0"),
            total_amount=amount,
            metadata={},
        )

    # ── 场景 1: collect_invoice 正常扣款成功 ──────────────────────────

    def test_collect_invoice_success(self):
        """正常扣款 → 钱包余额扣减、发票 status=paid、生成 WalletTransaction"""
        invoice = self._create_invoice(invoice_no="INV-TEST-SUCCESS", amount=Decimal("3.5000"))
        result = BillingCollectionService.collect_invoice(str(invoice.id))
        invoice.refresh_from_db()
        ws_wallet = OrganizationWallet.objects.get(organization_id=org_id_for("ws_collect_001"))

        self.assertEqual(result["result"], "paid")
        self.assertEqual(result["payer_source"], "organization_wallet")
        self.assertEqual(Decimal(result["charged_amount"]), Decimal("3.5"))
        self.assertEqual(invoice.status, "paid")
        self.assertIsNotNone(invoice.paid_at)
        self.assertEqual(ws_wallet.credits_precise, Decimal("96.5000"))
        tx = WalletTransaction.objects.get(related_order_id=str(invoice.id))
        self.assertEqual(tx.amount_precise, Decimal("-3.5000"))
        self.assertEqual(str(tx.organization_wallet_id), str(ws_wallet.id))

    def test_collect_invoice_success_metadata_collection_fields(self):
        """扣款成功后 metadata.collection 包含 attempt_count/last_success_at/wallet_tx_id"""
        invoice = self._create_invoice(invoice_no="INV-META-OK", amount=Decimal("1.0000"))
        result = BillingCollectionService.collect_invoice(str(invoice.id))
        invoice.refresh_from_db()

        collection = invoice.metadata.get("collection", {})
        self.assertEqual(int(collection["attempt_count"]), 1)
        self.assertTrue(collection.get("last_success_at"))
        self.assertTrue(collection.get("last_wallet_tx_id"))
        self.assertEqual(collection["last_error"], "")
        self.assertEqual(invoice.metadata["payer_user_id"], str(self.user.id))
        self.assertEqual(result["wallet_tx_id"], collection["last_wallet_tx_id"])

    def test_collect_invoice_already_paid_skips(self):
        """已支付发票 → 返回 already_paid、不重复扣款"""
        invoice = self._create_invoice(invoice_no="INV-DUP-PAY", amount=Decimal("2.0000"))
        invoice.status = "paid"
        invoice.save(update_fields=["status"])

        result = BillingCollectionService.collect_invoice(str(invoice.id))
        self.assertEqual(result["result"], "already_paid")
        self.assertEqual(result["charged_amount"], str(Decimal("0")))

        ws_wallet = OrganizationWallet.objects.get(organization_id=org_id_for("ws_collect_001"))
        self.assertEqual(ws_wallet.credits_precise, Decimal("100.0000"))

    def test_collect_invoice_existing_wallet_tx_marks_paid_without_recharge(self):
        """已存在同 invoice 扣款流水 → 补齐 paid 状态但不重复扣款"""
        invoice = self._create_invoice(invoice_no="INV-EXISTING-TX", amount=Decimal("2.0000"))
        ws_wallet = OrganizationWallet.objects.get(organization_id=org_id_for("ws_collect_001"))
        existing_tx = WalletTransaction.objects.create(
            organization_wallet=ws_wallet,
            transaction_type="consume",
            amount=-2,
            amount_precise=Decimal("-2.0000"),
            balance_before=100,
            balance_before_precise=Decimal("100.0000"),
            balance_after=98,
            balance_after_precise=Decimal("98.0000"),
            related_order_id=str(invoice.id),
            organization_id=org_id_for("ws_collect_001"),
            operator_user_id=str(self.user.id),
            description=f"账单自动扣款：{invoice.invoice_no}",
        )

        result = BillingCollectionService.collect_invoice(str(invoice.id))

        invoice.refresh_from_db()
        ws_wallet.refresh_from_db()
        self.assertEqual(result["result"], "already_charged")
        self.assertEqual(result["wallet_tx_id"], str(existing_tx.id))
        self.assertEqual(invoice.status, "paid")
        self.assertEqual(ws_wallet.credits_precise, Decimal("100.0000"))
        self.assertEqual(
            WalletTransaction.objects.filter(related_order_id=str(invoice.id)).count(),
            1,
        )

    def test_collect_invoice_zero_amount_auto_paid(self):
        """零金额发票 → 直接标记 paid 而不扣款"""
        invoice = self._create_invoice(invoice_no="INV-ZERO", amount=Decimal("0.0000"))
        result = BillingCollectionService.collect_invoice(str(invoice.id))
        invoice.refresh_from_db()

        self.assertEqual(result["result"], "zero_amount_paid")
        self.assertEqual(invoice.status, "paid")

        ws_wallet = OrganizationWallet.objects.get(organization_id=org_id_for("ws_collect_001"))
        self.assertEqual(ws_wallet.credits_precise, Decimal("100.0000"))

    # ── 场景 2: collect_invoice 余额不足 ──────────────────────────

    def test_collect_invoice_insufficient_credits(self):
        """余额不足 → 返回失败、发票保持 open、钱包余额不变"""
        ws_wallet = OrganizationWallet.objects.get(organization_id=org_id_for("ws_collect_001"))
        ws_wallet.credits_precise = Decimal("1.0000")
        ws_wallet.save(update_fields=["credits_precise", "credits", "updated_at"])

        invoice = self._create_invoice(invoice_no="INV-TEST-FAILED", amount=Decimal("2.5000"))
        result = BillingCollectionService.collect_invoice(str(invoice.id))
        invoice.refresh_from_db()

        self.assertEqual(result["result"], "failed_insufficient_credits")
        self.assertEqual(invoice.status, "open")
        collection = (invoice.metadata or {}).get("collection") or {}
        self.assertEqual(int(collection.get("attempt_count") or 0), 1)
        self.assertTrue(collection.get("last_error"))
        self.assertEqual(collection.get("last_error_code"), "insufficient_credits")

        ws_wallet.refresh_from_db()
        self.assertEqual(ws_wallet.credits_precise, Decimal("1.0000"))

    def test_collect_invoice_insufficient_credits_no_transaction_created(self):
        """余额不足时不产生任何 WalletTransaction"""
        ws_wallet = OrganizationWallet.objects.get(organization_id=org_id_for("ws_collect_001"))
        ws_wallet.credits_precise = Decimal("0.5000")
        ws_wallet.save(update_fields=["credits_precise", "credits", "updated_at"])

        invoice = self._create_invoice(invoice_no="INV-NO-TX", amount=Decimal("10.0000"))
        BillingCollectionService.collect_invoice(str(invoice.id))

        tx_count = WalletTransaction.objects.filter(related_order_id=str(invoice.id)).count()
        self.assertEqual(tx_count, 0)

    # ── 场景 3: collect_invoice 无钱包 ──────────────────────────

    def test_collect_invoice_no_wallet(self):
        """OrganizationWallet 不存在 → result=failed_no_wallet、error_code=no_wallet"""
        OrganizationWallet.objects.filter(organization_id=org_id_for("ws_collect_001")).delete()

        invoice = self._create_invoice(invoice_no="INV-NO-WALLET", amount=Decimal("5.0000"))
        result = BillingCollectionService.collect_invoice(str(invoice.id))
        invoice.refresh_from_db()

        self.assertEqual(result["result"], "failed_no_wallet")
        self.assertEqual(invoice.status, "open")
        collection = (invoice.metadata or {}).get("collection") or {}
        self.assertEqual(collection.get("last_error_code"), "no_wallet")
        self.assertEqual(int(collection.get("attempt_count") or 0), 1)

    def test_collect_invoice_no_wallet_creates_no_transaction(self):
        """无 OrganizationWallet 时不生成扣款流水"""
        OrganizationWallet.objects.filter(organization_id=org_id_for("ws_collect_001")).delete()

        invoice = self._create_invoice(invoice_no="INV-NO-WW", amount=Decimal("3.0000"))
        BillingCollectionService.collect_invoice(str(invoice.id))

        self.assertEqual(WalletTransaction.objects.filter(related_order_id=str(invoice.id)).count(), 0)

    @patch(
        "apps.services.billing.services.collection_service.OrganizationWalletService.consume",
        side_effect=Exception("unexpected DB error"),
    )
    def test_collect_invoice_wallet_unexpected_exception(self, _mock_consume):
        """钱包扣款抛出未预期异常 → result=failed_unexpected"""
        invoice = self._create_invoice(invoice_no="INV-UNEXP", amount=Decimal("1.0000"))
        result = BillingCollectionService.collect_invoice(str(invoice.id))
        invoice.refresh_from_db()

        self.assertEqual(result["result"], "failed_unexpected")
        self.assertEqual(invoice.status, "open")
        collection = (invoice.metadata or {}).get("collection") or {}
        self.assertEqual(collection.get("last_error_code"), "unexpected_error")

    # ── 场景 4: collect_invoice force retry ──────────────────────────

    def test_force_true_retries_failed_invoice(self):
        """failed 状态 + force=True → 重新扣款成功"""
        invoice = self._create_invoice(invoice_no="INV-FORCE-001", amount=Decimal("2.0000"))
        invoice.status = "failed"
        invoice.collection_attempt_count = BillingCollectionService.MAX_COLLECTION_ATTEMPTS
        invoice.metadata = {
            "collection": {
                "attempt_count": BillingCollectionService.MAX_COLLECTION_ATTEMPTS,
                "last_error": "credits 不足",
            }
        }
        invoice.save(update_fields=["status", "collection_attempt_count", "metadata"])

        result = BillingCollectionService.collect_invoice(str(invoice.id), force=True)
        self.assertEqual(result["result"], "paid")
        invoice.refresh_from_db()
        self.assertEqual(invoice.status, "paid")

    def test_force_false_skips_failed_invoice(self):
        """failed 状态 + force=False → 直接跳过不扣款"""
        invoice = self._create_invoice(invoice_no="INV-SKIP-FAIL", amount=Decimal("2.0000"))
        invoice.status = "failed"
        invoice.save(update_fields=["status"])

        result = BillingCollectionService.collect_invoice(str(invoice.id), force=False)
        self.assertEqual(result["result"], "skipped_max_attempts")
        self.assertEqual(result["charged_amount"], str(Decimal("0")))

        ws_wallet = OrganizationWallet.objects.get(organization_id=org_id_for("ws_collect_001"))
        self.assertEqual(ws_wallet.credits_precise, Decimal("100.0000"))

    def test_force_true_retries_non_open_status(self):
        """cancelled 状态 + force=True → 仍然尝试扣款"""
        invoice = self._create_invoice(invoice_no="INV-FORCE-CANCEL", amount=Decimal("1.0000"))
        invoice.status = "cancelled"
        invoice.save(update_fields=["status"])

        result = BillingCollectionService.collect_invoice(str(invoice.id), force=True)
        self.assertEqual(result["result"], "paid")
        invoice.refresh_from_db()
        self.assertEqual(invoice.status, "paid")

    def test_force_false_skips_non_open_status(self):
        """cancelled 状态 + force=False → 跳过"""
        invoice = self._create_invoice(invoice_no="INV-SKIP-CANCEL", amount=Decimal("1.0000"))
        invoice.status = "cancelled"
        invoice.save(update_fields=["status"])

        result = BillingCollectionService.collect_invoice(str(invoice.id), force=False)
        self.assertEqual(result["result"], "skipped_status")
        self.assertEqual(result["charged_amount"], str(Decimal("0")))

    # ── 场景 5: _is_collection_cooling_down 指数退避 ──────────────────────────

    def test_cooling_down_attempt_1_within_1h(self):
        """attempt_count=1 → 冷却 1 小时；30 分钟内仍在冷却期"""
        invoice = self._create_invoice(invoice_no="INV-COOL-1A", amount=Decimal("1.0000"))
        invoice.metadata = {
            "collection": {
                "attempt_count": 1,
                "last_attempt_at": (timezone.now() - timedelta(minutes=30)).isoformat(),
            }
        }
        invoice.save(update_fields=["metadata"])
        self.assertTrue(BillingCollectionService._is_collection_cooling_down(invoice))

    def test_cooling_down_attempt_1_past_1h(self):
        """attempt_count=1 → 冷却 1 小时；2 小时后已过冷却期"""
        invoice = self._create_invoice(invoice_no="INV-COOL-1B", amount=Decimal("1.0000"))
        invoice.metadata = {
            "collection": {
                "attempt_count": 1,
                "last_attempt_at": (timezone.now() - timedelta(hours=2)).isoformat(),
            }
        }
        invoice.save(update_fields=["metadata"])
        self.assertFalse(BillingCollectionService._is_collection_cooling_down(invoice))

    def test_cooling_down_attempt_4_within_8h(self):
        """attempt_count=4 → 冷却 8 小时；5 小时内仍在冷却期"""
        invoice = self._create_invoice(invoice_no="INV-COOL-4A", amount=Decimal("1.0000"))
        invoice.metadata = {
            "collection": {
                "attempt_count": 4,
                "last_attempt_at": (timezone.now() - timedelta(hours=5)).isoformat(),
            }
        }
        invoice.save(update_fields=["metadata"])
        self.assertTrue(BillingCollectionService._is_collection_cooling_down(invoice))

    def test_cooling_down_attempt_4_past_8h(self):
        """attempt_count=4 → 冷却 8 小时；9 小时后已过冷却期"""
        invoice = self._create_invoice(invoice_no="INV-COOL-4B", amount=Decimal("1.0000"))
        invoice.metadata = {
            "collection": {
                "attempt_count": 4,
                "last_attempt_at": (timezone.now() - timedelta(hours=9)).isoformat(),
            }
        }
        invoice.save(update_fields=["metadata"])
        self.assertFalse(BillingCollectionService._is_collection_cooling_down(invoice))

    def test_cooling_down_zero_attempts_always_false(self):
        """attempt_count=0 → 不冷却（首次扣款无需等待）"""
        invoice = self._create_invoice(invoice_no="INV-COOL-0", amount=Decimal("1.0000"))
        invoice.metadata = {
            "collection": {
                "attempt_count": 0,
                "last_attempt_at": timezone.now().isoformat(),
            }
        }
        invoice.save(update_fields=["metadata"])
        self.assertFalse(BillingCollectionService._is_collection_cooling_down(invoice))

    def test_cooling_down_empty_metadata(self):
        """无 collection 元数据 → 不冷却"""
        invoice = self._create_invoice(invoice_no="INV-COOL-NONE", amount=Decimal("1.0000"))
        invoice.metadata = {}
        invoice.save(update_fields=["metadata"])
        self.assertFalse(BillingCollectionService._is_collection_cooling_down(invoice))

    def test_cooling_down_beyond_backoff_array_uses_last_value(self):
        """attempt_count 超出退避数组长度 → 使用最后一个值 72 小时"""
        invoice = self._create_invoice(invoice_no="INV-COOL-MAX", amount=Decimal("1.0000"))

        invoice.metadata = {
            "collection": {
                "attempt_count": 15,
                "last_attempt_at": (timezone.now() - timedelta(hours=50)).isoformat(),
            }
        }
        invoice.save(update_fields=["metadata"])
        self.assertTrue(BillingCollectionService._is_collection_cooling_down(invoice))

        invoice.metadata["collection"]["last_attempt_at"] = (
            timezone.now() - timedelta(hours=73)
        ).isoformat()
        invoice.save(update_fields=["metadata"])
        self.assertFalse(BillingCollectionService._is_collection_cooling_down(invoice))

    def test_cooling_down_invalid_last_attempt_at(self):
        """last_attempt_at 格式无效 → 不冷却（容错）"""
        invoice = self._create_invoice(invoice_no="INV-COOL-BAD", amount=Decimal("1.0000"))
        invoice.metadata = {
            "collection": {
                "attempt_count": 3,
                "last_attempt_at": "not-a-date",
            }
        }
        invoice.save(update_fields=["metadata"])
        self.assertFalse(BillingCollectionService._is_collection_cooling_down(invoice))

    def test_cooldown_seconds_matches_backoff_table(self):
        """_cooldown_seconds 与 _BACKOFF_HOURS 配置一致"""
        expected_hours = [1, 2, 4, 8, 24, 24, 48, 48, 72, 72]
        for i, hours in enumerate(expected_hours, start=1):
            self.assertEqual(
                BillingCollectionService._cooldown_seconds(i),
                hours * 3600,
                f"attempt_count={i} 应冷却 {hours}h",
            )

    def test_cooldown_seconds_clamps_at_last_index(self):
        """attempt_count 远大于数组长度 → 固定返回最后一项（72h）"""
        self.assertEqual(
            BillingCollectionService._cooldown_seconds(100),
            72 * 3600,
        )

    def test_cooling_down_with_explicit_now(self):
        """传入 now 参数验证时间比较正确性"""
        invoice = self._create_invoice(invoice_no="INV-COOL-NOW", amount=Decimal("1.0000"))
        fixed_now = timezone.now()
        invoice.metadata = {
            "collection": {
                "attempt_count": 2,
                "last_attempt_at": (fixed_now - timedelta(hours=1)).isoformat(),
            }
        }
        invoice.save(update_fields=["metadata"])

        self.assertTrue(
            BillingCollectionService._is_collection_cooling_down(invoice, now=fixed_now)
        )
        future_now = fixed_now + timedelta(hours=3)
        self.assertFalse(
            BillingCollectionService._is_collection_cooling_down(invoice, now=future_now)
        )

    # ── 场景 6: _mark_collection_failed 达到上限标记 failed ──────────────────

    def test_mark_collection_failed_reaches_max_status_failed(self):
        """attempt_count 达到 MAX → status 变为 failed"""
        invoice = self._create_invoice(invoice_no="INV-MARK-FAIL", amount=Decimal("1.0000"))
        max_attempts = BillingCollectionService.MAX_COLLECTION_ATTEMPTS

        invoice.metadata = {"collection": {"attempt_count": max_attempts - 1}}
        invoice.collection_attempt_count = max_attempts - 1
        invoice.save(update_fields=["metadata", "collection_attempt_count"])

        BillingCollectionService._mark_collection_failed(
            invoice,
            payer_user_id=str(self.user.id),
            error_message="test error",
            error_code="insufficient_credits",
        )
        invoice.refresh_from_db()

        self.assertEqual(invoice.status, "failed")
        self.assertEqual(invoice.collection_attempt_count, max_attempts)

    def test_mark_collection_failed_below_max_stays_open(self):
        """attempt_count 未达 MAX → status 保持 open、attempt_count 递增"""
        invoice = self._create_invoice(invoice_no="INV-MARK-OPEN", amount=Decimal("1.0000"))
        invoice.metadata = {"collection": {"attempt_count": 2}}
        invoice.collection_attempt_count = 2
        invoice.save(update_fields=["metadata", "collection_attempt_count"])

        BillingCollectionService._mark_collection_failed(
            invoice,
            payer_user_id=str(self.user.id),
            error_message="retry later",
            error_code="insufficient_credits",
        )
        invoice.refresh_from_db()

        self.assertEqual(invoice.status, "open")
        self.assertEqual(invoice.collection_attempt_count, 3)
        collection = invoice.metadata.get("collection", {})
        self.assertEqual(collection["last_error"], "retry later")
        self.assertEqual(collection["last_error_code"], "insufficient_credits")
        self.assertTrue(collection.get("last_attempt_at"))

    @patch("apps.services.billing.tasks._dispatch_billing_alert")
    def test_mark_collection_failed_max_triggers_alert(self, mock_alert):
        """达到上限时触发 _dispatch_billing_alert（collection_exhausted / error）"""
        invoice = self._create_invoice(invoice_no="INV-ALERT-FAIL", amount=Decimal("1.0000"))
        max_attempts = BillingCollectionService.MAX_COLLECTION_ATTEMPTS

        invoice.metadata = {"collection": {"attempt_count": max_attempts - 1}}
        invoice.collection_attempt_count = max_attempts - 1
        invoice.save(update_fields=["metadata", "collection_attempt_count"])

        BillingCollectionService._mark_collection_failed(
            invoice,
            payer_user_id=str(self.user.id),
            error_message="exhausted",
            error_code="insufficient_credits",
        )

        mock_alert.assert_called_once()
        args, kwargs = mock_alert.call_args
        self.assertEqual(args[0], "collection_exhausted")
        self.assertEqual(args[1], "error")
        self.assertIn(invoice.invoice_no, args[2])
        self.assertEqual(kwargs.get("organization_id"), invoice.organization_id)

    @patch("apps.services.billing.tasks._dispatch_billing_alert")
    def test_mark_collection_failed_below_max_no_alert(self, mock_alert):
        """未达上限时不触发告警"""
        invoice = self._create_invoice(invoice_no="INV-NO-ALERT", amount=Decimal("1.0000"))
        invoice.metadata = {"collection": {"attempt_count": 1}}
        invoice.collection_attempt_count = 1
        invoice.save(update_fields=["metadata", "collection_attempt_count"])

        BillingCollectionService._mark_collection_failed(
            invoice,
            payer_user_id=str(self.user.id),
            error_message="retry",
            error_code="insufficient_credits",
        )

        mock_alert.assert_not_called()

    def test_mark_collection_failed_records_payer_user_id(self):
        """_mark_collection_failed 将 payer_user_id 写入 metadata"""
        invoice = self._create_invoice(invoice_no="INV-PAYER-META", amount=Decimal("1.0000"))
        BillingCollectionService._mark_collection_failed(
            invoice,
            payer_user_id="user_123",
            error_message="err",
            error_code="test",
        )
        invoice.refresh_from_db()
        self.assertEqual(invoice.metadata.get("payer_user_id"), "user_123")

    def test_repeated_collect_until_max_then_failed(self):
        """反复扣款直到 MAX_COLLECTION_ATTEMPTS → 最终 status=failed"""
        ws_wallet = OrganizationWallet.objects.get(organization_id=org_id_for("ws_collect_001"))
        ws_wallet.credits_precise = Decimal("0.0000")
        ws_wallet.credits = 0
        ws_wallet.save(update_fields=["credits_precise", "credits", "updated_at"])

        invoice = self._create_invoice(invoice_no="INV-MAXATT-001", amount=Decimal("5.0000"))

        for _ in range(BillingCollectionService.MAX_COLLECTION_ATTEMPTS):
            BillingCollectionService.collect_invoice(str(invoice.id))
            invoice.refresh_from_db()

        self.assertEqual(invoice.status, "failed")
        self.assertEqual(
            invoice.collection_attempt_count,
            BillingCollectionService.MAX_COLLECTION_ATTEMPTS,
        )

    # ── 额外场景: 批量扣款 ──────────────────────────

    def test_collect_open_invoices_success(self):
        """批量扣款 → 两张 open 发票全部扣款成功"""
        self._create_invoice(invoice_no="INV-OPEN-001", amount=Decimal("1.0000"))
        self._create_invoice(
            invoice_no="INV-OPEN-002",
            amount=Decimal("2.0000"),
            period_start=date(2026, 2, 1),
            period_end=date(2026, 2, 28),
        )

        result = BillingCollectionService.collect_open_invoices(limit=10)
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["success"], 2)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(
            BillingInvoice.objects.filter(organization_id=org_id_for("ws_collect_001"), status="paid").count(),
            2,
        )

    def test_collect_open_invoices_counts_existing_wallet_tx_as_success(self):
        """批量扣款命中已有扣款流水时应计为成功，不误报 failed"""
        invoice = self._create_invoice(invoice_no="INV-BATCH-EXISTING-TX", amount=Decimal("1.0000"))
        ws_wallet = OrganizationWallet.objects.get(organization_id=org_id_for("ws_collect_001"))
        WalletTransaction.objects.create(
            organization_wallet=ws_wallet,
            transaction_type="consume",
            amount=-1,
            amount_precise=Decimal("-1.0000"),
            balance_before=100,
            balance_before_precise=Decimal("100.0000"),
            balance_after=99,
            balance_after_precise=Decimal("99.0000"),
            related_order_id=str(invoice.id),
            organization_id=org_id_for("ws_collect_001"),
            operator_user_id=str(self.user.id),
            description=f"账单自动扣款：{invoice.invoice_no}",
        )

        result = BillingCollectionService.collect_open_invoices(limit=10)

        self.assertEqual(result["total"], 1)
        self.assertEqual(result["success"], 1)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(result["results"][0]["result"], "already_charged")

    def test_collect_open_invoices_skips_exhausted(self):
        """collection_attempt_count ≥ MAX 的发票不参与批量扣款"""
        max_attempts = BillingCollectionService.MAX_COLLECTION_ATTEMPTS

        inv_exhausted = self._create_invoice(invoice_no="INV-EXHAUST-001", amount=Decimal("1.0000"))
        inv_exhausted.collection_attempt_count = max_attempts
        inv_exhausted.metadata = {"collection": {"attempt_count": max_attempts}}
        inv_exhausted.save(update_fields=["collection_attempt_count", "metadata"])

        self._create_invoice(
            invoice_no="INV-VALID-001",
            amount=Decimal("0.5000"),
            period_start=date(2026, 3, 1),
            period_end=date(2026, 3, 31),
        )

        result = BillingCollectionService.collect_open_invoices(limit=10)
        self.assertEqual(result["total"], 1)
        inv_exhausted.refresh_from_db()
        self.assertEqual(inv_exhausted.status, "open")
        self.assertEqual(
            BillingInvoice.objects.filter(organization_id=org_id_for("ws_collect_001"), status="paid").count(),
            1,
        )

    def test_batch_collect_skips_cancelled(self):
        """批量扣款跳过 cancelled 状态的发票"""
        inv_cancelled = self._create_invoice(invoice_no="INV-BATCH-CANCEL", amount=Decimal("1.0000"))
        inv_cancelled.status = "cancelled"
        inv_cancelled.save(update_fields=["status"])

        inv_open = self._create_invoice(
            invoice_no="INV-BATCH-OPEN",
            amount=Decimal("1.0000"),
            period_start=date(2026, 4, 1),
            period_end=date(2026, 4, 30),
        )

        result = BillingCollectionService.collect_open_invoices(limit=10)
        self.assertEqual(result["total"], 1)

        inv_cancelled.refresh_from_db()
        self.assertEqual(inv_cancelled.status, "cancelled")

        inv_open.refresh_from_db()
        self.assertEqual(inv_open.status, "paid")

    def test_batch_collect_respects_cooling_down(self):
        """批量扣款跳过仍在冷却期的发票"""
        invoice = self._create_invoice(invoice_no="INV-BATCH-COOL", amount=Decimal("1.0000"))
        invoice.metadata = {
            "collection": {
                "attempt_count": 1,
                "last_attempt_at": (timezone.now() - timedelta(minutes=10)).isoformat(),
            }
        }
        invoice.collection_attempt_count = 1
        invoice.save(update_fields=["metadata", "collection_attempt_count"])

        result = BillingCollectionService.collect_open_invoices(limit=10)
        self.assertEqual(result["total"], 0)

        invoice.refresh_from_db()
        self.assertEqual(invoice.status, "open")

    # ── 辅助方法测试 ──────────────────────────

    def test_to_decimal_none_returns_zero(self):
        self.assertEqual(BillingCollectionService._to_decimal(None), Decimal("0"))

    def test_to_decimal_string(self):
        self.assertEqual(BillingCollectionService._to_decimal("3.14"), Decimal("3.14"))

    def test_ensure_collection_metadata_initializes_fields(self):
        """_ensure_collection_metadata 为空 metadata 初始化所有 collection 字段"""
        invoice = self._create_invoice(invoice_no="INV-ENSURE-META", amount=Decimal("1.0000"))
        invoice.metadata = None
        metadata = BillingCollectionService._ensure_collection_metadata(invoice)

        collection = metadata["collection"]
        self.assertEqual(collection["attempt_count"], 0)
        self.assertIsNone(collection["last_attempt_at"])
        self.assertEqual(collection["last_error"], "")
        self.assertEqual(collection["last_error_code"], "")
        self.assertIsNone(collection["last_success_at"])
        self.assertEqual(collection["last_wallet_tx_id"], "")
