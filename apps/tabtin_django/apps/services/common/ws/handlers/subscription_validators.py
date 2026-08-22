"""
Topic subscription validators — one class per topic-type prefix.

Each validator implements:
  - ``validate(consumer, topic, parts)`` → error message or None
  - ``on_subscribed(consumer, topic)``   → optional post-subscribe hook

Extracted from GatewayConsumer._handle_subscribe inline branches.
"""

from __future__ import annotations

import logging
import uuid
from typing import TYPE_CHECKING, Any, Dict, Optional, Protocol

from channels.db import database_sync_to_async

from apps.services.agent_engine.utils.common.thread_id import (
    ALLOWED_THREAD_PREFIXES as _ALLOWED_THREAD_PREFIXES,
    validate_thread_id_prefix,
)

from ..bus import claim_device_action_ready, release_device_action_ready
from ..protocol import ERROR_PERMISSION_DENIED, ERROR_SCHEMA_INVALID
from ..async_io import run_sync_io

if TYPE_CHECKING:
    from ..protocol import GatewayConsumerProtocol

logger = logging.getLogger(__name__)


class TopicValidatorProtocol(Protocol):
    """Topic validator interface."""

    async def validate(self, consumer: Any, topic: str, parts: list[str]) -> Optional[str]:
        """Return error string if invalid, else None."""
        ...

    async def on_subscribed(self, consumer: Any, topic: str) -> None:
        """Called after a successful subscription (optional hook)."""
        ...

    async def on_unsubscribed(self, consumer: Any, topic: str) -> None:
        """G-053: Called after a topic is unsubscribed (optional cleanup hook)."""
        ...


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------

class AgentStreamValidator:
    """agent.stream.{thread_id}

    Organization membership 不足以打开私有执行流：还须通过
    owner-or-shared capability（与 HTTP ``_get_session_with_shared_access`` 同判据）。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing thread_id: {topic}"
        thread_id = parts[2]
        thread_id_error = validate_thread_id_prefix(thread_id, allowed_prefixes=_ALLOWED_THREAD_PREFIXES)
        if thread_id_error:
            return thread_id_error
        if not consumer.organization_ctx:
            return "missing organization context"
        belongs = await self._check_thread_organization(thread_id, consumer)
        if not belongs:
            return "thread access denied"
        topic_contexts = getattr(consumer, "_pending_topic_contexts", None)
        topic_context = (
            topic_contexts.get(topic)
            if isinstance(topic_contexts, dict)
            else None
        )
        session_share_id = None
        if isinstance(topic_context, dict) and "share_id" in topic_context:
            raw_share_id = topic_context.get("share_id")
            if not isinstance(raw_share_id, str) or not raw_share_id.strip():
                return "thread access denied"
            session_share_id = raw_share_id.strip()

        if session_share_id is not None:
            can_access = await self._check_thread_session_access(
                thread_id,
                consumer,
                session_share_id=session_share_id,
            )
        else:
            can_access = await self._check_thread_session_access(thread_id, consumer)
        if not can_access:
            logger.info(
                "[AgentStreamValidator] thread access denied: "
                "reason=session_owner_or_shared topic=%s user=%s",
                topic,
                getattr(consumer, "user_id", None) or "-",
            )
            return "thread access denied"
        return None

    @staticmethod
    async def _check_thread_organization(thread_id: str, consumer) -> bool:
        """Return True only if thread's organization is in consumer's organization set; False otherwise (fail-close)."""
        try:
            from apps.chat.conversation.models import ChatSession

            if thread_id.startswith("gc-ext-"):
                logger.info("[WS][DEPRECATED] legacy gc-ext thread rejected: %s", thread_id)
                return False
            else:
                ws_id = await database_sync_to_async(
                    lambda: ChatSession.objects.filter(
                        thread_id=thread_id,
                    ).values_list('organization_id', flat=True).first()
                )()
            if ws_id is None:
                return False
            return consumer.organization_ctx.is_member(ws_id)
        except Exception:
            logger.warning("DB error in _check_thread_organization for thread=%s", thread_id, exc_info=True)
            return False

    @staticmethod
    async def _check_thread_session_access(
        thread_id: str,
        consumer,
        *,
        session_share_id: str | None = None,
    ) -> bool:
        """Owner-or-shared gate for stream topics。无用户上下文 fail-close。"""
        user = getattr(consumer, "user", None)
        if user is None:
            return False
        try:
            from apps.chat.conversation.api._common import (
                resolve_session_id_for_thread,
                user_can_access_session,
            )

            def _check() -> bool:
                session_id = resolve_session_id_for_thread(thread_id)
                if not session_id:
                    return False
                return user_can_access_session(
                    session_id,
                    user,
                    session_share_id=session_share_id,
                )

            return await database_sync_to_async(_check)()
        except Exception:
            logger.warning(
                "DB error in _check_thread_session_access for thread=%s",
                thread_id,
                exc_info=True,
            )
            return False

    @staticmethod
    def resolve_resource_organization(topic: str) -> Optional[str]:
        """Sync 解析 ``agent.stream.{thread_id}`` 的 organization 归属，供 membership sync 使用。

        与 ``_check_thread_organization`` 共享查询逻辑，但这是 sync 调用（由 caller 用
        ``database_sync_to_async`` 批量包装），返回 organization_id 而非 bool。
        """
        parts = topic.split(".", 2)
        if len(parts) < 3 or not parts[2]:
            return None
        thread_id = parts[2]
        if thread_id.startswith("gc-ext-"):
            return None
        try:
            from apps.chat.conversation.models import ChatSession
            if thread_id.startswith("chat-session-"):
                session_id = thread_id[len("chat-session-"):]
                ws_id = ChatSession.objects.filter(
                    id=session_id,
                ).values_list('organization_id', flat=True).first()
            else:
                ws_id = ChatSession.objects.filter(
                    thread_id=thread_id,
                ).values_list('organization_id', flat=True).first()
            return str(ws_id) if ws_id else None
        except Exception:
            return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class AgentSessionValidator:
    """agent.session.{session_id}

    Session 级订阅 topic，生命周期与 ChatSession 激活/离开绑定，
    独立于 agent.stream.{thread_id} 的 stream slot cleanup。

    用途：LLM 增强摘要、checkpoint 异步状态等在 agent.stream.done 之后
    产生的事件——此时 agent.stream topic 已被前端退订，但 session 仍在激活。

    ：organization 成员关系之外，还需 owner-or-shared capability，
    与 HTTP / presence 共用 ``user_can_access_session``。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing session_id: {topic}"
        session_id = parts[2]
        try:
            uuid.UUID(session_id)
        except ValueError:
            return "invalid session_id"
        if not consumer.organization_ctx:
            return "missing organization context"
        session_org_id = await self._get_session_organization_id(session_id)
        if session_org_id is None:
            logger.info(
                "[AgentSessionValidator] session access denied: "
                "reason=session_not_found topic=%s session_org=- primary_org=%s member_org_count=%d",
                topic,
                consumer.organization_ctx.primary_id or "-",
                len(consumer.organization_ctx.all_ids),
            )
            return "session access denied"
        if not consumer.organization_ctx.is_member(session_org_id):
            logger.info(
                "[AgentSessionValidator] session access denied: "
                "reason=organization_mismatch topic=%s session_org=%s primary_org=%s member_org_count=%d",
                topic,
                session_org_id,
                consumer.organization_ctx.primary_id or "-",
                len(consumer.organization_ctx.all_ids),
            )
            return "session access denied"
        can_access = await self._check_session_owner_or_shared(session_id, consumer)
        if not can_access:
            logger.info(
                "[AgentSessionValidator] session access denied: "
                "reason=session_owner_or_shared topic=%s session_org=%s user=%s",
                topic,
                session_org_id,
                getattr(consumer, "user_id", None) or "-",
            )
            return "session access denied"
        return None

    @staticmethod
    async def _check_session_owner_or_shared(session_id: str, consumer) -> bool:
        """Owner-or-shared gate；无用户上下文 fail-close。"""
        user = getattr(consumer, "user", None)
        if user is None:
            return False
        try:
            from apps.chat.conversation.api._common import user_can_access_session

            return await database_sync_to_async(user_can_access_session)(session_id, user)
        except Exception:
            logger.warning(
                "DB error in AgentSessionValidator._check_session_owner_or_shared for session=%s",
                session_id,
                exc_info=True,
            )
            return False

    @staticmethod
    async def _get_session_organization_id(session_id: str) -> Optional[str]:
        """Resolve session organization id. Missing or DB errors fail closed."""
        try:
            from apps.chat.conversation.models import ChatSession
            ws_id = await database_sync_to_async(
                lambda: ChatSession.objects.filter(
                    id=session_id,
                ).values_list('organization_id', flat=True).first()
            )()
            if ws_id is None:
                return None
            return str(ws_id)
        except Exception:
            logger.warning(
                "DB error in AgentSessionValidator._get_session_organization_id for session=%s",
                session_id, exc_info=True,
            )
            return None

    @staticmethod
    async def _check_session_organization(session_id: str, consumer) -> bool:
        """Compatibility wrapper: session must belong to any organization in the WS context."""
        if not getattr(consumer, "organization_ctx", None):
            return False
        ws_id = await AgentSessionValidator._get_session_organization_id(session_id)
        return ws_id is not None and consumer.organization_ctx.is_member(ws_id)

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class SessionCollaborationValidator:
    """session.collaboration.{share_id}.{access_epoch}."""

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3:
            return "invalid collaboration topic"
        tail = parts[2].rsplit(".", 1)
        if len(tail) != 2:
            return "invalid collaboration topic"
        share_id, raw_epoch = tail
        try:
            uuid.UUID(share_id)
            epoch = int(raw_epoch)
        except (ValueError, TypeError):
            return "invalid collaboration topic"
        user_id = str(getattr(consumer, "user_id", "") or "")
        if not user_id or not consumer.organization_ctx:
            return "collaboration access denied"

        def _check():
            from apps.chat.conversation.models import SessionShare
            from apps.tabtinspace.models import Organization
            from django.db.models import Q

            share = SessionShare.objects.filter(
                id=share_id,
                card_contract="session_share_v2",
                access_epoch=epoch,
            ).first()
            if share is None:
                return False
            if not Organization.objects.filter(
                Q(id=share.organization_id),
                Q(owner_id=user_id) | Q(members__user_id=user_id),
            ).exists():
                return False
            if share.owner_user_id == user_id:
                return True
            return (
                share.grantee_user_id == user_id
                and share.status == "active"
                and share.eligibility_status == "eligible"
            )

        try:
            allowed = await database_sync_to_async(_check)()
        except Exception:
            logger.warning(
                "DB error validating collaboration topic=%s",
                topic,
                exc_info=True,
            )
            return "collaboration access denied"
        return None if allowed else "collaboration access denied"

    @staticmethod
    def resolve_resource_organization(topic: str) -> Optional[str]:
        tail = topic.split(".", 2)
        if len(tail) < 3:
            return None
        share_id = tail[2].rsplit(".", 1)[0]
        try:
            from apps.chat.conversation.models import SessionShare

            organization_id = SessionShare.objects.filter(id=share_id).values_list(
                "organization_id",
                flat=True,
            ).first()
            return str(organization_id) if organization_id else None
        except Exception:
            return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class AgentActionValidator:
    """agent.action.{thread_id}

    ：organization 成员关系之外，须复用 stream 同款 owner-or-shared 门禁，
    避免同组织非责任设备订阅他人私有 thread 的审批/工具回调。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing thread_id: {topic}"
        thread_id = parts[2]
        thread_id_error = validate_thread_id_prefix(thread_id, allowed_prefixes=_ALLOWED_THREAD_PREFIXES)
        if thread_id_error:
            return thread_id_error
        # G-060: verify thread belongs to the consumer's organization (aligned with AgentStreamValidator)
        if not consumer.organization_ctx:
            return "missing organization context"
        belongs = await AgentStreamValidator._check_thread_organization(thread_id, consumer)
        if not belongs:
            return "thread access denied"
        can_access = await AgentStreamValidator._check_thread_session_access(thread_id, consumer)
        if not can_access:
            logger.info(
                "[AgentActionValidator] thread access denied: "
                "reason=session_owner_or_shared topic=%s user=%s",
                topic,
                getattr(consumer, "user_id", None) or "-",
            )
            return "thread access denied"
        if consumer.role not in ("electron", "daemon"):
            return "role not allowed"
        if not getattr(consumer, "device_identity_verified", False):
            return "device identity is not verified"
        if not consumer.device_fingerprint:
            return "missing device_id"
        if not consumer.user_id:
            return "missing user_id"
        # G-022: 检查设备绑定 — 同一用户允许抢占（应对页面刷新/重连导致 device_id 变化），
        # 释放前必须校验 bound_device 属于同一 user，防止跨用户抢占。
        bound_device = await run_sync_io(lambda: _get_action_service().get_action_device(thread_id))
        if bound_device and bound_device != consumer.device_fingerprint:
            same_user = await self._check_bound_device_user(bound_device, consumer.user_id)
            if not same_user:
                return "device preemption denied: different user"
            logger.info(
                "[AgentActionValidator] releasing stale device binding: "
                "thread=%s old_device=%s new_device=%s user=%s",
                thread_id, bound_device, consumer.device_fingerprint, consumer.user_id,
            )
            await run_sync_io(lambda: _get_action_service().force_release_action_device(thread_id))
        return None

    @staticmethod
    async def _check_bound_device_user(fingerprint: str, user_id: str) -> bool:
        """Return True if the device belongs to the given user (or device not found in DB)."""
        try:
            from apps.tabtinspace.models import Device
            owner_id = await database_sync_to_async(
                lambda: Device.objects.filter(
                    fingerprint=fingerprint,
                ).values_list('user_id', flat=True).first()
            )()
            if owner_id is None:
                return True  # device not in DB (e.g. stale key) — allow preemption
            return str(owner_id) == str(user_id)
        except Exception:
            return False

    @staticmethod
    def resolve_resource_organization(topic: str) -> Optional[str]:
        """agent.action.{thread_id} 复用 AgentStreamValidator 的 ChatSession 查询。"""
        return AgentStreamValidator.resolve_resource_organization(
            topic.replace("agent.action.", "agent.stream.", 1),
        )

    async def on_subscribed(self, consumer, topic: str) -> None:
        parts = topic.split(".", 2)
        thread_id = parts[2]
        await run_sync_io(
            lambda: _get_action_service().bind_action_device(
                thread_id,
                consumer.device_fingerprint,
            )
        )


class AgentActionDeviceValidator:
    """agent.action.device.{fingerprint} — 设备态 runtime action topic

    注册前缀为 "agent.action.device"，handler 传入
    parts = topic.split(".", 2) 得到 ["agent", "action", "device.{fingerprint}"]。
    从 parts[2] 中提取 fingerprint（更安全，含 '.' 的 fingerprint 不会被截断）。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        sub = parts[2] if len(parts) >= 3 else ""
        tail = sub.split(".", 1)
        fingerprint = tail[1] if len(tail) >= 2 else ""
        if not fingerprint:
            return f"missing device fingerprint: {topic}"
        if consumer.role not in {"daemon", "device_runtime", "electron"}:
            return "only device runtime roles can subscribe to device action topics"
        if not getattr(consumer, "device_identity_verified", False):
            return "device identity is not verified"
        if not consumer.device_fingerprint:
            return "missing device_id"
        if fingerprint != consumer.device_fingerprint:
            return "device fingerprint mismatch"
        if not consumer.user_id:
            return "missing user_id"
        owned = await _verify_device_ownership(fingerprint, consumer.user_id)
        if not owned:
            return "device not owned by current user"
        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        if not consumer.device_fingerprint:
            return
        fp = consumer.device_fingerprint
        consumer._device_action_ready_generation = await run_sync_io(
            claim_device_action_ready,
            fp,
            consumer.channel_name,
        )
        if consumer.role in {"daemon", "device_runtime"}:
            import asyncio
            from .auth import _drain_buffered_actions

            # DEV-P1-19: 清除预订阅标志 + drain 预缓冲区
            from ..bus import clear_pre_subscribe_flag, drain_pre_subscribe_buffer
            await run_sync_io(clear_pre_subscribe_flag, fp)
            try:
                pre_sub_actions = await asyncio.to_thread(drain_pre_subscribe_buffer, fp)
                from .auth import _is_sandbox_policy_blocked, _is_envelope_expired, BUFFERED_ACTION_MAX_AGE
                sent = 0
                blocked = 0
                expired = 0
                for action in pre_sub_actions:
                    # CA-013: 对预缓冲区 action 做 TTL 过期校验，与 offline buffer drain 对齐
                    if _is_envelope_expired(action, BUFFERED_ACTION_MAX_AGE):
                        expired += 1
                        continue
                    if _is_sandbox_policy_blocked(action):
                        blocked += 1
                        continue
                    await consumer._send_envelope(action)
                    sent += 1
                if sent:
                    logger.info(
                        "[AgentActionDeviceValidator] sent %d pre-subscribe buffered action(s) to device=%s",
                        sent, fp,
                    )
                if blocked:
                    logger.info(
                        "[AgentActionDeviceValidator] skipped %d policy-blocked pre-subscribe action(s) for device=%s",
                        blocked, fp,
                    )
                if expired:
                    logger.info(
                        "[AgentActionDeviceValidator] skipped %d expired pre-subscribe action(s) for device=%s",
                        expired, fp,
                    )
            except Exception as exc:
                logger.warning("[AgentActionDeviceValidator] pre-subscribe drain failed for %s: %s", fp, exc)

            loop = asyncio.get_running_loop()
            consumer._track_task(loop.create_task(
                _drain_buffered_actions(consumer, fp)
            ))

    async def on_unsubscribed(self, consumer, topic: str) -> None:
        fp = getattr(consumer, "device_fingerprint", None)
        if not fp:
            return
        await run_sync_io(
            release_device_action_ready,
            fp,
            consumer.channel_name,
            getattr(consumer, "_device_action_ready_generation", None),
        )


class TableEventsValidator:
    """table.events.{table_id}"""

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing table_id: {topic}"
        table_id = parts[2]
        topic_contexts = getattr(consumer, "_pending_topic_contexts", None)
        topic_context = (
            topic_contexts.get(topic)
            if isinstance(topic_contexts, dict)
            else None
        )
        parent_document_id = None
        if isinstance(topic_context, dict):
            raw_parent_id = (
                topic_context.get("parent_document_id")
                or topic_context.get("parentDocumentId")
            )
            if raw_parent_id is not None:
                if not isinstance(raw_parent_id, str) or not raw_parent_id.strip():
                    return "DENIED: invalid parent document context"
                parent_document_id = raw_parent_id.strip()
        table_belongs = await consumer._check_table_organization(
            table_id,
            parent_document_id=parent_document_id,
        )
        if not table_belongs:
            return "table access denied"
        return None

    @staticmethod
    def resolve_resource_organization(topic: str) -> Optional[str]:
        """table.events.{table_id} → Table.organization_id"""
        parts = topic.split(".", 2)
        if len(parts) < 3 or not parts[2]:
            return None
        try:
            from apps.tabdata.models import Table
            ws_id = Table.objects.filter(
                id=parts[2],
            ).values_list('organization_id', flat=True).first()
            return str(ws_id) if ws_id else None
        except Exception:
            return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class ScheduledTasksValidator:
    """scheduled.tasks.{user_id}"""

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing user_id: {topic}"
        if not consumer.user_id:
            return "missing user_id"
        if parts[2] != consumer.user_id:
            return "user mismatch"
        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class TraceStreamValidator:
    """trace.stream.{trace_id}"""

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing trace_id: {topic}"
        try:
            uuid.UUID(parts[2])
        except ValueError:
            return "invalid trace_id"
        if consumer.user and not getattr(consumer.user, "is_superuser", False):
            from apps.services.agent_engine.models import ExecutionTrace
            trace = await database_sync_to_async(
                lambda: ExecutionTrace.objects.filter(trace_id=parts[2]).first()
            )()
            if not trace or trace.user_id != str(consumer.user.id):
                return "trace access denied"
        elif consumer.user:
            # G-061: superuser bypass — log for audit trail
            logger.info(
                "[TraceStream] superuser %s subscribing to trace %s",
                consumer.user_id, parts[2],
            )
        elif not consumer.user:
            # G-019: channel role 用 organization 归属校验替代 user 检查
            if consumer.role == "channel" and consumer.organization_ctx:
                from apps.services.agent_engine.models import ExecutionTrace
                trace = await database_sync_to_async(
                    lambda: ExecutionTrace.objects.filter(trace_id=parts[2]).first()
                )()
                if not trace:
                    return "trace access denied"
                if not trace.organization_id or not consumer.organization_ctx.is_member(trace.organization_id):
                    return "trace access denied"
            else:
                return "trace access denied"
        return None

    @staticmethod
    def resolve_resource_organization(topic: str) -> Optional[str]:
        """trace.stream.{trace_id} → ExecutionTrace.organization_id"""
        parts = topic.split(".", 2)
        if len(parts) < 3 or not parts[2]:
            return None
        try:
            from apps.services.agent_engine.models import ExecutionTrace
            ws_id = ExecutionTrace.objects.filter(
                trace_id=parts[2],
            ).values_list('organization_id', flat=True).first()
            return str(ws_id) if ws_id else None
        except Exception:
            return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


# 2026-05-28 收编：SchedulerEventsValidator（scheduler.events.{organization_id}）
# 随 ScheduledJob 子系统下线一并删除——该 WS topic 已无任何推送方与订阅方。


class ChannelValidator:
    """channel.* topics"""

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if topic.startswith("channel.") and consumer.role not in {"channel", "admin"}:
            return "role not allowed"
        if consumer.role == "channel" and not topic.startswith("channel."):
            return "role not allowed"
        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

class DocEventsValidator:
    """doc.events.{document_id} — 文档事件订阅验证"""

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing document_id: {topic}"
        document_id = parts[2]
        try:
            uuid.UUID(document_id)
        except ValueError:
            return "invalid document_id"
        doc_belongs = await consumer._check_document_organization(document_id)
        if not doc_belongs:
            return "document access denied"
        return None

    @staticmethod
    def resolve_resource_organization(topic: str) -> Optional[str]:
        """doc.events.{document_id} → Document.organization_id"""
        parts = topic.split(".", 2)
        if len(parts) < 3 or not parts[2]:
            return None
        try:
            from apps.tabdoc.models import Document
            doc = Document.objects.filter(id=parts[2]).only('organization_id').first()
            if not doc or not doc.organization_id:
                return None
            return str(doc.organization_id)
        except Exception:
            return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class ShareEventsValidator:
    """share.events.{share_id} — 分享页评论等元事件。

    公开分享评论者通常不是文档所属 org 成员，不能订 doc.events。
    订阅须携带有效 share_collab_token（sct_*），经 topic_contexts 传入。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing share_id: {topic}"
        share_id = parts[2]
        if not consumer.user_id:
            return "DENIED: share events require authenticated user"

        topic_contexts = getattr(consumer, "_pending_topic_contexts", None) or {}
        ctx = topic_contexts.get(topic) if isinstance(topic_contexts, dict) else None
        token = ""
        if isinstance(ctx, dict):
            raw = ctx.get("share_collab_token") or ctx.get("shareCollabToken") or ""
            token = str(raw).strip()
        if not token:
            return "DENIED: missing share_collab_token"

        from apps.services.common.public_share.collab_token import (
            parse_share_guest_id,
            verify_share_collab_token,
        )
        from apps.services.common.public_share.exceptions import (
            ShareExpiredError,
            ShareNotFoundError,
        )

        claims = verify_share_collab_token(token)
        if claims is None:
            return "DENIED: invalid or expired share_collab_token"
        if claims.share_id != share_id:
            return "DENIED: share_collab_token share_id mismatch"

        _, token_user_id = parse_share_guest_id(claims.guest_id)
        if not token_user_id or str(token_user_id) != str(consumer.user_id):
            return "DENIED: share_collab_token user mismatch"

        try:
            from apps.tabdoc.services.share_service import (
                SHARE_COMMENTABLE_PERMISSIONS,
                DocumentShareService,
            )

            share = await database_sync_to_async(DocumentShareService.get_share_by_id)(share_id)
        except ShareNotFoundError:
            return "DENIED: share not found"
        except ShareExpiredError:
            return "DENIED: share expired"
        except Exception:
            logger.warning("[WS] share.events lookup failed for share=%s", share_id, exc_info=True)
            return "DENIED: share access denied"

        if getattr(share, "permission", "view") not in SHARE_COMMENTABLE_PERMISSIONS:
            return "DENIED: share does not allow commenting"

        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class GitStatusValidator:
    """git.status.{space_id} — Git 状态变更事件

    注意：Phase 1 的 git.status 事件通过 organization group 广播（与 device.status 一致），
    前端不需要显式订阅即可收到。此 Validator 为 Phase 2 topic 级订阅预留。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing space_id: {topic}"
        space_id = parts[2]
        try:
            uuid.UUID(space_id)
        except ValueError:
            return "invalid space_id"
        belongs = await self._check_space_organization(consumer, space_id)
        if not belongs:
            return "space access denied"
        return None

    @staticmethod
    async def _check_space_organization(consumer, space_id: str) -> bool:
        try:
            from apps.tabtinspace.services.host_resolver import host_organization_id
            ws_id = await database_sync_to_async(
                lambda: host_organization_id(space_id)
            )()
            return ws_id is not None and consumer.organization_ctx.is_member(ws_id)
        except Exception:
            return False

    @staticmethod
    def resolve_resource_organization(topic: str) -> Optional[str]:
        """git.status.{space_id} → Space.organization_id"""
        parts = topic.split(".", 2)
        if len(parts) < 3 or not parts[2]:
            return None
        try:
            from apps.tabtinspace.services.host_resolver import host_organization_id
            ws_id = host_organization_id(parts[2])
            return str(ws_id) if ws_id else None
        except Exception:
            return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class ContextSyncValidator:
    """支持三种 topic：
    - context.sync.{space_id}
    - context.sync.organization.{organization_id}
    - context.sync.user.{user_id}  ( 私有云资源扇出)
    """

    @staticmethod
    def resolve_resource_organization(topic: str) -> Optional[str]:
        """context.sync.{space_id} → Space.organization_id；organization 分支已由 _extract_topic_organization_id 处理。"""
        full_parts = topic.split(".")
        if len(full_parts) < 3:
            return None
        if len(full_parts) >= 4 and full_parts[2] in {"organization", "user"}:
            # A 类 / 用户 topic，不应走到这里
            return None
        space_id = full_parts[2]
        if not space_id:
            return None
        try:
            from apps.tabtinspace.services.host_resolver import host_organization_id
            ws_id = host_organization_id(space_id)
            return str(ws_id) if ws_id else None
        except Exception:
            return None

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        full_parts = topic.split(".")
        if len(full_parts) < 3:
            return f"invalid context sync topic: {topic}"

        if len(full_parts) >= 4 and full_parts[2] == "user":
            topic_user_id = full_parts[3]
            if not topic_user_id:
                return f"missing user_id: {topic}"
            if not consumer.user_id:
                return "missing user_id"
            if str(topic_user_id) != str(consumer.user_id):
                return "user mismatch"
            return None

        if len(full_parts) >= 4 and full_parts[2] == "organization":
            organization_id = full_parts[3]
            if not organization_id:
                return f"missing organization_id: {topic}"
            try:
                uuid.UUID(organization_id)
            except ValueError:
                return "invalid organization_id"
            if not consumer.organization_ctx:
                return "missing organization context"
            if not consumer.organization_ctx.is_member(organization_id):
                return "organization mismatch"
            return None

        if not full_parts[2]:
            return f"missing space_id: {topic}"
        space_id = full_parts[2]
        try:
            uuid.UUID(space_id)
        except ValueError:
            return "invalid space_id"
        belongs = await GitStatusValidator._check_space_organization(consumer, space_id)
        if not belongs:
            return "space access denied"
        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class NotificationsValidator:
    """notifications.{user_id}"""

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 2 or not parts[1]:
            return f"missing user_id: {topic}"
        if not consumer.user_id:
            return "missing user_id"
        if parts[1] != consumer.user_id:
            return "user mismatch"
        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class TrackerEventsValidator:
    """tracker.events.{space_id} —— Tracker WS 事件订阅校验（Module F 决策 3）。

    修复前：topic 是 ``tracker.events.{organization_id}``，只校验 organization
    membership。任何 organization 成员都能订阅本团队所有 Space 的 Tracker
    进度推送（含 progress_message / error_summary 等潜在敏感字段），违反
    Space 默认私有原则。

    修复后：topic 按 ``space_id`` 分发；订阅时校验当前用户对该 Space 有
    viewer 权限（合并 SpaceMembership / Agent SpaceMembership，与
    ``check_space_permission`` 单一权威保持一致）。

    波次 4 Stage 2.3 一刀切：原 ``GoalEventsValidator`` / legacy
    ``goal.events`` / ``agenda.events`` 三注册全部下线。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing space_id: {topic}"
        space_id_str = parts[2]
        try:
            uuid.UUID(space_id_str)
        except ValueError:
            return "invalid space_id"
        if not consumer.user:
            return "missing user context"

        # 走 BaseService.check_space_permission（合并 4 来源取最高级别）。
        # SpaceAccessService 沿用 BaseService 的实现。
        from apps.tabtinspace.services.access_service import SpaceAccessService

        user_for_check = consumer.user

        def _check_space_viewer():
            svc = SpaceAccessService(user=user_for_check)
            return svc.check_space_permission(space_id_str, 'viewer')

        try:
            allowed = await database_sync_to_async(_check_space_viewer)()
        except Exception:
            logger.warning("[TrackerEventsValidator] permission check error", exc_info=True)
            return "permission check failed"

        if not allowed:
            return "no viewer permission on space"
        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class ExtensionEventsValidator:
    """extension.events.{organization_id}"""

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing organization_id: {topic}"
        try:
            uuid.UUID(parts[2])
        except ValueError:
            return "invalid organization_id"
        if not consumer.organization_ctx:
            return "missing organization context"
        if not consumer.organization_ctx.is_member(parts[2]):
            return "organization mismatch"
        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class DocparseEventsValidator:
    """docparse.events.{file_record_id}"""

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing file_record_id: {topic}"
        file_record_id = parts[2]
        try:
            uuid.UUID(file_record_id)
        except ValueError:
            return "invalid file_record_id"
        owns = await self._check_file_ownership(consumer, file_record_id)
        if not owns:
            return "file access denied"
        return None

    @staticmethod
    async def _check_file_ownership(consumer, file_record_id: str) -> bool:
        try:
            from apps.services.oss.models import FileRecord
            upload_user = await database_sync_to_async(
                lambda: FileRecord.objects.filter(
                    id=file_record_id,
                ).values_list('upload_user', flat=True).first()
            )()
            return upload_user is not None and str(upload_user) == consumer.user_id
        except Exception:
            return False

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class BillingEventsValidator:
    """billing.events.{organization_id}"""

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing organization_id: {topic}"
        try:
            uuid.UUID(parts[2])
        except ValueError:
            return "invalid organization_id"
        if not consumer.organization_ctx:
            return "missing organization context"
        if not consumer.organization_ctx.is_member(parts[2]):
            return "organization mismatch"
        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class SlideEventsValidator:
    """slide.events.{slide_id}"""

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing slide_id: {topic}"
        slide_id = parts[2]
        try:
            uuid.UUID(slide_id)
        except ValueError:
            return "invalid slide_id"
        if not consumer.organization_ctx:
            return "missing organization context"
        belongs = await self._check_slide_organization(consumer, slide_id)
        if not belongs:
            return "slide access denied"
        return None

    @staticmethod
    async def _check_slide_organization(consumer, slide_id: str) -> bool:
        try:
            from apps.tabslide.models import SlideProject
            ws_id = await database_sync_to_async(
                lambda: SlideProject.objects.filter(
                    id=slide_id,
                ).values_list('organization_id', flat=True).first()
            )()
            return ws_id is not None and consumer.organization_ctx.is_member(ws_id)
        except Exception:
            return False

    @staticmethod
    def resolve_resource_organization(topic: str) -> Optional[str]:
        """slide.events.{slide_id} → SlideProject.organization_id"""
        parts = topic.split(".", 2)
        if len(parts) < 3 or not parts[2]:
            return None
        try:
            from apps.tabslide.models import SlideProject
            ws_id = SlideProject.objects.filter(
                id=parts[2],
            ).values_list('organization_id', flat=True).first()
            return str(ws_id) if ws_id else None
        except Exception:
            return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class OpenAPITableValidator:
    """table.open.{table_id} — Open API realtime subscription for external developers.

    Supports optional per-subscription row filtering and RLS enforcement:

    Subscribe payload::

        {
            "topics": ["table.open.<table_id>"],
            "filter": {                       # optional — server-side row filter
                "conjunction": "and",
                "filterSet": [
                    {"field": "Status", "operator": "equals", "value": "Active"}
                ]
            },
            "rls": true                       # optional — enforce RLS policies (default true for token auth)
        }

    Filters and RLS context are stored per-topic on the consumer so that
    ``GatewayConsumer.broadcast_message`` can evaluate them at delivery time.
    """

    @staticmethod
    def resolve_resource_organization(topic: str) -> Optional[str]:
        """table.open.{table_id} → Table.organization_id（复用 TableEventsValidator 查询）"""
        parts = topic.split(".", 2)
        if len(parts) < 3 or not parts[2]:
            return None
        try:
            from apps.tabdata.models import Table
            ws_id = Table.objects.filter(
                id=parts[2],
            ).values_list('organization_id', flat=True).first()
            return str(ws_id) if ws_id else None
        except Exception:
            return None

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing table_id: {topic}"
        table_id = parts[2]

        # API Token auth: check token scope and table access
        api_token = getattr(consumer, '_api_token', None)
        if api_token is not None:
            has_scope = await database_sync_to_async(
                lambda: 'record:read' in (api_token.scopes or [])
            )()
            if not has_scope:
                return "insufficient scope: record:read required"
            # Check table access if token has table whitelist
            table_ids = await database_sync_to_async(lambda: api_token.table_ids)()
            if table_ids and table_id not in [str(t) for t in table_ids]:
                return "table access denied"

            # Validate optional subscriber filter from pending context
            pending = getattr(consumer, '_pending_open_table_ctx', None) or {}
            filter_config = pending.get('filter')
            if filter_config is not None:
                from ..realtime_filter import validate_filter_config
                filter_err = validate_filter_config(filter_config)
                if filter_err:
                    return f"invalid filter: {filter_err}"

            return None

        # JWT auth: fall back to organization-level check
        table_belongs = await consumer._check_table_organization(table_id)
        if not table_belongs:
            return "table access denied"

        # Validate optional subscriber filter from pending context
        pending = getattr(consumer, '_pending_open_table_ctx', None) or {}
        filter_config = pending.get('filter')
        if filter_config is not None:
            from ..realtime_filter import validate_filter_config
            filter_err = validate_filter_config(filter_config)
            if filter_err:
                return f"invalid filter: {filter_err}"

        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        """Store per-topic filter config and RLS context after successful subscription.

        RLS policies are eagerly fetched and cached here (at subscription time)
        so that the delivery-time filter path in ``broadcast_message`` is pure
        Python with zero I/O.  Policies are refreshed on the next subscribe if
        the client reconnects.
        """
        parts = topic.split(".", 2)
        table_id = parts[2] if len(parts) > 2 else None

        pending = getattr(consumer, '_pending_open_table_ctx', None) or {}
        filter_config = pending.get('filter')
        rls_flag = pending.get('rls')  # None means use default

        api_token = getattr(consumer, '_api_token', None)

        # Determine RLS enforcement: default True for token auth, False for JWT
        if rls_flag is None:
            rls_enabled = api_token is not None
        else:
            rls_enabled = bool(rls_flag)

        # Build per-topic subscription context
        ctx: Dict[str, Any] = {}
        if filter_config:
            ctx['filter'] = filter_config
        if rls_enabled and table_id and api_token is not None:
            from apps.tabdata.services.rls_service import RLSContext, rls_service
            from uuid import UUID

            rls_context = RLSContext(
                user_id=consumer.user_id,
                api_token=api_token,
                is_token_auth=True,
            )
            ctx['rls_context'] = rls_context
            ctx['table_id'] = table_id

            # Eagerly fetch RLS policies (DB/cache) so broadcast_message
            # can evaluate them synchronously without I/O.
            try:
                policies = await database_sync_to_async(
                    rls_service.get_policies_for_table
                )(UUID(table_id), 'SELECT', rls_context)
                if policies:
                    # Pre-resolve runtime variables in each policy condition
                    import copy
                    resolved_policies = []
                    for p in policies:
                        rp = copy.deepcopy(p)
                        rp['_resolved_condition'] = rls_service._resolve_condition(
                            rp['condition'], rls_context,
                        )
                        resolved_policies.append(rp)
                    ctx['rls_policies'] = resolved_policies
            except Exception as exc:
                logger.error(
                    "[OpenAPITableValidator] failed to pre-fetch RLS policies "
                    "for table=%s: %s — all events will be blocked for this subscription",
                    table_id, exc,
                )
                # Fail closed: mark subscription to block all events
                ctx['rls_fetch_failed'] = True

        # For JWT users: build RLS context if rls is explicitly requested or rls_force is set
        if rls_enabled and table_id and api_token is None:
            user = getattr(consumer, 'user', None)
            if user:
                from apps.tabdata.services.rls_service import RLSContext, rls_service
                from uuid import UUID

                rls_context = RLSContext(user_id=str(user.id), is_token_auth=False)
                ctx['rls_context'] = rls_context
                ctx['table_id'] = table_id

                try:
                    policies = await database_sync_to_async(
                        rls_service.get_policies_for_table
                    )(UUID(table_id), 'SELECT', rls_context)
                    if policies:
                        import copy
                        resolved_policies = []
                        for p in policies:
                            rp = copy.deepcopy(p)
                            rp['_resolved_condition'] = rls_service._resolve_condition(
                                rp['condition'], rls_context,
                            )
                            resolved_policies.append(rp)
                        ctx['rls_policies'] = resolved_policies
                except Exception as exc:
                    logger.error(
                        "[OpenAPITableValidator] failed to pre-fetch RLS policies "
                        "for JWT user table=%s: %s — all events will be blocked",
                        table_id, exc,
                    )
                    ctx['rls_fetch_failed'] = True

        if ctx:
            if not hasattr(consumer, '_open_table_subscriptions'):
                consumer._open_table_subscriptions = {}
            consumer._open_table_subscriptions[topic] = ctx

        logger.info(
            "[OpenAPITableValidator] subscribed topic=%s filter=%s rls=%s user=%s",
            topic,
            bool(filter_config),
            rls_enabled,
            consumer.user_id,
        )


class ASRStreamValidator:
    """asr.stream.{thread_id} — ASR 语音识别流订阅验证

    校验 thread_id 格式、organization 归属与 owner-or-shared，
    防止任意客户端窃听其他会话的 ASR 流。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing thread_id: {topic}"
        thread_id = parts[2]
        thread_id_error = validate_thread_id_prefix(thread_id, allowed_prefixes=_ALLOWED_THREAD_PREFIXES)
        if thread_id_error:
            return thread_id_error
        if not consumer.organization_ctx:
            return "missing organization context"
        belongs = await AgentStreamValidator._check_thread_organization(thread_id, consumer)
        if not belongs:
            return "asr stream access denied"
        can_access = await AgentStreamValidator._check_thread_session_access(thread_id, consumer)
        if not can_access:
            return "asr stream access denied"
        return None

    @staticmethod
    def resolve_resource_organization(topic: str) -> Optional[str]:
        return AgentStreamValidator.resolve_resource_organization(
            topic.replace("asr.stream.", "agent.stream.", 1),
        )

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class TTSStreamValidator:
    """tts.stream.{thread_id} — TTS 语音合成流订阅验证

    校验 thread_id 格式、organization 归属与 owner-or-shared，
    防止任意客户端窃听其他会话的 TTS 流。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing thread_id: {topic}"
        thread_id = parts[2]
        thread_id_error = validate_thread_id_prefix(thread_id, allowed_prefixes=_ALLOWED_THREAD_PREFIXES)
        if thread_id_error:
            return thread_id_error
        if not consumer.organization_ctx:
            return "missing organization context"
        belongs = await AgentStreamValidator._check_thread_organization(thread_id, consumer)
        if not belongs:
            return "tts stream access denied"
        can_access = await AgentStreamValidator._check_thread_session_access(thread_id, consumer)
        if not can_access:
            return "tts stream access denied"
        return None

    @staticmethod
    def resolve_resource_organization(topic: str) -> Optional[str]:
        return AgentStreamValidator.resolve_resource_organization(
            topic.replace("tts.stream.", "agent.stream.", 1),
        )

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


# ---------------------------------------------------------------------------
# 设备归属校验共享辅助 — 供 Phone/MediaPipeline/SshStream 等 Validator 复用
# ---------------------------------------------------------------------------

async def _verify_device_ownership(fingerprint: str, user_id: str) -> bool:
    """检查设备是否属于指定用户（fail-close：异常时返回 False）。"""
    try:
        from apps.tabtinspace.models import Device
        return await database_sync_to_async(
            Device.objects.filter(fingerprint=fingerprint, user_id=user_id).exists
        )()
    except Exception:
        logger.warning(
            "DB error in _verify_device_ownership for fingerprint=%s user=%s",
            fingerprint, user_id, exc_info=True,
        )
        return False


class PhoneValidator:
    """phone.{sub_type}.{device_fingerprint} — TabPhone 设备事件订阅验证

    校验 topic 中的 device_fingerprint 是否属于当前用户，
    防止越权订阅他人设备的 TabPhone 事件流。
    覆盖 phone.sms / phone.media / phone.call / phone.notification /
    phone.agent / phone.sync / phone.mirror / phone.emulator 共 8 个子类型。

    注册粒度为 phone.{sub_type}，handler 传入的 parts = topic.split(".", 2)
    得到 ["phone", "{sub_type}", "{fingerprint}"]，parts[2] 即 fingerprint。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing device fingerprint: {topic}"
        if not consumer.user_id:
            return "missing user_id"
        fingerprint = parts[2]
        owned = await _verify_device_ownership(fingerprint, consumer.user_id)
        if not owned:
            return "device not owned by current user"
        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class MediaPipelineValidator:
    """media.pipeline.{device_fingerprint} — 媒体管道事件订阅验证

    校验设备归属，防止越权订阅他人设备的媒体管道事件。
    handler 传入 parts = topic.split(".", 2)，parts[2] 即 fingerprint。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing device fingerprint: {topic}"
        if not consumer.user_id:
            return "missing user_id"
        fingerprint = parts[2]
        owned = await _verify_device_ownership(fingerprint, consumer.user_id)
        if not owned:
            return "device not owned by current user"
        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class DeviceCapabilitiesRefreshValidator:
    """device.capabilities.refresh.{organization_id} — 设备能力刷新事件订阅验证

    校验 organization 归属，防止越权订阅其他团队的设备能力刷新事件。

    注册前缀为 "device.capabilities.refresh"，handler 传入
    parts = topic.split(".", 2) 得到 ["device", "capabilities", "refresh.{organization_id}"]。
    需要从 parts[2] 中进一步提取 organization_id。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        sub = parts[2] if len(parts) >= 3 else ""
        tail = sub.split(".", 1)
        organization_id = tail[1] if len(tail) >= 2 else ""
        if not organization_id:
            return f"missing organization_id: {topic}"
        try:
            uuid.UUID(organization_id)
        except ValueError:
            return "invalid organization_id"
        if not consumer.organization_ctx:
            return "missing organization context"
        if not consumer.organization_ctx.is_member(organization_id):
            return "organization mismatch"
        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


class SshStreamValidator:
    """ssh.stream.{device_fingerprint} — SSH 流订阅验证

    校验设备归属，防止越权订阅他人设备的 SSH 终端流。
    """

    async def validate(self, consumer, topic: str, parts: list[str]) -> Optional[str]:
        if len(parts) < 3 or not parts[2]:
            return f"missing device fingerprint: {topic}"
        if not consumer.user_id:
            return "missing user_id"
        fingerprint = parts[2]
        owned = await _verify_device_ownership(fingerprint, consumer.user_id)
        if not owned:
            return "device not owned by current user"
        return None

    async def on_subscribed(self, consumer, topic: str) -> None:
        pass


from apps.services.common.agent_protocol.namespace import STREAM_CAPABILITY as _STREAM_CAP, ACTION_CAPABILITY as _ACTION_CAP

_phone_validator = PhoneValidator()

VALIDATORS: Dict[str, TopicValidatorProtocol] = {
    _STREAM_CAP: AgentStreamValidator(),
    # agent.session.{session_id} — 与 agent.stream 共用 capability（见 protocol.py TOPIC_CAPABILITIES）。
    "agent.session": AgentSessionValidator(),
    f"{_ACTION_CAP}.device": AgentActionDeviceValidator(),
    _ACTION_CAP: AgentActionValidator(),
    "table.events": TableEventsValidator(),
    "doc.events": DocEventsValidator(),
    "share.events": ShareEventsValidator(),
    "session.collaboration": SessionCollaborationValidator(),
    "scheduled.tasks": ScheduledTasksValidator(),
    "trace.stream": TraceStreamValidator(),
    "channel": ChannelValidator(),
    "git.status": GitStatusValidator(),
    "context.sync": ContextSyncValidator(),
    "notifications": NotificationsValidator(),
    # Tracker 模块波次 4 Stage 2.3 一刀切：legacy goal.events / agenda.events 注册已下线。
    "tracker.events": TrackerEventsValidator(),
    "extension.events": ExtensionEventsValidator(),
    "docparse.events": DocparseEventsValidator(),
    "billing.events": BillingEventsValidator(),
    "slide.events": SlideEventsValidator(),
    "table.open": OpenAPITableValidator(),
    "asr.stream": ASRStreamValidator(),
    "tts.stream": TTSStreamValidator(),
    "phone.sms": _phone_validator,
    "phone.media": _phone_validator,
    "phone.call": _phone_validator,
    "phone.notification": _phone_validator,
    "phone.agent": _phone_validator,
    "phone.sync": _phone_validator,
    "phone.mirror": _phone_validator,
    "phone.emulator": _phone_validator,
    "media.pipeline": MediaPipelineValidator(),
    "device.capabilities.refresh": DeviceCapabilitiesRefreshValidator(),
    "ssh.stream": SshStreamValidator(),
}


def resolve_validator(topic: str) -> Optional[TopicValidatorProtocol]:
    """最长前缀匹配，顺序无关。"""
    best_prefix = ""
    best_validator = None
    for prefix, validator in VALIDATORS.items():
        if (topic == prefix or topic.startswith(f"{prefix}.")) and len(prefix) > len(best_prefix):
            best_prefix = prefix
            best_validator = validator
    return best_validator


# ---------------------------------------------------------------------------
# Lazy singleton for FrontendActionService (thread-local)
# ---------------------------------------------------------------------------
# G-039: 使用 threading.local 替代模块级全局单例，
# 避免多 ASGI worker 线程间共享同一实例导致 Redis 连接交叉污染。
import threading as _threading

_action_service_local = _threading.local()


def _get_action_service():
    svc = getattr(_action_service_local, 'instance', None)
    if svc is None:
        from apps.services.agent_engine.services.frontend_action_service import FrontendActionService
        svc = FrontendActionService()
        _action_service_local.instance = svc
    return svc
