"""PR5.2-A.3 会员 PaymentOrder 三支付方式验证。

这些测试只覆盖现有订单支付入口，禁止通过客户端或测试直接修改会员状态。
"""
import json
from datetime import timedelta
from decimal import Decimal
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.test.client import RequestFactory
from django.utils import timezone

from apps.services.payment.models import PaymentOrder
from apps.services.payment.services.benefit_service import OrderBenefitService
from apps.services.payment.tasks import close_superseded_payment_order
from apps.tabtinspace.models import Organization
from apps.users.membership.api import (
    membership_alipay_pay,
    membership_payment_options,
    membership_switch_payment_method,
    membership_wallet_pay,
    membership_wechat_pay,
)
from apps.users.wallet.models import CashWalletTransaction, OrganizationCashWallet
from apps.users.wallet.services.organization_cash_wallet_service import (
    InsufficientCashBalance,
    OrganizationCashWalletService,
)


User = get_user_model()


class MembershipPaymentPr52Tests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="pr52-payment-user", email="pr52-payment-user@tabtin.test", password="!"
        )
        self.organization = Organization.objects.create(
            name="pr52-payment-org", owner=self.user, type=Organization.OrganizationType.TEAM
        )
        self.factory = RequestFactory()

    def order(self, change_type="new", amount="98.00"):
        return PaymentOrder.objects.create(
            user=self.user,
            organization_id=str(self.organization.id),
            order_type="membership",
            subject="PR5.2 套餐",
            description="payment test",
            amount=Decimal(amount),
            payment_method="organization_wallet",
            status="pending",
            expired_at=timezone.now() + timedelta(minutes=30),
            business_data={"change_type": change_type, "pricing_snapshot": {"amount": amount}},
        )

    def request(self, method="post"):
        request = getattr(self.factory, method)("/membership")
        request.auth = self.user
        return request

    def third_party(self, method, change_type="new"):
        order = self.order(change_type)
        result = {"pay_url": "https://pay.test", "qr_code": "qr", "third_party_order_no": "tp-1"}
        service = Mock()
        service.create_payment.return_value = result
        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service", return_value=service
        ):
            response = (membership_alipay_pay if method == "alipay" else membership_wechat_pay)(
                self.request(), str(order.id)
            )
        order.refresh_from_db()
        return response, order, service

    def test_new_upgrade_renewal_switch_third_party_orders_freeze_amount(self):
        for change_type in ("new", "upgrade", "renewal", "switch"):
            with self.subTest(change_type=change_type):
                _, order, service = self.third_party("alipay", change_type)
                self.assertEqual(order.status, "paying")
                self.assertIn("third_party_payment", order.business_data)
                service.create_payment.assert_called_once()
                self.assertEqual(order.amount, Decimal("98.00"))

    def test_wechat_existing_membership_order(self):
        _, order, _ = self.third_party("wechat", "upgrade")
        self.assertEqual(order.payment_method, "wechat")
        self.assertEqual(order.status, "paying")

    def test_third_party_request_is_idempotent(self):
        order = self.order()
        service = Mock()
        service.create_payment.return_value = {"pay_url": "u", "third_party_order_no": "tp-1"}
        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service", return_value=service
        ):
            membership_alipay_pay(self.request(), str(order.id))
            membership_alipay_pay(self.request(), str(order.id))
        order.refresh_from_db()
        self.assertEqual(service.create_payment.call_count, 1)
        self.assertIn("third_party_payment", order.business_data)
        self.assertEqual(order.status, "paying")

    def test_payment_options_restore_started_qr_and_lock_channel(self):
        order = self.order("new")
        service = Mock()
        service.create_payment.return_value = {
            "pay_url": "https://pay.test/alipay",
            "qr_code": "alipay-qr",
            "third_party_order_no": "tp-restore",
        }
        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=service,
        ):
            membership_alipay_pay(self.request(), str(order.id))
            order.expired_at = timezone.now() - timedelta(seconds=1)
            order.save(update_fields=["expired_at", "updated_at"])
            response = membership_payment_options(self.request("get"), str(order.id))

        payload = response["data"]
        order.refresh_from_db()
        self.assertEqual(order.status, "paying")
        self.assertEqual(payload["payment_status"], "paying")
        self.assertEqual(payload["payment_data"]["qr_code"], "alipay-qr")
        self.assertFalse(payload["allowed_actions"]["organization_wallet"])
        self.assertTrue(payload["allowed_actions"]["alipay"])
        self.assertFalse(payload["allowed_actions"]["wechat"])
        service.query_order.assert_called_once_with(order.order_no)

    def test_expired_order_does_not_create_third_party_payment(self):
        order = self.order("upgrade")
        order.expired_at = timezone.now() - timedelta(seconds=1)
        order.save(update_fields=["expired_at", "updated_at"])
        service = Mock()
        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=service,
        ):
            membership_alipay_pay(self.request(), str(order.id))

        order.refresh_from_db()
        self.assertEqual(order.status, "expired")
        service.create_payment.assert_not_called()

    def test_started_order_rejects_switching_qr_channel(self):
        order = self.order("upgrade")
        service = Mock()
        service.create_payment.return_value = {
            "pay_url": "https://pay.test/alipay",
            "third_party_order_no": "tp-locked",
        }
        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=service,
        ):
            membership_alipay_pay(self.request(), str(order.id))
            membership_wechat_pay(self.request(), str(order.id))

        order.refresh_from_db()
        self.assertEqual(order.payment_method, "alipay")
        self.assertEqual(order.status, "paying")
        self.assertEqual(service.create_payment.call_count, 1)

    def test_switching_qr_channel_closes_old_order_and_creates_replacement(self):
        order = self.order("new")
        order.payment_method = "wechat"
        order.status = "paying"
        order.business_data = {
            **order.business_data,
            "third_party_payment": {
                "order_id": str(order.id),
                "order_no": order.order_no,
                "payment_method": "wechat",
                "qr_code": "wechat-qr",
            },
        }
        order.save(update_fields=["payment_method", "status", "business_data", "updated_at"])
        service = Mock()
        service.query_order.return_value = {}
        service.close_unpaid_order.return_value = True
        service.create_payment.return_value = {
            "pay_url": "https://pay.test/alipay",
            "qr_code": "alipay-qr",
            "third_party_order_no": "tp-alipay-new",
        }

        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=service,
        ):
            response = membership_switch_payment_method(
                self.request(),
                str(order.id),
                Mock(payment_method="alipay"),
            )

        order.refresh_from_db()
        replacement = PaymentOrder.objects.exclude(id=order.id).get(order_type="membership")
        self.assertEqual(order.status, "cancelled")
        self.assertEqual(order.business_data["replacement_order_id"], str(replacement.id))
        self.assertEqual(replacement.status, "paying")
        self.assertEqual(replacement.payment_method, "alipay")
        self.assertEqual(replacement.business_data["replaces_order_id"], str(order.id))
        self.assertEqual(response["data"]["order_id"], str(replacement.id))
        self.assertEqual(response["data"]["qr_code"], "alipay-qr")
        service.close_unpaid_order.assert_called_once_with(order.order_no)

    def test_switching_qr_channel_keeps_old_order_when_close_is_unconfirmed(self):
        order = self.order("new")
        order.payment_method = "wechat"
        order.status = "paying"
        order.business_data = {
            **order.business_data,
            "third_party_payment": {
                "order_id": str(order.id),
                "order_no": order.order_no,
                "payment_method": "wechat",
                "qr_code": "wechat-qr",
            },
        }
        order.save(update_fields=["payment_method", "status", "business_data", "updated_at"])
        service = Mock()
        service.query_order.return_value = {}
        service.close_unpaid_order.return_value = False

        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=service,
        ):
            response = membership_switch_payment_method(
                self.request(),
                str(order.id),
                Mock(payment_method="alipay"),
            )

        order.refresh_from_db()
        self.assertEqual(order.status, "paying")
        self.assertEqual(PaymentOrder.objects.filter(order_type="membership").count(), 1)
        self.assertEqual(json.loads(response.content)["code"], "PAYMENT_SWITCH_UNCONFIRMED")
        service.create_payment.assert_not_called()

    def test_switching_qr_channel_recovers_when_provider_order_is_already_closed(self):
        order = self.order("new")
        order.payment_method = "wechat"
        order.status = "paying"
        order.save(update_fields=["payment_method", "status", "updated_at"])
        service = Mock()
        service.query_order.side_effect = [{}, {"trade_status": "CLOSED"}]
        service.close_unpaid_order.return_value = False
        service.create_payment.return_value = {
            "pay_url": "https://pay.test/alipay",
            "qr_code": "alipay-retry-qr",
            "third_party_order_no": "tp-alipay-retry",
        }

        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=service,
        ):
            response = membership_switch_payment_method(
                self.request(),
                str(order.id),
                Mock(payment_method="alipay"),
            )

        order.refresh_from_db()
        replacement = PaymentOrder.objects.exclude(id=order.id).get(order_type="membership")
        self.assertEqual(order.status, "cancelled")
        self.assertEqual(replacement.status, "paying")
        self.assertEqual(response["data"]["order_id"], str(replacement.id))

    def test_payment_options_allow_wallet_when_switching_from_qr(self):
        order = self.order("new", amount="98.00")
        order.payment_method = "alipay"
        order.status = "paying"
        order.save(update_fields=["payment_method", "status", "updated_at"])
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=Decimal("100.00"),
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-wallet-switch",
        )
        service = Mock()
        service.query_order.return_value = {"trade_status": "WAIT_BUYER_PAY"}
        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.tasks._sync_order_with_provider",
            return_value=order,
        ):
            response = membership_payment_options(self.request("get"), str(order.id))

        payload = response["data"]
        self.assertTrue(payload["allowed_actions"]["organization_wallet"])
        self.assertTrue(payload["allowed_actions"]["alipay"])
        self.assertFalse(payload["allowed_actions"]["wechat"])

    def test_wallet_pay_closes_qr_order_and_pays_with_balance(self):
        order = self.order("new", amount="98.00")
        order.payment_method = "wechat"
        order.status = "paying"
        order.save(update_fields=["payment_method", "status", "updated_at"])
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=Decimal("200.00"),
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-wallet-pay-switch",
        )
        service = Mock()
        service.query_order.return_value = {}
        service.close_unpaid_order.return_value = True
        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=service,
        ), patch.object(OrderBenefitService, "grant", return_value=None):
            response = membership_wallet_pay(self.request(), str(order.id))

        order.refresh_from_db()
        replacement = PaymentOrder.objects.exclude(id=order.id).get(order_type="membership")
        self.assertEqual(order.status, "cancelled")
        self.assertEqual(replacement.payment_method, "organization_wallet")
        self.assertIn(replacement.status, {"paid", "completed"})
        self.assertEqual(
            replacement.business_data["replaces_order_id"],
            str(order.id),
        )
        self.assertEqual(
            replacement.business_data["payment_chain_id"],
            order.business_data["payment_chain_id"],
        )
        self.assertEqual(
            replacement.business_data["payment_source"],
            {"method": "organization_wallet", "channel": "wallet"},
        )
        self.assertNotIn("third_party_payment", replacement.business_data)
        self.assertEqual(response["data"]["order_id"], str(replacement.id))
        service.close_unpaid_order.assert_called_once_with(order.order_no)

    def test_wallet_switch_rolls_back_local_replacement_when_balance_spend_fails(self):
        order = self.order("new", amount="98.00")
        order.payment_method = "alipay"
        order.status = "paying"
        order.save(update_fields=["payment_method", "status", "updated_at"])
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=Decimal("100.00"),
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-wallet-switch-rollback",
        )
        service = Mock()
        service.query_order.return_value = {}
        service.close_unpaid_order.return_value = True
        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=service,
        ), patch.object(
            OrganizationCashWalletService,
            "spend",
            side_effect=InsufficientCashBalance("余额已被并发消费"),
        ):
            response = membership_wallet_pay(self.request(), str(order.id))

        order.refresh_from_db()
        self.assertEqual(order.status, "paying")
        self.assertEqual(
            PaymentOrder.objects.filter(order_type="membership").count(),
            1,
        )
        self.assertEqual(
            json.loads(response.content)["code"],
            "ORGANIZATION_BALANCE_INSUFFICIENT",
        )
        service.close_unpaid_order.assert_called_once_with(order.order_no)

    def test_non_new_qr_orders_cannot_switch_to_wallet(self):
        for change_type in ("upgrade", "renewal", "switch"):
            with self.subTest(change_type=change_type):
                order = self.order(change_type, amount="98.00")
                order.payment_method = "wechat"
                order.status = "paying"
                order.save(update_fields=["payment_method", "status", "updated_at"])
                OrganizationCashWalletService().recharge(
                    organization_id=str(self.organization.id),
                    amount_cny=Decimal("100.00"),
                    operator_user_id=str(self.user.id),
                    related_order_id=f"cash-recharge-no-wallet-switch-{change_type}",
                )
                service = Mock()
                with patch(
                    "apps.services.payment.tasks._sync_order_with_provider",
                    return_value=order,
                ):
                    options = membership_payment_options(
                        self.request("get"),
                        str(order.id),
                    )
                self.assertFalse(
                    options["data"]["allowed_actions"]["organization_wallet"],
                )

                with patch(
                    "apps.users.membership.api.ensure_organization_permission",
                ), patch(
                    "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
                    return_value=service,
                ):
                    response = membership_wallet_pay(self.request(), str(order.id))

                self.assertEqual(
                    json.loads(response.content)["code"],
                    "PAYMENT_SWITCH_NOT_ALLOWED",
                )
                service.close_unpaid_order.assert_not_called()

    def test_switching_qr_channel_recovers_when_alipay_trade_not_exist(self):
        """当面付预下单未扫码时，支付宝返回 TRADE_NOT_EXIST，应允许切换到微信。"""
        order = self.order("new")
        order.payment_method = "alipay"
        order.status = "paying"
        order.save(update_fields=["payment_method", "status", "updated_at"])
        service = Mock()
        service.query_order.side_effect = [
            {"trade_status": "TRADE_NOT_EXIST"},
            {"trade_status": "TRADE_NOT_EXIST"},
        ]
        service.close_unpaid_order.return_value = False
        service.create_payment.return_value = {
            "code_url": "weixin://wxpay/bizpayurl?pr=switch-not-exist",
            "qr_code": "wechat-switch-not-exist-qr",
            "third_party_order_no": "tp-wechat-switch-not-exist",
        }

        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=service,
        ):
            response = membership_switch_payment_method(
                self.request(),
                str(order.id),
                Mock(payment_method="wechat"),
            )

        order.refresh_from_db()
        replacement = PaymentOrder.objects.exclude(id=order.id).get(order_type="membership")
        self.assertEqual(order.status, "cancelled")
        self.assertEqual(replacement.payment_method, "wechat")
        self.assertEqual(replacement.status, "paying")
        self.assertEqual(response["data"]["order_id"], str(replacement.id))

    def test_repeated_switch_request_recovers_the_same_replacement_order(self):
        order = self.order("new")
        order.payment_method = "wechat"
        order.status = "paying"
        order.save(update_fields=["payment_method", "status", "updated_at"])
        service = Mock()
        service.query_order.return_value = {}
        service.close_unpaid_order.return_value = True
        service.create_payment.return_value = {
            "pay_url": "https://pay.test/alipay",
            "qr_code": "alipay-idempotent-qr",
            "third_party_order_no": "tp-alipay-idempotent",
        }

        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=service,
        ):
            first = membership_switch_payment_method(
                self.request(),
                str(order.id),
                Mock(payment_method="alipay"),
            )
            second = membership_switch_payment_method(
                self.request(),
                str(order.id),
                Mock(payment_method="alipay"),
            )

        self.assertEqual(first["data"]["order_id"], second["data"]["order_id"])
        self.assertEqual(PaymentOrder.objects.filter(order_type="membership").count(), 2)
        service.close_unpaid_order.assert_called_once_with(order.order_no)
        service.create_payment.assert_called_once()

    def test_switch_retry_continues_pending_replacement_after_provider_create_failure(self):
        order = self.order("new")
        order.payment_method = "wechat"
        order.status = "paying"
        order.save(update_fields=["payment_method", "status", "updated_at"])
        service = Mock()
        service.query_order.return_value = {}
        service.close_unpaid_order.return_value = True
        service.create_payment.side_effect = [
            RuntimeError("temporary provider error"),
            {
                "pay_url": "https://pay.test/alipay",
                "qr_code": "alipay-recovered-qr",
                "third_party_order_no": "tp-alipay-recovered",
            },
        ]

        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=service,
        ):
            failed = membership_switch_payment_method(
                self.request(),
                str(order.id),
                Mock(payment_method="alipay"),
            )
            recovered = membership_switch_payment_method(
                self.request(),
                str(order.id),
                Mock(payment_method="alipay"),
            )

        replacement = PaymentOrder.objects.exclude(id=order.id).get(order_type="membership")
        self.assertEqual(json.loads(failed.content)["code"], "PAYMENT_CREATE_FAILED")
        self.assertEqual(recovered["data"]["order_id"], str(replacement.id))
        self.assertEqual(replacement.status, "paying")
        self.assertEqual(PaymentOrder.objects.filter(order_type="membership").count(), 2)

    def test_payment_chain_grants_benefit_only_to_first_confirmed_order(self):
        order = self.order("new")
        order.payment_method = "wechat"
        order.status = "paying"
        order.business_data = {**order.business_data, "tier_id": "tier-chain"}
        order.save(update_fields=["payment_method", "status", "business_data", "updated_at"])
        service = Mock()
        service.query_order.return_value = {}
        service.close_unpaid_order.return_value = True
        service.create_payment.return_value = {
            "qr_code": "alipay-chain-qr",
            "third_party_order_no": "tp-alipay-chain",
        }

        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=service,
        ):
            membership_switch_payment_method(
                self.request(),
                str(order.id),
                Mock(payment_method="alipay"),
            )

        order.refresh_from_db()
        replacement = PaymentOrder.objects.exclude(id=order.id).get(order_type="membership")
        order.status = "paid"
        order.paid_amount = order.amount
        order.paid_at = timezone.now()
        order.save(update_fields=["status", "paid_amount", "paid_at", "updated_at"])

        with patch(
            "apps.users.membership.services.organization_membership_service.OrganizationMembershipService.activate_membership"
        ) as activate_membership, patch(
            "apps.services.payment.tasks.close_superseded_payment_order.delay"
        ) as enqueue_close:
            with self.captureOnCommitCallbacks(execute=True):
                OrderBenefitService.grant(str(order.id))
            replacement.refresh_from_db()
            self.assertEqual(replacement.status, "cancelled")
            self.assertTrue(replacement.business_data["payment_chain_close_pending"])
            enqueue_close.assert_called_once_with(str(replacement.id))
            replacement.status = "paid"
            replacement.paid_amount = replacement.amount
            replacement.paid_at = timezone.now()
            replacement.save(update_fields=["status", "paid_amount", "paid_at", "updated_at"])
            OrderBenefitService.grant(str(replacement.id))

        replacement.refresh_from_db()
        self.assertEqual(replacement.benefit_status, "failed")
        self.assertEqual(replacement.failure_code, "DUPLICATE_PAYMENT_CHAIN")
        activate_membership.assert_called_once()

    def test_superseded_payment_close_task_clears_persistent_retry_marker(self):
        order = self.order("new")
        order.payment_method = "alipay"
        order.status = "cancelled"
        order.business_data = {
            **order.business_data,
            "payment_chain_close_pending": True,
        }
        order.save(update_fields=["payment_method", "status", "business_data", "updated_at"])
        service = Mock()
        service.close_unpaid_order.return_value = True

        with patch(
            "apps.services.payment.tasks.PaymentServiceFactory.get_service",
            return_value=service,
        ):
            result = close_superseded_payment_order.run(str(order.id))

        order.refresh_from_db()
        self.assertTrue(result["closed"])
        self.assertFalse(order.business_data["payment_chain_close_pending"])
        service.close_unpaid_order.assert_called_once_with(order.order_no)

    def test_unpaid_chain_order_cannot_claim_payment_winner(self):
        order = self.order("new")
        order.business_data = {
            **order.business_data,
            "payment_chain_id": str(order.id),
        }
        order.save(update_fields=["business_data", "updated_at"])

        self.assertIsNone(OrderBenefitService.grant(str(order.id)))
        order.refresh_from_db()
        self.assertNotIn("payment_chain_winner_order_id", order.business_data)

    def test_wallet_payment_uses_frozen_amount_and_does_not_reprice(self):
        order = self.order("upgrade", "98.00")
        OrganizationCashWallet.objects.create(organization_id=str(self.organization.id), balance_cny=Decimal("200.00"))
        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.users.membership.services.membership_payment_service.OrderBenefitService.grant"
        ):
            membership_wallet_pay(self.request(), str(order.id))
        order.refresh_from_db()
        self.assertEqual(order.status, "paid")
        self.assertEqual(order.paid_amount, Decimal("98.00"))
        self.assertEqual(CashWalletTransaction.objects.filter(related_order_id=str(order.id)).count(), 1)
