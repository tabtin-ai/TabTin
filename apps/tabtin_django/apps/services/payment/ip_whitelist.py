"""
PAY-24: 支付回调 IP 白名单防护（应用层）

在 Nginx/网关层 IP 白名单配置前，提供应用层的纵深防御。
支付宝/微信支付服务器的 IP 段来自官方文档：
- 支付宝: https://opendocs.alipay.com/support/01rg6h
- 微信: https://pay.weixin.qq.com/wiki/doc/apiv3/wechatpay/wechatpay2_0.shtml

启用/禁用通过 settings.PAYMENT_CALLBACK_IP_WHITELIST_ENABLED 控制（默认启用）。
DEBUG 模式下自动放行 localhost/内网 IP，便于本地开发调试。
"""

import ipaddress
import json
import logging
from functools import wraps
from typing import Set

from django.conf import settings
from django.http import HttpRequest, HttpResponse

logger = logging.getLogger(__name__)

# 支付宝官方出口 IP 段（截至 2025 年）
# 来源: https://opendocs.alipay.com/support/01rg6h
ALIPAY_IP_RANGES = [
    "110.75.128.0/19",
    "110.75.224.0/19",
    "110.76.0.0/19",
    "110.76.32.0/19",
    "110.76.64.0/19",
    "110.76.96.0/19",
    "124.232.128.0/19",
    "124.232.144.0/20",
    "203.209.224.0/19",
    "203.209.244.0/23",
    "47.74.0.0/18",
    "47.88.0.0/17",
]

# 微信支付官方出口 IP 段
# 来源: https://pay.weixin.qq.com/wiki/doc/apiv3/wechatpay/wechatpay2_0.shtml
WECHAT_IP_RANGES = [
    "101.226.62.0/24",
    "101.226.103.0/24",
    "101.226.125.0/24",
    "140.207.54.0/24",
    "121.51.58.0/24",
    "183.3.234.0/24",
    "183.60.142.0/24",
    "59.37.125.0/24",
    "121.14.104.0/24",
]

# 开发/测试环境额外放行的 IP
_DEV_ALLOWED_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::1/128"),
]


def _parse_networks(ranges: list) -> list:
    result = []
    for r in ranges:
        try:
            result.append(ipaddress.ip_network(r, strict=False))
        except ValueError:
            logger.warning("[PaymentIPWhitelist] 无效 IP 段: %s", r)
    return result


_alipay_networks = _parse_networks(ALIPAY_IP_RANGES)
_wechat_networks = _parse_networks(WECHAT_IP_RANGES)
_extra_networks_cache: list | None = None


def _get_extra_networks() -> list:
    """缓存解析 settings.PAYMENT_CALLBACK_EXTRA_ALLOWED_IPS，避免每次请求重复解析。"""
    global _extra_networks_cache
    if _extra_networks_cache is not None:
        return _extra_networks_cache
    custom_ips = getattr(settings, "PAYMENT_CALLBACK_EXTRA_ALLOWED_IPS", [])
    _extra_networks_cache = _parse_networks(custom_ips) if custom_ips else []
    return _extra_networks_cache


def _get_client_ip(request: HttpRequest) -> str:
    """从请求中提取真实客户端 IP。

    安全说明：X-Forwarded-For 可被客户端伪造。本函数假设 Django 前置有可信的
    反向代理（Nginx/LB）会覆盖或规范 X-Forwarded-For。
    若 Django 直接暴露在公网，应仅使用 REMOTE_ADDR。
    可通过 settings.PAYMENT_CALLBACK_TRUST_PROXY=False 强制仅用 REMOTE_ADDR。
    """
    trust_proxy = getattr(settings, "PAYMENT_CALLBACK_TRUST_PROXY", True)
    if trust_proxy:
        x_forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
        if x_forwarded_for:
            return x_forwarded_for.split(",")[0].strip()
        x_real_ip = request.META.get("HTTP_X_REAL_IP")
        if x_real_ip:
            return x_real_ip.strip()
    return request.META.get("REMOTE_ADDR", "")


def _is_ip_allowed(ip_str: str, allowed_networks: list) -> bool:
    """检查 IP 是否在允许的网络段中。"""
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return False

    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped

    for network in allowed_networks:
        if addr in network:
            return True

    if getattr(settings, "DEBUG", False):
        for dev_net in _DEV_ALLOWED_NETWORKS:
            if addr in dev_net:
                return True

    for net in _get_extra_networks():
        if addr in net:
            return True

    return False


def require_payment_ip_whitelist(payment_method: str):
    """装饰器：校验支付回调请求的来源 IP。

    Args:
        payment_method: 'alipay' 或 'wechat'，决定使用哪组白名单。

    用法::

        @require_payment_ip_whitelist('alipay')
        def alipay_callback(request):
            ...
    """
    def decorator(view_func):
        @wraps(view_func)
        def wrapper(request, *args, **kwargs):
            if not getattr(settings, "PAYMENT_CALLBACK_IP_WHITELIST_ENABLED", True):
                return view_func(request, *args, **kwargs)

            client_ip = _get_client_ip(request)

            if payment_method == "alipay":
                networks = _alipay_networks
            elif payment_method in ("wechat", "wechat_refund"):
                networks = _wechat_networks
            else:
                networks = _alipay_networks + _wechat_networks

            if _is_ip_allowed(client_ip, networks):
                return view_func(request, *args, **kwargs)

            logger.warning(
                "[PAY-24] 支付回调 IP 白名单拦截: method=%s, ip=%s, "
                "path=%s, user_agent=%s",
                payment_method,
                client_ip,
                request.path,
                request.META.get("HTTP_USER_AGENT", "")[:200],
            )

            if payment_method == "alipay":
                return HttpResponse("fail", status=403)
            else:
                return HttpResponse(
                    json.dumps({"code": "FAIL", "message": "forbidden"}),
                    content_type="application/json",
                    status=403,
                )
        return wrapper
    return decorator
