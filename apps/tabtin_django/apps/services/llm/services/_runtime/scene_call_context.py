"""
SceneCallContext 装配

校验 scene_key 在 SCENES 注册 → E19
校验 capability_domain 匹配 → E20
校验 organization_id / user_id 必填 → MISSING_*
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from apps.services.llm.scenes.registry import SCENES, SceneSpec
from apps.services.llm.scenes.exceptions import (
    SceneNotRegistered,
    CapabilityDomainMismatch,
    MissingOrganizationId,
    MissingUserId,
)
from apps.services.llm.services.types import CapabilityDomain


# EQ-018 D1 决策：平台级调用 sentinel
# 允许业务 scene 被平台级路径合法调用：caller 用 organization_id 中的特殊值
# 标记"无用户归属、平台买单"语义，此时不再强制 user_id 必填。
# - "system": ToolEmbeddingService 等平台 RAG 索引使用（apps/capabilities/services/tool_embedding.py）
# - "__system__": sms/email billing_hook 已有约定（apps/services/{sms,email}/services/billing_hook.py）
# 两个值合并支持，避免分裂。新代码统一用 "system"。
PLATFORM_ORGANIZATION_SENTINELS = frozenset({"system", "__system__"})


@dataclass
class SceneCallContext:
    """装配后的场景调用上下文，传递给后续流水线各阶段。"""
    scene_spec: SceneSpec
    scene_key: str
    capability_domain: CapabilityDomain
    organization_id: str
    user_id: str
    request_id: str
    variables: Mapping[str, Any] | None
    override_params: Mapping[str, Any] | None
    timeout_sec: int | None


def build_scene_call_context(
    *,
    scene_key: str,
    expected_domain: CapabilityDomain,
    organization_id: str,
    user_id: str,
    request_id: str | None = None,
    variables: Mapping[str, Any] | None = None,
    override_params: Mapping[str, Any] | None = None,
    timeout_sec: int | None = None,
) -> SceneCallContext:
    """装配 SceneCallContext，校验不通过直接抛异常。"""
    import uuid

    if scene_key not in SCENES:
        raise SceneNotRegistered(
            f"scene_key='{scene_key}' 未在 SCENES 注册",
            scene_key=scene_key,
        )

    spec = SCENES[scene_key]

    if spec.capability_domain != expected_domain:
        raise CapabilityDomainMismatch(
            f"入口 domain='{expected_domain}' 与 scene domain='{spec.capability_domain}' 不匹配",
            scene_key=scene_key,
            expected=expected_domain,
            actual=spec.capability_domain,
        )

    if not organization_id:
        raise MissingOrganizationId(
            "organization_id 为空",
            scene_key=scene_key,
        )

    # 三种放行 user_id="" 的合法场景：
    # 1) system scene（_main_chat / _compact 等平台核心循环）
    # 2) organization_id 是 PLATFORM_ORGANIZATION_SENTINELS（EQ-018 平台级调用约定）
    is_platform_call = organization_id in PLATFORM_ORGANIZATION_SENTINELS
    if not user_id and not spec.is_system and not is_platform_call:
        raise MissingUserId(
            "user_id 为空（非 system scene 必填；如为平台级调用，"
            f"organization_id 应为 {sorted(PLATFORM_ORGANIZATION_SENTINELS)} 之一）",
            scene_key=scene_key,
        )

    resolved_request_id = request_id or str(uuid.uuid4())

    return SceneCallContext(
        scene_spec=spec,
        scene_key=scene_key,
        capability_domain=spec.capability_domain,
        organization_id=organization_id,
        user_id=user_id,
        request_id=resolved_request_id,
        variables=variables,
        override_params=override_params,
        timeout_sec=timeout_sec,
    )
