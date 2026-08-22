"""
支付服务工厂

统一管理支付服务实例，类似LLMServiceFactory
"""

import logging
import threading
import time
from typing import Optional, Dict, Any, Tuple

from .base import BasePaymentService
from .alipay_service import AlipayService
from .wechat_service import WechatPayService
from ..exceptions import PaymentMethodNotSupportedError

logger = logging.getLogger(__name__)

# PAY-23: 默认缓存 TTL（秒）。证书/密钥有效期通常为数年，24h 轮换一次足以兼容
# 密钥轮换场景；如需立即失效可调用 clear_cache()。
_DEFAULT_CACHE_TTL_SECONDS = 86400  # 24 小时


class PaymentServiceFactory:
    """
    支付服务工厂

    负责创建和管理支付服务实例。
    PAY-23: 使用 TTL 机制自动淘汰过期实例，支持证书/密钥轮换后无需手动干预。
    所有读写均在 _lock 内完成，消除高并发下的竞态窗口。
    """

    _lock = threading.Lock()
    # 支付服务映射：method -> (service_instance, created_at_monotonic)
    _services: Dict[str, Tuple[BasePaymentService, float]] = {}

    # 支付方式映射
    _service_classes = {
        'alipay': AlipayService,
        'wechat': WechatPayService,
    }

    @classmethod
    def get_service(
        cls,
        payment_method: str,
        config: Optional[Dict[str, Any]] = None,
        ttl: int = _DEFAULT_CACHE_TTL_SECONDS,
    ) -> BasePaymentService:
        """
        获取支付服务实例（带 TTL 的单例模式）。

        Args:
            payment_method: 支付方式（alipay、wechat）
            config: 支付配置（可选）；传入时强制重建实例
            ttl: 缓存有效期（秒），默认 86400（24h）

        Returns:
            支付服务实例

        Raises:
            PaymentMethodNotSupportedError: 不支持的支付方式
        """
        if payment_method not in cls._service_classes:
            raise PaymentMethodNotSupportedError(
                f"不支持的支付方式: {payment_method}",
                method=payment_method
            )

        with cls._lock:
            # PAY-23: 读操作在锁内执行，消除 double-checked locking 竞态
            cached = cls._services.get(payment_method)
            if cached is not None and config is None:
                service, created_at = cached
                if (time.monotonic() - created_at) < ttl:
                    return service
                logger.info("支付服务缓存过期，重建: %s", payment_method)

            try:
                service_class = cls._service_classes[payment_method]
                service = service_class(config)
                cls._services[payment_method] = (service, time.monotonic())
                logger.info("支付服务创建成功: %s", payment_method)
                return service
            except Exception as e:
                logger.error("创建支付服务失败: %s, 错误: %s", payment_method, e)
                raise

    @classmethod
    def clear_cache(cls, payment_method: Optional[str] = None):
        """
        清除缓存的服务实例（密钥轮换后立即调用）。

        Args:
            payment_method: 支付方式，None 表示清除所有
        """
        with cls._lock:
            if payment_method:
                cls._services.pop(payment_method, None)
                logger.info("清除支付服务缓存: %s", payment_method)
            else:
                cls._services.clear()
                logger.info("清除所有支付服务缓存")

    @classmethod
    def get_supported_methods(cls) -> list:
        """获取支持的支付方式列表"""
        return list(cls._service_classes.keys())
