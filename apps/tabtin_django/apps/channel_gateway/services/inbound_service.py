"""Channel inbound routing service."""

from __future__ import annotations

import logging
import re

from django.db import IntegrityError
from django.utils import timezone

from apps.channel_gateway.compat import run_adapter_coro
from apps.i18n import get_text as _
from apps.i18n.language import SupportedLanguage
from apps.channel_gateway.models import ChannelAccount, ChannelBinding, ChannelInboundMessageLog
from apps.channel_gateway.schemas import ChannelInboundMessage, ChannelOutboundMessage, ChannelOutboundPayload
from apps.channel_gateway.services.identity_context import (
    normalize_channel_context_value,
    resolve_channel_runtime_identity_context,
)
from apps.channel_gateway.services.pairing_service import ChannelPairingService
from apps.channel_gateway.services.policy_service import ChannelPolicyService
from apps.channel_gateway.services.outbound_service import ChannelOutboundService

logger = logging.getLogger(__name__)

_SENDER_NAME_MAX_LEN = 64
_SENDER_NAME_UNSAFE_RE = re.compile(r"[\[\]\n\r\t]")

_BOT_COMMANDS = frozenset({"/start", "/help"})

_CHANNEL_DEFAULT_LOCALE: dict[str, SupportedLanguage] = {
    "wechat_work": SupportedLanguage.ZH_CN,
    "feishu": SupportedLanguage.ZH_CN,
    "dingtalk": SupportedLanguage.ZH_CN,
    "telegram": SupportedLanguage.EN_US,
    "slack": SupportedLanguage.EN_US,
    "discord": SupportedLanguage.EN_US,
    "whatsapp": SupportedLanguage.EN_US,
    "line": SupportedLanguage.EN_US,
    "googlechat": SupportedLanguage.EN_US,
    "msteams": SupportedLanguage.EN_US,
    "mattermost": SupportedLanguage.EN_US,
}

_BOT_COMMAND_FALLBACKS = {
    "/start": (
        "Hi! I'm a TabTin AI assistant. Send me a message and I'll do my best to help.\n\n"
        "Use /help to see available commands."
    ),
    "/help": (
        "Available commands:\n"
        "/start - Start a conversation\n"
        "/help  - Show this help message\n\n"
        "You can also send any text message and I'll respond.\n\n"
        "I can help with data analysis, document editing, web scraping, and more."
    ),
}


class ChannelInboundService:
    """处理 channel.inbound 的路由与消息派发。"""

    def __init__(self):
        self.default_account_id = "default"

    def handle_inbound(self, data: ChannelInboundMessage) -> None:
        if not data.organization_id:
            logger.error(
                "[ChannelInbound] rejected: missing organization_id "
                "(channel=%s, peer_id=%s, sender_id=%s, message_id=%s, account_id=%s)",
                getattr(data, "channel", "?"),
                getattr(data, "peer_id", "?"),
                getattr(data, "sender_id", "?"),
                getattr(data, "message_id", "?"),
                getattr(data, "account_id", "?"),
            )
            raise ValueError("channel.inbound requires organization_id")

        if not self._register_inbound(data):
            logger.info("[ChannelInbound] duplicate message ignored: %s", data.message_id)
            return

        if self._handle_bot_command(data):
            return

        existing_binding = self._get_binding(data)
        if existing_binding and existing_binding.status != "active":
            logger.info("[ChannelInbound] binding not active: %s", existing_binding.id)
            return

        account = self._get_account(data)

        decision = ChannelPolicyService().evaluate(data, existing_binding, account=account)
        if not decision.allowed:
            if decision.pairing_required:
                self._handle_pairing(data)
            logger.info("[ChannelInbound] blocked by policy: %s", decision.reason)
            return

        try:
            binding = self._resolve_binding(data, account=account)
        except ValueError as exc:
            logger.warning(
                "[ChannelInbound] binding resolve blocked: channel=%s peer=%s reason=%s",
                data.channel,
                data.peer_id,
                exc,
            )
            return
        if binding.status != "active":
            logger.info("[ChannelInbound] binding not active after resolve: %s", binding.id)
            return

        self._sync_routing_context(binding, data)

        message_text = self._render_message_text(data)
        if not message_text:
            logger.info("[ChannelInbound] empty message ignored: %s", data.message_id)
            return

        self._send_typing_indicator(data, account=account)

        self._emit_extension_event(data, binding)

        from apps.channel_gateway.tasks import dispatch_agent_reply
        dispatch_agent_reply.delay(
            binding_id=str(binding.id),
            data_dict=data.model_dump(),
            message_text=message_text,
        )

    # ------------------------------------------------------------------
    # Bot commands
    # ------------------------------------------------------------------

    def _handle_bot_command(self, data: ChannelInboundMessage) -> bool:
        """Intercept /start, /help etc. and respond directly (skip Agent)."""
        text = (data.text or "").strip()
        cmd = text.split()[0].split("@")[0] if text else ""
        if cmd not in _BOT_COMMANDS:
            return False

        locale = _CHANNEL_DEFAULT_LOCALE.get(data.channel, SupportedLanguage.EN_US)
        i18n_key = f"channel.bot.{cmd.lstrip('/')}"
        response = _(i18n_key, language=locale)
        if not response or response == i18n_key:
            response = _BOT_COMMAND_FALLBACKS.get(cmd, "")

        payload = ChannelOutboundPayload(text=response, media=None, reply_to=None, metadata=None)
        outbound = ChannelOutboundMessage(
            schema_version=data.schema_version,
            type="channel.outbound",
            channel=data.channel,
            account_id=self._account_id(data),
            organization_id=data.organization_id,
            space_id=None,
            execution_agent_id=None,
            session_id=None,
            thread_id=None,
            to=data.peer_id.strip(),
            message_id=None,
            idempotency_key=f"cmd:{data.message_id}",
            payload=payload,
        )
        ChannelOutboundService().publish(outbound)
        return True

    # ------------------------------------------------------------------
    # Typing indicator
    # ------------------------------------------------------------------

    def _get_account(self, data: ChannelInboundMessage) -> ChannelAccount | None:
        """Fetch the ChannelAccount once, intended to be shared across the
        handle_inbound call chain to avoid repeated DB queries."""
        account_id = self._account_id(data)
        return ChannelAccount.objects.filter(
            organization_id=data.organization_id,
            channel=data.channel,
            account_id=account_id,
            enabled=True,
        ).first()

    def _send_typing_indicator(
        self,
        data: ChannelInboundMessage,
        *,
        account: ChannelAccount | None = None,
    ) -> None:
        """Fire-and-forget typing action before agent processing.

        Calls the unified ``send_typing()`` base method (works for all adapters),
        with fallback to Telegram-specific ``send_chat_action()`` for backwards compat.
        """
        try:
            from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry
            adapter = ChannelAdapterRegistry.get(data.channel)
            if not adapter:
                return

            if account is None:
                account = ChannelAccount.objects.filter(
                    channel=data.channel,
                    account_id=self._account_id(data),
                    organization_id=data.organization_id,
                    enabled=True,
                ).first()
            if not account:
                return

            if hasattr(adapter, "send_chat_action"):
                run_adapter_coro(adapter.send_chat_action(account, data.peer_id.strip()))
            else:
                run_adapter_coro(adapter.send_typing(account, data.peer_id.strip()))
        except Exception:
            logger.debug("[ChannelInbound] typing indicator failed", exc_info=True)

    # ------------------------------------------------------------------
    # Binding resolution
    # ------------------------------------------------------------------

    def _resolve_default_space(
        self,
        data: ChannelInboundMessage,
        organization_id: str,
        *,
        account: ChannelAccount | None = None,
    ):
        """Read the bound space from ChannelAccount config.

        Keeps backward compatibility with historical ``default_project_id``.
        """
        from apps.tabtinspace.services.host_resolver import resolve_host

        if account is None:
            account = ChannelAccount.objects.filter(
                channel=data.channel,
                account_id=self._account_id(data),
                organization_id=data.organization_id,
                enabled=True,
            ).first()
        if not account:
            return None
        config = account.config or {}
        space_id = (
            config.get("default_space_id")
            or config.get("default_project_id")
        )
        if not space_id:
            return None
        space = resolve_host(space_id)
        if space and str(space.organization_id) == str(organization_id):
            return space
        return None

    def _resolve_binding(
        self,
        data: ChannelInboundMessage,
        *,
        account: ChannelAccount | None = None,
    ) -> ChannelBinding:
        from apps.chat.conversation.models import ChatSession
        from apps.channel_gateway.services.binding_service import ChannelBindingService
        from apps.tabtinspace.models import Organization

        account_id = self._account_id(data)
        peer_id = data.peer_id.strip()
        organization = Organization.objects.filter(id=data.organization_id).first()
        if not organization:
            raise ValueError(f"organization not found: {data.organization_id}")

        # DS-019: 忽略外部消息传入的 space_id，强制从 ChannelAccount 配置获取，
        # 防止攻击者枚举同 organization 下任意 space。
        if data.space_id:
            logger.warning(
                "[ChannelInbound] DS-019: ignoring externally supplied space_id=%s "
                "(channel=%s, peer_id=%s)",
                data.space_id, data.channel, data.peer_id,
            )
        space = self._resolve_default_space(data, organization.id, account=account)

        configured_space_id = str(space.id) if space else None

        binding = self._get_binding(data, account_id=account_id, peer_id=peer_id)
        identity_context = resolve_channel_runtime_identity_context(
            organization_id=str(organization.id),
            binding=binding,
            account=account,
            fallback_handling_space_id=configured_space_id or "",
        )

        if binding and binding.session_id:
            session = ChatSession.objects.filter(id=binding.session_id).first()
            if session and str(session.organization_id) == str(organization.id):
                identity_context = resolve_channel_runtime_identity_context(
                    organization_id=str(organization.id),
                    binding=binding,
                    account=account,
                    session=session,
                    fallback_handling_space_id=configured_space_id or "",
                )
                target_space = self._resolve_existing_binding_space(
                    session=session,
                    organization_id=organization.id,
                    binding_space_id=(
                        identity_context.handling_space_id
                        or getattr(binding, "handling_space_id", None)
                        or getattr(binding, "space_id", None)
                    ),
                    fallback_space_id=configured_space_id,
                )
                target_space_id = str(target_space.id) if target_space else None

                if (
                    identity_context.identity_user_id
                    and str(getattr(session, "user_id", "") or "") != identity_context.identity_user_id
                ):
                    logger.info(
                        "[ChannelInbound] binding=%s session user changed, rotating session: %s -> %s",
                        binding.id,
                        getattr(session, "user_id", ""),
                        identity_context.identity_user_id,
                    )
                else:
                    self._sync_session_space(
                        session=session,
                        organization_id=data.organization_id,
                        binding_space_id=target_space_id,
                    )
                    update_fields = ["last_message_id", "updated_at"]
                    if binding.space_id != target_space_id:
                        binding.space_id = target_space_id
                        update_fields.append("space_id")
                    if binding.handling_space_id != target_space_id:
                        binding.handling_space_id = target_space_id
                        update_fields.append("handling_space_id")
                    if (
                        identity_context.identity_user_id
                        and binding.identity_user_id != identity_context.identity_user_id
                    ):
                        binding.identity_user_id = identity_context.identity_user_id
                        update_fields.append("identity_user_id")
                    if (
                        identity_context.execution_agent_id
                        and binding.execution_agent_id != identity_context.execution_agent_id
                    ):
                        binding.execution_agent_id = identity_context.execution_agent_id
                        update_fields.append("execution_agent_id")
                    if (
                        identity_context.execution_workspace_id
                        and binding.execution_workspace_id
                        != identity_context.execution_workspace_id
                    ):
                        binding.execution_workspace_id = identity_context.execution_workspace_id
                        update_fields.append("execution_workspace_id")
                    binding.last_message_id = data.message_id
                    binding.updated_at = timezone.now()
                    binding.save(update_fields=update_fields)
                    return binding

        space = self._resolve_space_for_organization(
            organization.id,
            identity_context.handling_space_id,
            (
                getattr(binding, "handling_space_id", None)
                or getattr(binding, "space_id", None)
            ) if binding else None,
            configured_space_id,
        )
        target_space_id = str(space.id) if space else None
        identity_context = resolve_channel_runtime_identity_context(
            organization_id=str(organization.id),
            binding=binding,
            account=account,
            fallback_handling_space_id=target_space_id or configured_space_id or "",
        )
        if not identity_context.identity_user_id and account is not None:
            identity_context = resolve_channel_runtime_identity_context(
                organization_id=str(organization.id),
                binding=binding,
                account=account,
                fallback_identity_user_id=normalize_channel_context_value(
                    getattr(account, "user_id", "")
                    or (getattr(account, "config", None) or {}).get("user_id")
                ),
                fallback_handling_space_id=target_space_id or configured_space_id or "",
            )
        if not identity_context.identity_user_id:
            raise ValueError("identity user required")

        binding_service = ChannelBindingService(organization_id=str(organization.id))
        identity_user = binding_service.resolve_identity_user(identity_context.identity_user_id)
        session = binding_service.create_session(
            organization=organization,
            space=space,
            identity_user=identity_user,
            agent_id=identity_context.execution_agent_id,
            workspace_id=identity_context.execution_workspace_id,
            title=self._build_session_title(data),
        )

        if binding:
            binding.session_id = session.id
            binding.thread_id = session.thread_id
            binding.space_id = target_space_id
            binding.handling_space_id = target_space_id
            binding.identity_user_id = identity_context.identity_user_id or None
            binding.execution_agent_id = identity_context.execution_agent_id or None
            binding.execution_workspace_id = identity_context.execution_workspace_id or None
            binding.last_message_id = data.message_id
            binding.updated_at = timezone.now()
            binding.save(
                update_fields=[
                    "session_id",
                    "thread_id",
                    "space_id",
                    "handling_space_id",
                    "identity_user_id",
                    "execution_agent_id",
                    "execution_workspace_id",
                    "last_message_id",
                    "updated_at",
                ]
            )
            return binding

        return ChannelBinding.objects.create(
            channel=data.channel,
            account_id=account_id,
            peer_kind=data.peer_kind,
            peer_id=peer_id,
            organization_id=str(organization.id),
            identity_user_id=identity_context.identity_user_id or None,
            execution_agent_id=identity_context.execution_agent_id or None,
            execution_workspace_id=identity_context.execution_workspace_id or None,
            handling_space_id=target_space_id,
            space_id=target_space_id,
            session_id=session.id,
            thread_id=session.thread_id,
            status="active",
            last_message_id=data.message_id,
        )

    def _build_session_title(self, data: ChannelInboundMessage) -> str:
        """DS-016: session 标题加 [Channel Bot] 前缀，审计可区分 Owner 主动操作和外部触发。"""
        meta = data.metadata or {}
        raw_name = meta.get("sender_username") or meta.get("sender_name") or data.sender_id
        name = self.sanitize_sender_name(raw_name)
        channel_label = data.channel.capitalize()
        if data.peer_kind == "group":
            return f"[Channel Bot] {channel_label} Group - {data.peer_id}"
        return f"[Channel Bot] {channel_label} - {name}"

    def _resolve_existing_binding_space(
        self,
        *,
        session,
        organization_id: str,
        binding_space_id: str | None,
        fallback_space_id: str | None,
    ):
        from django.core.exceptions import ObjectDoesNotExist

        context_space_id = None
        context_project_id = None
        try:
            context_space_id = session.context.current_space_id or None
            context_project_id = str(session.context.current_project_id or "") or None
        except (AttributeError, ObjectDoesNotExist):
            context_space_id = None
            context_project_id = None

        return self._resolve_space_for_organization(
            organization_id,
            binding_space_id,
            str(session.project_id) if session.project_id else None,
            str(session.workspace_id) if session.workspace_id else None,
            context_project_id,
            context_space_id,
            fallback_space_id,
        )

    def _resolve_space_for_organization(self, organization_id: str, *candidate_ids: str | None):
        from apps.tabtinspace.services.host_resolver import resolve_host

        seen: set[str] = set()
        for candidate_id in candidate_ids:
            normalized_id = str(candidate_id).strip() if candidate_id else ""
            if not normalized_id or normalized_id in seen:
                continue
            seen.add(normalized_id)
            space = resolve_host(normalized_id)
            if space and str(space.organization_id) == str(organization_id):
                return space
        return None

    def _sync_session_space(
        self,
        *,
        session,
        organization_id: str,
        binding_space_id: str | None,
    ) -> None:
        from apps.channel_gateway.services.binding_service import ChannelBindingService
        from apps.tabtinspace.services.host_resolver import resolve_host

        target_space = None
        if binding_space_id:
            space = resolve_host(binding_space_id)
            if space and str(space.organization_id) == str(organization_id):
                target_space = space
        ChannelBindingService(organization_id).sync_session_space(session, target_space)

    def _get_binding(
        self,
        data: ChannelInboundMessage,
        *,
        account_id: str | None = None,
        peer_id: str | None = None,
        for_update: bool = False,
    ) -> ChannelBinding | None:
        account_id = (account_id or data.account_id or self.default_account_id).strip() or self.default_account_id
        peer_id = (peer_id or data.peer_id).strip()
        query = ChannelBinding.objects.filter(
            channel=data.channel,
            account_id=account_id,
            peer_id=peer_id,
            organization_id=data.organization_id,
        )
        if for_update:
            query = query.select_for_update()
        binding = query.first()
        if binding:
            return binding

        binding = self._fallback_binding(data, account_id=account_id, peer_id=peer_id)
        return binding

    def _fallback_binding(
        self,
        data: ChannelInboundMessage,
        *,
        account_id: str,
        peer_id: str,
    ) -> ChannelBinding | None:
        """Channel-specific fallback for binding lookup after peer_id format migration."""
        if data.channel == "wechat_work" and data.peer_kind == "dm":
            corp_id = (data.metadata or {}).get("corp_id", "")
            if corp_id and corp_id != peer_id:
                return self._migrate_wechat_work_binding(
                    account_id=account_id,
                    organization_id=data.organization_id,
                    old_peer_id=corp_id,
                    new_peer_id=peer_id,
                )
        return None

    def _migrate_wechat_work_binding(
        self,
        *,
        account_id: str,
        organization_id: str,
        old_peer_id: str,
        new_peer_id: str,
    ) -> ChannelBinding | None:
        from django.db import transaction

        try:
            with transaction.atomic():
                old_binding = (
                    ChannelBinding.objects
                    .select_for_update()
                    .filter(
                        channel="wechat_work",
                        account_id=account_id,
                        peer_id=old_peer_id,
                        organization_id=organization_id,
                    )
                    .first()
                )
                if not old_binding:
                    return None

                logger.info(
                    "[ChannelInbound] migrating wechat_work binding peer_id: %s → %s",
                    old_peer_id, new_peer_id,
                )
                old_binding.peer_id = new_peer_id
                old_binding.peer_kind = "dm"
                old_binding.save(update_fields=["peer_id", "peer_kind", "updated_at"])
                return old_binding
        except IntegrityError:
            logger.warning(
                "[ChannelInbound] wechat_work binding migration conflict: %s → %s, "
                "falling back to new binding creation",
                old_peer_id, new_peer_id,
            )
            return None

    # ------------------------------------------------------------------
    # Message rendering
    # ------------------------------------------------------------------

    @staticmethod
    def sanitize_sender_name(name: str) -> str:
        """DS-017: 净化 sender_name 防止 prompt injection。

        移除可被利用伪造系统前缀的字符（方括号、换行等），并限制长度。
        """
        sanitized = _SENDER_NAME_UNSAFE_RE.sub("", name).strip()
        if len(sanitized) > _SENDER_NAME_MAX_LEN:
            sanitized = sanitized[:_SENDER_NAME_MAX_LEN]
        return sanitized or "unknown"

    def _render_message_text(self, data: ChannelInboundMessage) -> str:
        parts = []
        if data.text:
            parts.append(data.text.strip())
        if data.media:
            for media in data.media:
                label = media.kind
                if media.filename:
                    label = f"{label}:{media.filename}"
                parts.append(f"[media:{label}]")
        text = "\n".join([p for p in parts if p])

        if data.peer_kind == "group" and data.sender_id != "unknown":
            meta = data.metadata or {}
            raw_sender = meta.get("sender_username") or meta.get("sender_name") or data.sender_id
            sender = self.sanitize_sender_name(raw_sender)
            text = f"[{sender}]: {text}"

        return text

    # ------------------------------------------------------------------
    # Pairing
    # ------------------------------------------------------------------

    def _handle_pairing(self, data: ChannelInboundMessage) -> None:
        pairing_service = ChannelPairingService()
        try:
            result = pairing_service.create_or_get_pending(data)
        except Exception as exc:
            logger.warning("[ChannelInbound] pairing create failed: %s", exc)
            return

        if not result.created:
            return

        prompt = f"请输入配对码 {result.request.code} 以完成绑定。"
        payload = ChannelOutboundPayload(text=prompt, media=None, reply_to=None, metadata=None)
        outbound = ChannelOutboundMessage(
            schema_version=data.schema_version,
            type="channel.outbound",
            channel=data.channel,
            account_id=self._account_id(data),
            organization_id=data.organization_id,
            space_id=None,
            execution_agent_id=None,
            session_id=None,
            thread_id=None,
            to=data.peer_id.strip(),
            idempotency_key=result.request.code,
            payload=payload,
        )

        ChannelOutboundService().publish(outbound)

    # ------------------------------------------------------------------
    # Dedup
    # ------------------------------------------------------------------

    def _register_inbound(self, data: ChannelInboundMessage) -> bool:
        try:
            ChannelInboundMessageLog.objects.create(
                channel=data.channel,
                account_id=self._account_id(data),
                organization_id=data.organization_id,
                peer_id=data.peer_id,
                message_id=data.message_id,
            )
            return True
        except IntegrityError:
            return False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _emit_extension_event(self, data: ChannelInboundMessage, binding: ChannelBinding) -> None:
        """将入站消息桥接到 EventBus。"""
        try:
            from apps.extensions.event_bus import Event, EventBus

            channel = data.channel or "unknown"
            text = (data.text or "").strip()
            event_type = f"{channel}.message_received"
            if text.startswith("/"):
                event_type = f"{channel}.command_received"

            EventBus.emit(Event(
                source=channel,
                event_type=event_type,
                organization_id=data.organization_id,
                space_id=(
                    getattr(binding, "handling_space_id", None)
                    or getattr(binding, "space_id", None)
                ) if binding else None,
                payload={
                    "text": text,
                    "sender_id": data.sender_id,
                    "peer_id": data.peer_id,
                    "peer_kind": data.peer_kind,
                    "message_id": data.message_id,
                    "metadata": data.metadata,
                    "identity_user_id": normalize_channel_context_value(getattr(binding, "identity_user_id", "")),
                    "execution_agent_id": normalize_channel_context_value(getattr(binding, "effective_execution_agent_id", "")),
                    "handling_space_id": normalize_channel_context_value(getattr(binding, "effective_handling_space_id", "")),
                },
            ))
        except Exception:
            logger.debug("[ChannelInbound] emit extension event failed", exc_info=True)

    def _sync_routing_context(self, binding: ChannelBinding, data: ChannelInboundMessage) -> None:
        """Persist adapter-specific routing context into binding.metadata.

        Delegates to ``adapter.extract_routing_context(data)`` so that each
        adapter owns its own routing-context shape (Open-Closed Principle).
        """
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry

        adapter = ChannelAdapterRegistry.get(data.channel)
        if not adapter:
            return
        ctx = adapter.extract_routing_context(data)
        if not ctx:
            return

        old_routing = binding.metadata.get("_routing") if binding.metadata else None
        if old_routing == ctx:
            return

        if not binding.metadata:
            binding.metadata = {}
        binding.metadata["_routing"] = ctx
        binding.save(update_fields=["metadata", "updated_at"])

    def _account_id(self, data: ChannelInboundMessage) -> str:
        return (data.account_id or self.default_account_id).strip() or self.default_account_id
