"""Channel policy and allowlist evaluation."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

from django.conf import settings

from apps.channel_gateway.models import ChannelAllowlistEntry, ChannelBinding, ChannelAccount
from apps.channel_gateway.schemas import ChannelInboundMessage

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PolicyDecision:
    allowed: bool
    reason: str
    pairing_required: bool = False


VALID_DM_POLICY = {"open", "allowlist", "pairing"}
VALID_GROUP_POLICY = {"open", "allowlist"}


class ChannelPolicyService:
    def __init__(self):
        self.dm_policy = self._sanitize_dm_policy(getattr(settings, "CHANNEL_GATEWAY_DM_POLICY", "pairing"))
        self.group_policy = self._sanitize_group_policy(
            getattr(settings, "CHANNEL_GATEWAY_GROUP_POLICY", "allowlist")
        )

    def evaluate(
        self,
        data: ChannelInboundMessage,
        binding: Optional[ChannelBinding],
        *,
        account: Optional[ChannelAccount] = None,
    ) -> PolicyDecision:
        if binding and binding.status == "active":
            return PolicyDecision(allowed=True, reason="binding_active")

        policy = self.resolve_policy(data, account=account)

        if data.peer_kind == "dm":
            return self._evaluate_dm(data, policy)

        if data.peer_kind in {"group", "thread"}:
            return self._evaluate_group(data, policy)

        return PolicyDecision(allowed=False, reason="unsupported_peer_kind")

    def resolve_policy(
        self,
        data: ChannelInboundMessage,
        *,
        account: Optional[ChannelAccount] = None,
    ) -> dict[str, Any]:
        if account is None:
            account = self._get_account(data)
        config = account.config if account else {}
        return self.extract_policy_config(config)

    def extract_policy_config(self, config: object) -> dict[str, Any]:
        if not isinstance(config, dict):
            return {
                "dm_policy": self.dm_policy,
                "group_policy": self.group_policy,
                "require_mention": True,
                "group_require_mention": {},
                "command_gate_enabled": False,
                "command_prefixes": ["/"],
            }

        policy_config = config.get("policy") if isinstance(config.get("policy"), dict) else {}
        dm_policy_raw = (
            policy_config.get("dm_policy")
            or policy_config.get("dmPolicy")
            or config.get("dm_policy")
            or config.get("dmPolicy")
        )
        group_policy_raw = (
            policy_config.get("group_policy")
            or policy_config.get("groupPolicy")
            or config.get("group_policy")
            or config.get("groupPolicy")
        )
        require_mention = self._extract_require_mention(policy_config, config)
        group_require_mention = self._extract_group_require_mention(policy_config, config)
        command_gate_enabled = self._extract_command_gate_enabled(policy_config, config)
        command_prefixes = self._extract_command_prefixes(policy_config, config)
        return {
            "dm_policy": self._sanitize_dm_policy(dm_policy_raw),
            "group_policy": self._sanitize_group_policy(group_policy_raw),
            "require_mention": require_mention,
            "group_require_mention": group_require_mention,
            "command_gate_enabled": command_gate_enabled,
            "command_prefixes": command_prefixes,
        }

    def apply_policy_patch(
        self,
        config: object,
        *,
        dm_policy: Optional[str] = None,
        group_policy: Optional[str] = None,
        require_mention: Optional[bool] = None,
        group_require_mention: Optional[dict[str, bool]] = None,
        command_gate_enabled: Optional[bool] = None,
        command_prefixes: Optional[list[str]] = None,
        clear_group_overrides: bool = False,
    ) -> dict[str, Any]:
        base_config = dict(config) if isinstance(config, dict) else {}
        current = self.extract_policy_config(base_config)

        next_dm_policy = self._sanitize_dm_policy(dm_policy or current["dm_policy"])
        next_group_policy = self._sanitize_group_policy(group_policy or current["group_policy"])
        next_require_mention = (
            bool(require_mention) if require_mention is not None else bool(current["require_mention"])
        )
        next_command_gate_enabled = (
            bool(command_gate_enabled)
            if command_gate_enabled is not None
            else bool(current["command_gate_enabled"])
        )
        next_command_prefixes = list(current["command_prefixes"])
        if command_prefixes is not None:
            next_command_prefixes = [
                item.strip()
                for item in command_prefixes
                if isinstance(item, str) and item.strip()
            ]
        if not next_command_prefixes:
            next_command_prefixes = ["/"]

        next_group_overrides = dict(current["group_require_mention"])
        if clear_group_overrides:
            next_group_overrides = {}
        if group_require_mention is not None:
            next_group_overrides = {
                key.strip(): bool(value)
                for key, value in group_require_mention.items()
                if isinstance(key, str) and key.strip()
            }

        serialized_groups = {
            key: {"require_mention": value}
            for key, value in next_group_overrides.items()
        }

        policy_config = base_config.get("policy")
        if not isinstance(policy_config, dict):
            policy_config = {}
        policy_config.update(
            {
                "dm_policy": next_dm_policy,
                "group_policy": next_group_policy,
                "require_mention": next_require_mention,
                "groups": serialized_groups,
                "command_gate_enabled": next_command_gate_enabled,
                "command_prefixes": next_command_prefixes,
            }
        )

        # 向后兼容历史配置读法（顶层字段仍可用）。
        base_config["policy"] = policy_config
        base_config["dm_policy"] = next_dm_policy
        base_config["group_policy"] = next_group_policy
        base_config["require_mention"] = next_require_mention
        base_config["groups"] = serialized_groups
        base_config["command_gate_enabled"] = next_command_gate_enabled
        base_config["command_prefixes"] = next_command_prefixes
        base_config["command_only"] = next_command_gate_enabled
        return base_config

    def _evaluate_dm(self, data: ChannelInboundMessage, policy: dict[str, Any]) -> PolicyDecision:
        dm_policy = policy["dm_policy"]

        # DS-020: dm_policy=open 仍须尊重显式 block 条目，防止被滥用绕过配对保护。
        allow = self._allowlist_hit(data)
        if allow is False:
            return PolicyDecision(allowed=False, reason="allowlist_blocked")

        if dm_policy == "open":
            logger.info(
                "[PolicyService] dm_policy=open active for organization=%s channel=%s — "
                "any unblocked external user can trigger Bot with Owner privileges",
                data.organization_id, data.channel,
            )
            return PolicyDecision(allowed=True, reason="dm_open")

        if allow is True:
            return PolicyDecision(allowed=True, reason="allowlist")

        if dm_policy == "allowlist":
            return PolicyDecision(allowed=False, reason="dm_allowlist_only")

        return PolicyDecision(allowed=False, reason="dm_pairing_required", pairing_required=True)

    def _evaluate_group(self, data: ChannelInboundMessage, policy: dict[str, Any]) -> PolicyDecision:
        group_policy = policy["group_policy"]
        if group_policy == "open":
            if self._require_mention(data, policy) and not self._is_mentioned(data):
                return PolicyDecision(allowed=False, reason="group_require_mention")
            if self._require_command(data, policy) and not self._is_command(data, policy):
                return PolicyDecision(allowed=False, reason="group_command_required")
            return PolicyDecision(allowed=True, reason="group_open")

        allow = self._allowlist_hit(data)
        if allow is True:
            if self._require_mention(data, policy) and not self._is_mentioned(data):
                return PolicyDecision(allowed=False, reason="group_require_mention")
            if self._require_command(data, policy) and not self._is_command(data, policy):
                return PolicyDecision(allowed=False, reason="group_command_required")
            return PolicyDecision(allowed=True, reason="allowlist")
        if allow is False:
            return PolicyDecision(allowed=False, reason="allowlist_blocked")

        return PolicyDecision(allowed=False, reason="group_allowlist_only")

    def _allowlist_hit(self, data: ChannelInboundMessage) -> Optional[bool]:
        account_id = (data.account_id or "default").strip() or "default"
        query = ChannelAllowlistEntry.objects.filter(
            organization_id=data.organization_id,
            channel=data.channel,
            account_id=account_id,
            peer_kind=data.peer_kind,
            peer_id__in=[data.peer_id, "*"]
        )
        entry = query.first()
        if not entry:
            return None
        return bool(entry.allow)

    def _require_mention(self, data: ChannelInboundMessage, policy: dict[str, Any]) -> bool:
        group_overrides = policy.get("group_require_mention") or {}
        if isinstance(group_overrides, dict):
            peer_keys = [data.peer_id]
            if ":thread:" in data.peer_id:
                peer_keys.append(data.peer_id.split(":thread:", 1)[0])
            for key in peer_keys:
                if key in group_overrides:
                    return bool(group_overrides[key])
            if "*" in group_overrides:
                return bool(group_overrides["*"])

        return bool(policy.get("require_mention", True))

    def _get_account(self, data: ChannelInboundMessage) -> ChannelAccount | None:
        account_id = (data.account_id or "default").strip() or "default"
        return ChannelAccount.objects.filter(
            organization_id=data.organization_id,
            channel=data.channel,
            account_id=account_id,
        ).first()

    @staticmethod
    def _require_command(data: ChannelInboundMessage, policy: dict[str, Any]) -> bool:
        if data.peer_kind not in {"group", "thread"}:
            return False
        return bool(policy.get("command_gate_enabled", False))

    @staticmethod
    def _is_command(data: ChannelInboundMessage, policy: dict[str, Any]) -> bool:
        text = (data.text or "").strip()
        if not text:
            return False
        prefixes = policy.get("command_prefixes")
        if not isinstance(prefixes, list) or not prefixes:
            prefixes = ["/"]
        return any(text.startswith(prefix) for prefix in prefixes if isinstance(prefix, str) and prefix)

    def _is_mentioned(self, data: ChannelInboundMessage) -> bool:
        metadata = data.metadata or {}
        mentioned = metadata.get("mentioned")
        if isinstance(mentioned, bool):
            return mentioned
        return False

    @staticmethod
    def _extract_require_mention(policy_config: dict[str, Any], root_config: dict[str, Any]) -> bool:
        for payload in (policy_config, root_config):
            if "require_mention" in payload and isinstance(payload["require_mention"], bool):
                return payload["require_mention"]
            if "requireMention" in payload and isinstance(payload["requireMention"], bool):
                return payload["requireMention"]
        return True

    @staticmethod
    def _extract_group_require_mention(
        policy_config: dict[str, Any],
        root_config: dict[str, Any],
    ) -> dict[str, bool]:
        groups = policy_config.get("groups")
        if not isinstance(groups, dict):
            groups = root_config.get("groups")
        if not isinstance(groups, dict):
            return {}

        result: dict[str, bool] = {}
        for key, value in groups.items():
            if not isinstance(key, str) or not key.strip():
                continue
            cleaned_key = key.strip()
            if isinstance(value, bool):
                result[cleaned_key] = value
                continue
            if isinstance(value, dict):
                if "require_mention" in value and isinstance(value["require_mention"], bool):
                    result[cleaned_key] = value["require_mention"]
                    continue
                if "requireMention" in value and isinstance(value["requireMention"], bool):
                    result[cleaned_key] = value["requireMention"]
        return result

    @staticmethod
    def _extract_command_gate_enabled(policy_config: dict[str, Any], root_config: dict[str, Any]) -> bool:
        for payload in (policy_config, root_config):
            if "command_gate_enabled" in payload and isinstance(payload["command_gate_enabled"], bool):
                return payload["command_gate_enabled"]
            if "commandGateEnabled" in payload and isinstance(payload["commandGateEnabled"], bool):
                return payload["commandGateEnabled"]
            if "command_only" in payload and isinstance(payload["command_only"], bool):
                return payload["command_only"]
            if "commandOnly" in payload and isinstance(payload["commandOnly"], bool):
                return payload["commandOnly"]
        return False

    @staticmethod
    def _extract_command_prefixes(policy_config: dict[str, Any], root_config: dict[str, Any]) -> list[str]:
        candidates = (
            policy_config.get("command_prefixes"),
            policy_config.get("commandPrefixes"),
            root_config.get("command_prefixes"),
            root_config.get("commandPrefixes"),
            root_config.get("command_prefix"),
        )

        for raw_value in candidates:
            normalized = ChannelPolicyService._normalize_prefixes(raw_value)
            if normalized:
                return normalized
        return ["/"]

    @staticmethod
    def _normalize_prefixes(value: object) -> list[str]:
        if isinstance(value, str):
            cleaned = value.strip()
            return [cleaned] if cleaned else []
        if not isinstance(value, list):
            return []

        result: list[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            cleaned = item.strip()
            if not cleaned:
                continue
            result.append(cleaned)
        return result

    def _sanitize_dm_policy(self, value: object) -> str:
        if isinstance(value, str) and value in VALID_DM_POLICY:
            return value
        return self.dm_policy if isinstance(getattr(self, "dm_policy", None), str) else "pairing"

    def _sanitize_group_policy(self, value: object) -> str:
        if isinstance(value, str) and value in VALID_GROUP_POLICY:
            return value
        return self.group_policy if isinstance(getattr(self, "group_policy", None), str) else "allowlist"
