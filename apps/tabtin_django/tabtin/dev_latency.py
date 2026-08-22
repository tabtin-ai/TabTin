"""本地开发用：给所有 Django 请求响应注入可配置延迟，模拟弱网 / 高延迟环境。

- 仅在本地开发环境（``settings.DEBUG=True``）生效；生产环境（DEBUG=False）返回 0，
  调用方据此完全跳过延迟逻辑。
- 延迟时长由环境变量 ``DEV_RESPONSE_LATENCY_MS``（毫秒）配置；未配置、非法或 <=0
  时返回 0，即不注入任何延迟。

HTTP 侧由 ``DevLatencyMiddleware.process_request`` 使用同步 ``time.sleep``，会占住
当前 worker（同步模型无法重叠）。

WS 侧在 ``GatewayConsumer.receive`` 校验通过后、业务 handler 前注入入站延迟：
每条客户端消息各自从到达时刻倒计时 N ms（计时器可并行重叠），``receive`` 不
await 延迟任务，故不挡后续收帧；到期后用连接级锁串行跑 handler（保序、避免
踩踏 consumer 状态）。服务端主动下发的 broadcast/stream/心跳不走该路径。

两侧共用同一份配置解析，保证延迟数值一致；调度模型因协议不同而不同。
"""

import asyncio
import logging
import os
import time

logger = logging.getLogger(__name__)

DEV_LATENCY_ENV_KEY = "DEV_RESPONSE_LATENCY_MS"


def get_latency_seconds() -> float:
    """返回需要注入的延迟秒数；未启用时返回 ``0.0``。

    启用条件：``settings.DEBUG=True`` 且 ``DEV_RESPONSE_LATENCY_MS`` 为正数（毫秒）。
    """
    from django.conf import settings

    if not settings.DEBUG:
        return 0.0

    raw = os.getenv(DEV_LATENCY_ENV_KEY, "").strip()
    if not raw:
        return 0.0

    try:
        ms = float(raw)
    except ValueError:
        logger.warning("[DevLatency] 忽略非法 %s=%r（应为毫秒数）", DEV_LATENCY_ENV_KEY, raw)
        return 0.0

    if ms <= 0:
        return 0.0
    return ms / 1000.0


def sleep_sync() -> None:
    """HTTP 同步路径：按配置阻塞当前线程注入延迟。"""
    delay = get_latency_seconds()
    if delay > 0:
        time.sleep(delay)


async def sleep_async() -> None:
    """按配置 await 注入延迟（不阻塞事件循环）。

    WS gateway 已改为「并行计时 + 串行 handler」调度，不再在 ``receive`` 里
    直接调用本函数；保留给需要简单 await 的调用方。
    """
    delay = get_latency_seconds()
    if delay > 0:
        await asyncio.sleep(delay)
