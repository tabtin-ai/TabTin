"""
支付宝支付服务

使用python-alipay-sdk实现支付宝支付功能
文档: https://github.com/fzlee/alipay
"""

import logging
import base64
import io
import uuid
import textwrap
from typing import Dict, Any, Optional
from decimal import Decimal
from datetime import datetime
from django.conf import settings

from .base import BasePaymentService, RefundResult
from ..exceptions import PaymentException, SignatureVerificationError

logger = logging.getLogger(__name__)


class AlipayService(BasePaymentService):
    """
    支付宝支付服务

    支持功能：
    - PC网站支付
    - 手机网站支付
    - 扫码支付
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        """初始化支付宝服务"""
        if config is None:
            # 从文件读取私钥
            try:
                with open(settings.ALIPAY_PRIVATE_KEY_PATH, 'r') as f:
                    private_key = f.read().strip()
            except FileNotFoundError:
                logger.error(f"支付宝私钥文件不存在: {settings.ALIPAY_PRIVATE_KEY_PATH}")
                raise PaymentException("支付宝私钥文件不存在")

            config = {
                'app_id': settings.ALIPAY_APP_ID,
                'private_key': private_key,
                'gateway': settings.ALIPAY_GATEWAY,
                'notify_url': settings.ALIPAY_NOTIFY_URL,
                'return_url': settings.ALIPAY_RETURN_URL,
                # 证书模式配置
                'app_cert_path': settings.ALIPAY_APP_CERT_PATH,
                'alipay_cert_path': settings.ALIPAY_ALIPAY_CERT_PATH,
                'root_cert_path': settings.ALIPAY_ROOT_CERT_PATH,
            }
        super().__init__(config)
        self._init_alipay_client()

    @staticmethod
    def _normalize_private_key(private_key: str) -> str:
        """Normalize common Alipay private key formats for python-alipay-sdk."""
        value = (private_key or "").strip().strip('"').strip("'")
        if "\\n" in value and "\n" not in value:
            value = value.replace("\\n", "\n")

        if "BEGIN ENCRYPTED PRIVATE KEY" in value:
            raise PaymentException("支付宝私钥不支持加密格式，请提供未加密 RSA 私钥")

        if "BEGIN RSA PRIVATE KEY" in value:
            return value

        candidates = [value]
        if "BEGIN PRIVATE KEY" in value:
            candidates = [value]
        elif "BEGIN " not in value and value:
            body = "".join(value.split())
            wrapped_body = "\n".join(textwrap.wrap(body, 64))
            candidates = [
                f"-----BEGIN RSA PRIVATE KEY-----\n{wrapped_body}\n-----END RSA PRIVATE KEY-----",
                f"-----BEGIN PRIVATE KEY-----\n{wrapped_body}\n-----END PRIVATE KEY-----",
            ]

        try:
            from cryptography.hazmat.primitives import serialization
        except ImportError:
            return candidates[0]

        for candidate in candidates:
            try:
                key = serialization.load_pem_private_key(
                    candidate.encode("utf-8"),
                    password=None,
                )
                return key.private_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PrivateFormat.TraditionalOpenSSL,
                    encryption_algorithm=serialization.NoEncryption(),
                ).decode("utf-8").strip()
            except Exception:
                continue

        return value

    @staticmethod
    def _is_sandbox_gateway(gateway: str) -> bool:
        """Match SDK debug mode to the configured Alipay gateway, not Django DEBUG."""
        value = (gateway or "").lower()
        return "alipaydev.com" in value or "sandbox" in value

    def _validate_config(self):
        """验证配置"""
        required_keys = ['app_id', 'private_key', 'gateway']
        for key in required_keys:
            if not self.config.get(key):
                raise PaymentException(f"支付宝配置缺少必要参数: {key}")

    def _init_alipay_client(self):
        """初始化支付宝客户端（证书模式）"""
        try:
            # 检查是否使用证书模式
            use_cert = all([
                self.config.get('app_cert_path'),
                self.config.get('alipay_cert_path'),
                self.config.get('root_cert_path')
            ])

            if use_cert:
                from alipay import DCAliPay

                # 证书模式
                logger.info("使用支付宝证书模式初始化")
                private_key = self._normalize_private_key(self.config['private_key'])
                self.alipay = DCAliPay(
                    appid=self.config['app_id'],
                    app_notify_url=self.config.get('notify_url'),
                    app_private_key_string=private_key,
                    app_public_key_cert_string=self._read_cert_file(
                        self.config['app_cert_path'],
                        "支付宝应用公钥证书",
                    ),
                    alipay_public_key_cert_string=self._read_cert_file(
                        self.config['alipay_cert_path'],
                        "支付宝公钥证书",
                    ),
                    alipay_root_cert_string=self._read_cert_file(
                        self.config['root_cert_path'],
                        "支付宝根证书",
                    ),
                    sign_type="RSA2",
                    debug=self._is_sandbox_gateway(self.config.get('gateway', '')),
                )
            else:
                from alipay import AliPay

                # 公钥模式（兼容旧方式）
                logger.info("使用支付宝公钥模式初始化")
                private_key = self._normalize_private_key(self.config['private_key'])
                self.alipay = AliPay(
                    appid=self.config['app_id'],
                    app_notify_url=self.config.get('notify_url'),
                    app_private_key_string=private_key,
                    alipay_public_key_string=self.config.get('public_key', ''),
                    sign_type="RSA2",
                    debug=self._is_sandbox_gateway(self.config.get('gateway', '')),
                )

            logger.info("支付宝客户端初始化成功")
        except ImportError:
            raise PaymentException(
                "未安装 python-alipay-sdk，请运行: pip install python-alipay-sdk"
            )
        except Exception as e:
            logger.error(f"支付宝客户端初始化失败: {str(e)}")
            raise PaymentException(f"支付宝客户端初始化失败: {str(e)}")

    @staticmethod
    def _read_cert_file(path: str, label: str) -> str:
        try:
            with open(path, 'r') as f:
                return f.read()
        except FileNotFoundError:
            logger.error("%s文件不存在: %s", label, path)
            raise PaymentException(f"{label}文件不存在")

    def create_payment(
        self,
        order_no: str,
        amount: Decimal,
        subject: str,
        description: str = "",
        extra_params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        创建支付宝支付订单

        支持三种支付方式：
        1. page: PC网站支付（默认）
        2. wap: 手机网站支付
        3. qr: 扫码支付
        """
        try:
            payment_type = extra_params.get('payment_type', 'page') if extra_params else 'page'
            if payment_type not in {'page', 'wap', 'qr'}:
                raise PaymentException(f"不支持的支付宝支付类型: {payment_type}")

            # 公共参数
            order_params = {
                'out_trade_no': order_no,
                'total_amount': str(amount),
                'subject': subject,
                'body': description or subject,
                'product_code': self._get_product_code(payment_type),
            }

            # 根据支付方式生成支付URL
            if payment_type == 'page':
                # PC网站支付
                pay_url = self.alipay.api_alipay_trade_page_pay(
                    **order_params,
                    return_url=self.config.get('return_url')
                )
                full_url = f"{self.config['gateway']}?{pay_url}"
            elif payment_type == 'wap':
                # 手机网站支付
                pay_url = self.alipay.api_alipay_trade_wap_pay(
                    **order_params,
                    return_url=self.config.get('return_url')
                )
                full_url = f"{self.config['gateway']}?{pay_url}"
            else:
                # 扫码支付
                result = self.alipay.api_alipay_trade_precreate(
                    **order_params
                )
                if result.get('code') == '10000':
                    full_url = result.get('qr_code')
                else:
                    error_msg = result.get('sub_msg') or result.get('msg') or '未知错误'
                    error_code = result.get('sub_code') or result.get('code') or ''
                    raise PaymentException(f"创建支付失败: [{error_code}] {error_msg}")

            logger.info(f"支付宝订单创建成功: {order_no}, 支付类型: {payment_type}")

            qr_code_value = None
            if payment_type == 'qr' and full_url:
                qr_code_value = full_url
                try:
                    import qrcode
                    qr_img = qrcode.make(full_url, box_size=8, border=2)
                    buf = io.BytesIO()
                    qr_img.save(buf, format='PNG')
                    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
                    qr_code_value = f'data:image/png;base64,{b64}'
                except Exception:
                    logger.warning(
                        "qrcode 库未安装，支付宝扫码二维码返回原始 URL，"
                        "前端需自行渲染。请运行: pip install qrcode[pil]"
                    )

            return {
                'pay_url': full_url,
                'qr_code': qr_code_value,
                'third_party_order_no': order_no,
            }

        except Exception as e:
            logger.error(f"创建支付宝订单失败: {str(e)}")
            raise PaymentException(f"创建支付宝订单失败: {str(e)}")

    def _get_product_code(self, payment_type: str) -> str:
        """获取产品码"""
        product_codes = {
            'page': 'FAST_INSTANT_TRADE_PAY',
            'wap': 'QUICK_WAP_WAY',
            'qr': 'FACE_TO_FACE_PAYMENT',
        }
        return product_codes.get(payment_type, 'FAST_INSTANT_TRADE_PAY')

    def verify_callback(self, callback_data: Dict[str, Any]) -> bool:
        """验证支付宝回调签名"""
        try:
            signature = callback_data.get('sign')
            if not signature:
                logger.warning("支付宝回调缺少签名")
                return False

            # 验证签名（不修改原数据）
            verify_data = {k: v for k, v in callback_data.items() if k not in ('sign', 'sign_type')}
            is_valid = self.alipay.verify(verify_data, signature)

            if not is_valid:
                logger.warning(
                    "支付宝回调签名验证失败: out_trade_no=%s, trade_status=%s",
                    callback_data.get('out_trade_no', 'N/A'),
                    callback_data.get('trade_status', 'N/A'),
                )

            return is_valid

        except Exception as e:
            logger.error(f"支付宝回调验证异常: {str(e)}")
            return False

    def parse_callback(self, callback_data: Dict[str, Any]) -> Dict[str, Any]:
        """解析支付宝回调数据"""
        try:
            return {
                'order_no': callback_data.get('out_trade_no'),
                'third_party_trade_no': callback_data.get('trade_no'),
                'paid_amount': Decimal(callback_data.get('total_amount', '0')),
                'trade_status': callback_data.get('trade_status'),
                'paid_at': self._parse_paid_at(callback_data.get('gmt_payment', '')),
            }
        except Exception as e:
            logger.error(f"解析支付宝回调数据失败: {str(e)}")
            raise PaymentException(f"解析支付宝回调数据失败: {str(e)}")

    def _parse_paid_at(self, gmt_payment: str):
        """解析支付宝支付时间为 aware datetime，异常时回退为当前时间"""
        from django.utils import timezone as dj_tz
        import zoneinfo

        if not gmt_payment:
            return dj_tz.now()
        try:
            naive = datetime.strptime(gmt_payment, '%Y-%m-%d %H:%M:%S')
            return dj_tz.make_aware(naive, timezone=zoneinfo.ZoneInfo('Asia/Shanghai'))
        except (ValueError, Exception) as e:
            logger.warning(f"解析支付时间失败: {gmt_payment}, 错误: {e}")
            return dj_tz.now()

    def query_order(self, order_no: str) -> Dict[str, Any]:
        """查询支付宝订单状态"""
        try:
            result = self.alipay.api_alipay_trade_query(out_trade_no=order_no)

            if result.get('code') == '10000':
                return {
                    'order_no': result.get('out_trade_no'),
                    'third_party_trade_no': result.get('trade_no'),
                    'trade_status': result.get('trade_status'),
                    'total_amount': Decimal(result.get('total_amount', '0')),
                }

            sub_code = str(result.get('sub_code') or '')
            # 当面付预下单：用户未扫码唤起收银台前，支付宝侧尚无正式交易。
            if sub_code == 'ACQ.TRADE_NOT_EXIST':
                return {
                    'order_no': order_no,
                    'trade_status': 'TRADE_NOT_EXIST',
                    'total_amount': Decimal('0'),
                }

            logger.warning(
                "查询支付宝订单失败: order_no=%s code=%s sub_code=%s msg=%s",
                order_no,
                result.get('code'),
                sub_code,
                result.get('sub_msg') or result.get('msg'),
            )
            return {}

        except Exception as e:
            logger.error(f"查询支付宝订单异常: {str(e)}")
            return {}

    def cancel_order(self, order_no: str) -> bool:
        """取消支付宝订单"""
        try:
            result = self.alipay.api_alipay_trade_cancel(out_trade_no=order_no)

            if result.get('code') == '10000':
                logger.info(f"取消支付宝订单成功: {order_no}")
                return True
            else:
                logger.warning(f"取消支付宝订单失败: {result.get('msg')}")
                return False

        except Exception as e:
            logger.error(f"取消支付宝订单异常: {str(e)}")
            return False

    def close_unpaid_order(self, order_no: str) -> bool:
        """关闭未支付交易，避免 trade.cancel 对已支付交易产生退款语义。"""
        try:
            result = self.alipay.api_alipay_trade_close(out_trade_no=order_no)
            if result.get('code') == '10000':
                logger.info(f"关闭支付宝未支付订单成功: {order_no}")
                return True

            sub_code = str(result.get('sub_code') or '')
            # 当面付预下单生成二维码后，用户未扫码前交易可能尚未创建。
            # 此时 close/query 都会返回 TRADE_NOT_EXIST，原二维码无法形成可支付交易，
            # 切换支付渠道时可以安全视为已关闭。
            if sub_code in {'ACQ.TRADE_NOT_EXIST', 'ACQ.TRADE_HAS_CLOSE'}:
                logger.info(
                    "关闭支付宝未支付订单：%s，视为已关闭 order_no=%s",
                    sub_code,
                    order_no,
                )
                return True

            logger.warning(
                "关闭支付宝未支付订单失败: order_no=%s code=%s sub_code=%s msg=%s",
                order_no,
                result.get('code'),
                sub_code,
                result.get('sub_msg') or result.get('msg'),
            )
            return False
        except Exception as e:
            logger.error(f"关闭支付宝未支付订单异常: {str(e)}")
            return False

    def refund(
        self,
        order_no: str,
        refund_amount: Decimal,
        total_amount: Decimal,
        refund_reason: str = "",
        refund_no: Optional[str] = None,
        transaction_id: Optional[str] = None,
    ) -> RefundResult:
        """
        支付宝退款（同步接口，D10 决策）

        调用 alipay.trade.refund，同步返回退款结果，无需异步回调。
        支付宝退款是同步的：调用成功 → 资金即时到账，不需要回调通知。
        同一笔交易可多次退款，但累计退款金额不能超过原支付金额。

        Args:
            order_no: 商户订单号（out_trade_no）
            refund_amount: 退款金额（元），不能超过原支付金额
            total_amount: 原订单总金额（元），用于校验
            refund_reason: 退款原因
            refund_no: 商户退款单号（out_request_no），全额退款可不传
            transaction_id: 支付宝交易号（trade_no），优先使用
        """
        if not order_no and not transaction_id:
            raise PaymentException("order_no 和 transaction_id 至少需要一个")

        if refund_amount <= 0:
            raise PaymentException("退款金额必须大于 0")

        if refund_amount > total_amount:
            raise PaymentException(
                f"退款金额 {refund_amount} 超过原订单金额 {total_amount}"
            )

        out_request_no = refund_no or order_no or str(uuid.uuid4().hex[:24])

        try:
            kwargs: Dict[str, Any] = {
                "refund_amount": str(refund_amount),
                "out_request_no": out_request_no,
            }
            if order_no:
                kwargs["out_trade_no"] = order_no
            if transaction_id:
                kwargs["trade_no"] = transaction_id
            if refund_reason:
                kwargs["refund_reason"] = refund_reason

            logger.info(
                "发起支付宝退款: out_trade_no=%s trade_no=%s amount=%s reason=%s",
                order_no, transaction_id, refund_amount, refund_reason,
            )

            result = self.alipay.api_alipay_trade_refund(**kwargs)

            success = result.get("code") == "10000"

            if success:
                logger.info(
                    "支付宝退款成功: out_trade_no=%s trade_no=%s amount=%s fund_change=%s",
                    result.get("out_trade_no", order_no),
                    result.get("trade_no", ""),
                    result.get("refund_fee", refund_amount),
                    result.get("fund_change", ""),
                )
                return RefundResult(
                    success=True,
                    refund_id=out_request_no,
                    status="refunded",
                    raw_response=result,
                )

            error_msg = result.get("sub_msg") or result.get("msg") or "未知错误"
            logger.warning(
                "支付宝退款失败: out_trade_no=%s code=%s sub_code=%s msg=%s",
                order_no,
                result.get("code"),
                result.get("sub_code"),
                error_msg,
            )
            return RefundResult(
                success=False,
                refund_id=out_request_no,
                status="failed",
                error_message=f"[{result.get('sub_code', result.get('code'))}] {error_msg}",
                raw_response=result,
            )

        except PaymentException:
            raise
        except Exception as e:
            logger.error(
                "支付宝退款异常: out_trade_no=%s trade_no=%s err=%s",
                order_no, transaction_id, e, exc_info=True,
            )
            raise PaymentException(f"支付宝退款请求失败: {e}")

    def query_refund(
        self,
        out_request_no: str,
        out_trade_no: str = "",
        trade_no: str = "",
    ) -> Dict[str, Any]:
        """
        查询退款结果

        调用 alipay.trade.fastpay.refund.query，用于确认退款是否到账。

        Args:
            out_request_no: 退款请求号（refund 时传入的 out_request_no）
            out_trade_no: 商户订单号（与 trade_no 至少传一个）
            trade_no: 支付宝交易号

        Returns:
            {
                'success': bool,
                'refund_amount': Decimal,
                'out_trade_no': str,
                'trade_no': str,
                'out_request_no': str,
                'error_code': str,
                'error_msg': str,
            }
        """
        if not out_trade_no and not trade_no:
            raise PaymentException("out_trade_no 和 trade_no 至少需要一个")

        try:
            kwargs: Dict[str, Any] = {}
            if out_trade_no:
                kwargs["out_trade_no"] = out_trade_no
            if trade_no:
                kwargs["trade_no"] = trade_no

            result = self.alipay.api_alipay_trade_fastpay_refund_query(
                out_request_no, **kwargs
            )

            success = result.get("code") == "10000"

            return {
                "success": success,
                "refund_amount": Decimal(result["refund_amount"]) if result.get("refund_amount") else Decimal("0"),
                "out_trade_no": result.get("out_trade_no", out_trade_no),
                "trade_no": result.get("trade_no", trade_no),
                "out_request_no": result.get("out_request_no", out_request_no),
                "error_code": result.get("sub_code", ""),
                "error_msg": result.get("sub_msg", result.get("msg", "")),
            }

        except Exception as e:
            logger.error(
                "查询支付宝退款异常: out_request_no=%s out_trade_no=%s err=%s",
                out_request_no, out_trade_no, e, exc_info=True,
            )
            raise PaymentException(f"查询支付宝退款失败: {e}")

    def get_callback_response(self, success: bool = True) -> str:
        """支付宝回调响应"""
        return "success" if success else "fail"
