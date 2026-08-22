"""
字节跳动 TTS 公共基础

包含 HTTP 单向和 WS 双向共用的：
  - 端点 URL / Resource ID 常量
  - 认证 Header 构造
  - V3 WS 二进制帧编解码
  - 事件码定义
  - 错误码映射
"""

from __future__ import annotations

import gzip
import json
import logging
import struct
import uuid
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ── 端点 URL ──────────────────────────────────────────────────────
HTTP_UNIDIRECTIONAL_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
WS_BIDIRECTIONAL_URL = "wss://openspeech.bytedance.com/api/v3/tts/bidirection"

# ── Resource ID ───────────────────────────────────────────────────
RESOURCE_TTS_10 = "seed-tts-1.0"
RESOURCE_TTS_10_CONCURR = "seed-tts-1.0-concurr"
RESOURCE_TTS_20 = "seed-tts-2.0"
RESOURCE_TTS_30 = "seed-tts-3.0"
RESOURCE_ICL_10 = "seed-icl-1.0"
RESOURCE_ICL_10_CONCURR = "seed-icl-1.0-concurr"
RESOURCE_ICL_20 = "seed-icl-2.0"

# ── 默认值 ────────────────────────────────────────────────────────
DEFAULT_SPEAKER = "zh_female_vv_uranus_bigtts"
DEFAULT_MODEL = ""
DEFAULT_FORMAT = "mp3"
DEFAULT_SAMPLE_RATE = 24000

# ── 错误码 ────────────────────────────────────────────────────────
CODE_SUCCESS = 20000000
CODE_TEXT_TOO_LONG = 40402003
CODE_CLIENT_ERROR = 45000000
CODE_CLIENT_PARAM_ERROR = 45000001
CODE_SERVER_ERROR = 55000000
CODE_SERVER_SESSION_ERROR = 55000001

ERROR_CODE_MAP = {
    20000000: "success",
    40402003: "text_too_long",
    45000000: "client_error",
    45000001: "param_error",
    55000000: "server_error",
    55000001: "session_error",
}

SUBTITLE_RESOURCE_PREFIXES = (RESOURCE_TTS_20, RESOURCE_TTS_30)


def supports_subtitle_resource(resource_id: str) -> bool:
    """Return whether the resource uses subtitle timestamps instead of plain timestamps."""
    return str(resource_id or "").startswith(SUBTITLE_RESOURCE_PREFIXES)

# ── WS 二进制协议常量 ─────────────────────────────────────────────

PROTOCOL_VERSION = 0b0001
HEADER_SIZE_UNIT = 0b0001  # 4 bytes


class MsgType:
    FULL_CLIENT_REQUEST = 0b0001
    SERVER_FULL_RESPONSE = 0b1001
    SERVER_AUDIO_ONLY = 0b1011
    SERVER_ERROR = 0b1111


class MsgFlags:
    WITH_EVENT = 0b0100
    NONE = 0b0000


class Serialization:
    RAW = 0b0000
    JSON = 0b0001


class Compression:
    NONE = 0b0000
    GZIP = 0b0001


class Event:
    """WS 双向流式事件码"""
    # 上行 - 连接类
    START_CONNECTION = 1
    FINISH_CONNECTION = 2
    # 下行 - 连接类
    CONNECTION_STARTED = 50
    CONNECTION_FAILED = 51
    CONNECTION_FINISHED = 52
    # 上行 - 会话类
    START_SESSION = 100
    CANCEL_SESSION = 101
    FINISH_SESSION = 102
    # 下行 - 会话类
    SESSION_STARTED = 150
    SESSION_CANCELED = 151
    SESSION_FINISHED = 152
    SESSION_FAILED = 153
    # 上行 - 数据类
    TASK_REQUEST = 200
    # 下行 - 数据类
    TTS_SENTENCE_START = 350
    TTS_SENTENCE_END = 351
    TTS_RESPONSE = 352
    TTS_SUBTITLE = 353


# ── 认证 ──────────────────────────────────────────────────────────


def build_http_auth_headers(
    *,
    app_id: str,
    access_token: str,
    resource_id: str,
    request_id: Optional[str] = None,
) -> dict[str, str]:
    """构造 HTTP 单向 TTS 认证 Header"""
    headers: dict[str, str] = {
        "X-Api-App-Id": app_id,
        "X-Api-Access-Key": access_token,
        "X-Api-Resource-Id": resource_id,
        "Content-Type": "application/json",
    }
    if request_id:
        headers["X-Api-Request-Id"] = request_id
    return headers


def build_ws_auth_headers(
    *,
    app_id: str,
    access_token: str,
    resource_id: str,
    connect_id: Optional[str] = None,
) -> dict[str, str]:
    """构造 WS 双向 TTS 认证 Header"""
    headers: dict[str, str] = {
        "X-Api-App-Key": app_id,
        "X-Api-Access-Key": access_token,
        "X-Api-Resource-Id": resource_id,
    }
    if connect_id:
        headers["X-Api-Connect-Id"] = connect_id
    return headers


def new_connect_id() -> str:
    return str(uuid.uuid4())


# ── 请求参数构造 ──────────────────────────────────────────────────


def build_tts_request_params(
    text: str,
    *,
    speaker: str = DEFAULT_SPEAKER,
    model: str = DEFAULT_MODEL,
    format: str = DEFAULT_FORMAT,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    speed_ratio: float = 1.0,
    volume_ratio: float = 1.0,
    pitch: int = 0,
    emotion: str = "",
    emotion_scale: int = 4,
    enable_timestamp: bool = False,
    enable_subtitle: bool = False,
    context_texts: Optional[list[str]] = None,
    silence_duration: int = 0,
    disable_markdown_filter: bool = False,
    mute_cut_threshold: Optional[str] = None,
    mute_cut_remain_ms: Optional[str] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """构造 TTS 请求参数 (req_params)，HTTP 和 WS 共用"""
    audio_params: dict[str, Any] = {
        "format": format,
        "sample_rate": sample_rate,
    }

    speech_rate = int((speed_ratio - 1.0) * 100)
    speech_rate = max(-50, min(100, speech_rate))
    if speech_rate != 0:
        audio_params["speech_rate"] = speech_rate

    loudness_rate = int((volume_ratio - 1.0) * 100)
    loudness_rate = max(-50, min(100, loudness_rate))
    if loudness_rate != 0:
        audio_params["loudness_rate"] = loudness_rate

    if emotion:
        audio_params["emotion"] = emotion
        audio_params["emotion_scale"] = emotion_scale

    if enable_timestamp:
        audio_params["enable_timestamp"] = True
    if enable_subtitle:
        audio_params["enable_subtitle"] = True

    if format == "pcm":
        audio_params.setdefault("channel", 1)
        audio_params.setdefault("bits", 16)
    elif format in ("mp3", "ogg_opus"):
        audio_params.setdefault("bit_rate", 64000)

    req_params: dict[str, Any] = {
        "text": text,
        "speaker": speaker,
        "audio_params": audio_params,
    }

    if model:
        req_params["model"] = model

    additions: dict[str, Any] = {}
    if silence_duration > 0:
        additions["silence_duration"] = silence_duration
    if disable_markdown_filter:
        additions["disable_markdown_filter"] = True
    if pitch != 0:
        additions["post_process"] = {"pitch": max(-12, min(12, pitch))}
    if context_texts:
        additions["context_texts"] = context_texts

    if mute_cut_threshold is not None:
        additions["mute_cut_threshold"] = mute_cut_threshold
        additions["mute_cut_remain_ms"] = mute_cut_remain_ms or "50"

    if additions:
        req_params["additions"] = json.dumps(additions, ensure_ascii=False)

    return req_params


# ── WS 二进制帧编解码 ────────────────────────────────────────────


_CONNECTION_EVENTS = {
    Event.START_CONNECTION, Event.FINISH_CONNECTION,
    Event.CONNECTION_STARTED, Event.CONNECTION_FAILED, Event.CONNECTION_FINISHED,
}

_CLIENT_NEEDS_SESSION_ID = {
    Event.START_SESSION, Event.CANCEL_SESSION, Event.FINISH_SESSION,
    Event.TASK_REQUEST,
}


def build_ws_frame(
    event: int,
    payload: Optional[dict[str, Any]] = None,
    *,
    session_id: str = "",
    serialization: int = Serialization.JSON,
    compression: int = Compression.NONE,
) -> bytes:
    """
    构造 WS 双向 TTS 上行（客户端）二进制帧。

    帧结构：
      header (4 bytes) + event (4 bytes) +
      [session_id_size + session_id] (会话/数据事件: 100/101/102/200) +
      payload_size (4 bytes) + payload
    """
    byte0 = (PROTOCOL_VERSION << 4) | HEADER_SIZE_UNIT
    byte1 = (MsgType.FULL_CLIENT_REQUEST << 4) | MsgFlags.WITH_EVENT
    byte2 = (serialization << 4) | compression
    byte3 = 0x00

    header = struct.pack(">BBBB", byte0, byte1, byte2, byte3)
    event_bytes = struct.pack(">I", event)

    id_bytes = b""
    if event in _CLIENT_NEEDS_SESSION_ID and session_id:
        sid = session_id.encode("utf-8")
        id_bytes = struct.pack(">I", len(sid)) + sid

    if payload is not None:
        payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if compression == Compression.GZIP:
            payload_bytes = gzip.compress(payload_bytes)
    else:
        payload_bytes = b""

    payload_size = struct.pack(">I", len(payload_bytes))
    return header + event_bytes + id_bytes + payload_size + payload_bytes


def parse_ws_frame(data: bytes) -> dict[str, Any]:
    """
    解析 WS 双向 TTS 下行二进制帧。

    Returns:
        dict with keys: msg_type, event, serialization, compression,
                        payload_bytes, payload_json, error_code
    """
    if len(data) < 4:
        raise ValueError(f"帧太短: {len(data)} bytes")

    byte0, byte1, byte2, byte3 = struct.unpack(">BBBB", data[:4])

    msg_type = (byte1 >> 4) & 0x0F
    msg_flags = byte1 & 0x0F
    serialization = (byte2 >> 4) & 0x0F
    compression = byte2 & 0x0F

    offset = 4
    result: dict[str, Any] = {
        "msg_type": msg_type,
        "msg_flags": msg_flags,
        "serialization": serialization,
        "compression": compression,
        "event": 0,
        "error_code": 0,
        "payload_bytes": b"",
        "payload_json": None,
    }

    if msg_type == MsgType.SERVER_ERROR:
        if len(data) >= 8:
            result["error_code"] = struct.unpack(">I", data[4:8])[0]
            offset = 8
        if offset < len(data):
            payload_size_bytes = data[offset:offset + 4]
            if len(payload_size_bytes) == 4:
                payload_size = struct.unpack(">I", payload_size_bytes)[0]
                offset += 4
                payload_bytes = data[offset:offset + payload_size]
                if compression == Compression.GZIP:
                    payload_bytes = gzip.decompress(payload_bytes)
                result["payload_bytes"] = payload_bytes
                if serialization == Serialization.JSON and payload_bytes:
                    try:
                        result["payload_json"] = json.loads(payload_bytes)
                    except json.JSONDecodeError:
                        pass
        return result

    is_server = msg_type in (
        MsgType.SERVER_FULL_RESPONSE, MsgType.SERVER_AUDIO_ONLY,
    )

    has_event = (msg_flags & MsgFlags.WITH_EVENT) != 0
    if has_event and len(data) >= offset + 4:
        result["event"] = struct.unpack(">I", data[offset:offset + 4])[0]
        offset += 4

    event_val = result["event"]
    if event_val in _CONNECTION_EVENTS and len(data) >= offset + 4:
        cid_size = struct.unpack(">I", data[offset:offset + 4])[0]
        offset += 4
        if cid_size > 0 and len(data) >= offset + cid_size:
            result["connect_id"] = data[offset:offset + cid_size].decode("utf-8", errors="replace")
            offset += cid_size
    elif event_val not in _CONNECTION_EVENTS and event_val != 0:
        # Server responses include session_id for ALL non-connection events
        # (session events + data events like 350/351/352/353)
        if is_server and len(data) >= offset + 4:
            sid_size = struct.unpack(">I", data[offset:offset + 4])[0]
            offset += 4
            if sid_size > 0 and len(data) >= offset + sid_size:
                result["session_id"] = data[offset:offset + sid_size].decode("utf-8", errors="replace")
                offset += sid_size
        elif event_val in _CLIENT_NEEDS_SESSION_ID and len(data) >= offset + 4:
            sid_size = struct.unpack(">I", data[offset:offset + 4])[0]
            offset += 4
            if sid_size > 0 and len(data) >= offset + sid_size:
                result["session_id"] = data[offset:offset + sid_size].decode("utf-8", errors="replace")
                offset += sid_size

    if len(data) >= offset + 4:
        payload_size = struct.unpack(">I", data[offset:offset + 4])[0]
        offset += 4
        payload_bytes = data[offset:offset + payload_size]

        if compression == Compression.GZIP and payload_bytes:
            try:
                payload_bytes = gzip.decompress(payload_bytes)
            except Exception:
                pass

        result["payload_bytes"] = payload_bytes

        if serialization == Serialization.JSON and payload_bytes:
            try:
                result["payload_json"] = json.loads(payload_bytes)
            except json.JSONDecodeError:
                pass
    elif msg_type == MsgType.SERVER_AUDIO_ONLY and len(data) > offset:
        result["payload_bytes"] = data[offset:]

    return result
