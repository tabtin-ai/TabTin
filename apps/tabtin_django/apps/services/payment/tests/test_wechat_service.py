import sys
import types
from decimal import Decimal
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.payment.exceptions import PaymentException
from apps.services.payment.services.wechat_service import WechatPayService


class WechatPayServiceTests(SimpleTestCase):
    def test_init_passes_platform_certificate_options_to_sdk(self):
        captured = {}
        fake_type = types.SimpleNamespace(NATIVE="native")

        class FakeWeChatPay:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        fake_wechat_module = types.SimpleNamespace(
            WeChatPay=FakeWeChatPay,
            WeChatPayType=fake_type,
        )

        with patch.dict(sys.modules, {"wechatpayv3": fake_wechat_module}):
            WechatPayService({
                "app_id": "wx_app",
                "mch_id": "mch_id",
                "private_key": "private_key",
                "cert_serial_no": "cert_serial_no",
                "apiv3_key": "apiv3_key",
                "notify_url": "https://example.com/callback",
                "platform_cert_dir": "/etc/tabtin/payment/wechat-platform",
                "platform_public_key": "public_key",
                "platform_public_key_id": "PUB_KEY_ID_xxx",
            })

        self.assertEqual(captured["cert_dir"], "/etc/tabtin/payment/wechat-platform")
        self.assertEqual(captured["public_key"], "public_key")
        self.assertEqual(captured["public_key_id"], "PUB_KEY_ID_xxx")

    def test_requires_platform_public_key_id_when_public_key_is_configured(self):
        with self.assertRaises(PaymentException):
            WechatPayService({
                "app_id": "wx_app",
                "mch_id": "mch_id",
                "private_key": "private_key",
                "cert_serial_no": "cert_serial_no",
                "apiv3_key": "apiv3_key",
                "platform_public_key": "public_key",
            })

    def test_create_native_payment_accepts_json_string_result(self):
        fake_type = types.SimpleNamespace(NATIVE="native")

        class FakeWeChatPay:
            def __init__(self, **kwargs):
                pass

            def pay(self, **kwargs):
                return 200, '{"code_url": "weixin://wxpay/bizpayurl?pr=test"}'

        fake_wechat_module = types.SimpleNamespace(
            WeChatPay=FakeWeChatPay,
            WeChatPayType=fake_type,
        )

        with patch.dict(sys.modules, {"wechatpayv3": fake_wechat_module}):
            service = WechatPayService({
                "app_id": "wx_app",
                "mch_id": "mch_id",
                "private_key": "private_key",
                "cert_serial_no": "cert_serial_no",
                "apiv3_key": "apiv3_key",
            })

        result = service.create_payment(
            order_no="ORDER_WECHAT_JSON_STRING",
            amount=Decimal("1.00"),
            subject="测试订单",
        )

        self.assertEqual(result["pay_url"], "weixin://wxpay/bizpayurl?pr=test")

    def test_create_native_payment_reports_string_error_result(self):
        fake_type = types.SimpleNamespace(NATIVE="native")

        class FakeWeChatPay:
            def __init__(self, **kwargs):
                pass

            def pay(self, **kwargs):
                return 400, "INVALID_REQUEST"

        fake_wechat_module = types.SimpleNamespace(
            WeChatPay=FakeWeChatPay,
            WeChatPayType=fake_type,
        )

        with patch.dict(sys.modules, {"wechatpayv3": fake_wechat_module}):
            service = WechatPayService({
                "app_id": "wx_app",
                "mch_id": "mch_id",
                "private_key": "private_key",
                "cert_serial_no": "cert_serial_no",
                "apiv3_key": "apiv3_key",
            })

        with self.assertRaisesMessage(PaymentException, "INVALID_REQUEST"):
            service.create_payment(
                order_no="ORDER_WECHAT_STRING_ERROR",
                amount=Decimal("1.00"),
                subject="测试订单",
            )
