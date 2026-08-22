"""AI Scene 的业务调用、Provider 尝试与最终结算身份。"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

logger = logging.getLogger(__name__)

FUNDING_MODE_PROVIDER_CREDIT_V1 = "provider_credit_v1"
FUNDING_MODE_LEGACY_BUDGET_WALLET = "legacy_budget_wallet"
FUNDING_MODES = frozenset(
    {FUNDING_MODE_PROVIDER_CREDIT_V1, FUNDING_MODE_LEGACY_BUDGET_WALLET}
)


def current_funding_mode() -> str:
    """把 rollout boolean 转成可冻结、可长期解释的资金契约版本。"""
    from django.conf import settings

    if getattr(settings, "PROVIDER_CREDIT_FUNDING_ENABLED", False):
        return FUNDING_MODE_PROVIDER_CREDIT_V1
    return FUNDING_MODE_LEGACY_BUDGET_WALLET


def normalize_funding_mode(funding_mode: str | None) -> str:
    resolved = str(funding_mode or "").strip() or current_funding_mode()
    if resolved not in FUNDING_MODES:
        raise ValueError(f"未知 funding_mode: {resolved}")
    return resolved


class SettlementIdempotencyKeyBuilder:
    """集中生成最终用户结算幂等键。"""

    VERSION = "v1"
    PREFIX = "ai-scene-settlement"
    MAX_LENGTH = 255

    @classmethod
    def build(
        cls,
        *,
        organization_id: str,
        execution_key: str,
        invocation_id: str,
    ) -> str:
        parts = {
            "organization_id": str(organization_id or "").strip(),
            "execution_key": str(execution_key or "").strip(),
            "invocation_id": str(invocation_id or "").strip(),
        }
        missing = [name for name, value in parts.items() if not value]
        if missing:
            raise ValueError(
                "结算幂等键缺少必填身份: " + ", ".join(sorted(missing))
            )
        key = (
            f"{cls.PREFIX}:{cls.VERSION}:{parts['organization_id']}:"
            f"{parts['execution_key']}:{parts['invocation_id']}"
        )
        if len(key) > cls.MAX_LENGTH:
            raise ValueError("结算幂等键不能超过 255 字符")
        return key


@dataclass(frozen=True)
class SettlementIdentity:
    idempotency_key: str
    version: str
    stable: bool


@dataclass(frozen=True)
class ProviderAttemptContext:
    invocation_id: str
    attempt_id: str
    request_id: str
    settlement_identity: SettlementIdentity
    funding_mode: str
    retry_source: str = ""


@dataclass(frozen=True)
class SceneInvocationContext:
    invocation_id: str
    scene_key: str
    execution_key: str
    organization_id: str
    user_id: str
    stable_invocation: bool
    funding_mode: str
    selected_model_id: str = ""
    business_object_type: str = ""
    business_object_id: str = ""
    run_id: str = ""
    task_id: str = ""
    parent_invocation_id: str = ""
    retry_source: str = ""

    @classmethod
    def stable(
        cls,
        *,
        invocation_id: str,
        scene_key: str,
        execution_key: str,
        organization_id: str,
        user_id: str,
        selected_model_id: str = "",
        business_object_type: str = "",
        business_object_id: str = "",
        run_id: str = "",
        task_id: str = "",
        parent_invocation_id: str = "",
        retry_source: str = "",
        funding_mode: str | None = None,
    ) -> "SceneInvocationContext":
        normalized_invocation_id = str(invocation_id or "").strip()
        if not normalized_invocation_id:
            raise ValueError("stable invocation_id 不能为空")
        return cls(
            invocation_id=normalized_invocation_id,
            scene_key=str(scene_key or "").strip(),
            execution_key=str(execution_key or "").strip(),
            organization_id=str(organization_id or "").strip(),
            user_id=str(user_id or "").strip(),
            stable_invocation=True,
            funding_mode=normalize_funding_mode(funding_mode),
            selected_model_id=str(selected_model_id or "").strip(),
            business_object_type=str(business_object_type or "").strip(),
            business_object_id=str(business_object_id or "").strip(),
            run_id=str(run_id or "").strip(),
            task_id=str(task_id or "").strip(),
            parent_invocation_id=str(parent_invocation_id or "").strip(),
            retry_source=str(retry_source or "").strip(),
        )

    @classmethod
    def legacy(
        cls,
        *,
        scene_key: str,
        execution_key: str,
        organization_id: str,
        user_id: str,
        selected_model_id: str = "",
        retry_source: str = "",
        funding_mode: str | None = None,
    ) -> "SceneInvocationContext":
        return cls(
            invocation_id=str(uuid.uuid4()),
            scene_key=str(scene_key or "").strip(),
            execution_key=str(execution_key or "").strip(),
            organization_id=str(organization_id or "").strip(),
            user_id=str(user_id or "").strip(),
            stable_invocation=False,
            funding_mode=normalize_funding_mode(funding_mode),
            selected_model_id=str(selected_model_id or "").strip(),
            retry_source=str(retry_source or "").strip(),
        )

    def start_attempt(self, *, request_id: str | None = None) -> ProviderAttemptContext:
        attempt_id = str(uuid.uuid4())
        resolved_request_id = str(request_id or "").strip() or attempt_id
        if self.stable_invocation:
            settlement_identity = SettlementIdentity(
                idempotency_key=SettlementIdempotencyKeyBuilder.build(
                    organization_id=self.organization_id,
                    execution_key=self.execution_key,
                    invocation_id=self.invocation_id,
                ),
                version=SettlementIdempotencyKeyBuilder.VERSION,
                stable=True,
            )
        else:
            settlement_identity = SettlementIdentity(
                idempotency_key=f"llm_usage:{resolved_request_id}",
                version="legacy_request_id",
                stable=False,
            )
        return ProviderAttemptContext(
            invocation_id=self.invocation_id,
            attempt_id=attempt_id,
            request_id=resolved_request_id,
            settlement_identity=settlement_identity,
            funding_mode=self.funding_mode,
            retry_source=self.retry_source,
        )


def prepare_scene_invocation(
    *,
    scene_key: str,
    organization_id: str,
    user_id: str,
    selected_model_id: str | None = None,
    invocation_context: SceneInvocationContext | None = None,
) -> SceneInvocationContext:
    """校验 caller 身份；缺失时显式降级到可观测的 legacy 模式。"""
    from apps.services.llm.scenes.exceptions import SceneNotRegistered
    from apps.services.llm.scenes.registry import SCENES

    scene_spec = SCENES.get(scene_key)
    if scene_spec is None:
        raise SceneNotRegistered(
            f"scene_key='{scene_key}' 未在 SCENES 注册",
            scene_key=scene_key,
        )
    execution_key = (
        scene_spec.policy.execution_key if scene_spec.policy is not None else scene_key
    )
    if invocation_context is None:
        resolved = SceneInvocationContext.legacy(
            scene_key=scene_key,
            execution_key=execution_key,
            organization_id=organization_id,
            user_id=user_id,
            selected_model_id=selected_model_id or "",
        )
    else:
        expected = {
            "scene_key": str(scene_key or "").strip(),
            "execution_key": execution_key,
            "organization_id": str(organization_id or "").strip(),
            "user_id": str(user_id or "").strip(),
            "selected_model_id": str(selected_model_id or "").strip(),
        }
        actual = {
            "scene_key": invocation_context.scene_key,
            "execution_key": invocation_context.execution_key,
            "organization_id": invocation_context.organization_id,
            "user_id": invocation_context.user_id,
            "selected_model_id": invocation_context.selected_model_id,
        }
        mismatches = [
            name for name, value in expected.items() if actual[name] != value
        ]
        if mismatches:
            raise ValueError(
                "SceneInvocationContext 与调用入口不一致: "
                + ", ".join(sorted(mismatches))
            )
        resolved = invocation_context

    _record_invocation_observability(resolved)
    return resolved


def _record_invocation_observability(invocation: SceneInvocationContext) -> None:
    try:
        from apps.services.llm.services.llm_metrics import (
            ai_scene_invocation_total,
            ai_scene_legacy_identity_total,
        )

        stable_label = "true" if invocation.stable_invocation else "false"
        ai_scene_invocation_total.labels(
            scene=invocation.scene_key,
            stable=stable_label,
        ).inc()
        if not invocation.stable_invocation:
            ai_scene_legacy_identity_total.labels(scene=invocation.scene_key).inc()
    except Exception:
        pass

    logger.info(
        "ai_scene_invocation",
        extra={
            "event": "ai_scene_invocation",
            "scene_key": invocation.scene_key,
            "execution_key": invocation.execution_key,
            "invocation_id": invocation.invocation_id,
            "stable_invocation": invocation.stable_invocation,
            "business_object_type": invocation.business_object_type,
            "business_object_id": invocation.business_object_id,
            "run_id": invocation.run_id,
            "task_id": invocation.task_id,
            "retry_source": invocation.retry_source,
            "funding_mode": invocation.funding_mode,
            "selected_model_id": invocation.selected_model_id,
            "legacy_settlement_identity": not invocation.stable_invocation,
        },
    )


__all__ = [
    "ProviderAttemptContext",
    "FUNDING_MODE_LEGACY_BUDGET_WALLET",
    "FUNDING_MODE_PROVIDER_CREDIT_V1",
    "FUNDING_MODES",
    "SceneInvocationContext",
    "SettlementIdempotencyKeyBuilder",
    "SettlementIdentity",
    "current_funding_mode",
    "normalize_funding_mode",
    "prepare_scene_invocation",
]
