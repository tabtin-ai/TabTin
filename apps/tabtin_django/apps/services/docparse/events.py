"""
DocParse WebSocket 事件推送

通过 WS Gateway 向前端推送解析状态变更事件。

事件类型：
- docparse.progress  — 解析进度更新（每页完成后）
- docparse.completed — 解析完成
- docparse.failed    — 解析失败

前端订阅 topic: docparse.events.{file_record_id}
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def publish_parse_progress(
    file_record_id: str,
    parsed_pages: int,
    total_pages: int,
) -> None:
    """推送解析进度。"""
    _publish(
        file_record_id,
        "docparse.progress",
        {
            "file_record_id": file_record_id,
            "parsed_pages": parsed_pages,
            "total_pages": total_pages,
        },
    )


def publish_parse_completed(
    file_record_id: str,
    total_pages: int,
    parse_method: str = "",
    title: str = "",
) -> None:
    """推送解析完成。"""
    _publish(
        file_record_id,
        "docparse.completed",
        {
            "file_record_id": file_record_id,
            "total_pages": total_pages,
            "parse_method": parse_method,
            "title": title,
        },
    )


def publish_parse_failed(
    file_record_id: str,
    error: str = "",
    failure_code: str = "",
) -> None:
    """推送解析失败。

    W1 / L9：补 failure_code 字段（与 ParsedDocument.FailureCode 13 类 SSoT 对齐），
    让前端 WebSocket 监听者能按 failure_code 路由到 i18n 文案，而不是裸 message
    自己解析关键词。
    """
    _publish(
        file_record_id,
        "docparse.failed",
        {
            "file_record_id": file_record_id,
            "error": error[:500],
            "failure_code": failure_code,
        },
    )


def _publish(file_record_id: str, event_type: str, payload: dict) -> None:
    try:
        from apps.services.common.ws.bus import publish_ws_event
        from apps.services.common.ws.protocol import build_envelope, new_event_id

        topic = f"docparse.events.{file_record_id}"
        envelope = build_envelope(
            event_type,
            new_event_id(),
            payload,
        )
        publish_ws_event(topic, envelope)
    except Exception as exc:
        logger.debug("docparse 事件推送失败: %s", exc)
