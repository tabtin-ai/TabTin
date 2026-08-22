"""
支付服务抽象基类
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, Any, Optional
from decimal import Decimal


@dataclass
class RefundResult:
    """退款操作结果"""
    success: bool
    refund_id: str = ""
    status: str = ""
    error_message: str = ""
    raw_response: Dict[str, Any] = field(default_factory=dict)


class BasePaymentService(ABC):
    """
    支付服务抽象基类

    所有支付服务必须实现此接口。当前已注册实现：AlipayService、WechatPayService。

    TODO [PAY-29]: 添加 StripePaymentService 骨架以支持国际支付场景。
    Stripe 接入需要：stripe-python SDK、Webhook 签名验证（stripe.Webhook.construct_event）、
    PaymentIntent 流程。接入前需完成：1) 产品侧确认货币单位（USD/CNY）；
    2) Stripe 账户主体合规审核；3) 前端支付组件适配。
    """

    def __init__(self, config: Dict[str, Any]):
        """
        初始化支付服务

        Args:
            config: 支付配置字典
        """
        self.config = config
        self._validate_config()

    @abstractmethod
    def _validate_config(self):
        """验证配置是否完整"""
        pass

    @abstractmethod
    def create_payment(
        self,
        order_no: str,
        amount: Decimal,
        subject: str,
        description: str = "",
        extra_params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        创建支付订单

        Args:
            order_no: 订单号
            amount: 金额（元）
            subject: 订单标题
            description: 订单描述
            extra_params: 额外参数

        Returns:
            包含支付信息的字典，格式：
            {
                'pay_url': 'https://...',  # PC端支付URL
                'qr_code': 'https://...',  # 二维码URL（可选）
                'form_html': '<form>...</form>',  # 表单HTML（可选）
                'third_party_order_no': 'xxx',  # 第三方订单号
            }
        """
        pass

    @abstractmethod
    def verify_callback(self, callback_data: Dict[str, Any]) -> bool:
        """
        验证支付回调签名

        Args:
            callback_data: 回调数据

        Returns:
            验证是否通过
        """
        pass

    @abstractmethod
    def parse_callback(self, callback_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        解析支付回调数据

        Args:
            callback_data: 回调数据

        Returns:
            解析后的标准化数据，格式：
            {
                'order_no': 'xxx',  # 商户订单号
                'third_party_trade_no': 'xxx',  # 第三方交易号
                'paid_amount': Decimal('100.00'),  # 实付金额
                'trade_status': 'TRADE_SUCCESS',  # 交易状态
                'paid_at': datetime,  # 支付时间
            }
        """
        pass

    @abstractmethod
    def query_order(self, order_no: str) -> Dict[str, Any]:
        """
        查询订单状态

        Args:
            order_no: 订单号

        Returns:
            订单状态信息
        """
        pass

    @abstractmethod
    def cancel_order(self, order_no: str) -> bool:
        """
        取消订单

        Args:
            order_no: 订单号

        Returns:
            是否取消成功
        """
        pass

    def close_unpaid_order(self, order_no: str) -> bool:
        """关闭未支付订单，不得触发退款语义。

        支付渠道若没有独立的关单接口，可复用 ``cancel_order``；有“取消即退款”
        语义的渠道必须覆盖本方法。
        """
        return self.cancel_order(order_no)

    @abstractmethod
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
        申请退款

        Args:
            order_no: 商户订单号（out_trade_no）
            refund_amount: 退款金额（元）
            total_amount: 原订单总金额（元）
            refund_reason: 退款原因
            refund_no: 商户退款单号，为空时自动生成
            transaction_id: 第三方交易号，优先使用

        Returns:
            RefundResult 包含退款结果
        """
        pass

    def get_callback_response(self, success: bool = True) -> Any:
        """
        获取回调响应内容（字符串或字典，视支付渠道而定）
        """
        return "success" if success else "fail"
