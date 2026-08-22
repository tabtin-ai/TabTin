"""
字节跳动 V3 WS 双向流式 TTS

协议：wss://openspeech.bytedance.com/api/v3/tts/bidirection
认证：WS Headers X-Api-App-Key, X-Api-Access-Key, X-Api-Resource-Id
二进制帧协议，事件驱动：
  StartConnection(1) → ConnectionStarted(50)
  StartSession(100) → SessionStarted(150)
  TaskRequest(200) → TTSResponse(352) / TTSSentenceStart(350) / TTSSentenceEnd(351)
  FinishSession(102) → SessionFinished(152)
  FinishConnection(2) → ConnectionFinished(52)

适用于 LLM 流式输出场景（边生成文本边合成语音）。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncGenerator, Optional

import aiohttp

from ....config_types import TTSProviderConfig
from ...base import BaseTTSService
from ...types import TTSChunk, TTSResult, TTSSentence, TTSStreamEvent, TTSWordTimestamp
from ...factory import TTSUpstreamError
from .base import (
    DEFAULT_FORMAT,
    DEFAULT_SAMPLE_RATE,
    DEFAULT_SPEAKER,
    RESOURCE_TTS_20,
    WS_BIDIRECTIONAL_URL,
    Compression,
    Event,
    MsgType,
    Serialization,
    build_tts_request_params,
    build_ws_auth_headers,
    build_ws_frame,
    new_connect_id,
    parse_ws_frame,
    supports_subtitle_resource,
)

logger = logging.getLogger(__name__)


class ByteDanceWsBidirectionalTTS(BaseTTSService):
    """字节跳动 V3 WS 双向流式 TTS"""

    def __init__(self, config: TTSProviderConfig):
        super().__init__(config)
        self.app_id: str = config.app_id
        self.access_token: str = config.access_token
        self.resource_id: str = config.resource_id or RESOURCE_TTS_20
        self.default_speaker: str = config.default_speaker or DEFAULT_SPEAKER

    async def synthesize(
        self,
        text: str,
        *,
        speaker: str = "",
        model: str = "",
        format: str = DEFAULT_FORMAT,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        speed_ratio: float = 1.0,
        volume_ratio: float = 1.0,
        pitch: int = 0,
        emotion: str = "",
        enable_timestamp: bool = False,
        **kwargs: Any,
    ) -> TTSResult:
        """完整合成（通过 WS 双向协议，收集全部数据后返回）"""
        self._raise_if_rate_limited()

        import time as _time
        _start = _time.monotonic()
        try:
            audio_chunks: list[bytes] = []
            sentences: list[TTSSentence] = []
            usage: dict[str, Any] = {}

            async for chunk in self.synthesize_stream(
                text,
                speaker=speaker,
                model=model,
                format=format,
                sample_rate=sample_rate,
                speed_ratio=speed_ratio,
                volume_ratio=volume_ratio,
                pitch=pitch,
                emotion=emotion,
                enable_timestamp=enable_timestamp,
                **kwargs,
            ):
                if chunk.audio_data:
                    audio_chunks.append(chunk.audio_data)
                if chunk.sentence:
                    sentences.append(chunk.sentence)

            result = TTSResult(
                audio_data=b"".join(audio_chunks),
                format=format,
                sample_rate=sample_rate,
                sentences=sentences,
                usage=usage,
                provider=self.provider_name,
                mode=self.mode,
            )
            self._report_call_result(
                success=True, latency_seconds=_time.monotonic() - _start,
            )
            return result
        except Exception as exc:
            self._report_call_result(
                success=False,
                latency_seconds=_time.monotonic() - _start,
                error_message=str(exc)[:500],
            )
            raise

    async def synthesize_stream(
        self,
        text: str,
        *,
        speaker: str = "",
        model: str = "",
        format: str = DEFAULT_FORMAT,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        speed_ratio: float = 1.0,
        volume_ratio: float = 1.0,
        pitch: int = 0,
        emotion: str = "",
        enable_timestamp: bool = False,
        **kwargs: Any,
    ) -> AsyncGenerator[TTSChunk, None]:
        """WS 双向流式合成"""
        actual_speaker = speaker or self.default_speaker
        connect_id = new_connect_id()
        enable_subtitle = enable_timestamp and supports_subtitle_resource(self.resource_id)

        headers = build_ws_auth_headers(
            app_id=self.app_id,
            access_token=self.access_token,
            resource_id=self.resource_id,
            connect_id=connect_id,
        )
        headers["X-Control-Require-Usage-Tokens-Return"] = "*"

        req_params = build_tts_request_params(
            text,
            speaker=actual_speaker,
            model=model,
            format=format,
            sample_rate=sample_rate,
            speed_ratio=speed_ratio,
            volume_ratio=volume_ratio,
            pitch=pitch,
            emotion=emotion,
            enable_timestamp=enable_timestamp and not enable_subtitle,
            enable_subtitle=enable_subtitle,
            **kwargs,
        )

        ws_session_id = new_connect_id()
        nc = Compression.NONE

        timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.ws_connect(
                WS_BIDIRECTIONAL_URL,
                headers=headers,
            ) as ws:
                # 1. StartConnection
                await ws.send_bytes(build_ws_frame(
                    Event.START_CONNECTION, {"user": {"uid": "tabtin"}},
                    compression=nc,
                ))
                evt = await self._recv_event(ws)
                if evt != Event.CONNECTION_STARTED:
                    raise TTSUpstreamError(
                        f"WS TTS: 期望 ConnectionStarted(50)，收到 event={evt}"
                    )

                # 2. StartSession（设置音频参数，text 通过 TaskRequest 发送）
                session_req_params = {
                    k: v for k, v in req_params.items() if k != "text"
                }
                session_payload = {
                    "user": {"uid": "tabtin"},
                    "event": Event.START_SESSION,
                    "namespace": "BidirectionalTTS",
                    "req_params": session_req_params,
                }
                await ws.send_bytes(build_ws_frame(
                    Event.START_SESSION, session_payload,
                    session_id=ws_session_id, compression=nc,
                ))
                evt = await self._recv_event(ws)
                if evt != Event.SESSION_STARTED:
                    raise TTSUpstreamError(
                        f"WS TTS: 期望 SessionStarted(150)，收到 event={evt}"
                    )

                # 3. TaskRequest + FinishSession + receive 并发执行
                #    send/receive 必须并发，否则 FinishSession 可能抢先导致空音频
                chunk_queue: asyncio.Queue[TTSChunk | None] = asyncio.Queue()

                async def _sender() -> None:
                    await ws.send_bytes(build_ws_frame(
                        Event.TASK_REQUEST,
                        {"req_params": {"text": text}},
                        session_id=ws_session_id, compression=nc,
                    ))
                    await ws.send_bytes(build_ws_frame(
                        Event.FINISH_SESSION, {},
                        session_id=ws_session_id, compression=nc,
                    ))

                async def _receiver() -> None:
                    try:
                        async for chunk in self._receive_loop(ws):
                            await chunk_queue.put(chunk)
                    except Exception as exc:
                        await chunk_queue.put(exc)  # type: ignore[arg-type]
                    finally:
                        await chunk_queue.put(None)

                send_task = asyncio.create_task(_sender())
                recv_task = asyncio.create_task(_receiver())

                while True:
                    item = await chunk_queue.get()
                    if item is None:
                        break
                    if isinstance(item, Exception):
                        send_task.cancel()
                        recv_task.cancel()
                        raise item
                    yield item

                await send_task
                await recv_task

                # 4. FinishConnection
                try:
                    await ws.send_bytes(build_ws_frame(
                        Event.FINISH_CONNECTION, {"user": {"uid": "tabtin"}},
                        compression=nc,
                    ))
                except Exception:
                    pass

    async def _recv_event(self, ws: aiohttp.ClientWebSocketResponse) -> int:
        """接收一帧并返回事件码"""
        msg = await ws.receive()
        if msg.type == aiohttp.WSMsgType.BINARY:
            parsed = parse_ws_frame(msg.data)
            if parsed["msg_type"] == MsgType.SERVER_ERROR:
                error_code = parsed["error_code"]
                error_json = parsed.get("payload_json", {})
                raise TTSUpstreamError(
                    f"WS TTS 错误: code={error_code} detail={error_json}"
                )
            return parsed["event"]
        elif msg.type in (aiohttp.WSMsgType.TEXT,):
            logger.warning("WS TTS: 收到文本帧: %s", msg.data[:500])
            raise TTSUpstreamError(f"WS TTS 意外文本帧: {msg.data[:500]}")
        elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED):
            raise TTSUpstreamError("WS TTS: 连接意外关闭")
        elif msg.type == aiohttp.WSMsgType.ERROR:
            raise TTSUpstreamError(f"WS TTS 错误: {ws.exception()}")
        return 0

    async def _receive_loop(
        self, ws: aiohttp.ClientWebSocketResponse,
    ) -> AsyncGenerator[TTSChunk, None]:
        """接收音频数据直到 SessionFinished"""
        while True:
            msg = await ws.receive()
            if msg.type == aiohttp.WSMsgType.BINARY:
                parsed = parse_ws_frame(msg.data)
                msg_type = parsed["msg_type"]
                event = parsed["event"]

                if msg_type == MsgType.SERVER_ERROR:
                    error_code = parsed["error_code"]
                    error_json = parsed.get("payload_json", {})
                    raise TTSUpstreamError(
                        f"WS TTS 错误: code={error_code} detail={error_json}"
                    )

                if msg_type == MsgType.SERVER_AUDIO_ONLY:
                    audio_data = parsed["payload_bytes"]
                    if audio_data:
                        yield TTSChunk(
                            audio_data=audio_data,
                            event_type="audio",
                        )
                    continue

                if event == Event.TTS_RESPONSE:
                    audio_data = parsed["payload_bytes"]
                    if audio_data:
                        yield TTSChunk(
                            audio_data=audio_data,
                            event_type="audio",
                        )

                elif event == Event.TTS_SENTENCE_START:
                    payload_json = parsed.get("payload_json", {})
                    text = ""
                    if payload_json:
                        res_params = payload_json.get("res_params", {})
                        text = res_params.get("text", "")
                    yield TTSChunk(
                        audio_data=b"",
                        sentence=TTSSentence(text=text) if text else None,
                        event_type="sentence_start",
                    )

                elif event == Event.TTS_SENTENCE_END:
                    payload_json = parsed.get("payload_json", {})
                    sentence = self._parse_sentence_payload(payload_json)
                    yield TTSChunk(
                        audio_data=b"",
                        sentence=sentence,
                        event_type="sentence_end",
                    )

                elif event == Event.TTS_SUBTITLE:
                    payload_json = parsed.get("payload_json", {})
                    sentence = self._parse_sentence_payload(payload_json)
                    yield TTSChunk(
                        audio_data=b"",
                        sentence=sentence,
                        event_type="subtitle",
                    )

                elif event == Event.SESSION_FINISHED:
                    yield TTSChunk(
                        audio_data=b"",
                        is_last=True,
                        event_type="done",
                    )
                    return

                elif event == Event.SESSION_FAILED:
                    payload_json = parsed.get("payload_json", {})
                    raise TTSUpstreamError(f"WS TTS SessionFailed: {payload_json}")

            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED):
                yield TTSChunk(audio_data=b"", is_last=True, event_type="done")
                return
            elif msg.type == aiohttp.WSMsgType.ERROR:
                raise TTSUpstreamError(f"WS TTS 错误: {ws.exception()}")

    @staticmethod
    def _parse_sentence_payload(payload_json: Optional[dict]) -> Optional[TTSSentence]:
        """解析 TTSSentenceEnd / TTSSubtitle 事件中的文本与词级时间戳"""
        if not payload_json:
            return None
        res_params = payload_json.get("res_params", {})
        text = res_params.get("text", "")
        words = [
            TTSWordTimestamp(
                word=w.get("word", ""),
                start_time=float(w.get("startTime", 0)),
                end_time=float(w.get("endTime", 0)),
                confidence=float(w.get("confidence", 0)),
            )
            for w in res_params.get("words", [])
        ]
        return TTSSentence(text=text, words=words) if (text or words) else None

    def get_provider_info(self) -> dict[str, Any]:
        return {
            "provider": self.provider_name,
            "mode": "ws_bidirectional",
            "protocol": "V3 WS Bidirectional",
            "resource_id": self.resource_id,
        }
