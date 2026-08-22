"""LLM Wire Adapter · Capability Self-Test Probes(W1c 落地)。

> 用途:
> * ``llm_capability_test`` management command 调用本模块跑 dry-run probe。
> * W3 升级 ``--live`` 真发 LLM API(本期留 stub)。

设计:

* **插件式 Probe 类**:加新 Probe 不改框架;每个 Probe 含 ``name`` /
  ``prepare_body`` / ``dry_run`` / ``expected_capability`` / ``compare`` /
  ``live_run`` 五个方法。
* **dry-run 范围(W1c)**:跑 ``utils.capabilities.resolve_for_wire(model, provider=...)`` +
  ``adapt_request(body, caps, ctx)``,捕获 CapabilityGateError → 报"capability gate"。
  不真发 API。
* **live 路径(W3)**:留 stub,raise NotImplementedError。

drift 判定:

| declared | observed | 结论 |
|----------|----------|------|
| True | True | ✅ pass |
| True | False | ✗ regression(declared 但 fail) |
| False | False | ✅ all-no-support |
| False | True | △ under-claim(可升级 declared) |
| capability_gated | capability_gated | ✅ gated 一致 |
| 任意 mismatch | | △ drift |

输出统一 ProbeResult 结构。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .request_adapter import CapabilityGateError, adapt_request
from .resolved_capabilities import ResolvedCapabilities

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

@dataclass
class ProbeResult:
    """单个 probe 在单个 model 上的结果。

    - ``observed``:dry-run 实际结果 ``"pass"`` / ``"capability_gated"`` / ``"error"``
    - ``declared``:基于 caps 推断的"应该"结果(同三值集合)
    - ``drift_type``:``"none"`` / ``"regression"`` / ``"under_claim"`` /
      ``"gated_aligned"`` / ``"unknown"``
    - ``downgrade_events``:adapt_request 输出的降级 event 列表(W1b 已支持)
    - ``error_code``:CapabilityGateError 的 error_code(若 gated)
    - ``error_detail``:技术详情(用户看的中文文案 + 英文 detail)
    """

    probe_name: str
    model_id: str
    model_name: str
    observed: str  # pass / capability_gated / error
    declared: str  # pass / capability_gated / error
    drift_type: str
    downgrade_events: List[Dict[str, Any]] = field(default_factory=list)
    error_code: str = ""
    error_detail: str = ""

    def to_json(self) -> Dict[str, Any]:
        return {
            "probe_name": self.probe_name,
            "model_id": self.model_id,
            "model_name": self.model_name,
            "observed": self.observed,
            "declared": self.declared,
            "drift_type": self.drift_type,
            "downgrade_events": self.downgrade_events,
            "error_code": self.error_code,
            "error_detail": self.error_detail,
        }


def _compare(observed: str, declared: str) -> str:
    """drift 判定。"""
    if observed == declared:
        if observed == "capability_gated":
            return "gated_aligned"
        return "none"
    if declared == "pass" and observed == "capability_gated":
        return "regression"
    if declared == "capability_gated" and observed == "pass":
        return "under_claim"
    return "unknown"


# ---------------------------------------------------------------------------
# Probe 基类
# ---------------------------------------------------------------------------

class BaseProbe:
    """Probe 基类。子类必须实现 ``name`` / ``prepare_body`` /
    ``expected_capability``。

    框架统一调度 ``dry_run`` 和 ``live_run``。
    """

    name: str = ""
    description: str = ""

    def prepare_body(self, model: Any) -> Dict[str, Any]:
        """构造 minimal request body 供 adapt_request 跑。"""
        raise NotImplementedError

    def expected_capability(self, model: Any, caps: ResolvedCapabilities) -> str:
        """基于 caps 推断 declared 结果。

        Returns:
            "pass" / "capability_gated"
        """
        raise NotImplementedError

    def dry_run(self, model: Any) -> ProbeResult:
        """跑 dry-run:构造 body + adapt_request,捕获 CapabilityGateError。"""
        try:
            caps = _resolve_caps_for_probe(model)
        except Exception as exc:
            return ProbeResult(
                probe_name=self.name,
                model_id=str(getattr(model, "id", "")),
                model_name=getattr(model, "model_name", "") or "",
                observed="error",
                declared="error",
                drift_type="unknown",
                error_code="caps_resolution_failed",
                error_detail=str(exc),
            )

        try:
            body = self.prepare_body(model)
        except Exception as exc:
            return ProbeResult(
                probe_name=self.name,
                model_id=str(getattr(model, "id", "")),
                model_name=getattr(model, "model_name", "") or "",
                observed="error",
                declared="error",
                drift_type="unknown",
                error_code="probe_prepare_failed",
                error_detail=str(exc),
            )

        try:
            declared = self.expected_capability(model, caps)
        except Exception:
            declared = "pass"

        ctx = _DummyCtx(
            request_id=f"probe-{self.name}-{getattr(model, 'id', '')}",
            model_name=getattr(model, "model_name", "") or "",
        )

        try:
            _, downgrade_events = adapt_request(body, caps, ctx)
            observed = "pass"
            return ProbeResult(
                probe_name=self.name,
                model_id=str(getattr(model, "id", "")),
                model_name=getattr(model, "model_name", "") or "",
                observed=observed,
                declared=declared,
                drift_type=_compare(observed, declared),
                downgrade_events=downgrade_events,
            )
        except CapabilityGateError as exc:
            observed = "capability_gated"
            return ProbeResult(
                probe_name=self.name,
                model_id=str(getattr(model, "id", "")),
                model_name=getattr(model, "model_name", "") or "",
                observed=observed,
                declared=declared,
                drift_type=_compare(observed, declared),
                error_code=exc.error_code,
                error_detail=f"{exc.user_message} | {exc.technical_detail}",
            )
        except Exception as exc:
            return ProbeResult(
                probe_name=self.name,
                model_id=str(getattr(model, "id", "")),
                model_name=getattr(model, "model_name", "") or "",
                observed="error",
                declared=declared,
                drift_type="unknown",
                error_code="adapt_request_unexpected",
                error_detail=str(exc),
            )

    def live_run(self, model: Any, api_key: Optional[str] = None) -> ProbeResult:
        """W3 真发 API。W1c 留 stub。"""
        raise NotImplementedError("W3 implements live runs")


@dataclass
class _DummyCtx:
    request_id: str
    model_name: str


def _resolve_caps_for_probe(model: Any) -> ResolvedCapabilities:
    """W1c probe 用的 caps 解析器。

    优先级:
    1. ``utils.capabilities.resolve_for_wire``(若可 import 且未被破坏)
    2. 直接 ``ResolvedCapabilities.from_json(model.capabilities_config['wire_adapter'])``
    3. 兜底 ``ResolvedCapabilities()`` 默认值

    设计:probe 不应该因 W1a 工具被改动而崩溃,本函数让 probe 在受限环境也能跑。
    """
    # 优先用 W1a/W1b 的 resolve_for_wire(若工作区完整)
    try:
        from apps.services.llm.utils.capabilities import resolve_for_wire
        return resolve_for_wire(model, getattr(model, "provider", None))
    except (ImportError, AttributeError):
        pass
    # 退级:直接 from_json
    config = getattr(model, "capabilities_config", None) or {}
    if isinstance(config, dict):
        wa_data = config.get("wire_adapter")
        if wa_data:
            caps = ResolvedCapabilities.from_json(wa_data)
            caps.is_configured = True
            return caps
    return ResolvedCapabilities()


# ---------------------------------------------------------------------------
# 6 个 Probe 实现
# ---------------------------------------------------------------------------

class BasicChatProbe(BaseProbe):
    """1. 简单文本对话(所有 chat-capable model 都应通过)。"""

    name = "basic_chat"
    description = "minimal user message; should always pass for chat models"

    def prepare_body(self, model: Any) -> Dict[str, Any]:
        return {
            "model": getattr(model, "model_name", ""),
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 10,
        }

    def expected_capability(self, model: Any, caps: ResolvedCapabilities) -> str:
        return "pass"


class ImageBase64Probe(BaseProbe):
    """2. base64 image input(supports_vision model 应通过,其他应 gated)。"""

    name = "image_base64"
    description = "data URL base64 image; gated when image.enabled=False"

    # 1x1 transparent PNG base64
    _DATA_URL = (
        "data:image/png;base64,"
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    )

    def prepare_body(self, model: Any) -> Dict[str, Any]:
        return {
            "model": getattr(model, "model_name", ""),
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "describe"},
                    {"type": "image_url", "image_url": {"url": self._DATA_URL}},
                ],
            }],
        }

    def expected_capability(self, model: Any, caps: ResolvedCapabilities) -> str:
        if not caps.image.enabled:
            return "capability_gated"
        if "base64" not in (caps.image.input_via or ()):
            return "capability_gated"
        return "pass"


class ImageUrlProbe(BaseProbe):
    """3. https URL image input(input_via 含 url 应通过 / 否则 gated)。

    注意:wire_adapter 在 base64 fallback 路径下会调 image_fetcher 真下载 URL。
    为了让 dry-run 不真下载,这里**只测 input_via 含 url 的快路径**。
    若 input_via 不含 url,helper 会走 base64 fallback → 触发网络请求,
    本 probe 改为 expected=capability_gated 并跳过实际下载断言(仅校验 caps 推断)。
    """

    name = "image_url"
    description = "https URL image; only tests caps inference path"

    _URL = "https://example.com/test.png"

    def prepare_body(self, model: Any) -> Dict[str, Any]:
        return {
            "model": getattr(model, "model_name", ""),
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "describe"},
                    {"type": "image_url", "image_url": {"url": self._URL}},
                ],
            }],
        }

    def expected_capability(self, model: Any, caps: ResolvedCapabilities) -> str:
        if not caps.image.enabled:
            return "capability_gated"
        if "url" not in (caps.image.input_via or ()):
            # input_via 只含 base64 时,helper 会走 image_fetcher 下载 → 真请求
            # → 在 dry-run 视为 capability_gated(不可行)
            return "capability_gated"
        return "pass"

    def dry_run(self, model: Any) -> ProbeResult:
        # 重写以避免 input_via=base64-only 时触发真下载
        try:
            caps = _resolve_caps_for_probe(model)
        except Exception as exc:
            return ProbeResult(
                probe_name=self.name,
                model_id=str(getattr(model, "id", "")),
                model_name=getattr(model, "model_name", "") or "",
                observed="error",
                declared="error",
                drift_type="unknown",
                error_code="caps_resolution_failed",
                error_detail=str(exc),
            )

        # 若 input_via 不含 url,跳过实际 adapt(避免下载)
        if not caps.image.enabled or "url" not in (caps.image.input_via or ()):
            declared = self.expected_capability(model, caps)
            return ProbeResult(
                probe_name=self.name,
                model_id=str(getattr(model, "id", "")),
                model_name=getattr(model, "model_name", "") or "",
                observed="capability_gated",
                declared=declared,
                drift_type=_compare("capability_gated", declared),
                error_code="image_url_without_url_input_via",
                error_detail="input_via 不含 url,跳过 dry-run 避免触发真下载",
            )
        return super().dry_run(model)


class ToolCallProbe(BaseProbe):
    """4. 单工具调用(tool.enabled=True 应通过)。"""

    name = "tool_call"
    description = "single tool defined; gated when tool.enabled=False"

    def prepare_body(self, model: Any) -> Dict[str, Any]:
        return {
            "model": getattr(model, "model_name", ""),
            "messages": [{"role": "user", "content": "compute"}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "add",
                    "description": "add two numbers",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "a": {"type": "number"},
                            "b": {"type": "number"},
                        },
                        "required": ["a", "b"],
                    },
                },
            }],
            "tool_choice": "auto",
        }

    def expected_capability(self, model: Any, caps: ResolvedCapabilities) -> str:
        if not caps.tool.enabled:
            return "capability_gated"
        return "pass"


class ParallelToolProbe(BaseProbe):
    """5. 多工具同轮(tool.enabled=True 应通过,关注 parallel 注入)。"""

    name = "parallel_tool"
    description = "multiple tools; tests parallel_tool_calls injection"

    def prepare_body(self, model: Any) -> Dict[str, Any]:
        return {
            "model": getattr(model, "model_name", ""),
            "messages": [{"role": "user", "content": "compute and lookup"}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "add",
                        "description": "add",
                        "parameters": {
                            "type": "object",
                            "properties": {"a": {"type": "number"}},
                        },
                    },
                },
                {
                    "type": "function",
                    "function": {
                        "name": "lookup",
                        "description": "lookup",
                        "parameters": {
                            "type": "object",
                            "properties": {"q": {"type": "string"}},
                        },
                    },
                },
            ],
            "parallel_tool_calls": True,
        }

    def expected_capability(self, model: Any, caps: ResolvedCapabilities) -> str:
        if not caps.tool.enabled:
            return "capability_gated"
        return "pass"


class JsonSchemaProbe(BaseProbe):
    """6. response_format json_schema(json_schema mode 应通过 / fallback 时 downgrade)。"""

    name = "json_schema"
    description = "response_format json_schema; downgrade event when unsupported"

    def prepare_body(self, model: Any) -> Dict[str, Any]:
        return {
            "model": getattr(model, "model_name", ""),
            "messages": [{"role": "user", "content": "produce json"}],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "answer",
                    "schema": {
                        "type": "object",
                        "properties": {"value": {"type": "string"}},
                        "required": ["value"],
                    },
                },
            },
        }

    def expected_capability(self, model: Any, caps: ResolvedCapabilities) -> str:
        modes = set(caps.json_mode.modes or ())
        if "json_schema" in modes:
            return "pass"
        # 不支持 json_schema 但有 fallback → 仍能跑过(只是 emit downgrade event)
        if caps.json_mode.schema_fallback:
            return "pass"
        return "pass"  # 即使不支持也透传(adapt_request warn 但不抛)

    # JsonSchemaProbe 的 dry-run 几乎不会 capability gate(只在没 fallback 路径下 warn 透传)


# ---------------------------------------------------------------------------
# 注册 + 全集
# ---------------------------------------------------------------------------

ALL_PROBES: List[BaseProbe] = [
    BasicChatProbe(),
    ImageBase64Probe(),
    ImageUrlProbe(),
    ToolCallProbe(),
    ParallelToolProbe(),
    JsonSchemaProbe(),
]


def get_probe_by_name(name: str) -> Optional[BaseProbe]:
    for p in ALL_PROBES:
        if p.name == name:
            return p
    return None


def run_probes(
    models: List[Any],
    probes: Optional[List[BaseProbe]] = None,
    dry_run: bool = True,
) -> List[ProbeResult]:
    """对一组 model 跑一组 probe(默认全跑)。"""
    if probes is None:
        probes = ALL_PROBES
    results: List[ProbeResult] = []
    for model in models:
        for probe in probes:
            if dry_run:
                results.append(probe.dry_run(model))
            else:
                # W3 实装
                results.append(probe.live_run(model))
    return results


__all__ = [
    "ProbeResult",
    "BaseProbe",
    "BasicChatProbe",
    "ImageBase64Probe",
    "ImageUrlProbe",
    "ToolCallProbe",
    "ParallelToolProbe",
    "JsonSchemaProbe",
    "ALL_PROBES",
    "get_probe_by_name",
    "run_probes",
]
