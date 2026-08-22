"""
ResultValidator — 结果校验

embedding 维度校验 → E22
chat finish_reason 合法性校验
vision json_object 格式返回值类型校验
asr / tts 基本合理性校验
"""

from __future__ import annotations

import logging

from apps.services.llm.scenes.exceptions import EmbeddingDimensionMismatch

logger = logging.getLogger(__name__)

_VALID_FINISH_REASONS = frozenset({"stop", "length", "content_filter", "tool_calls", "error"})


def validate_embedding_result(
    *,
    vectors: list[list[float]],
    expected_dimensions: int | None,
    scene_key: str,
) -> None:
    """校验 embedding 向量维度。"""
    if not vectors or expected_dimensions is None:
        return

    actual_dim = len(vectors[0])
    if actual_dim != expected_dimensions:
        raise EmbeddingDimensionMismatch(
            f"scene_key='{scene_key}' 期望 {expected_dimensions} 维，"
            f"实际返回 {actual_dim} 维",
            scene_key=scene_key,
            expected=expected_dimensions,
            actual=actual_dim,
        )


def validate_chat_result(
    *,
    content: str,
    finish_reason: str = "stop",
    scene_key: str,
) -> None:
    """chat 结果校验：finish_reason 必须在合法值集合内。"""
    if finish_reason and finish_reason not in _VALID_FINISH_REASONS:
        logger.warning(
            "chat result finish_reason='%s' 不在合法集合 %s 中 (scene_key='%s')",
            finish_reason, _VALID_FINISH_REASONS, scene_key,
        )


def validate_transcribe_result(
    *,
    text: str,
    duration_sec: float,
    scene_key: str,
) -> None:
    """asr 结果校验：文本非空且时长合理。"""
    if duration_sec < 0:
        logger.warning(
            "transcribe result duration_sec=%.2f < 0 (scene_key='%s')",
            duration_sec, scene_key,
        )
    if not text and duration_sec > 1.0:
        logger.warning(
            "transcribe result text is empty but duration_sec=%.2f > 1s (scene_key='%s')",
            duration_sec, scene_key,
        )


def validate_synthesize_result(
    *,
    audio: bytes | str,
    duration_sec: float,
    scene_key: str,
) -> None:
    """tts 结果校验：音频数据非空且时长合理。"""
    if not audio:
        logger.warning(
            "synthesize result audio is empty (scene_key='%s')", scene_key,
        )
    if duration_sec < 0:
        logger.warning(
            "synthesize result duration_sec=%.2f < 0 (scene_key='%s')",
            duration_sec, scene_key,
        )


def validate_vision_result(
    *,
    content: str | dict,
    scene_key: str,
    response_format: str = "text",
) -> None:
    """校验 Vision 既有 JSON contract；失败必须阻止最终结算。"""
    if response_format == "json_object" and not isinstance(content, dict):
        raise ValueError(
            "vision result response_format='json_object' 但返回类型为 "
            f"{type(content).__name__} (scene_key='{scene_key}')"
        )
    if scene_key == "vision_parse_document" and isinstance(content, dict):
        blocks = content.get("blocks")
        if not isinstance(blocks, list) or not blocks:
            raise ValueError("vision_parse_document 结果缺少非空 blocks 数组")
        if any(not isinstance(block, dict) for block in blocks):
            raise ValueError("vision_parse_document blocks 元素必须为对象")
