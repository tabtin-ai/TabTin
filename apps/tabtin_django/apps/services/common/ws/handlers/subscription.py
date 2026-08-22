"""
Subscribe / unsubscribe handlers.

Delegates per-topic validation to the validator registry.
Extracted from GatewayConsumer._handle_subscribe / _handle_unsubscribe.
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from channels.db import database_sync_to_async

from ..protocol import (
    ERROR_PERMISSION_DENIED,
    ERROR_INTERNAL,
    ERROR_SCHEMA_INVALID,
    ERROR_SUBSCRIPTION_LIMIT,
    ERROR_TYPE_UNKNOWN,
    MAX_SUBSCRIPTIONS_PER_CONNECTION,
    build_envelope,
    resolve_required_capability,
)
from ..event_buffer import get_event_buffer
from ..metrics import ws_subscription_count
from .subscription_validators import resolve_validator

logger = logging.getLogger(__name__)


def _topic_prefix(topic: str) -> str:
    """Extract a stable prefix for Gauge labelling (first two segments)."""
    parts = topic.split(".", 3)
    return ".".join(parts[:2]) if len(parts) >= 2 else topic


def create_subscribe_handler(consumer):
    """Factory: returns the subscribe handler bound to *consumer*."""

    async def handle_subscribe(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope["payload"]
        topics = payload.get("topics")

        if not isinstance(topics, list) or not topics:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "topics must be a non-empty list")
            return

        # G-049: 订阅数限制检查 — 仅计入尚未订阅的 topic，避免误拒已订阅 topic
        new_topic_count = sum(1 for t in topics if t not in consumer.subscriptions)
        if len(consumer.subscriptions) + new_topic_count > MAX_SUBSCRIPTIONS_PER_CONNECTION:
            await consumer._send_error(
                request_id, ERROR_SUBSCRIPTION_LIMIT,
                f"too many subscriptions (max {MAX_SUBSCRIPTIONS_PER_CONNECTION})",
            )
            return

        # G-048: per-topic filter/rls context for table.open.* subscriptions.
        # Build a dict keyed by topic so different tables can have independent filter/rls.
        # Falls back to a shared context for backward compat when per-topic config is absent.
        # Also used by share.events.* for share_collab_token.
        shared_open_table_ctx: dict | None = None
        per_topic_ctx: dict[str, dict] = {}
        if payload.get("filter") is not None or payload.get("rls") is not None:
            shared_ctx: dict = {}
            if payload.get("filter") is not None:
                shared_ctx["filter"] = payload["filter"]
            if payload.get("rls") is not None:
                shared_ctx["rls"] = payload["rls"]
            shared_open_table_ctx = shared_ctx
        topic_contexts = payload.get("topic_contexts")
        if isinstance(topic_contexts, dict):
            for t, ctx in topic_contexts.items():
                if isinstance(ctx, dict):
                    per_topic_ctx[t] = ctx
        consumer._pending_open_table_ctx = None
        consumer._pending_topic_contexts = per_topic_ctx

        # Phase 1: validate all topics before any side effects (P-01 atomicity fix)
        validated_topics: list[tuple[str, Any]] = []
        try:
            for topic in topics:
                if not isinstance(topic, str):
                    await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid topic")
                    return

                required = resolve_required_capability(topic)
                if not required:
                    await consumer._send_error(
                        request_id,
                        ERROR_TYPE_UNKNOWN,
                        f"unknown topic: {topic}",
                        details={"topic": topic},
                    )
                    return

                if consumer.role == "channel" and not topic.startswith("channel."):
                    await consumer._send_error(
                        request_id,
                        ERROR_PERMISSION_DENIED,
                        "channel role restricted to channel.* topics",
                        details={"topic": topic},
                    )
                    return

                if required not in consumer.capabilities:
                    await consumer._send_error(
                        request_id,
                        ERROR_PERMISSION_DENIED,
                        f"topic not allowed: {topic}",
                        details={"topic": topic},
                    )
                    return

                if topic.startswith("table.open."):
                    consumer._pending_open_table_ctx = per_topic_ctx.get(topic, shared_open_table_ctx)

                validator = resolve_validator(topic)
                if validator:
                    parts = topic.split(".", 2)
                    error_msg = await validator.validate(consumer, topic, parts)
                    if error_msg:
                        if error_msg.startswith("DENIED:"):
                            error_code = ERROR_PERMISSION_DENIED
                            error_msg = error_msg[7:].strip()
                        elif error_msg.startswith("INVALID:"):
                            error_code = ERROR_SCHEMA_INVALID
                            error_msg = error_msg[8:].strip()
                        else:
                            _msg_lower = error_msg.lower()
                            error_code = ERROR_PERMISSION_DENIED if any(
                                kw in _msg_lower for kw in ("denied", "not allowed", "mismatch", "bound", "forbidden", "unauthorized")
                            ) else ERROR_SCHEMA_INVALID
                        await consumer._send_error(
                            request_id,
                            error_code,
                            error_msg,
                            details={"topic": topic},
                        )
                        return

                validated_topics.append((topic, validator))
        finally:
            consumer._pending_open_table_ctx = None
            consumer._pending_topic_contexts = None

        # Phase 2: all topics validated — execute subscriptions
        subscription_boundaries = getattr(consumer, "subscription_boundaries", None)
        if subscription_boundaries is None:
            subscription_boundaries = {}
            consumer.subscription_boundaries = subscription_boundaries
        topics_missing_boundary = [
            topic for topic, _validator in validated_topics
            if topic not in subscription_boundaries
        ]
        if topics_missing_boundary:
            captured = await database_sync_to_async(
                get_event_buffer().capture_subscription_boundaries
            )(topics_missing_boundary)
            if len(captured) != len(topics_missing_boundary):
                await consumer._send_error(
                    request_id,
                    ERROR_INTERNAL,
                    "subscription boundary unavailable",
                )
                return
            subscription_boundaries.update(captured)

        accepted: list[str] = []
        try:
            for topic, validator in validated_topics:
                if topic in consumer.subscriptions:
                    logger.debug("[WS] topic %s already subscribed, skipping duplicate", topic)
                    accepted.append(topic)
                    continue

                if topic.startswith("table.open."):
                    consumer._pending_open_table_ctx = per_topic_ctx.get(topic, shared_open_table_ctx)

                await consumer._join_group(f"topic.{topic}")
                consumer.subscriptions.add(topic)
                accepted.append(topic)

                ws_subscription_count.labels(topic_prefix=_topic_prefix(topic)).inc()

                if validator:
                    await validator.on_subscribed(consumer, topic)

                logger.info("[WS Gateway] ✅ subscribed topic=%s, user=%s", topic, consumer.user_id)
        finally:
            consumer._pending_open_table_ctx = None

        response = build_envelope("subscribe.ok", request_id, {
            "topics": accepted,
            "boundary_cursors": {
                topic: subscription_boundaries[topic]
                for topic in accepted
            },
        })
        await consumer._send_envelope(response)
        await consumer._refresh_runtime_snapshot()

    return handle_subscribe


def create_unsubscribe_handler(consumer):
    """Factory: returns the unsubscribe handler bound to *consumer*."""

    async def handle_unsubscribe(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        topics = envelope["payload"].get("topics")

        if not isinstance(topics, list) or not topics:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "topics must be a non-empty list")
            return

        removed: list[str] = []
        for topic in topics:
            if topic in consumer.subscriptions:
                await consumer._leave_group(f"topic.{topic}")
                consumer.subscriptions.discard(topic)
                subscription_boundaries = getattr(consumer, "subscription_boundaries", None)
                if subscription_boundaries is not None:
                    subscription_boundaries.pop(topic, None)
                removed.append(topic)
                # G-074: track subscription count
                ws_subscription_count.labels(topic_prefix=_topic_prefix(topic)).dec()
                # G-053: 通用 on_unsubscribed 钩子 — 新增 topic 类型无需修改主流程
                validator = resolve_validator(topic)
                if validator and hasattr(validator, 'on_unsubscribed'):
                    try:
                        await validator.on_unsubscribed(consumer, topic)
                    except Exception as exc:
                        logger.debug("[WS] on_unsubscribed hook failed for topic=%s: %s", topic, exc)
                # Clean up per-topic filter/RLS context for table.open.* topics
                open_subs = getattr(consumer, '_open_table_subscriptions', None)
                if open_subs and topic in open_subs:
                    del open_subs[topic]

        response = build_envelope("unsubscribe.ok", request_id, {"topics": removed})
        await consumer._send_envelope(response)
        await consumer._refresh_runtime_snapshot()

    return handle_unsubscribe
