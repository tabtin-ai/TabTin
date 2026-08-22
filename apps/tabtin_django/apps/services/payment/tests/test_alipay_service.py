from decimal import Decimal
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.payment.exceptions import PaymentException
from apps.services.payment.services.alipay_service import AlipayService


class AlipayServiceTests(SimpleTestCase):
    @patch.object(AlipayService, "_init_alipay_client", return_value=None)
    def test_rejects_unsupported_payment_type(self, _mock_init):
        service = AlipayService({
            "app_id": "app_id",
            "private_key": "private_key",
            "gateway": "https://openapi.alipay.com/gateway.do",
        })

        with self.assertRaises(PaymentException):
            service.create_payment(
                order_no="ORDER_INVALID_PAYMENT_TYPE",
                amount=Decimal("1.00"),
                subject="测试订单",
                extra_params={"payment_type": "unexpected"},
            )

    def test_cert_mode_uses_dc_alipay_certificate_strings(self):
        captured = {}

        class FakeDCAliPay:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        fake_alipay_module = types.SimpleNamespace(DCAliPay=FakeDCAliPay)

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            app_cert = tmp / "app.crt"
            alipay_cert = tmp / "alipay.crt"
            root_cert = tmp / "root.crt"
            app_cert.write_text("app-cert-content", encoding="utf-8")
            alipay_cert.write_text("alipay-cert-content", encoding="utf-8")
            root_cert.write_text("root-cert-content", encoding="utf-8")

            with patch.dict(sys.modules, {"alipay": fake_alipay_module}):
                AlipayService({
                    "app_id": "app_id",
                    "private_key": "private_key",
                    "gateway": "https://openapi.alipay.com/gateway.do",
                    "app_cert_path": str(app_cert),
                    "alipay_cert_path": str(alipay_cert),
                    "root_cert_path": str(root_cert),
                })

        self.assertEqual(captured["app_public_key_cert_string"], "app-cert-content")
        self.assertEqual(captured["alipay_public_key_cert_string"], "alipay-cert-content")
        self.assertEqual(captured["alipay_root_cert_string"], "root-cert-content")
        self.assertNotIn("app_cert_path", captured)

    def test_private_key_literal_newlines_are_normalized_before_sdk_init(self):
        captured = {}

        class FakeAliPay:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        fake_alipay_module = types.SimpleNamespace(AliPay=FakeAliPay)
        raw_key = (
            "-----BEGIN RSA PRIVATE KEY-----\\n"
            "MIIBOgIBAAJBAK0CAQAwDQYJKoZIhvcNAQEBBQADQQA=\\n"
            "-----END RSA PRIVATE KEY-----"
        )

        with patch.dict(sys.modules, {"alipay": fake_alipay_module}):
            AlipayService({
                "app_id": "app_id",
                "private_key": raw_key,
                "gateway": "https://openapi.alipay.com/gateway.do",
            })

        self.assertIn("\n", captured["app_private_key_string"])
        self.assertNotIn("\\n", captured["app_private_key_string"])

    @patch.object(AlipayService, "_init_alipay_client", return_value=None)
    def test_qr_payment_reports_precreate_forbidden(self, _mock_init):
        class FakeAlipayClient:
            def api_alipay_trade_precreate(self, **kwargs):
                return {
                    "code": "40004",
                    "msg": "Business Failed",
                    "sub_code": "ACQ.ACCESS_FORBIDDEN",
                    "sub_msg": "ACCESS_FORBIDDEN",
                }

        fake_client = FakeAlipayClient()
        service = AlipayService({
            "app_id": "app_id",
            "private_key": "private_key",
            "gateway": "https://openapi.alipay.com/gateway.do",
        })
        service.alipay = fake_client

        with self.assertRaisesRegex(PaymentException, "ACQ.ACCESS_FORBIDDEN"):
            service.create_payment(
                order_no="ORDER_QR_FORBIDDEN",
                amount=Decimal("0.10"),
                subject="测试订单",
                extra_params={"payment_type": "qr"},
            )

    @patch.object(AlipayService, "_init_alipay_client", return_value=None)
    def test_close_unpaid_order_uses_trade_close_instead_of_trade_cancel(self, _mock_init):
        class FakeAlipayClient:
            def __init__(self):
                self.closed_order_no = None

            def api_alipay_trade_close(self, **kwargs):
                self.closed_order_no = kwargs["out_trade_no"]
                return {"code": "10000"}

            def api_alipay_trade_cancel(self, **_kwargs):
                raise AssertionError("切换支付方式不得调用可能产生退款语义的 trade.cancel")

        client = FakeAlipayClient()
        service = AlipayService({
            "app_id": "app_id",
            "private_key": "private_key",
            "gateway": "https://openapi.alipay.com/gateway.do",
        })
        service.alipay = client

        self.assertTrue(service.close_unpaid_order("ORDER_TO_SWITCH"))
        self.assertEqual(client.closed_order_no, "ORDER_TO_SWITCH")

    @patch.object(AlipayService, "_init_alipay_client", return_value=None)
    def test_close_unpaid_order_treats_trade_not_exist_as_closed(self, _mock_init):
        class FakeAlipayClient:
            def api_alipay_trade_close(self, **_kwargs):
                return {
                    "code": "40004",
                    "msg": "Business Failed",
                    "sub_code": "ACQ.TRADE_NOT_EXIST",
                    "sub_msg": "交易不存在",
                }

        service = AlipayService({
            "app_id": "app_id",
            "private_key": "private_key",
            "gateway": "https://openapi.alipay.com/gateway.do",
        })
        service.alipay = FakeAlipayClient()

        self.assertTrue(service.close_unpaid_order("ORDER_PRECREATE_NOT_SCANNED"))

    @patch.object(AlipayService, "_init_alipay_client", return_value=None)
    def test_query_order_exposes_trade_not_exist_status(self, _mock_init):
        class FakeAlipayClient:
            def api_alipay_trade_query(self, **_kwargs):
                return {
                    "code": "40004",
                    "msg": "Business Failed",
                    "sub_code": "ACQ.TRADE_NOT_EXIST",
                    "sub_msg": "交易不存在",
                    "out_trade_no": "ORDER_PRECREATE_NOT_SCANNED",
                }

        service = AlipayService({
            "app_id": "app_id",
            "private_key": "private_key",
            "gateway": "https://openapi.alipay.com/gateway.do",
        })
        service.alipay = FakeAlipayClient()

        result = service.query_order("ORDER_PRECREATE_NOT_SCANNED")
        self.assertEqual(result.get("trade_status"), "TRADE_NOT_EXIST")
