"""LLM Wire Adapter · Capability 静态校验器(W1c 落地)。

> 用途:
> * ``validate_wire_capabilities`` management command 调用本模块做 9 项静态校验。
> * pytest 测试调用,作为 CI gate。

校验项(总控 § 4 W1 S1.4 + § 6.1):

1. **字段值 enum 合法性** — 字段当前值是否在 capability_enums 表内。
2. **helper 真识别** — 字段值是否在 ``HELPER_RECOGNIZED_*`` 集合内。
3. **必填字段完整性** — REQUIRED_FIELDS 必须非空。
4. **逻辑一致性** — 已知 invariant(image.input_via=()→image.enabled=False 等)。
5. **drift vs Provider.CAPABILITIES** — 与离散布尔字段交叉对比。

返回 ``ValidationReport``,逐项含 level=error/warning + 修复建议。
"""

from __future__ import annotations

import logging
from apps.services.common.db_router import postgres_app_db_alias
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .capability_enums import (
    REQUIRED_FIELDS,
    helper_recognizes,
    is_valid_enum,
    format_enum_hint,
    IMAGE_INPUT_VIA_TOKENS,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 报告数据类型
# ---------------------------------------------------------------------------

@dataclass
class ValidationIssue:
    """单条校验发现。

    - ``level``:``"error"`` / ``"warning"`` / ``"info"``
    - ``rule``:校验规则代号(便于过滤)
    - ``field``:涉及的字段路径(如 ``"wire.system_message_style"``)
    - ``message``:中文描述
    - ``observed``:实际值
    - ``expected``:期望值(描述)
    - ``hint``:修复建议
    """

    level: str
    rule: str
    field: str
    message: str
    observed: Any = None
    expected: Any = None
    hint: str = ""

    def to_json(self) -> Dict[str, Any]:
        return {
            "level": self.level,
            "rule": self.rule,
            "field": self.field,
            "message": self.message,
            "observed": _to_jsonable(self.observed),
            "expected": _to_jsonable(self.expected),
            "hint": self.hint,
        }


@dataclass
class ValidationReport:
    """单个 model 的校验报告。"""

    model_id: str
    model_name: str
    provider: str
    is_active: bool
    is_configured: bool
    wave_status: str
    issues: List[ValidationIssue] = field(default_factory=list)

    @property
    def errors(self) -> List[ValidationIssue]:
        return [i for i in self.issues if i.level == "error"]

    @property
    def warnings(self) -> List[ValidationIssue]:
        return [i for i in self.issues if i.level == "warning"]

    @property
    def has_errors(self) -> bool:
        return any(i.level == "error" for i in self.issues)

    @property
    def has_warnings(self) -> bool:
        return any(i.level == "warning" for i in self.issues)

    def passed(self, strict: bool = False) -> bool:
        if self.has_errors:
            return False
        if strict and self.has_warnings:
            return False
        return True

    def to_json(self) -> Dict[str, Any]:
        return {
            "model_id": self.model_id,
            "model_name": self.model_name,
            "provider": self.provider,
            "is_active": self.is_active,
            "is_configured": self.is_configured,
            "wave_status": self.wave_status,
            "errors": [i.to_json() for i in self.errors],
            "warnings": [i.to_json() for i in self.warnings],
            "info": [i.to_json() for i in self.issues if i.level == "info"],
        }


def _to_jsonable(value: Any) -> Any:
    """把 tuple/list/dict 等递归转 JSON-safe 类型。"""
    if isinstance(value, tuple):
        return [_to_jsonable(v) for v in value]
    if isinstance(value, list):
        return [_to_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    return value


# ---------------------------------------------------------------------------
# 主校验函数
# ---------------------------------------------------------------------------

def validate_model(model: Any) -> ValidationReport:
    """对单个 LLMModel 跑全套静态校验。

    Args:
        model: LLMModel 实例(必须含 ``capabilities_config`` / ``provider`` /
               ``is_active`` / ``model_name`` / ``id`` / ``wave_status``)。

    Returns:
        ValidationReport,含 issues 列表。
    """
    capabilities_config = getattr(model, "capabilities_config", None) or {}
    if not isinstance(capabilities_config, dict):
        capabilities_config = {}
    wa = capabilities_config.get("wire_adapter")
    is_configured = isinstance(wa, dict) and len(wa) > 0
    if not isinstance(wa, dict):
        wa = {}

    provider_name = ""
    try:
        provider_name = (model.provider.name or "").lower()
    except Exception:
        pass

    # v0.1：LLMModel.is_active 字段已删（0022）；保留 ``is_active`` 字段名以兼容报告 schema，
    # 取值改成 ``wave_status='ready'``——v0.1 下"参与路由"的语义就在 wave_status 里。
    is_active_v01 = (getattr(model, "wave_status", "") or "") == "ready"
    report = ValidationReport(
        model_id=str(getattr(model, "id", "")),
        model_name=getattr(model, "model_name", "") or "",
        provider=provider_name,
        is_active=is_active_v01,
        is_configured=is_configured,
        wave_status=getattr(model, "wave_status", "") or "",
    )

    # 未配置 wire_adapter 子键 → 给一条 warning(active model 才挑)
    if not is_configured and report.is_active:
        report.issues.append(
            ValidationIssue(
                level="warning",
                rule="W1c.config.missing_wire_adapter",
                field="capabilities_config.wire_adapter",
                message=(
                    "active model 未配置 capabilities_config['wire_adapter'] 子键,"
                    "wire_adapter 走 service / 离散字段 fallback。"
                ),
                observed=None,
                expected="non-empty wire_adapter dict",
                hint="跑 W1a migration 0015/0016 或 admin 手工补齐 wire_adapter 字段。",
            )
        )

    # 1. 字段值 enum 合法性 + helper 识别
    _check_enum_fields(wa, report)

    # 2. 必填字段
    _check_required_fields(wa, report, is_configured)

    # 3. 逻辑一致性（Invariant 5 需 provider/model 才能判「真 drift」）
    provider_key = ""
    try:
        provider_key = (getattr(model.provider, "provider_key", None) or "") or ""
    except Exception:
        provider_key = ""
    _check_invariants(
        wa,
        report,
        provider_name=provider_name,
        provider_key=str(provider_key).lower(),
        model_name=report.model_name,
    )

    # 4. drift vs 离散布尔字段
    _check_discrete_drift(model, wa, report)

    return report


# ---------------------------------------------------------------------------
# 子校验函数
# ---------------------------------------------------------------------------

def _check_enum_fields(wa: Dict[str, Any], report: ValidationReport) -> None:
    """校验 enum 字段:在 enum 表内 + helper 识别。"""
    enum_fields = [
        "wire.system_message_style",
        "wire.system_placement",
        "wire.request_protocol",
        "wire.streaming_protocol",
        "reasoning.format",
        "reasoning.param_path",
        "caching.mode",
    ]
    for path in enum_fields:
        value = _read_path(wa, path)
        if value is None and path in {
            "wire.streaming_protocol",  # Optional
            "reasoning.param_path",      # Optional / None
        }:
            # None 在这些字段是合法的
            continue
        if value is None:
            # 字段缺失 → 由必填字段校验报告
            continue

        if not is_valid_enum(path, value):
            report.issues.append(
                ValidationIssue(
                    level="error",
                    rule="W1c.enum.invalid_value",
                    field=path,
                    message=f"{path}={value!r} 不在 enum 权威表内。",
                    observed=value,
                    expected="见 capability_enums 权威表",
                    hint=format_enum_hint(path),
                )
            )
            continue

        if not helper_recognizes(path, value):
            report.issues.append(
                ValidationIssue(
                    level="warning",
                    rule="W1c.helper.not_recognized",
                    field=path,
                    message=(
                        f"{path}={value!r} 在 enum 表内但 helper 不显式识别(可能走默认透传分支)。"
                    ),
                    observed=value,
                    expected="HELPER_RECOGNIZED_* 内的值",
                    hint=(
                        "确认 helper 是否真的覆盖此值,或在 capability_enums.py "
                        "的 HELPER_RECOGNIZED_* 集合内补登记。"
                    ),
                )
            )


def _check_required_fields(
    wa: Dict[str, Any],
    report: ValidationReport,
    is_configured: bool,
) -> None:
    """校验必填字段(W2 sdk_dispatcher / stream_adapter 依赖)。"""
    if not is_configured:
        # 未配置 wire_adapter 不挑必填(已经报过 missing_wire_adapter warning)
        return
    for path, purpose in REQUIRED_FIELDS:
        value = _read_path(wa, path)
        if value is None or value == "":
            report.issues.append(
                ValidationIssue(
                    level="error",
                    rule="W1c.required.missing",
                    field=path,
                    message=f"必填字段 {path} 缺失。用途:{purpose}",
                    observed=value,
                    expected="non-empty value",
                    hint=f"补齐 {path}(参考 capability_enums 权威表)。",
                )
            )


def _provider_accepts_thinking_request_switch(
    *,
    provider_name: str,
    provider_key: str,
    model_name: str,
) -> bool:
    """该 provider/model 是否接受 Anthropic 风顶层 ``thinking`` 请求开关。

    响应侧 ``format=reasoning_content_field`` 与请求侧 ``param_path`` 正交：
    Kimi K2.x 即「响应走 reasoning_content + 请求走 thinking{type,budget}」
    （含 ``{type:'disabled'}`` 强制工具轮，见 ）。

    用 provider/model 白名单判定，**禁止**再用 format 反推「不许配 thinking」。
    """
    tokens = " ".join(
        [
            (provider_name or "").lower(),
            (provider_key or "").lower(),
            (model_name or "").lower(),
        ]
    )
    if "moonshot" in tokens:
        return True
    # 模型名直接暴露厂商时（BYOK / 转售）也放行 K2 系
    if "kimi-k2" in tokens:
        return True
    return False


def _check_invariants(
    wa: Dict[str, Any],
    report: ValidationReport,
    *,
    provider_name: str = "",
    provider_key: str = "",
    model_name: str = "",
) -> None:
    """校验逻辑一致性 invariants(常识约束)。"""
    image = wa.get("image", {}) or {}
    wire = wa.get("wire", {}) or {}
    caching = wa.get("caching", {}) or {}
    reasoning = wa.get("reasoning", {}) or {}
    tool = wa.get("tool", {}) or {}

    # === Invariant 1:image.input_via=()→image.enabled=False(MiniMax 场景) ===
    input_via = image.get("input_via") or []
    if isinstance(input_via, (list, tuple)):
        if image.get("enabled") and len(input_via) == 0:
            report.issues.append(
                ValidationIssue(
                    level="error",
                    rule="W1c.invariant.image_enabled_without_input_via",
                    field="image.enabled",
                    message="image.enabled=True 但 image.input_via 为空,逻辑矛盾。",
                    observed={"enabled": True, "input_via": []},
                    expected="enabled=False 或 input_via 非空",
                    hint="若 model 不支持图片,把 image.enabled 改 False;否则补 input_via。",
                )
            )
        if not image.get("enabled") and len(input_via) > 0:
            report.issues.append(
                ValidationIssue(
                    level="warning",
                    rule="W1c.invariant.input_via_without_enabled",
                    field="image.enabled",
                    message="image.input_via 非空但 image.enabled=False,可能是配置遗留。",
                    observed={"enabled": False, "input_via": list(input_via)},
                    expected="enabled=True",
                    hint="若 model 支持图片,把 image.enabled 改 True;否则清空 input_via。",
                )
            )
        # input_via 内 token 必须在合法 token 集合内
        for token in input_via:
            if isinstance(token, str) and token not in IMAGE_INPUT_VIA_TOKENS:
                report.issues.append(
                    ValidationIssue(
                        level="error",
                        rule="W1c.invariant.invalid_input_via_token",
                        field="image.input_via",
                        message=(
                            f"image.input_via 含非法 token {token!r},"
                            f"合法 token: {sorted(IMAGE_INPUT_VIA_TOKENS)}"
                        ),
                        observed=list(input_via),
                        expected=sorted(IMAGE_INPUT_VIA_TOKENS),
                        hint="只能用 base64/url/file_id 三个 token。",
                    )
                )

    # === Invariant 2:anthropic_messages → upstream_path=/v1/messages ===
    if wire.get("request_protocol") == "anthropic_messages":
        upstream = wire.get("upstream_path")
        if upstream and not upstream.endswith("/v1/messages"):
            report.issues.append(
                ValidationIssue(
                    level="error",
                    rule="W1c.invariant.anthropic_messages_path_mismatch",
                    field="wire.upstream_path",
                    message=(
                        f"request_protocol=anthropic_messages 但 upstream_path={upstream!r},"
                        "应该是 /v1/messages。"
                    ),
                    observed=upstream,
                    expected="/v1/messages",
                    hint="W2 sdk_dispatcher 用此字段路由到 anthropic SDK。",
                )
            )

    # === Invariant 3:caching.mode=explicit_cache_control → cache_control_strip=False ===
    if caching.get("mode") == "explicit_cache_control":
        if caching.get("cache_control_strip", False):
            report.issues.append(
                ValidationIssue(
                    level="error",
                    rule="W1c.invariant.explicit_cache_with_strip",
                    field="caching.cache_control_strip",
                    message=(
                        "caching.mode=explicit_cache_control 但 cache_control_strip=True,"
                        "会把客户端发的 cache_control 剥离掉,功能失效。"
                    ),
                    observed=True,
                    expected=False,
                    hint="explicit_cache_control 必须保留 cache_control 透传给上游。",
                )
            )

    # === Invariant 4:tool.parallel_param_inverted=True → parallel_param_name 是反向参数 ===
    if tool.get("enabled"):
        if tool.get("parallel_param_inverted") and tool.get("parallel_param_name") == "parallel_tool_calls":
            report.issues.append(
                ValidationIssue(
                    level="error",
                    rule="W1c.invariant.parallel_inverted_name_mismatch",
                    field="tool.parallel_param_name",
                    message=(
                        "parallel_param_inverted=True 但 parallel_param_name=parallel_tool_calls,"
                        "反向参数名应是 disable_parallel_tool_use 之类。"
                    ),
                    observed=tool.get("parallel_param_name"),
                    expected="disable_parallel_tool_use(Anthropic 风)",
                    hint="Anthropic / MiniMax 反向时改名 disable_parallel_tool_use。",
                )
            )
        if not tool.get("parallel_param_inverted") and tool.get("parallel_param_name", "").startswith("disable_"):
            report.issues.append(
                ValidationIssue(
                    level="warning",
                    rule="W1c.invariant.parallel_inverted_name_polarity",
                    field="tool.parallel_param_inverted",
                    message=(
                        f"parallel_param_name={tool.get('parallel_param_name')!r} 看起来是反向命名"
                        ",但 parallel_param_inverted=False,可能配置错位。"
                    ),
                    observed={"name": tool.get("parallel_param_name"), "inverted": False},
                    expected="inverted=True",
                    hint="若用 disable_xxx 反向参数,inverted 应为 True。",
                )
            )

    # === Invariant 5:reasoning 跨字段一致性 ===
    fmt = reasoning.get("format")
    param_path = reasoning.get("param_path")
    if fmt == "thinking_block" and param_path not in (None, "", "thinking"):
        report.issues.append(
            ValidationIssue(
                level="warning",
                rule="W1c.invariant.reasoning_format_param_mismatch",
                field="reasoning.param_path",
                message=(
                    f"reasoning.format=thinking_block(Claude) 但 param_path={param_path!r},"
                    "应是 'thinking'。"
                ),
                observed=param_path,
                expected="thinking",
                hint="Claude 风 thinking_block 与 thinking 顶层字段配套。",
            )
        )
    if fmt == "thinking_config" and not (
        isinstance(param_path, str) and param_path.startswith("extra_body.")
    ):
        report.issues.append(
            ValidationIssue(
                level="warning",
                rule="W1c.invariant.reasoning_format_param_mismatch",
                field="reasoning.param_path",
                message=(
                    f"reasoning.format=thinking_config(Gemini) 但 param_path={param_path!r},"
                    "应以 'extra_body.' 开头。"
                ),
                observed=param_path,
                expected="extra_body.google.thinking_config",
                hint="Gemini 必须走 extra_body 路径(OpenAI 兼容层)。",
            )
        )
    if (
        fmt == "reasoning_content_field"
        and isinstance(param_path, str)
        and param_path == "thinking"
    ):
        # : format 描述响应形态,param_path 描述请求开关 —— 二者正交。
        # Moonshot Kimi K2.x 合法组合是 reasoning_content_field + thinking
        # （强制工具轮依赖 thinking.type=disabled）。禁止按 format 一律报警,
        # 也禁止「修」成 param_path=None（会弄坏关思考）。
        if not _provider_accepts_thinking_request_switch(
            provider_name=provider_name,
            provider_key=provider_key,
            model_name=model_name,
        ):
            report.issues.append(
                ValidationIssue(
                    level="warning",
                    rule="W1c.invariant.reasoning_format_param_mismatch",
                    field="reasoning.param_path",
                    message=(
                        f"provider={provider_key or provider_name or '?'} "
                        f"model={model_name or '?'}："
                        "reasoning.format=reasoning_content_field 且 "
                        "param_path='thinking',但该厂商未登记为接受 Anthropic 风 "
                        "thinking 请求开关。可能是配置漂移。"
                    ),
                    observed={
                        "format": fmt,
                        "param_path": param_path,
                        "provider": provider_key or provider_name,
                        "model": model_name,
                    },
                    expected=(
                        "Moonshot/Kimi K2: 保持 thinking；"
                        "Qwen DashScope: enable_thinking；"
                        "Kimi K3: reasoning_effort；"
                        "无请求侧开关: None / ''"
                    ),
                    hint=(
                        "不要为了消 warning 把 Kimi 的 param_path 改成 None——"
                        "会破坏 tool_choice=required 时显式关闭 thinking。"
                        "若确认为新厂商也接受 thinking 开关,把白名单扩到 "
                        "_provider_accepts_thinking_request_switch。"
                    ),
                )
            )


def _check_discrete_drift(
    model: Any,
    wa: Dict[str, Any],
    report: ValidationReport,
) -> None:
    """对比 wire_adapter 字段与离散布尔字段的一致性。

    v0.1：LLMModel.supports_*/multimodal_limits 等离散字段已删（0022），
    对照值改从 ``capabilities_config`` 读，沿用同一份 wire_adapter 漂移告警链路。
    """
    pairs = [
        # (字段路径, capabilities_config 内 alias key, 描述)
        ("image.enabled", "supports_vision", "图片输入"),
        ("video.enabled", "supports_video_input", "视频输入"),
        ("tool.enabled", "supports_function_calling", "工具调用"),
        ("reasoning.enabled", "supports_reasoning", "Reasoning"),
    ]
    config = getattr(model, "capabilities_config", None) or {}
    if not isinstance(config, dict):
        config = {}
    for wa_path, discrete_key, desc in pairs:
        wa_value = _read_path(wa, wa_path)
        # 优先实例属性兜底（dict 透传 / 单测 SimpleNamespace），其次 capabilities_config。
        discrete_value = getattr(model, discrete_key, None)
        if discrete_value is None:
            discrete_value = config.get(discrete_key)
        if wa_value is None or discrete_value is None:
            continue
        wa_bool = bool(wa_value)
        discrete_bool = bool(discrete_value)
        if wa_bool != discrete_bool:
            report.issues.append(
                ValidationIssue(
                    level="warning",
                    rule="W1c.drift.discrete_vs_wire_adapter",
                    field=wa_path,
                    message=(
                        f"{desc}:wire_adapter.{wa_path}={wa_bool} 与 capabilities_config.{discrete_key}={discrete_bool} 不一致。"
                    ),
                    observed={"wire_adapter": wa_bool, "capabilities_config": discrete_bool},
                    expected="两者一致",
                    hint=(
                        f"对齐方式:更新 capabilities_config.{discrete_key} 或 "
                        f"wire_adapter.{wa_path}。"
                    ),
                )
            )


def _read_path(d: Dict[str, Any], path: str) -> Any:
    """按 dot path 读取 nested dict 字段。"""
    cursor: Any = d
    for part in path.split("."):
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(part)
    return cursor


# ---------------------------------------------------------------------------
# 多 model 批量入口
# ---------------------------------------------------------------------------

def validate_models(models: List[Any]) -> List[ValidationReport]:
    """对一组 LLMModel 批量校验,返回 reports 列表。"""
    return [validate_model(m) for m in models]


def select_chat_capable_active_models(model_filter: Optional[str] = None) -> List[Any]:
    """选出 active 且 chat-capable 的 LLMModel 列表。

    Args:
        model_filter: model_name 子串(case-insensitive),None=全选。

    注:LLMModel class 里 ``wave_status`` 字段 W1a migration 已 AddField 但 model
    class 未声明(总控 § 5 W1a 遗留)。本函数对每个 model 用 ``_attach_raw_wave_status``
    从 DB 直查并附加为属性,validator 显示用。
    """
    from apps.services.llm.models import LLMModel

    # v0.1：LLMModel.is_active / mode 字段已删（0022），只校验 chat 域 + ready 模型。
    qs = LLMModel.objects.select_related("provider").filter(
        capability_domain="chat",
        wave_status="ready",
    )
    if model_filter:
        qs = qs.filter(model_name__icontains=model_filter)
    models = list(qs.order_by("provider__name", "model_name"))
    _attach_raw_wave_status(models)
    return models


def _attach_raw_wave_status(models: List[Any]) -> None:
    """从 DB raw 查询 wave_status 字段,挂到 model 实例的 ``wave_status`` 属性。

    LLMModel class 缺字段声明时 ``getattr(m, 'wave_status', None)`` 返回 None;
    本函数补真值(v0.1：services_llm 已迁 PostgreSQL，DB 直查走 ``postgresql`` alias)。

    注:历史 MySQL 时代存 UUID 用无 dash 32-char hex,Python ``str(m.id)`` 含 dash,
    保留双向 map 以兼容旧记录。
    """
    if not models:
        return
    try:
        from django.db import connections
        ids_with_dash = [str(m.id) for m in models]
        ids_no_dash = [s.replace("-", "") for s in ids_with_dash]
        all_ids = list({*ids_with_dash, *ids_no_dash})
        placeholders = ",".join(["%s"] * len(all_ids))
        with connections[postgres_app_db_alias()].cursor() as cursor:
            cursor.execute(
                f"SELECT id, wave_status FROM services_llm_model WHERE id IN ({placeholders})",
                all_ids,
            )
            wave_map = {str(row[0]): row[1] for row in cursor.fetchall()}
    except Exception:
        return
    for m in models:
        existing = getattr(m, "wave_status", None)
        if existing in (None, ""):
            try:
                key1 = str(m.id)
                key2 = key1.replace("-", "")
                wave = wave_map.get(key1) or wave_map.get(key2)
                if wave is not None:
                    object.__setattr__(m, "wave_status", wave)
            except Exception:
                pass


__all__ = [
    "ValidationIssue",
    "ValidationReport",
    "validate_model",
    "validate_models",
    "select_chat_capable_active_models",
]
