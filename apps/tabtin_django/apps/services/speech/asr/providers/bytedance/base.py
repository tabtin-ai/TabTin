"""
字节跳动 ASR 公共基础

包含三种模式共用的：
  - 认证 Header 构造
  - 统一的响应解析 → ASRResult
  - 错误码映射
  - 二进制协议常量（WebSocket 模式）
"""

from __future__ import annotations

import gzip
import json
import logging
import struct
import uuid
from typing import Any, Optional

from ...types import (
    ASRAudioInfo,
    ASRResult,
    ASRStreamEvent,
    ASRUtterance,
    ASRWord,
)

logger = logging.getLogger(__name__)

# ── 字节跳动 ASR 端点 ─────────────────────────────────────────────
FLASH_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit"
QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query"

# WebSocket 端点
WS_BIGMODEL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"
WS_BIGMODEL_ASYNC = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
WS_BIGMODEL_NOSTREAM = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream"

WS_ENDPOINTS: dict[str, str] = {
    "bigmodel": WS_BIGMODEL,
    "bigmodel_async": WS_BIGMODEL_ASYNC,
    "bigmodel_nostream": WS_BIGMODEL_NOSTREAM,
}
VALID_WS_ENDPOINT_KEYS: frozenset[str] = frozenset(WS_ENDPOINTS.keys())

# ── Resource ID ───────────────────────────────────────────────────
RESOURCE_ID_FLASH = "volc.bigasr.auc_turbo"
RESOURCE_ID_AUC_V1 = "volc.bigasr.auc"
RESOURCE_ID_AUC_V2 = "volc.seedasr.auc"
RESOURCE_ID_SAUC_DURATION = "volc.bigasr.sauc.duration"
RESOURCE_ID_SAUC_CONCURRENT = "volc.bigasr.sauc.concurrent"
RESOURCE_ID_SAUC_V2_DURATION = "volc.seedasr.sauc.duration"
RESOURCE_ID_SAUC_V2_CONCURRENT = "volc.seedasr.sauc.concurrent"

# ── 错误码 ────────────────────────────────────────────────────────
BYTEDANCE_STATUS_SUCCESS = "20000000"
BYTEDANCE_STATUS_PROCESSING = "20000001"
BYTEDANCE_STATUS_QUEUED = "20000002"
BYTEDANCE_STATUS_SILENT = "20000003"

STATUS_CODE_MAP = {
    "20000000": "completed",
    "20000001": "processing",
    "20000002": "queued",
    "20000003": "silent",
    "45000001": "failed",
    "45000002": "failed",
    "45000081": "failed",
    "45000151": "failed",
    "55000031": "failed",
}


def resolve_status_code(code: str | int) -> str:
    """解析字节跳动 ASR 状态码，支持精确匹配和 550xxxxx 前缀通配。"""
    code_str = str(code)
    status = STATUS_CODE_MAP.get(code_str)
    if status:
        return status
    if code_str.startswith("55"):
        return "failed"
    return "unknown"

# ── WebSocket 二进制协议常量 ──────────────────────────────────────

class ProtocolVersion:
    V1 = 0b0001

class MessageType:
    CLIENT_FULL_REQUEST = 0b0001
    CLIENT_AUDIO_ONLY = 0b0010
    SERVER_FULL_RESPONSE = 0b1001
    SERVER_ERROR_RESPONSE = 0b1111

class MessageFlags:
    NO_SEQUENCE = 0b0000
    POS_SEQUENCE = 0b0001
    NEG_SEQUENCE = 0b0010
    NEG_WITH_SEQUENCE = 0b0011

class SerializationType:
    NONE = 0b0000
    JSON = 0b0001

class CompressionType:
    NONE = 0b0000
    GZIP = 0b0001


# ── 语言代码映射（字节跳动 → 标准） ────────────────────────────────
LANGUAGE_MAP = {
    "": "auto",
    "zh-CN": "zh",
    "en-US": "en",
    "ja-JP": "ja",
    "ko-KR": "ko",
    "id-ID": "id",
    "es-MX": "es",
    "pt-BR": "pt",
    "de-DE": "de",
    "fr-FR": "fr",
    "fil-PH": "fil",
    "ms-MY": "ms",
    "th-TH": "th",
    "ar-SA": "ar",
}


def build_auth_headers(
    *,
    app_id: str,
    access_token: str,
    resource_id: str,
    request_id: Optional[str] = None,
    sequence: Optional[str] = None,
    connect_id: Optional[str] = None,
) -> dict[str, str]:
    """
    构造字节跳动 ASR 认证 Header（Bearer Token 模式）。

    当前不使用 secret_key；若需 HMAC 签名认证，需扩展此函数。
    """
    headers: dict[str, str] = {
        "X-Api-App-Key": app_id,
        "X-Api-Access-Key": access_token,
        "X-Api-Resource-Id": resource_id,
    }
    if request_id:
        headers["X-Api-Request-Id"] = request_id
    if sequence is not None:
        headers["X-Api-Sequence"] = sequence
    if connect_id:
        headers["X-Api-Connect-Id"] = connect_id
    return headers


def new_request_id() -> str:
    return str(uuid.uuid4())


def build_request_params(**kwargs: Any) -> dict[str, Any]:
    """
    构建 request 字段中的可选参数。
    仅包含显式传入的参数，未传入的不写入（使用服务端默认值）。
    """
    field_map = {
        "model_name": "model_name",
        "model_version": "model_version",
        "enable_itn": "enable_itn",
        "enable_punc": "enable_punc",
        "enable_ddc": "enable_ddc",
        "enable_speaker_info": "enable_speaker_info",
        "enable_channel_split": "enable_channel_split",
        "show_utterances": "show_utterances",
        "show_speech_rate": "show_speech_rate",
        "show_volume": "show_volume",
        "enable_lid": "enable_lid",
        "enable_emotion_detection": "enable_emotion_detection",
        "enable_gender_detection": "enable_gender_detection",
        "vad_segment": "vad_segment",
        "end_window_size": "end_window_size",
        "sensitive_words_filter": "sensitive_words_filter",
        "enable_poi_fc": "enable_poi_fc",
        "enable_music_fc": "enable_music_fc",
        "enable_nonstream": "enable_nonstream",
        "result_type": "result_type",
        "enable_accelerate_text": "enable_accelerate_text",
        "accelerate_score": "accelerate_score",
        "vad_segment_duration": "vad_segment_duration",
        "force_to_speech_time": "force_to_speech_time",
        "ssd_version": "ssd_version",
    }
    params: dict[str, Any] = {}
    for key, api_key in field_map.items():
        if key in kwargs and kwargs[key] is not None:
            params[api_key] = kwargs[key]
    return params


def build_corpus_params(**kwargs: Any) -> Optional[dict[str, Any]]:
    """构建 corpus（热词/上下文）参数"""
    corpus: dict[str, Any] = {}
    if kwargs.get("boosting_table_name"):
        corpus["boosting_table_name"] = kwargs["boosting_table_name"]
    if kwargs.get("boosting_table_id"):
        corpus["boosting_table_id"] = kwargs["boosting_table_id"]
    if kwargs.get("correct_table_name"):
        corpus["correct_table_name"] = kwargs["correct_table_name"]
    if kwargs.get("correct_table_id"):
        corpus["correct_table_id"] = kwargs["correct_table_id"]
    if kwargs.get("context"):
        corpus["context"] = kwargs["context"]
    return corpus if corpus else None


def _parse_utterances(
    result_data: dict[str, Any],
    *,
    definite_default: bool = True,
) -> list[ASRUtterance]:
    """从字节跳动 ASR result 字段解析 utterance/word 列表（共用逻辑）"""
    utterances: list[ASRUtterance] = []
    for utt in result_data.get("utterances", []):
        words = [
            ASRWord(
                text=w.get("text", ""),
                start_time=w.get("start_time", 0),
                end_time=w.get("end_time", 0),
                confidence=w.get("confidence", 0.0),
                blank_duration=w.get("blank_duration", 0),
            )
            for w in utt.get("words", [])
        ]
        utterances.append(ASRUtterance(
            text=utt.get("text", ""),
            start_time=utt.get("start_time", 0),
            end_time=utt.get("end_time", 0),
            definite=utt.get("definite", definite_default),
            words=words,
            speaker_id=utt.get("speaker_id"),
            additions=utt.get("additions", {}),
        ))
    return utterances


def parse_asr_response(
    data: dict[str, Any],
    *,
    provider: str = "bytedance",
    mode: str = "flash",
) -> ASRResult:
    """将字节跳动 ASR 响应 JSON 解析为统一 ASRResult"""
    result_data = data.get("result", {})
    audio_info_data = data.get("audio_info", {})

    return ASRResult(
        text=result_data.get("text", ""),
        utterances=_parse_utterances(result_data, definite_default=True),
        audio_info=ASRAudioInfo(duration=audio_info_data.get("duration", 0)),
        provider=provider,
        mode=mode,
        raw_response=data,
    )


def build_ws_header(
    message_type: int,
    flags: int,
    serialization: int = SerializationType.JSON,
    compression: int = CompressionType.GZIP,
) -> bytes:
    """构造 4 字节 WS 帧头"""
    h = bytearray(4)
    h[0] = (ProtocolVersion.V1 << 4) | 1
    h[1] = (message_type << 4) | flags
    h[2] = (serialization << 4) | compression
    h[3] = 0x00
    return bytes(h)


def build_full_client_request(
    *,
    app_id: str,
    audio_format: str,
    sample_rate: int,
    language: str = "",
    ws_endpoint: str = "",
    seq: int = 1,
    extra_params: Optional[dict[str, Any]] = None,
) -> bytes:
    """构造流式 ASR FullClientRequest 帧（初始配置包）"""
    request_params: dict[str, Any] = {"model_name": "bigmodel"}
    defaults: dict[str, Any] = {
        "enable_itn": True,
        "enable_punc": True,
        "show_utterances": True,
    }
    if extra_params:
        defaults.update(extra_params)
    extra = build_request_params(**defaults)
    request_params.update(extra)

    corpus = build_corpus_params(**(extra_params or {}))
    if corpus:
        request_params["corpus"] = corpus

    audio_config: dict[str, Any] = {
        "format": audio_format,
        "rate": sample_rate,
        "bits": 16,
        "channel": 1,
        "codec": "opus" if audio_format == "ogg" else "raw",
    }
    if language and ws_endpoint in ("bigmodel_nostream", ""):
        audio_config["language"] = language

    payload = {
        "user": {"uid": app_id},
        "audio": audio_config,
        "request": request_params,
    }

    payload_bytes = json.dumps(payload).encode("utf-8")
    compressed = gzip.compress(payload_bytes)

    header = build_ws_header(
        MessageType.CLIENT_FULL_REQUEST,
        MessageFlags.POS_SEQUENCE,
    )
    packet = bytearray()
    packet.extend(header)
    packet.extend(struct.pack(">i", seq))
    packet.extend(struct.pack(">I", len(compressed)))
    packet.extend(compressed)
    return bytes(packet)


def build_audio_packet(
    seq: int,
    segment: bytes,
    is_last: bool = False,
) -> bytes:
    """构造音频数据帧"""
    if is_last:
        flags = MessageFlags.NEG_WITH_SEQUENCE
        seq = -seq
    else:
        flags = MessageFlags.POS_SEQUENCE

    header = build_ws_header(
        MessageType.CLIENT_AUDIO_ONLY,
        flags,
        serialization=SerializationType.NONE,
        compression=CompressionType.GZIP,
    )
    compressed = gzip.compress(segment)

    packet = bytearray()
    packet.extend(header)
    packet.extend(struct.pack(">i", seq))
    packet.extend(struct.pack(">I", len(compressed)))
    packet.extend(compressed)
    return bytes(packet)


def parse_ws_binary_frame(data: bytes) -> Optional[dict[str, Any]]:
    """
    解析字节跳动 ASR WebSocket 二进制响应帧。

    统一的底层协议解析，被 streaming.py (Provider 层) 和
    asr_stream.py (WS handler 层) 共同复用，避免重复实现。

    Returns:
        None — 帧太短或不可识别
        {"error": str, "error_code": int, "is_final": True} — 错误帧
        {"json_data": dict, "is_final": bool, "sequence": int} — 正常 JSON 响应
        {"json_data": None, "is_final": bool, "sequence": int} — 空/不可解析
    """
    if len(data) < 4:
        return None

    header_size = data[0] & 0x0F
    message_type = data[1] >> 4
    flags = data[1] & 0x0F
    serialization = data[2] >> 4
    compression = data[2] & 0x0F

    payload = data[header_size * 4:]
    sequence = 0
    is_final = False

    if flags & 0x01:
        if len(payload) < 4:
            return None
        sequence = struct.unpack(">i", payload[:4])[0]
        payload = payload[4:]
    if flags & 0x02:
        is_final = True

    if message_type == MessageType.SERVER_ERROR_RESPONSE:
        if len(payload) < 8:
            return None
        error_code = struct.unpack(">i", payload[:4])[0]
        error_size = struct.unpack(">I", payload[4:8])[0]
        error_body = payload[8:8 + error_size]
        if compression == CompressionType.GZIP:
            try:
                error_body = gzip.decompress(error_body)
            except Exception:
                pass
        return {
            "error": error_body.decode("utf-8", errors="replace"),
            "error_code": error_code,
            "is_final": True,
        }

    if message_type != MessageType.SERVER_FULL_RESPONSE:
        return None

    if not payload:
        return {"json_data": None, "is_final": is_final, "sequence": sequence}

    if len(payload) < 4:
        return {"json_data": None, "is_final": is_final, "sequence": sequence}

    payload_size = struct.unpack(">I", payload[:4])[0]
    payload = payload[4:4 + payload_size]

    if compression == CompressionType.GZIP:
        try:
            payload = gzip.decompress(payload)
        except Exception:
            return {"json_data": None, "is_final": is_final, "sequence": sequence}

    if serialization == SerializationType.JSON:
        try:
            json_data = json.loads(payload.decode("utf-8"))
            return {"json_data": json_data, "is_final": is_final, "sequence": sequence}
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {"json_data": None, "is_final": is_final, "sequence": sequence}

    return {"json_data": None, "is_final": is_final, "sequence": sequence}


def parse_stream_event(
    data: dict[str, Any],
    *,
    is_final: bool = False,
    sequence: int = 0,
) -> ASRStreamEvent:
    """将字节跳动流式响应 JSON 解析为 ASRStreamEvent"""
    result_data = data.get("result", {})
    audio_info_data = data.get("audio_info", {})

    return ASRStreamEvent(
        text=result_data.get("text", ""),
        utterances=_parse_utterances(result_data, definite_default=False),
        is_final=is_final,
        sequence=sequence,
        audio_info=ASRAudioInfo(duration=audio_info_data.get("duration", 0)),
    )
