"""
流式 WS Handler 基类 — TTS / ASR 共享的会话管理逻辑。

提取自 tts_stream.py 和 asr_stream.py 中重复代码：
  - 连接生命周期：_http_session / _ws / _closed / _receive_done
  - 前端事件推送：_send_event()
  - 接收循环骨架：receive_loop() — 模板方法，子类实现 _dispatch_binary
  - 优雅关闭：_wait_and_cleanup() — 等 receive_loop → cleanup
  - 资源释放：_cleanup() + _on_cleanup_ws() 钩子
  - consumer 断连清理：cleanup_streams_for_consumer()
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

import aiohttp

from ..protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

_RECEIVE_LOOP_TIMEOUT = 5.0


class _BaseStreamSession:
    """TTS / ASR 流式会话的公共基类。"""

    _log_prefix: str = "STREAM"

    def __init__(
        self,
        stream_id: str,
        consumer: Any,
        svc: Any,
    ):
        self.stream_id = stream_id
        self.consumer = consumer
        self.owner_channel: str = getattr(consumer, "channel_name", "")
        self.svc = svc
        self._http_session: Optional[aiohttp.ClientSession] = None
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._closed = False
        self._receive_done = asyncio.Event()

    # ------------------------------------------------------------------
    # 前端推送
    # ------------------------------------------------------------------

    async def _send_event(self, event_type: str, payload: dict) -> None:
        """向前端推送一个 envelope 事件。

        ASR / TTS 流只在当前连接内流转，不经过 organization group 广播，
        因此 envelope 不携带 organization_id；如果将来需要定位流到某个 organization，
        应在 session 创建时显式把 organization_id 注入到实例上，而不是依赖 consumer 状态。
        """
        envelope = build_envelope(
            event_type, new_event_id(), payload,
        )
        await self.consumer._send_envelope(envelope)

    # ------------------------------------------------------------------
    # 接收循环（模板方法）
    # ------------------------------------------------------------------

    async def receive_loop(self) -> None:
        """
        持续接收上游 WS 消息并分发。模板方法骨架——子类通过以下钩子注入差异化逻辑：

        - _dispatch_binary(data) → bool: 处理 BINARY 帧，返回 True 继续 / False 退出
        - _on_receive_error(): 未预期异常时向前端发错误事件
        - _deregister(): 从全局 session registry 中移除自身
        """
        if not self._ws:
            return

        try:
            async for msg in self._ws:
                if self._closed:
                    break

                if msg.type == aiohttp.WSMsgType.BINARY:
                    should_continue = await self._dispatch_binary(msg.data)
                    if not should_continue:
                        break

                elif msg.type == aiohttp.WSMsgType.TEXT:
                    should_continue = await self._dispatch_text(msg.data)
                    if not should_continue:
                        break

                elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                    break

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("[%s] receive_loop error: %s", self._log_prefix, exc)
            try:
                await self._on_receive_error()
            except Exception:
                pass
        finally:
            self._receive_done.set()
            try:
                self._deregister()
            except Exception:
                logger.debug("[%s] _deregister error", self._log_prefix)
            await self._cleanup()

    async def _dispatch_binary(self, data: bytes) -> bool:
        """处理一个 BINARY WS 帧。返回 True 继续接收，False 终止循环。子类必须实现。"""
        raise NotImplementedError

    _stream_error_event: str = "stream.error"

    async def _dispatch_text(self, data: str) -> bool:
        """处理一个 TEXT WS 帧（上游 JSON 错误等）。

        默认实现：解析 JSON 并向前端推送错误事件，然后终止循环。
        子类可覆盖以实现自定义逻辑。
        """
        import json as _json
        try:
            text_payload = _json.loads(data) if isinstance(data, str) else {}
        except (ValueError, TypeError):
            text_payload = {"raw": str(data)[:500]}

        logger.warning(
            "[%s] upstream TEXT frame received: %s",
            self._log_prefix, str(data)[:200],
        )
        await self._send_event(self._stream_error_event, {
            "stream_id": self.stream_id,
            "error": "upstream_text_frame",
            "detail": text_payload,
        })
        return False

    async def _on_receive_error(self) -> None:
        """receive_loop 出现未预期异常时向前端发送错误事件。子类必须实现。"""
        raise NotImplementedError

    def _deregister(self) -> None:
        """从全局 session registry 中移除自身。子类必须实现。"""
        raise NotImplementedError

    # ------------------------------------------------------------------
    # 优雅关闭
    # ------------------------------------------------------------------

    async def _wait_and_cleanup(self, timeout: float = _RECEIVE_LOOP_TIMEOUT) -> None:
        """等待 receive_loop 设置 _receive_done，超时后强制清理。"""
        try:
            await asyncio.wait_for(self._receive_done.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning(
                "[%s] receive_loop 未在超时内结束，强制清理 stream_id=%s",
                self._log_prefix, self.stream_id,
            )
        if not self._closed:
            await self._cleanup()

    # ------------------------------------------------------------------
    # 资源释放
    # ------------------------------------------------------------------

    async def _cleanup(self) -> None:
        """释放 WS 连接和 HTTP session。可安全多次调用。子类通过 _on_cleanup_ws 扩展。"""
        self._closed = True
        if self._ws and not self._ws.closed:
            try:
                await self._on_cleanup_ws()
            except Exception:
                pass
            try:
                await self._ws.close()
            except Exception:
                pass
        if self._http_session and not self._http_session.closed:
            try:
                await self._http_session.close()
            except Exception:
                pass

    async def _on_cleanup_ws(self) -> None:
        """子类覆写：cleanup 时 WS 未关闭前的额外操作（如发送 FinishConnection）。"""


# ------------------------------------------------------------------
# 工厂辅助
# ------------------------------------------------------------------

async def cleanup_streams_for_consumer(
    active_streams: dict[str, _BaseStreamSession],
    channel_name: str,
    log_prefix: str = "STREAM",
) -> None:
    """consumer 断连时，清理其拥有的所有 stream session。"""
    to_remove = [
        sid for sid, s in active_streams.items()
        if s.owner_channel == channel_name
    ]
    for sid in to_remove:
        session = active_streams.pop(sid, None)
        if session:
            try:
                await session._cleanup()
            except Exception:
                logger.debug("[%s] cleanup error for stream %s", log_prefix, sid)
