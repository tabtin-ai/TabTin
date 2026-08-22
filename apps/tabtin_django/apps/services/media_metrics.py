"""多模态 AI 服务 Prometheus 指标。

覆盖 TTS、ASR、图片/视频生成、BGM 生成等非 LLM 模态。
与 llm_metrics.py 设计对齐：prometheus_client 不可用时静默降级为空操作。
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


class _NullMetric:
    """prometheus_client 不可用时的静默降级。"""

    def labels(self, **kwargs):
        return self

    def inc(self, amount=1):
        pass

    def observe(self, value):
        pass

    def set(self, value):
        pass


def _null():
    return _NullMetric()


try:
    from prometheus_client import Counter, Histogram

    # ── TTS ──────────────────────────────────────────────────────────
    tts_calls_total = Counter(
        "tts_calls_total",
        "TTS 调用次数",
        ["provider", "voice", "status"],
    )
    tts_duration_seconds = Histogram(
        "tts_duration_seconds",
        "TTS 合成延迟（秒）",
        ["provider"],
        buckets=[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
    )
    tts_characters_total = Counter(
        "tts_characters_total",
        "TTS 合成字符数",
        ["provider", "voice"],
    )

    # ── ASR ──────────────────────────────────────────────────────────
    asr_calls_total = Counter(
        "asr_calls_total",
        "ASR 转写调用次数",
        ["provider", "status"],
    )
    asr_duration_seconds = Histogram(
        "asr_duration_seconds",
        "ASR 转写延迟（秒）",
        ["provider"],
        buckets=[0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0],
    )
    asr_audio_seconds_total = Counter(
        "asr_audio_seconds_total",
        "ASR 处理音频总时长（秒）",
        ["provider"],
    )

    # ── 图片/视频生成 ────────────────────────────────────────────────
    media_gen_calls_total = Counter(
        "media_gen_calls_total",
        "媒体生成调用次数",
        ["provider", "model", "media_type", "status"],
    )
    media_gen_duration_seconds = Histogram(
        "media_gen_duration_seconds",
        "媒体生成端到端耗时（秒）",
        ["provider", "media_type"],
        buckets=[1.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0],
    )
    media_gen_cost_total = Counter(
        "media_gen_cost_total",
        "媒体生成成本（点券）",
        ["provider", "media_type"],
    )

    # ── BGM ──────────────────────────────────────────────────────────
    bgm_calls_total = Counter(
        "bgm_calls_total",
        "BGM 生成调用次数",
        ["provider", "status"],
    )
    bgm_duration_seconds = Histogram(
        "bgm_duration_seconds",
        "BGM 生成耗时（秒）",
        ["provider"],
        buckets=[1.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0],
    )
    bgm_audio_seconds_total = Counter(
        "bgm_audio_seconds_total",
        "BGM 生成音频总时长（秒）",
        ["provider"],
    )

except Exception as _exc:  # noqa: BLE001
    logger.warning("[MediaMetrics] prometheus_client 不可用，指标已降级为空操作: %s", _exc)
    tts_calls_total = _null()
    tts_duration_seconds = _null()
    tts_characters_total = _null()
    asr_calls_total = _null()
    asr_duration_seconds = _null()
    asr_audio_seconds_total = _null()
    media_gen_calls_total = _null()
    media_gen_duration_seconds = _null()
    media_gen_cost_total = _null()
    bgm_calls_total = _null()
    bgm_duration_seconds = _null()
    bgm_audio_seconds_total = _null()
