"""
微信支付服务

使用wechatpayv3实现微信支付功能
文档: https://github.com/wechatpay-apiv3/wechatpay-python
"""

import logging
import base64
import io
import json
import zoneinfo
from typing import Dict, Any, Optional
from decimal import Decimal
from datetime import datetime, timedelta
from django.conf import settings
from django.utils import timezone as dj_tz

from .base import BasePaymentService, RefundResult
from ..exceptions import PaymentException, SignatureVerificationError

logger = logging.getLogger(__name__)


class WechatPayService(BasePaymentService):
    """
    微信支付服务

    支持功能：
    - Native支付（扫码支付）
    - JSAPI支付（公众号/小程序）
    - H5支付（手机网站）
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        """初始化微信支付服务"""
        if config is None:
            # 从文件读取私钥
            try:
                with open(settings.WECHAT_PRIVATE_KEY_PATH, 'r') as f:
                    private_key = f.read()
            except FileNotFoundError:
                logger.error(f"微信支付私钥文件不存在: {settings.WECHAT_PRIVATE_KEY_PATH}")
                raise PaymentException("微信支付私钥文件不存在")

            platform_public_key = ""
            if settings.WECHAT_PLATFORM_PUBLIC_KEY_PATH:
                try:
                    with open(settings.WECHAT_PLATFORM_PUBLIC_KEY_PATH, 'r') as f:
                        platform_public_key = f.read()
                except FileNotFoundError:
                    logger.error("微信支付平台公钥文件不存在: %s", settings.WECHAT_PLATFORM_PUBLIC_KEY_PATH)
                    raise PaymentException("微信支付平台公钥文件不存在")

            config = {
                'app_id': settings.WECHAT_APP_ID,
                'mch_id': settings.WECHAT_MCH_ID,
                'private_key': private_key,
                'cert_serial_no': settings.WECHAT_CERT_SERIAL_NO,
                'apiv3_key': settings.WECHAT_APIV3_KEY,
                'notify_url': settings.WECHAT_NOTIFY_URL,
                'platform_cert_dir': settings.WECHAT_PLATFORM_CERT_DIR,
                'platform_public_key': platform_public_key,
                'platform_public_key_id': settings.WECHAT_PLATFORM_PUBLIC_KEY_ID,
            }
        super().__init__(config)
        self._init_wechat_client()

    def _validate_config(self):
        """验证配置"""
        required_keys = ['app_id', 'mch_id', 'private_key', 'cert_serial_no', 'apiv3_key']
        for key in required_keys:
            if not self.config.get(key):
                raise PaymentException(f"微信支付配置缺少必要参数: {key}")
        has_public_key = bool(self.config.get('platform_public_key'))
        has_public_key_id = bool(self.config.get('platform_public_key_id'))
        if has_public_key != has_public_key_id:
            raise PaymentException("微信支付平台公钥和公钥 ID 必须同时配置")

    def _init_wechat_client(self):
        """初始化微信支付客户端"""
        try:
            from wechatpayv3 import WeChatPay, WeChatPayType

            # PAY-21: wechatpayv3 SDK 的 wechatpay_type 参数用于控制底层 URL 路由
            # (NATIVE/JSAPI/H5 对应不同的 API 端点前缀)。实际支付类型由 pay() 的
            # pay_type 参数决定，此处初始化为 NATIVE 是因为工厂为单例，后续所有下单
            # 调用均通过 pay_type 参数覆盖。
            # TODO [PAY-21]: 如 SDK 版本升级后 wechatpay_type 影响到实例方法行为，
            # 应改为每种支付类型创建独立实例（NATIVE/JSAPI/H5 各一个）。
            self.wechat_pay = WeChatPay(
                wechatpay_type=WeChatPayType.NATIVE,
                mchid=self.config['mch_id'],
                private_key=self.config['private_key'],
                cert_serial_no=self.config['cert_serial_no'],
                apiv3_key=self.config['apiv3_key'],
                appid=self.config['app_id'],
                notify_url=self.config.get('notify_url', ''),
                cert_dir=self.config.get('platform_cert_dir') or None,
                public_key=self.config.get('platform_public_key') or None,
                public_key_id=self.config.get('platform_public_key_id') or None,
            )
            logger.info("微信支付客户端初始化成功")
        except ImportError:
            raise PaymentException(
                "未安装 wechatpayv3，请运行: pip install wechatpayv3"
            )
        except Exception as e:
            logger.error(f"微信支付客户端初始化失败: {str(e)}")
            raise PaymentException(f"微信支付客户端初始化失败: {str(e)}")

    @staticmethod
    def _normalize_sdk_result(result: Any) -> Dict[str, Any]:
        """wechatpayv3 may return either a dict or a JSON string."""
        if isinstance(result, dict):
            return result
        if isinstance(result, str):
            try:
                parsed = json.loads(result)
            except json.JSONDecodeError:
                return {"message": result}
            if isinstance(parsed, dict):
                return parsed
            return {"message": result}
        return {"message": str(result)}

    def create_payment(
        self,
        order_no: str,
        amount: Decimal,
        subject: str,
        description: str = "",
        extra_params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        创建微信支付订单

        支持三种支付方式：
        1. native: Native扫码支付（默认）
        2. jsapi: JSAPI支付（公众号/小程序）
        3. h5: H5支付（手机网站）
        """
        try:
            payment_type = extra_params.get('payment_type', 'native') if extra_params else 'native'

            # 金额转换为分
            amount_fen = int(amount * 100)

            expire_minutes = getattr(settings, 'ORDER_EXPIRE_MINUTES', 30)
            expire_dt = dj_tz.now() + timedelta(minutes=expire_minutes)
            # PAY-05: 必须转为 Asia/Shanghai 再格式化，避免 UTC+写死08:00 偏移 8h
            expire_shanghai = expire_dt.astimezone(zoneinfo.ZoneInfo('Asia/Shanghai'))
            time_expire = expire_shanghai.strftime('%Y-%m-%dT%H:%M:%S+08:00')

            # 公共参数
            order_params = {
                'out_trade_no': order_no,
                'description': description or subject,
                'amount': {
                    'total': amount_fen,
                    'currency': 'CNY'
                },
                'time_expire': time_expire,
            }

            from wechatpayv3 import WeChatPayType

            if payment_type == 'native':
                code, result = self.wechat_pay.pay(
                    description=order_params['description'],
                    out_trade_no=order_params['out_trade_no'],
                    amount=order_params['amount'],
                    time_expire=order_params['time_expire'],
                    pay_type=WeChatPayType.NATIVE,
                )
                result = self._normalize_sdk_result(result)

                if code == 200 and result.get('code_url'):
                    pay_url = result['code_url']
                    logger.info(f"微信订单创建成功: {order_no}, 支付类型: Native")

                    qr_code_value = pay_url
                    try:
                        import qrcode
                        qr_img = qrcode.make(pay_url, box_size=8, border=2)
                        buf = io.BytesIO()
                        qr_img.save(buf, format='PNG')
                        b64 = base64.b64encode(buf.getvalue()).decode('ascii')
                        qr_code_value = f'data:image/png;base64,{b64}'
                    except Exception:
                        logger.warning(
                            "qrcode 库未安装，微信 Native 二维码返回原始 code_url，"
                            "前端需自行渲染。请运行: pip install qrcode[pil]"
                        )

                    return {
                        'pay_url': pay_url,
                        'qr_code': qr_code_value,
                        'third_party_order_no': order_no,
                    }
                else:
                    raise PaymentException(f"创建微信支付失败: {result}")

            elif payment_type == 'jsapi':
                # JSAPI支付（需要openid）
                openid = extra_params.get('openid') if extra_params else None
                if not openid:
                    raise PaymentException("JSAPI支付需要提供openid")

                code, result = self.wechat_pay.pay(
                    description=order_params['description'],
                    out_trade_no=order_params['out_trade_no'],
                    amount=order_params['amount'],
                    time_expire=order_params['time_expire'],
                    pay_type=WeChatPayType.JSAPI,
                    payer={'openid': openid}
                )
                result = self._normalize_sdk_result(result)

                if code == 200:
                    logger.info(f"微信订单创建成功: {order_no}, 支付类型: JSAPI")
                    return {
                        'prepay_id': result.get('prepay_id'),
                        'pay_params': result,
                        'third_party_order_no': order_no,
                    }
                else:
                    raise PaymentException(f"创建微信支付失败: {result}")

            else:  # h5
                # H5支付
                code, result = self.wechat_pay.pay(
                    description=order_params['description'],
                    out_trade_no=order_params['out_trade_no'],
                    amount=order_params['amount'],
                    time_expire=order_params['time_expire'],
                    pay_type=WeChatPayType.H5,
                )
                result = self._normalize_sdk_result(result)

                if code == 200 and result.get('h5_url'):
                    pay_url = result['h5_url']
                    logger.info(f"微信订单创建成功: {order_no}, 支付类型: H5")

                    return {
                        'pay_url': pay_url,
                        'third_party_order_no': order_no,
                    }
                else:
                    raise PaymentException(f"创建微信支付失败: {result}")

        except PaymentException:
            raise
        except Exception as e:
            logger.error(f"创建微信订单失败: {str(e)}")
            raise PaymentException(f"创建微信订单失败: {str(e)}")

    def verify_callback(self, callback_data: Dict[str, Any]) -> bool:
        """验证微信支付回调签名，并缓存解密结果供 parse_callback 复用"""
        self._cached_callback_resource = None
        try:
            headers = callback_data.get("headers") or {}
            body = callback_data.get("body")

            if not headers or body is None:
                logger.warning("微信回调缺少必要的验证参数")
                return False

            decoded = self.wechat_pay.callback(headers=headers, body=body)
            if decoded is None:
                return False
            decoded = self._normalize_sdk_result(decoded)
            self._cached_callback_resource = decoded.get("resource", {})
            return True
        except Exception as e:
            logger.error(f"微信回调验证异常: {str(e)}")
            return False

    def parse_callback(self, callback_data: Dict[str, Any]) -> Dict[str, Any]:
        """解析微信支付回调数据，复用 verify_callback 缓存的解密结果"""
        try:
            resource = getattr(self, '_cached_callback_resource', None)
            if resource is None:
                headers = callback_data.get("headers") or {}
                raw_body = callback_data.get("body")
                if headers and raw_body is not None:
                    decoded = self.wechat_pay.callback(headers=headers, body=raw_body)
                    if not decoded:
                        raise PaymentException("微信回调验签或解密失败")
                    decoded = self._normalize_sdk_result(decoded)
                    resource = decoded.get("resource", {})
                else:
                    resource = callback_data.get('resource') or {}

            self._cached_callback_resource = None

            if not resource:
                raise PaymentException("微信回调缺少 resource 字段")
            if not isinstance(resource, dict):
                raise PaymentException("微信回调 resource 格式错误")

            result = resource

            # 金额从分转换为元
            amount_fen = result.get('amount', {}).get('total', 0)
            amount = Decimal(str(amount_fen)) / Decimal('100')

            success_time = result.get('success_time', '')
            if success_time:
                try:
                    naive = datetime.strptime(success_time, '%Y-%m-%dT%H:%M:%S+08:00')
                    paid_at = dj_tz.make_aware(naive, timezone=zoneinfo.ZoneInfo('Asia/Shanghai'))
                except (ValueError, Exception) as e:
                    logger.warning(f"解析微信支付时间失败: {success_time}, 错误: {e}")
                    paid_at = dj_tz.now()
            else:
                paid_at = dj_tz.now()

            return {
                'order_no': result.get('out_trade_no'),
                'third_party_trade_no': result.get('transaction_id'),
                'paid_amount': amount,
                'trade_status': result.get('trade_state'),
                'paid_at': paid_at,
            }
        except Exception as e:
            logger.error(f"解析微信回调数据失败: {str(e)}")
            raise PaymentException(f"解析微信回调数据失败: {str(e)}")

    def query_order(self, order_no: str) -> Dict[str, Any]:
        """查询微信订单状态"""
        try:
            code, result = self.wechat_pay.query(out_trade_no=order_no)
            result = self._normalize_sdk_result(result)

            if code == 200:
                amount_fen = result.get('amount', {}).get('total', 0)
                amount = Decimal(str(amount_fen)) / Decimal('100')

                return {
                    'order_no': result.get('out_trade_no'),
                    'third_party_trade_no': result.get('transaction_id'),
                    'trade_status': result.get('trade_state'),
                    'total_amount': amount,
                }
            else:
                logger.warning(f"查询微信订单失败: {result}")
                return {}

        except Exception as e:
            logger.error(f"查询微信订单异常: {str(e)}")
            return {}

    def cancel_order(self, order_no: str) -> bool:
        """关闭微信订单"""
        try:
            code, result = self.wechat_pay.close(out_trade_no=order_no)

            if code == 204:  # 微信关闭订单成功返回204
                logger.info(f"关闭微信订单成功: {order_no}")
                return True
            else:
                logger.warning(f"关闭微信订单失败: {result}")
                return False

        except Exception as e:
            logger.error(f"关闭微信订单异常: {str(e)}")
            return False

    # ------------------------------------------------------------------
    # 退款
    # ------------------------------------------------------------------

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
        申请微信退款（V3 接口 POST /v3/refund/domestic/refunds）

        D10 决策：全额退款，异步回调更新状态。
        """
        import uuid

        if refund_no is None:
            refund_no = f"R{datetime.now().strftime('%Y%m%d%H%M%S')}{uuid.uuid4().hex[:10]}"

        refund_amount_fen = int(refund_amount * 100)
        total_amount_fen = int(total_amount * 100)

        refund_notify_url = getattr(settings, 'WECHAT_REFUND_NOTIFY_URL', '') or ''

        try:
            kwargs: Dict[str, Any] = {
                'out_refund_no': refund_no,
                'amount': {
                    'refund': refund_amount_fen,
                    'total': total_amount_fen,
                    'currency': 'CNY',
                },
            }
            if transaction_id:
                kwargs['transaction_id'] = transaction_id
            else:
                kwargs['out_trade_no'] = order_no
            if refund_reason:
                kwargs['reason'] = refund_reason
            if refund_notify_url:
                kwargs['notify_url'] = refund_notify_url

            code, message = self.wechat_pay.refund(**kwargs)
            result = self._normalize_sdk_result(message)

            if code in range(200, 300):
                wx_status = result.get('status', '')
                mapped_status = self._map_refund_status(wx_status)
                logger.info(
                    "微信退款申请成功: order_no=%s refund_no=%s wx_status=%s",
                    order_no, refund_no, wx_status,
                )
                return RefundResult(
                    success=True,
                    refund_id=result.get('refund_id', ''),
                    status=mapped_status,
                    raw_response=result,
                )
            else:
                error_msg = result.get('message', '') or str(message)
                error_code = result.get('code', '')
                logger.error(
                    "微信退款失败: order_no=%s refund_no=%s http=%s code=%s msg=%s",
                    order_no, refund_no, code, error_code, error_msg,
                )
                return RefundResult(
                    success=False,
                    refund_id='',
                    status='failed',
                    error_message=f"[{error_code}] {error_msg}",
                    raw_response=result,
                )

        except Exception as e:
            logger.error(
                "微信退款异常: order_no=%s refund_no=%s error=%s",
                order_no, refund_no, e, exc_info=True,
            )
            return RefundResult(
                success=False,
                refund_id='',
                status='error',
                error_message=str(e),
            )

    def query_refund(self, refund_no: str) -> Dict[str, Any]:
        """查询微信退款状态"""
        try:
            code, message = self.wechat_pay.query_refund(out_refund_no=refund_no)
            result = self._normalize_sdk_result(message)

            if code in range(200, 300):
                return {
                    'refund_id': result.get('refund_id', ''),
                    'refund_no': result.get('out_refund_no', ''),
                    'status': self._map_refund_status(result.get('status', '')),
                    'wx_status': result.get('status', ''),
                    'amount': result.get('amount', {}),
                    'raw': result,
                }
            else:
                logger.warning("查询微信退款失败: refund_no=%s code=%s", refund_no, code)
                return {}
        except Exception as e:
            logger.error("查询微信退款异常: refund_no=%s error=%s", refund_no, e)
            return {}

    @staticmethod
    def _map_refund_status(wx_status: str) -> str:
        """将微信退款状态映射为内部状态"""
        mapping = {
            'SUCCESS': 'refunded',
            'CLOSED': 'failed',
            'PROCESSING': 'refunding',
            'ABNORMAL': 'abnormal',
        }
        return mapping.get(wx_status, 'unknown')

    # ------------------------------------------------------------------
    # 退款回调
    # ------------------------------------------------------------------

    def verify_refund_callback(self, callback_data: Dict[str, Any]) -> bool:
        """验证微信退款回调签名，缓存解密结果"""
        self._cached_refund_callback_resource = None
        try:
            headers = callback_data.get("headers") or {}
            body = callback_data.get("body")

            if not headers or body is None:
                logger.warning("微信退款回调缺少必要的验证参数")
                return False

            decoded = self.wechat_pay.callback(headers=headers, body=body)
            if decoded is None:
                return False
            decoded = self._normalize_sdk_result(decoded)
            self._cached_refund_callback_resource = decoded.get("resource", {})
            return True
        except Exception as e:
            logger.error("微信退款回调验证异常: %s", e)
            return False

    def parse_refund_callback(self, callback_data: Dict[str, Any]) -> Dict[str, Any]:
        """解析微信退款回调，返回标准化退款结果"""
        try:
            resource = getattr(self, '_cached_refund_callback_resource', None)
            if resource is None:
                headers = callback_data.get("headers") or {}
                raw_body = callback_data.get("body")
                if headers and raw_body is not None:
                    decoded = self.wechat_pay.callback(headers=headers, body=raw_body)
                    if not decoded:
                        raise PaymentException("微信退款回调验签或解密失败")
                    decoded = self._normalize_sdk_result(decoded)
                    resource = decoded.get("resource", {})
                else:
                    raise PaymentException("微信退款回调缺少 headers/body")

            self._cached_refund_callback_resource = None

            if not resource:
                raise PaymentException("微信退款回调缺少 resource 字段")
            if not isinstance(resource, dict):
                raise PaymentException("微信退款回调 resource 格式错误")

            wx_status = resource.get('refund_status', '')
            amount_info = resource.get('amount', {})

            return {
                'order_no': resource.get('out_trade_no', ''),
                'refund_no': resource.get('out_refund_no', ''),
                'refund_id': resource.get('refund_id', ''),
                'transaction_id': resource.get('transaction_id', ''),
                'wx_refund_status': wx_status,
                'status': self._map_refund_status(wx_status),
                'refund_amount': Decimal(str(amount_info.get('refund', 0))) / Decimal('100'),
                'total_amount': Decimal(str(amount_info.get('total', 0))) / Decimal('100'),
                'success_time': resource.get('success_time', ''),
                'raw': resource,
            }
        except PaymentException:
            raise
        except Exception as e:
            logger.error("解析微信退款回调失败: %s", e)
            raise PaymentException(f"解析微信退款回调失败: {e}")

    def get_callback_response(self, success: bool = True) -> Dict[str, str]:
        """微信回调响应（JSON格式）"""
        if success:
            return {'code': 'SUCCESS', 'message': '成功'}
        else:
            return {'code': 'FAIL', 'message': '失败'}
