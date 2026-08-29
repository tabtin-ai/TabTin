"""LLM Proxy Service — 本地 Agent Runtime 的 LLM 请求代理。

将认证、模型解析、计费预检、冻结、httpx SSE 转发、结算整合为一个
统一的服务层，供 proxy_api 视图调用。
"""

from __future__ import annotations

import contextlib
import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Generator, Optional, Tuple

import httpx

from apps.services.llm.utils.capabilities import (
    get_capability_flag,
    get_model_limit,
    resolve_for_wire,
)
from apps.services.llm.utils.param_adaptor import requires_kimi_temperature_one as _requires_kimi_temperature_one
from apps.services.llm.wire_adapter import (
    CapabilityGateError,
    ImageFetchError,
    adapt_request,
    is_wire_adapter_enabled,
    normalize_image_urls,
    render_error,
)

logger = logging.getLogger(__name__)

SSE_CONNECT_TIMEOUT = 10
SSE_READ_TIMEOUT = 120

# 上游连接池：跨请求复用 keep-alive 连接，省掉每次 LLM 调用对 provider 的
# TCP+TLS 握手（实测占上游首响应延迟 ~100-300ms）。
UPSTREAM_MAX_KEEPALIVE_CONNECTIONS = 50
UPSTREAM_MAX_CONNECTIONS = 200
UPSTREAM_KEEPALIVE_EXPIRY_SECONDS = 90.0
# 预热请求只为完成握手，不做真实推理，单独用短超时避免拖住草稿态。
UPSTREAM_WARMUP_TIMEOUT_SECONDS = 5.0
# 对话与「测试连接」共用的上游 path。不要再让探针走厂商 SDK 的另一套协议。
UPSTREAM_CHAT_COMPLETIONS_PATH = "/chat/completions"
UPSTREAM_PROBE_TIMEOUT_SECONDS = 30.0

_upstream_client: Optional[httpx.Client] = None
_upstream_client_lock = threading.Lock()


def _get_upstream_client() -> httpx.Client:
    """返回进程级共享的上游 httpx.Client（连接池 + keep-alive）。

    过去 stream_upstream 每次都 ``with httpx.Client()`` 新建再关闭，导致每个
    LLM 请求都对 provider 做一次完整 TCP+TLS 握手。改为进程级复用后，指向同一
    provider host 的后续请求复用 keep-alive 连接、跳过握手。

    httpx.Client 对并发请求线程安全，可被 Django 线程池并发使用；进程退出时
    连接随之关闭，无需显式 close。
    """
    global _upstream_client
    client = _upstream_client
    if client is not None and not client.is_closed:
        return client
    with _upstream_client_lock:
        if _upstream_client is None or _upstream_client.is_closed:
            _upstream_client = httpx.Client(
                timeout=httpx.Timeout(SSE_READ_TIMEOUT, connect=SSE_CONNECT_TIMEOUT),
                limits=httpx.Limits(
                    max_keepalive_connections=UPSTREAM_MAX_KEEPALIVE_CONNECTIONS,
                    max_connections=UPSTREAM_MAX_CONNECTIONS,
                    keepalive_expiry=UPSTREAM_KEEPALIVE_EXPIRY_SECONDS,
                ),
            )
        return _upstream_client


def reset_upstream_client() -> None:
    """关闭并清空进程级上游连接池。

    供测试隔离使用（避免 patch(httpx.Client) 时命中上一个用例缓存的 client），
    也可在需要时手动重置连接池。
    """
    global _upstream_client
    client = _upstream_client
    _upstream_client = None
    if client is not None:
        try:
            client.close()
        except Exception:  # noqa: BLE001 - 关闭失败无需处理
            pass


def compose_upstream_chat_url(api_base: str) -> str:
    """对话与测试连接共用的上游 URL，与 stream_upstream 一致。"""
    return f"{(api_base or '').rstrip('/')}{UPSTREAM_CHAT_COMPLETIONS_PATH}"


def prime_upstream_connection(api_base: str) -> bool:
    """对给定 provider api_base 完成 TCP+TLS 握手并把连接留在 keep-alive 池，
    让草稿态之后的首条真实消息复用暖连接、跳过握手。

    仅为建连，不发真实推理请求——用 HTTP OPTIONS 打 chat/completions 端点，任何
    响应（含 4xx/405）都已完成握手即达目的。全异常吞掉：预热失败绝不影响正常发送
    （best-effort）。**纯网络操作、不访问 DB**，可安全放到后台线程执行。
    """
    api_base = (api_base or "").rstrip("/")
    if not api_base:
        return False
    client = _get_upstream_client()
    try:
        client.request(
            "OPTIONS",
            compose_upstream_chat_url(api_base),
            timeout=httpx.Timeout(
                UPSTREAM_WARMUP_TIMEOUT_SECONDS, connect=SSE_CONNECT_TIMEOUT
            ),
        )
        return True
    except Exception as exc:  # noqa: BLE001 - 预热失败静默降级
        logger.debug("[LLMProxy] warmup 请求失败（忽略）: %s", exc)
        return False


def resolve_upstream_api_base(model_instance) -> str:
    """解析 model_instance 的上游 api_base（DB 操作，应在请求线程内调用）。

    预热场景用：请求线程内解析出 api_base，再把纯网络的 prime 丢到后台线程，
    避免手工线程里做 ORM 查询带来的连接管理问题。失败返回空串。
    """
    try:
        config = build_upstream_config(model_instance)
    except Exception as exc:  # noqa: BLE001 - best-effort，解析失败跳过预热
        logger.debug("[LLMProxy] warmup 跳过：build_upstream_config 失败 %s", exc)
        return ""
    return (config.get("api_base") or "").rstrip("/")


# ---------------------------------------------------------------------------
# 错误类型
# ---------------------------------------------------------------------------

class ProxyError(Exception):
    """Proxy 层可控错误，携带 HTTP 状态码和结构化 body。

    extras: 可选的结构化附加字段，会透传到 SSE error chunk（供前端
    errorHandler 细分引导，如 topup_reason）。
    """

    def __init__(self, status: int, error_code: str, detail: str = "", extras: Optional[Dict[str, Any]] = None):
        self.status = status
        self.error_code = error_code
        self.detail = detail
        self.extras = extras or {}
        super().__init__(detail or error_code)


def classify_byok_error(
    status_code: int,
    error_body: bytes | str | None = None,
    is_byok_path: bool = False,
) -> str | None:
    """识别 BYOK 错误并细分。返回 None 表示不是 BYOK 错误。

    v0.1 强制——让前端 BillingErrorCard 能区分 4 类 BYOK 故障
    并展示准确的文案和 CTA（充值平台钱包对 BYOK 错误无效）。

    Returns:
        'byok_provider_unavailable' — 上游 503 / 网络超时
        'byok_rate_limit_exceeded'  — 上游 429 RPM/TPM 限流
        'byok_quota_exhausted'      — 上游 401/403/429 + insufficient_quota
        'byok_invalid_key'          — 上游 401 + invalid_api_key 或其他 auth 错误
        None                        — 非 BYOK 路径或无法分类
    """
    if not is_byok_path:
        return None

    body_str = ""
    if isinstance(error_body, bytes):
        try:
            body_str = error_body.decode("utf-8", errors="replace")
        except Exception:
            pass
    elif isinstance(error_body, str):
        body_str = error_body
    body_lower = body_str.lower()

    if status_code in (500, 502, 503, 504):
        return 'byok_provider_unavailable'

    if status_code == 429:
        if "insufficient_quota" in body_lower:
            return 'byok_quota_exhausted'
        return 'byok_rate_limit_exceeded'

    if status_code in (401, 403):
        if "insufficient_quota" in body_lower:
            return 'byok_quota_exhausted'
        return 'byok_invalid_key'

    return None


# ---------------------------------------------------------------------------
# 请求上下文
# ---------------------------------------------------------------------------

# 主对话路径 source → 宪法 v0.1 §2.3 system scene_key 映射。
# 旧 source 取值（react_loop / compact / auto_condense）仍可能从客户端透传过来，
# 需统一映射为 v0.1 4 个 system scene。其他无映射的 source 兜底为 '_main_chat'
# （视为主对话 ReAct 主循环）。
PROXY_SCENE_KEY_MAP = {
    '_main_chat': '_main_chat',
    '_compact': '_compact',
    '_summary_judge': '_summary_judge',
    '_sub_agent': '_sub_agent',
    'react_loop': '_main_chat',
    'compact': '_compact',
    'auto_condense': '_compact',
    'summary_judge': '_summary_judge',
    'sub_agent': '_sub_agent',
}


def map_source_to_scene_key(source: str) -> str:
    """把客户端透传的 requestSource 映射成 v0.1 system scene_key。"""
    if not source:
        return '_main_chat'
    return PROXY_SCENE_KEY_MAP.get(source.strip(), '_main_chat')


@dataclass
class ProxyContext:
    """贯穿整个 proxy 流程的上下文。"""
    request_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    view_started_at: float = field(default_factory=time.monotonic)
    timings: Dict[str, float] = field(default_factory=dict)
    user_id: str = ""
    organization_id: str = ""
    agent_id: str = ""
    session_id: str = ""
    source: str = "llm_proxy"
    billing_idempotency_key: Optional[str] = None
    logical_billing_key: str = ""
    attempt_index: Optional[int] = None
    usage_source: str = "provider_final"

    # v0.1 必填：LLMUsageFact.scene_key（主对话路径走 4 个 system scene）。
    # 默认从 source 映射；上层可通过 ProxyContext(scene_key=...) 显式覆盖。
    scene_key: str = "_main_chat"

    model_name: str = ""
    model_instance: Any = None
    provider: Any = None
    is_byok: bool = False

    api_key: str = field(default="", repr=False)
    api_base: str = ""

    key_obj: Any = None

    freeze_id: Optional[str] = None

    stream: bool = True

    # 用户主动选择的上下文档位 id（如 'long_1m'）。
    # 来自请求头 X-TabTin-Context-Tier；为空时走默认档（is_default 或第一档）。
    # 影响两件事：
    #   1) stream_upstream 透传该档 extra_headers（如 anthropic-beta）
    #   2) settle_and_charge 锁定该档单价计费
    context_tier_id: Optional[str] = None

    # 流式转发过程中累积的最新 usage 快照。
    # stream_upstream 每解析到一个含 usage 的 SSE chunk 就更新此字段，
    # 以便 GeneratorExit（客户端断连）时仍可按已收 usage 结算。
    accumulated_usage: Optional[dict] = None
    streamed_output_chars: int = 0


def _ms_since(started_at: float) -> float:
    return (time.monotonic() - started_at) * 1000


def _build_timing_comment(
    ctx: ProxyContext,
    phase: str,
    *,
    duration_ms: Optional[float] = None,
    elapsed_ms: Optional[float] = None,
    extras: Optional[Dict[str, Any]] = None,
) -> str:
    """构造只含低敏耗时字段的 SSE comment，客户端按需解析为 timing 事件。"""
    payload: Dict[str, Any] = {
        "phase": phase,
        "request_id": ctx.request_id,
        "model": ctx.model_name,
    }
    if duration_ms is not None:
        payload["duration_ms"] = round(duration_ms)
    if elapsed_ms is not None:
        payload["elapsed_ms"] = round(elapsed_ms)
    if extras:
        payload["extras"] = extras
    return f": tabtin_timing {json.dumps(payload, ensure_ascii=False)}\n\n"


def _log_timing(
    ctx: ProxyContext,
    phase: str,
    *,
    duration_ms: Optional[float] = None,
    elapsed_ms: Optional[float] = None,
    extras: Optional[Dict[str, Any]] = None,
) -> None:
    logger.info(
        "[LLMProxy][%s] timing phase=%s duration_ms=%s elapsed_ms=%s model=%s extras=%s",
        ctx.request_id,
        phase,
        round(duration_ms) if duration_ms is not None else None,
        round(elapsed_ms) if elapsed_ms is not None else None,
        ctx.model_name,
        extras or {},
    )


# ---------------------------------------------------------------------------
# 模型解析
# ---------------------------------------------------------------------------

def resolve_proxy_model(model_name: str, organization_id: str = "") -> Any:
    """根据模型名称解析到 LLMModel 实例。

    优先精确匹配 model_name，也支持 model_id UUID 直查。
    """
    from .model_resolver import resolve_model

    model = resolve_model(
        model_name=model_name,
        organization_id=organization_id,
        require_active=True,
        allowed_modes=("chat", "completion"),
    )
    if model:
        return model

    # model_name 可能实际是 model_id
    try:
        uuid.UUID(model_name)
        model = resolve_model(
            model_id=model_name,
            organization_id=organization_id,
            require_active=True,
            allowed_modes=("chat", "completion"),
        )
    except (ValueError, AttributeError):
        pass

    return model


def build_upstream_config(model_instance) -> Dict[str, Any]:
    """从 model_instance 构建上游请求所需的 api_key / api_base / model_name。

    复用 build_litellm_config 获取 provider 级配置（含 key 轮换逻辑）。
    返回值中 key_obj 用于向 key_manager 反馈错误状态。
    """
    from apps.services.llm.litellm_config import build_litellm_config
    from apps.services.llm.models import LLMCredentialDecryptionError

    try:
        config = build_litellm_config(str(model_instance.id))
    except LLMCredentialDecryptionError as exc:
        raise ProxyError(
            503,
            "credential_decryption_failed",
            "AI 服务密钥无法解密，请配置正确的 CREDENTIAL_ENCRYPTION_KEY 或重新录入密钥",
        ) from exc

    api_key = config.get("api_key", "")
    api_base = config.get("api_base", "")
    key_obj = None

    if not api_key:
        from .key_manager import select_provider_key
        provider = model_instance.provider
        key_obj = select_provider_key(str(provider.id))
        if key_obj:
            try:
                api_key = key_obj.api_key
            except LLMCredentialDecryptionError as exc:
                raise ProxyError(
                    503,
                    "credential_decryption_failed",
                    "AI 服务密钥无法解密，请配置正确的 CREDENTIAL_ENCRYPTION_KEY 或重新录入密钥",
                ) from exc
        else:
            raise ProxyError(503, "all_keys_exhausted", "所有 API Key 均不可用")

    if not api_base:
        api_base = getattr(model_instance.provider, "base_url", "") or ""

    if not api_base:
        raise ProxyError(500, "missing_api_base", "模型未配置 api_base")

    upstream_model_name = config.get("model", model_instance.model_name)
    custom_provider = config.get("custom_llm_provider", "")
    if custom_provider and upstream_model_name.startswith(f"{custom_provider}/"):
        upstream_model_name = upstream_model_name[len(custom_provider) + 1:]

    return {
        "api_key": api_key,
        "api_base": api_base.rstrip("/"),
        "model_name": upstream_model_name,
        "key_obj": key_obj,
    }


def _probe_rejects_before_generation(status_code: int) -> bool:
    """空 messages 的校验失败发生在采样前，不计 token，但说明鉴权与路径可用。"""
    return status_code in {400, 422}


def probe_upstream_chat(model_instance, *, level: int = 1) -> Dict[str, Any]:
    """用与对话相同的 OpenAI 兼容口探测连通性，且不发起计费生成。

    成员侧「测试连接」不得再走厂商 SDK（例如 MiniMax Anthropic
    ``/v1/messages``），否则会出现对话通、测试失败。

    请求打 ``{api_base}/chat/completions``，但 ``messages`` 为空、``max_tokens=0``，
    上游应在采样前以 400/422 拒绝；401/403/404 仍按鉴权或错误基址失败。
    """
    started = time.perf_counter()
    result: Dict[str, Any] = {
        "valid": False,
        "level": level,
        "latency_ms": 0,
        "details": {},
        "error": None,
        "error_code": None,
        "status_code": None,
    }

    try:
        config = build_upstream_config(model_instance)
    except ProxyError as exc:
        result["error"] = str(exc)[:500]
        result["error_code"] = exc.error_code
        result["status_code"] = exc.status
        result["latency_ms"] = int((time.perf_counter() - started) * 1000)
        return result

    model_name = config["model_name"]
    url = compose_upstream_chat_url(config["api_base"])
    body: Dict[str, Any] = {
        "model": model_name,
        "messages": [],
        "max_tokens": 0,
        "stream": False,
    }

    result["details"]["upstream_path"] = UPSTREAM_CHAT_COMPLETIONS_PATH
    result["details"]["probe_model_name"] = model_name
    result["details"]["probe_mode"] = "no_generation"

    try:
        response = _get_upstream_client().post(
            url,
            json=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {config['api_key']}",
            },
            timeout=httpx.Timeout(
                UPSTREAM_PROBE_TIMEOUT_SECONDS,
                connect=SSE_CONNECT_TIMEOUT,
            ),
        )
    except httpx.HTTPError as exc:
        result["error"] = str(exc)[:500]
        result["error_code"] = "upstream_transport_error"
        result["latency_ms"] = int((time.perf_counter() - started) * 1000)
        return result

    result["status_code"] = response.status_code
    result["latency_ms"] = int((time.perf_counter() - started) * 1000)

    if response.status_code in {401, 403}:
        result["error"] = (response.text or f"HTTP {response.status_code}")[:500]
        result["error_code"] = "upstream_auth_error"
        return result

    if response.status_code == 404:
        result["error"] = (response.text or "HTTP 404")[:500]
        result["error_code"] = "upstream_error"
        return result

    if response.status_code >= 500:
        result["error"] = (response.text or f"HTTP {response.status_code}")[:500]
        result["error_code"] = "upstream_error"
        return result

    if response.status_code >= 400 and not _probe_rejects_before_generation(
        response.status_code
    ):
        result["error"] = (response.text or f"HTTP {response.status_code}")[:500]
        result["error_code"] = "upstream_error"
        return result

    result["valid"] = True
    result["details"]["level_0"] = {
        "valid": True,
        "api_base": config["api_base"],
        "http_status": response.status_code,
    }
    if level >= 1:
        result["details"]["level_1"] = {
            "valid": True,
            "model": model_name,
            "probe_mode": "no_generation",
        }
    return result


def apply_provider_request_policy(
    upstream_body: Dict[str, Any],
    ctx: ProxyContext,
    *,
    incoming_body: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """把直连代理的厂商请求策略委托给原 Provider Service。"""
    from apps.services.llm.adapter_resolver import (
        resolve_adapter_name,
        resolve_provider_adapter,
    )

    adapter_name = resolve_adapter_name(ctx.provider)
    if not adapter_name:
        return upstream_body

    service_class = resolve_provider_adapter(ctx.provider)
    prepare_request = getattr(service_class, "prepare_proxy_request", None)
    if not callable(prepare_request):
        return upstream_body
    return prepare_request(
        upstream_body,
        session_id=ctx.session_id,
        incoming_body=incoming_body,
    )


# ---------------------------------------------------------------------------
# 计费预检 + 冻结
# ---------------------------------------------------------------------------

def billing_precheck(ctx: ProxyContext) -> None:
    """执行计费链路的预检和冻结。失败时抛 ProxyError。"""
    from .billing import check_budget_before_request, _is_byok_provider
    from .billed_call import (
        check_balance_before_request,
        _estimate_wallet_freeze_credits,
    )

    if not (ctx.organization_id or "").strip():
        raise ProxyError(
            400,
            "missing_organization_id",
            "缺少 organization_id，无法执行 LLM 调用",
        )

    ctx.is_byok = _is_byok_provider(ctx.model_instance)

    if ctx.is_byok:
        # BYOK 跳过余额/预算预检，只记录用量（在 settle_and_charge 中处理）
        return

    budget_block = check_budget_before_request(
        ctx.organization_id,
        model_instance=ctx.model_instance,
    )
    if budget_block:
        error_code = str(budget_block.get("error_category") or budget_block.get("reason") or "budget_exceeded")
        detail = str(budget_block.get("detail") or budget_block.get("error") or "预算超限")
        raise ProxyError(402, error_code.lower(), detail)

    balance_block = check_balance_before_request(
        ctx.user_id, ctx.organization_id,
        model_instance=ctx.model_instance,
    )
    if balance_block:
        error_code = balance_block.get("error_code", "INSUFFICIENT_CREDITS")
        # 点券用尽被拦时，把自动补充失败原因透传到 SSE extras，
        # 前端 BillingErrorCard 据此区分引导（开启自动补充 / 去充值 / 调整上限）。
        extras = (
            {"topup_reason": balance_block["topup_reason"]}
            if balance_block.get("topup_reason")
            else None
        )
        raise ProxyError(402, error_code.lower(), balance_block.get("error", "余额不足"), extras=extras)

    # 冻结
    if ctx.organization_id:
        estimated = _estimate_wallet_freeze_credits(ctx.organization_id, ctx.model_instance)
        # 冻结保护的是每次物理上游调用；即使逻辑计费键相同，重试也必须重新
        # 占用额度，完成后再各自释放。只有最终扣费使用逻辑幂等键。
        candidate_id = f"freeze:proxy:{ctx.request_id}"
        try:
            from apps.users.wallet.services.credits_service import CreditsService
            frozen = True
            if estimated > 0:
                frozen = CreditsService.freeze_credits_for_llm(
                    ctx.organization_id, estimated, candidate_id,
                )
            if frozen:
                if estimated > 0:
                    ctx.freeze_id = candidate_id
            else:
                #  冻结兜底：钱包不足以冻结本次预估时，quota_only 下先尝试现金
                # 自动补充一档再重试一次冻结，覆盖「预检通过后钱包被并发耗尽 / 实际
                # 预估高于预检口径」的竞态。try_auto_topup 内部按模式/开关判定，非
                # quota_only 或未开自动补充直接返回不补充；补充失败才抛 freeze_failed。
                from apps.services.billing.services.llm_topup_service import LlmQuotaTopupService

                topup = LlmQuotaTopupService.try_auto_topup(
                    ctx.organization_id, trigger="freeze_retry", required_credits=estimated,
                )
                if topup.get("topped_up") and CreditsService.freeze_credits_for_llm(
                    ctx.organization_id, estimated, candidate_id,
                ):
                    ctx.freeze_id = candidate_id
                else:
                    raise ProxyError(402, "freeze_failed", "冻结 credits 失败，余额可能不足")
        except ProxyError:
            raise
        except Exception as exc:
            # E4：冻结异常此前无条件放行（unbounded fail-open），计费 DB
            # 持续异常时可被持续刷量。改为复用 L4 余额预检同款「有上限 fail-open」
            # （连续次数阈值 + 累计金额上限）：超阈值即 fail-closed 拒绝，
            # 未超则有限放行并计入累计，避免 transient 抖动误伤正常请求。
            from .billed_call import (
                _is_failopen_amount_exceeded,
                _record_failopen_amount,
                _record_precheck_failure,
            )

            if _record_precheck_failure() or _is_failopen_amount_exceeded():
                logger.error(
                    "[LLMProxy][%s] 冻结异常且 fail-open 超阈值，拒绝请求: %s",
                    ctx.request_id, exc,
                )
                raise ProxyError(
                    503, "freeze_unavailable", "计费冻结暂不可用，请稍后重试",
                ) from exc

            logger.warning(
                "[LLMProxy][%s] 冻结异常，本次有限放行（fail-open 未超阈值）: %s",
                ctx.request_id, exc,
            )
            _record_failopen_amount()


def _resolve_upstream_tier_headers(ctx: ProxyContext) -> Dict[str, str]:
    """根据 ctx.context_tier_id 从模型上下文档位解析需要透传给上游的 header。

    解析顺序：
      1) 显式 tier_id 命中 → 该档 extra_headers
      2) tier_id 为空 → 默认档（is_default 或第一档）的 extra_headers
      3) 模型未配档位 → 空 dict
    """
    if not ctx.model_instance:
        return {}
    try:
        from .billing import (
            get_model_context_tiers,
            resolve_default_tier,
            resolve_tier_by_id,
        )
    except ImportError:
        return {}

    custom_billing = getattr(ctx.model_instance, "custom_billing_config", {}) or {}
    tier: Optional[dict] = None
    if ctx.context_tier_id:
        tier = resolve_tier_by_id(custom_billing, ctx.context_tier_id)
        if not tier:
            logger.warning(
                "[LLMProxy][%s] context_tier_id=%s 在模型 %s 上未找到，回退默认档",
                ctx.request_id, ctx.context_tier_id,
                getattr(ctx.model_instance, "model_name", ""),
            )
    if not tier:
        tier = resolve_default_tier(custom_billing)
    if not tier:
        return {}

    extra_headers = tier.get("extra_headers") or {}
    if not isinstance(extra_headers, dict):
        return {}
    return {str(k): str(v) for k, v in extra_headers.items() if k and v is not None}


def release_freeze(ctx: ProxyContext) -> None:
    """释放冻结（流失败时调用）。"""
    if not ctx.freeze_id or not ctx.organization_id:
        return
    try:
        from apps.users.wallet.services.credits_service import CreditsService
        CreditsService.release_frozen_credits(ctx.organization_id, ctx.freeze_id)
    except Exception as exc:
        logger.warning(
            "[LLMProxy][%s] 冻结释放失败: freeze_id=%s err=%s",
            ctx.request_id, ctx.freeze_id, exc,
        )
    finally:
        ctx.freeze_id = None


def settle_and_charge(
    ctx: ProxyContext,
    usage: Optional[dict],
    *,
    usage_source: Optional[str] = None,
) -> tuple:
    """流结束后结算：扣费 + 释放冻结。

    Returns:
        (credits_charged: float, charge_ok: bool, error_category: Optional[str])
        charge_ok=True 表示 charge_llm_usage 返回了有效 dict（含零价格成功扣费），
        charge_ok=False 表示异常/返回 None；此时 error_category 区分
        organization_insufficient_credits / budget_exceeded / billing_charge_failed，
        避免 runtime 把基础设施结算失败误报成「余额不足」。
    """
    from .billing import BudgetExceededException, charge_llm_usage, _safe_decimal
    from .billed_call import (
        _organization_has_post_charge_insufficient_block,
        _settle_freeze_safely,
        _record_usage_fact_for_billed_call,
    )
    from decimal import Decimal

    # LLM 流式请求生命周期内（30s ~ 5min）Django 复用同一个 DB connection，
    # 流式中转期间 0 SQL 调用 → connection 在 MySQL/LB idle timeout 触发后被关。
    # 这里在扣费之前主动 close_old_connections 替换 stale connection，
    # 把"主路径炸 → 兜底也炸 → 平台真亏"的场景前置消除。
    # 与 billing.py charge_llm_usage except 内的兜底刷连接是双保险。
    # 详见 support/go-live/llm-billing-charge-resilience-go-live-checklist.md §1.3。
    try:
        from django.db import close_old_connections
        close_old_connections()
    except Exception as conn_exc:
        logger.warning("[LLMProxy][%s] settle 前刷新连接失败: %s", ctx.request_id, conn_exc)

    credits_charged: float = 0.0
    charge_ok: bool = False
    error_category: Optional[str] = None
    try:
        billing_idempotency_key = (
            ctx.billing_idempotency_key or f"{ctx.source}:{ctx.request_id}"
        )
        resolved_usage_source = (
            usage_source
            or ctx.usage_source
            or "provider_final"
        )
        if (usage or {}).get("estimated") or (usage or {}).get("usage_estimated"):
            resolved_usage_source = "estimated_interrupted"
        result = charge_llm_usage(
            user_id=ctx.user_id,
            organization_id=ctx.organization_id,
            model_instance=ctx.model_instance,
            usage=usage,
            request_id=ctx.request_id,
            source=ctx.source,
            biz_id=billing_idempotency_key,
            idempotency_key=billing_idempotency_key,
            context_tier_id=ctx.context_tier_id,
            # 子 Agent 计费收尾：把「这笔属于哪类活」的 scene_key 一并落进
            # BillingUsageEvent，与下方 LLMUsageFact 同源同值（主管/小工/压缩/摘要）。
            scene_key=ctx.scene_key or map_source_to_scene_key(ctx.source),
            #  用量流水任务归属：session_id 即客户端 X-TabTin-Session-Id
            # （= ChatSession.thread_id），落进 BillingUsageEvent.metadata，
            # 供用量明细/CSV 导出反查会话标题（任务名）。无会话的调用留空。
            billing_metadata={
                **({"session_id": ctx.session_id} if ctx.session_id else {}),
                **({"freeze_id": ctx.freeze_id} if ctx.freeze_id else {}),
            } or None,
            logical_billing_key=ctx.logical_billing_key,
            attempt_index=ctx.attempt_index,
            usage_source=resolved_usage_source,
        )
        _update_billing_usage_attempt_fields(
            idempotency_key=billing_idempotency_key,
            logical_billing_key=ctx.logical_billing_key,
            attempt_index=ctx.attempt_index,
            usage_source=resolved_usage_source,
        )
        if result and isinstance(result, dict):
            # 本次实际消耗的总点券 = 配额覆盖 + 免费溢出 + 钱包实扣 paygo。
            # 只取 credits_consumed_precise（钱包实扣）会在 quota_only 模式下恒为 0
            # ——runtime 的 tabtin.billing 尾帧据此累计 state.creditsCharged，若恒为 0，
            # CostCap 的 max_credits_per_run 预算闸门永不触发（ followup）。
            # 与 charge_llm_usage 内成员计数器 actual_credits 同口径。
            credits_charged = float(
                _safe_decimal(result.get("provider_credit_credits_precise"))
                + _safe_decimal(result.get("quota_covered_credits_precise"))
                + _safe_decimal(result.get("overflow_credits_precise"))
                + _safe_decimal(result.get("credits_consumed_precise"))
            )
            charge_ok = True
        else:
            # charge_llm_usage 对余额不足返回 None（并已 mark_post_charge_insufficient）；
            # schema/连接等基础设施失败同样返回 None。用 post-charge 阻断标记区分。
            error_category = "billing_charge_failed"
            try:
                if ctx.organization_id and _organization_has_post_charge_insufficient_block(
                    ctx.organization_id,
                    model_instance=ctx.model_instance,
                ):
                    error_category = "organization_insufficient_credits"
            except Exception:
                pass
    except BudgetExceededException:
        error_category = "budget_exceeded"
        logger.warning(
            "[LLMProxy][%s] 扣费失败（预算超限）", ctx.request_id,
        )
    except Exception as exc:
        error_category = "billing_charge_failed"
        logger.warning(
            "[LLMProxy][%s] 扣费失败（非阻断）: %s", ctx.request_id, exc,
        )

    try:
        _record_usage_fact_for_billed_call(
            request_id=ctx.billing_idempotency_key or ctx.request_id,
            user_id=ctx.user_id,
            organization_id=ctx.organization_id,
            model_instance=ctx.model_instance,
            usage=usage,
            scene_key=ctx.scene_key or map_source_to_scene_key(ctx.source),
            capability_domain='chat',
            context_tier_id=ctx.context_tier_id,
        )
    except Exception as exc:
        logger.warning(
            "[LLMProxy][%s] UsageFact 记录失败: %s", ctx.request_id, exc,
        )

    _settle_freeze_safely(
        ctx.freeze_id, ctx.organization_id,
        ctx.model_instance, usage,
    )
    ctx.freeze_id = None
    return credits_charged, charge_ok, error_category


def _update_billing_usage_attempt_fields(
    *,
    idempotency_key: str,
    logical_billing_key: str,
    attempt_index: Optional[int],
    usage_source: str,
) -> None:
    if not idempotency_key:
        return
    updates = {"usage_source": (usage_source or "").strip() or "provider_final"}
    if logical_billing_key:
        updates["logical_billing_key"] = logical_billing_key
    if attempt_index is not None:
        updates["attempt_index"] = attempt_index
    try:
        from apps.services.billing.models import BillingUsageEvent

        events = BillingUsageEvent.objects.filter(idempotency_key=idempotency_key)
        if updates["usage_source"] == "estimated_interrupted":
            events = events.exclude(charge_status__in=["charged", "aggregated"])
        events.update(**updates)
    except Exception as exc:
        logger.warning(
            "[LLMProxy][%s] 更新计费 attempt 元数据失败: %s",
            idempotency_key,
            exc,
        )


# ---------------------------------------------------------------------------
# SSE error 流式响应 helper
# ---------------------------------------------------------------------------


def build_sse_error_chunk(
    *,
    user_message: str,
    technical_detail: str = "",
    error_code: str = "proxy_error",
    status: Optional[int] = None,
    extras: Optional[Dict[str, Any]] = None,
) -> str:
    """构造一条符合 OpenAI SSE error 风格的 data line(末尾带 \\n\\n)。

    客户端 [`proxy-provider.ts:processChunk`](../../../../../packages/agent-runtime/src/providers/proxy-provider.ts:502)
    在 W0 同步会识别 `chunk.error` 分支并 throw AgentError。

    payload schema(向后兼容 OpenAI 风 message/type,扩展 user_message/code/extras
    供前端 errorHandler 渲染中文气泡 + 结构化排障字段):

        {"error": {
            "message": <user_message>,             # OpenAI 风兼容
            "user_message": <user_message>,        # 中文用户文案
            "technical_detail": <technical_detail>,# 技术详情(查看技术详情折叠)
            "type": <error_code>,                  # OpenAI 风兼容
            "code": <error_code>,                  # 同上(双名)
            "status": <status>,                    # 业务级 status 码
            ...<extras>                            # 可选 stage/reason/host/failed_count
        }}

    `message`/`user_message` 是中文用户文案,`technical_detail` 给 admin / 日志。
    `extras` 用于 capability gate / image fetch 等场景的结构化字段透传。
    """
    error_obj: Dict[str, Any] = {
        "message": user_message,
        "user_message": user_message,
        "type": error_code,
        "code": error_code,
    }
    if status is not None:
        error_obj["status"] = status
    if technical_detail:
        error_obj["technical_detail"] = technical_detail
    if extras:
        error_obj.update(extras)
    return f"data: {json.dumps({'error': error_obj}, ensure_ascii=False)}\n\n"


def stream_proxy_error_as_sse(
    user_message: str,
    technical_detail: str = "",
    error_code: str = "proxy_error",
    status: Optional[int] = None,
    extras: Optional[Dict[str, Any]] = None,
) -> Generator[str, None, None]:
    """把单个错误展开为 SSE 流(error chunk + [DONE])。

    给 view 层 `_stream_error_response` 用:把 ProxyError / ImageFetchError
    包装成 StreamingHttpResponse,客户端永远收到 200 OK + SSE 流,不会触发
    fetch reject(总控 § 4 S0.1)。

    `extras`(可选):透传给 SSE error chunk 的结构化字段(如 backend_error_type /
    stage),与流内 catch 块的 SSE error chunk schema 对齐。
    """
    yield build_sse_error_chunk(
        user_message=user_message,
        technical_detail=technical_detail,
        error_code=error_code,
        status=status,
        extras=extras,
    )
    yield "data: [DONE]\n\n"


def _proxy_error_to_friendly(
    exc: "ProxyError",
    model_name: str = "",
) -> Tuple[str, str, Dict[str, Any]]:
    """把 ProxyError 的 error_code 映射到 wire_adapter 模板表的中文文案 + 结构化字段。

    Args:
        exc: ProxyError 实例
        model_name: 可选的模型名,用于 system_routing 类模板的 `{model_name}` 占位
                    (build_upstream_config 抛 ProxyError 时 caller 已知 ctx.model_name)

    Returns:
        (user_message, technical_detail, structured_extra) 三元组。
        - user_message:中文友好文案
        - technical_detail:技术详情(查看技术详情折叠)
        - structured_extra:SSE error chunk 的 extras 字段(供前端 errorHandler 区分
          "换 model"按钮 / "充值"按钮 / "查看 admin" 等),至少含 backend_error_type。
        映射缺失时降级为原 detail,extras 仍带 backend_error_type 供排障。
    """
    code = (exc.error_code or "").lower()
    extras: Dict[str, Any] = {"backend_error_type": code}
    if getattr(exc, "extras", None):
        extras.update(exc.extras)

    # 上游 burst / RPM 限流：专用文案，勿落到 4xx「网络」语义。
    if code == "upstream_rate_limited" or (
        code == "upstream_error"
        and (exc.status == 429 or _is_upstream_burst_rate_limit(exc.detail))
    ):
        msg, detail = render_error(
            "upstream", "*", "rate_limited", status=exc.status or 429,
        )
        extras["backend_error_type"] = "upstream_rate_limited"
        extras["upstream_reason"] = "rate_limited"
        return msg, detail, extras

    # upstream_error 按 status code / body 摘要选模板(动态)
    if code == "upstream_error":
        detail_lower = (exc.detail or "").lower()
        if exc.status < 500 and (
            "invalid temperature" in detail_lower
            or "messages with role" in detail_lower
            or "role=tool" in detail_lower
            or "role 'tool'" in detail_lower
            or "tool_calls" in detail_lower
            or "request format" in detail_lower
        ):
            reason = "request_format"
        else:
            reason = "5xx" if exc.status >= 500 else "4xx"
        msg, detail = render_error("upstream", "*", reason, status=exc.status)
        extras["upstream_reason"] = reason
        return msg, detail, extras

    # 映射表:proxy_service 内 6 处抛点 + view 层 4xx 兜底
    # all_keys_exhausted / missing_api_base 各用专属模板(语义最精准)
    mapping: Dict[str, Tuple[str, str, str]] = {
        "all_keys_exhausted": ("system_routing", "*", "all_keys_exhausted"),
        "missing_api_base": ("system_routing", "*", "missing_api_base"),
        "missing_organization_id": ("system_routing", "*", "missing_organization_id"),
        "budget_exceeded": ("billing", "*", "budget_exceeded"),
        "membership_expired": ("billing", "*", "membership_expired"),
        "insufficient_credits": ("billing", "*", "insufficient_credits"),
        "freeze_failed": ("billing", "*", "freeze_failed"),
        "model_not_found": ("system_routing", "*", "model_not_found"),
    }
    byok_errors = {
        "byok_provider_unavailable",
        "byok_rate_limit_exceeded",
        "byok_quota_exhausted",
        "byok_invalid_key",
    }
    if code in byok_errors:
        extras["error_category"] = code
        byok_messages = {
            "byok_provider_unavailable": "您组织自备的 API Key 对应的上游服务暂时无法访问，过几分钟一般会自动恢复。",
            "byok_rate_limit_exceeded": "您的 API Key 请求频率过高，被上游服务商限速了。请稍等几分钟再试。",
            "byok_quota_exhausted": "您组织自备的 API Key 在上游服务商的账号余额已耗尽，需要前往上游服务商充值。",
            "byok_invalid_key": "您组织自备的 API Key 已失效或不正确，请到组织设置中检查并替换。",
        }
        return (
            byok_messages.get(code, "BYOK 调用遇到问题，请检查 API Key 配置。"),
            f"byok_error={code} status={exc.status}",
            extras,
        )
    template_key = mapping.get(code)
    if template_key:
        # 显式给 model_name 占位 — 缺省时由 _safe_vars 兜底"未知模型"。
        msg, detail = render_error(
            *template_key,
            model_name=model_name or "未知模型",
            status=exc.status,
        )
        return msg, detail, extras
    # 未识别 error_code → 兜底返回 detail(test_unknown_error_code 验证此分支)
    return (
        exc.detail or "请求处理失败,请稍后重试。",
        f"error_code={exc.error_code} status={exc.status}",
        extras,
    )


# ---------------------------------------------------------------------------
# SSE 流式转发
# ---------------------------------------------------------------------------

def _parse_usage_from_sse(data_str: str) -> Optional[dict]:
    """尝试从 SSE data JSON 中提取 usage 信息。"""
    try:
        obj = json.loads(data_str)
    except (json.JSONDecodeError, TypeError):
        return None

    usage = obj.get("usage")
    if not usage:
        return None

    result: Dict[str, Any] = {}
    # 区分 provider 语义来源：OpenAI-shape 的 prompt_tokens 已含 cache；
    # Anthropic-shape 的 input_tokens 不含 cache（cache 在顶层 cache_read/creation 字段）。
    prompt_tokens = _safe_int(usage.get("prompt_tokens"))
    input_tokens = prompt_tokens or _safe_int(usage.get("input_tokens"))
    output_tokens = (
        _safe_int(usage.get("completion_tokens"))
        or _safe_int(usage.get("output_tokens"))
    )
    total_tokens = _safe_int(usage.get("total_tokens"))
    if total_tokens <= 0:
        total_tokens = input_tokens + output_tokens

    if input_tokens > 0:
        result["input_tokens"] = input_tokens
    if output_tokens > 0:
        result["output_tokens"] = output_tokens
    if total_tokens > 0:
        result["total_tokens"] = total_tokens

    for key in ("cache_read_input_tokens", "cache_creation_input_tokens"):
        v = _safe_int(usage.get(key))
        if v > 0:
            result[key] = v

    prompt_details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details")
    if prompt_details:
        cr = _safe_int(prompt_details.get("cached_tokens") or prompt_details.get("cache_read_input_tokens"))
        cw = _safe_int(prompt_details.get("cache_creation_input_tokens"))
        if cr > 0:
            result.setdefault("cache_read_input_tokens", cr)
        if cw > 0:
            result.setdefault("cache_creation_input_tokens", cw)

    if input_tokens > 0:
        # include_cache 必须按 provider 语义判定，不能无条件 True。
        # OpenAI 的 prompt_tokens 已含 cache → True；Anthropic 的 input_tokens 不含
        # cache → False。无条件 True 会让 billing 对 Anthropic 走 base = input - cache
        # （把本就不含 cache 的 input 又减一遍），非缓存 input 漏计费 → 计费系统性偏低。
        # 与 billing.py 的 prompt_tokens == input_tokens 推断口径一致。
        result["input_tokens_include_cache"] = prompt_tokens > 0

    return result if result else None


def _enforce_request_payload_limit(
    upstream_body: Dict[str, Any],
    caps: Any,
    model_instance: Any = None,
) -> int:
    """按最终上游 JSON 的 UTF-8 字节数执行请求体上限。"""
    payload_size = len(
        json.dumps(
            upstream_body,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    max_mb = None
    if caps is not None:
        candidate = getattr(getattr(caps, "limits", None), "request_payload_max_mb", None)
        if isinstance(candidate, int) and not isinstance(candidate, bool) and candidate > 0:
            max_mb = candidate
    elif model_instance is not None:
        max_mb = get_model_limit(model_instance, "request_payload_max_mb")
    if max_mb and payload_size > max_mb * 1024 * 1024:
        actual_mb = payload_size / 1024 / 1024
        raise CapabilityGateError(
            user_message=(
                f"本次请求体约 {actual_mb:.1f} MB，超过当前模型 {max_mb} MB 的上限。"
                "请减少附件、对话历史或工具数量后重试。"
            ),
            technical_detail=(
                f"request_payload_bytes={payload_size} exceeds "
                f"limits.request_payload_max_mb={max_mb}"
            ),
            error_code="request_payload_too_large",
            status=413,
        )
    return payload_size


def _nonstream_response_to_sse_payload(response_data: Dict[str, Any]) -> str:
    """把 OpenAI 非流式响应包装成客户端现有解析器可消费的单个 SSE chunk。"""
    chunk_choices = []
    for choice in response_data.get("choices") or []:
        message = choice.get("message") or {}
        delta = {
            key: message[key]
            for key in ("role", "content", "reasoning_content", "refusal", "tool_calls")
            if key in message and message[key] is not None
        }
        tool_calls = delta.get("tool_calls")
        if isinstance(tool_calls, list):
            delta["tool_calls"] = [
                {"index": index, **tool_call}
                if isinstance(tool_call, dict) and "index" not in tool_call
                else tool_call
                for index, tool_call in enumerate(tool_calls)
            ]
        chunk_choices.append({
            "index": choice.get("index", len(chunk_choices)),
            "delta": delta,
            "finish_reason": choice.get("finish_reason"),
            "logprobs": choice.get("logprobs"),
        })

    chunk = {
        "id": response_data.get("id"),
        "object": "chat.completion.chunk",
        "created": response_data.get("created"),
        "model": response_data.get("model"),
        "choices": chunk_choices,
    }
    if response_data.get("usage") is not None:
        chunk["usage"] = response_data["usage"]
    return json.dumps(chunk, ensure_ascii=False)


def _estimate_tokens_from_text(value: Any) -> int:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if not text:
        return 0
    chinese_chars = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    other_chars = len(text) - chinese_chars
    return max(1, chinese_chars + (other_chars // 4))


def _estimate_usage_for_interrupted_stream(ctx: ProxyContext, body: dict) -> Optional[dict]:
    messages = body.get("messages") or []
    if body.get("system"):
        messages = [{"role": "system", "content": body["system"]}, *messages]
    input_tokens = _estimate_tokens_from_text(messages)
    output_tokens = _estimate_tokens_from_text("x" * ctx.streamed_output_chars) if ctx.streamed_output_chars > 0 else 0
    total_tokens = input_tokens + output_tokens
    if total_tokens <= 0:
        return None
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "estimated": True,
    }


def _parse_delta_chars_from_sse(data_str: str) -> int:
    try:
        obj = json.loads(data_str)
    except (json.JSONDecodeError, TypeError):
        return 0

    total = 0
    for choice in obj.get("choices") or []:
        delta = choice.get("delta") or {}
        content = delta.get("content")
        if isinstance(content, str):
            total += len(content)
        reasoning = delta.get("reasoning_content") or delta.get("reasoning")
        if isinstance(reasoning, str):
            total += len(reasoning)
    return total


def _safe_int(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


# 火山方舟 / 豆包等上游 burst 限流指纹。命中后走 upstream_rate_limited，
# 避免英文原文透传被前端 LLM_ERROR 映射成「网络连接异常」。
_UPSTREAM_BURST_RATE_LIMIT_MARKERS = (
    "request burst",
    "system protection triggered",
    "slow down traffic growth",
)


def _is_upstream_burst_rate_limit(text: str | None) -> bool:
    if not text:
        return False
    lowered = text.lower()
    return any(marker in lowered for marker in _UPSTREAM_BURST_RATE_LIMIT_MARKERS)


def _extract_upstream_error_summary(error_body: bytes | str | None) -> str:
    if not error_body:
        return ""
    if isinstance(error_body, bytes):
        text = error_body.decode("utf-8", errors="replace")
    else:
        text = str(error_body)
    try:
        payload = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return text[:500]

    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str):
            return message[:500]
    return text[:500]


def _extract_sse_payload_error_message(payload: str) -> str | None:
    """从上游 SSE data JSON 提取 error.message（若有）。"""
    try:
        obj = json.loads(payload)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(obj, dict):
        return None
    error = obj.get("error")
    if not isinstance(error, dict):
        return None
    for key in ("message", "user_message"):
        value = error.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


# ---------------------------------------------------------------------------
# 强制工具调用（tool_choice）通用降级
# ---------------------------------------------------------------------------

# 进程级记忆：曾以 400 拒收「强制工具调用」请求的上游模型名。命中后同进程
# 后续请求直接预先摘除 tool_choice/thinking，不再白撞一次；进程重启即清
# （自愈）。刻意不做静态模型名单——哪些模型不接受强制调用（如
# kimi-k2.7-code 思考不可关、与 forced tool_choice 互斥）由上游 400 自己
# 暴露，零配置零维护。
_FORCED_TOOL_CHOICE_REJECTED_MODELS: set = set()

# 只有 error body 命中这些指纹才把模型写入上面的记忆（：无关 400——
# 消息配对/上下文超限等——不能永久软化该模型的强制工具调用）。指纹取自
# 真实抓到的上游 400 body：
#   - "tool_choice 'required' is incompatible with thinking enabled"（kimi-k2.6）
#   - "invalid thinking: only type=enabled is allowed for this model"（kimi-k2.7-code）
# 未命中指纹的 400 仍会摘参重试一次（措辞变体也能救活），只是不入记忆。
_FORCED_TOOL_CHOICE_CONFLICT_MARKERS = (
    "incompatible with thinking",
    "only type=enabled",
)


def _is_forced_tool_choice_conflict_error(error_body: bytes | str | None) -> bool:
    """判断 400 body 是否为「强制工具调用 × thinking 互斥」类错误。"""
    if not error_body:
        return False
    if isinstance(error_body, bytes):
        text = error_body.decode("utf-8", errors="replace")
    else:
        text = str(error_body)
    lowered = text.lower()
    return any(marker in lowered for marker in _FORCED_TOOL_CHOICE_CONFLICT_MARKERS)


def _strip_forced_tool_call_params(upstream_body: Dict[str, Any]) -> None:
    """摘除强制工具调用相关字段（tool_choice + thinking）。

    二者成对出现：login-wall-gate 门禁轮带 tool_choice='required' 时，
    runtime 会同时带 thinking={"type":"disabled"} 规避思考互斥；思考不可关
    的模型（如 kimi-k2.7-code）对这两个字段都会 400，必须一起摘。摘除后
    该轮退回「工具收窄 + 指引注入」软强制，任务不中断。
    """
    upstream_body.pop("tool_choice", None)
    upstream_body.pop("thinking", None)


# 门禁轮（强制工具调用）降级刻意**不向客户端发 capability_downgrade**：
# 登录门禁是用户不感知的内部机制，降级细节属研发口径，用户只需要看到
# ask_user 登录卡片本身。排障走服务端日志（「拒收强制工具调用……重试」）。
_GATE_TURN_SILENCED_DOWNGRADE_STAGES = frozenset({"tool_choice", "reasoning"})


# Moonshot Kimi K3 / K2.x / Coding 上游只接受 temperature=1。
#  修过 digest 硬编码 0；compact 摘要仍发 0.3（packages/agent-runtime compact.ts）。
# BYOK「Kimi For Coding」模型名见 param_adaptor.KIMI_TEMPERATURE_ONE_MARKERS。
# 兼容旧测试 / 调用方命名
_is_kimi_k26_model = _requires_kimi_temperature_one


def _normalize_upstream_request_params(
    upstream_body: Dict[str, Any],
    ctx: ProxyContext,
) -> None:
    """Provider quirks that must be fixed before the request reaches upstream."""
    model_name = str(upstream_body.get("model") or ctx.model_name or "")
    if _requires_kimi_temperature_one(model_name):
        temperature = upstream_body.get("temperature")
        if temperature is not None and temperature != 1:
            logger.info(
                "[LLMProxy][%s] normalize temperature for %s: %s -> 1",
                ctx.request_id, model_name, temperature,
            )
            upstream_body["temperature"] = 1


def _merge_model_param_overrides(
    upstream_body: Dict[str, Any],
    body: Dict[str, Any],
) -> None:
    """Pass through only the client-provided reasoning-effort field.

    Runtime Profile flag OFF 时的旧路径；flag ON 时由
    ``_apply_runtime_params_for_proxy`` → Resolver 替代。
    """
    overrides = body.get("model_param_overrides")
    if isinstance(overrides, dict) and "reasoning_effort" in overrides:
        value = overrides["reasoning_effort"]
    elif "reasoning_effort" in body:
        value = body["reasoning_effort"]
    else:
        return

    if value is None:
        upstream_body.pop("reasoning_effort", None)
    else:
        upstream_body["reasoning_effort"] = value


def _apply_runtime_params_for_proxy(
    upstream_body: Dict[str, Any],
    body: Dict[str, Any],
    ctx: ProxyContext,
) -> List[Dict[str, Any]]:
    """flag 分流：ON → Runtime Profile Resolver；OFF → 旧 merge。

    Returns:
        需在 adapt_request 之前/一并 yield 的 capability_downgrade 事件列表。
        **不**把 ResolvedRuntime 写回 Session。
    """
    from apps.services.llm.runtime_profile.feature_flag import (
        is_runtime_profile_enabled,
    )
    from apps.services.llm.runtime_profile.proxy_resolution import (
        apply_runtime_profile_resolution,
    )

    if not is_runtime_profile_enabled(ctx.model_instance):
        _merge_model_param_overrides(upstream_body, body)
        return []

    _resolved, events = apply_runtime_profile_resolution(
        upstream_body,
        body,
        model_instance=ctx.model_instance,
        model_label=ctx.model_name or "",
    )
    return events


def _finalize_pending_tool_calls(
    result: list[dict],
    pending_assistant_index: Optional[int],
    pending_tool_calls: list[dict],
    satisfied_tool_call_ids: set[str],
) -> bool:
    if pending_assistant_index is None or not pending_tool_calls:
        return False

    unresolved = [
        call for call in pending_tool_calls
        if call.get("id") not in satisfied_tool_call_ids
    ]
    if not unresolved:
        return False

    assistant = result[pending_assistant_index]
    kept = [
        call for call in pending_tool_calls
        if call.get("id") in satisfied_tool_call_ids
    ]
    assistant = dict(assistant)
    if kept:
        assistant["tool_calls"] = kept
    else:
        assistant.pop("tool_calls", None)
        assistant["content"] = assistant.get("content") or ""
    result[pending_assistant_index] = assistant
    return True


def _sanitize_openai_tool_pairing(messages: list[dict]) -> tuple[list[dict], bool]:
    """Drop OpenAI-invalid orphan tool messages before they reach provider APIs.

    OpenAI-compatible providers require each ``role=tool`` message to immediately
    answer the preceding assistant message's ``tool_calls``. Historical replay can
    occasionally leave a later duplicate tool result after a plain assistant
    message; upstream rejects that shape with HTTP 400.
    """
    result: list[dict] = []
    changed = False
    pending_assistant_index: Optional[int] = None
    pending_tool_calls: list[dict] = []
    pending_tool_call_ids: set[str] = set()
    satisfied_tool_call_ids: set[str] = set()

    def finalize() -> None:
        nonlocal changed, pending_assistant_index
        nonlocal pending_tool_calls, pending_tool_call_ids, satisfied_tool_call_ids
        changed = (
            _finalize_pending_tool_calls(
                result,
                pending_assistant_index,
                pending_tool_calls,
                satisfied_tool_call_ids,
            )
            or changed
        )
        pending_assistant_index = None
        pending_tool_calls = []
        pending_tool_call_ids = set()
        satisfied_tool_call_ids = set()

    for message in messages or []:
        role = message.get("role")
        if role == "tool":
            tool_call_id = message.get("tool_call_id")
            if tool_call_id and tool_call_id in pending_tool_call_ids:
                result.append(message)
                pending_tool_call_ids.discard(tool_call_id)
                satisfied_tool_call_ids.add(tool_call_id)
            else:
                changed = True
            continue

        finalize()
        result.append(message)
        calls = [
            call for call in (message.get("tool_calls") or [])
            if isinstance(call, dict) and call.get("id")
        ]
        if role == "assistant" and calls:
            pending_assistant_index = len(result) - 1
            pending_tool_calls = calls
            pending_tool_call_ids = {str(call["id"]) for call in calls}
            satisfied_tool_call_ids = set()

    finalize()
    return (result if changed else messages, changed)


def _handle_upstream_http_error(
    ctx: ProxyContext,
    upstream_body: Dict[str, Any],
    status_code: int,
    error_body: bytes,
    *,
    is_degrade_retry: bool,
) -> bool:
    """处理上游非 200；返回 True 表示已摘参，应原地重试。"""
    if (
        not is_degrade_retry
        and status_code == 400
        and upstream_body.get("tool_choice") is not None
    ):
        if _is_forced_tool_choice_conflict_error(error_body):
            _FORCED_TOOL_CHOICE_REJECTED_MODELS.add(upstream_body.get("model"))
        _strip_forced_tool_call_params(upstream_body)
        logger.warning(
            "[LLMProxy][%s] model=%s 拒收强制工具调用（HTTP 400，body=%s），"
            "摘除 tool_choice/thinking 后重试一次（入记忆=%s）",
            ctx.request_id,
            upstream_body.get("model"),
            error_body[:500] if error_body else "(empty)",
            upstream_body.get("model") in _FORCED_TOOL_CHOICE_REJECTED_MODELS,
        )
        return True

    _report_key_error(ctx, status_code)
    logger.warning(
        "[LLMProxy][%s] 上游返回 HTTP %d, body=%s",
        ctx.request_id,
        status_code,
        error_body[:2000] if error_body else "(empty)",
    )
    byok_category = classify_byok_error(status_code, error_body, ctx.is_byok)
    upstream_summary = _extract_upstream_error_summary(error_body)
    if byok_category:
        error_code = byok_category
        error_status = status_code
    elif status_code == 429 or _is_upstream_burst_rate_limit(upstream_summary):
        error_code = "upstream_rate_limited"
        error_status = 429
    else:
        error_code = "upstream_error"
        error_status = status_code
    raise ProxyError(
        error_status,
        error_code,
        f"上游服务返回错误，status={status_code}, detail={upstream_summary}",
    )


def stream_upstream(
    ctx: ProxyContext,
    body: dict,
) -> Generator[str, None, Optional[dict]]:
    """向上游 LLM Provider 发起 SSE 请求并逐行 yield。

    Returns（通过 generator return）最后解析到的 usage dict。

    wire_adapter 接入(harness 总控 § 4 / S1.2):构造内部规范化 upstream_body
    后,根据 feature flag 决定走 wire_adapter.adapt_request 全链路适配,还是
    回退仅 image_fetcher.normalize_image_urls 的兜底路径。

      - feature flag ON(默认):wire_adapter 接管 image / system / tool /
        parallel / cache_control / json_mode / reasoning 全套适配,新模型/
        新 provider 上线无需在本文件加 if/elif 分支。
      - feature flag OFF(env LLM_WIRE_ADAPTER_ENABLED=false 或
        LLMModel.wire_adapter_disabled=True):仅做 image URL → base64
        normalize,W1 灰度兜底。
    """
    url = compose_upstream_chat_url(ctx.api_base)
    wire_adapter_active = is_wire_adapter_enabled(ctx.model_instance)
    caps = None
    if wire_adapter_active:
        caps = resolve_for_wire(
            ctx.model_instance,
            provider=getattr(ctx.model_instance, "provider", None),
        )
        upstream_stream = bool(caps.wire.stream_supported)
    else:
        upstream_stream = get_capability_flag(
            ctx.model_instance,
            "supports_streaming",
            default=True,
        )

    upstream_body: Dict[str, Any] = {
        "model": body.get("_upstream_model_name", ctx.model_name),
        "messages": body["messages"],  # 暂不转换,留给 wire_adapter 或 W0 路径处理
        "stream": upstream_stream,
    }
    if body.get("tools"):
        upstream_body["tools"] = body["tools"]
    if body.get("tool_choice"):
        upstream_body["tool_choice"] = body["tool_choice"]
    if body.get("system"):
        # 注意:LLMProxy 的内部规范化是 OpenAI 风(messages 内 role=system),
        # body 顶层 system 仅 wire_adapter Anthropic 路径需要;此处先合并到
        # messages 头部,wire_adapter 出口前若走 anthropic_top_level 会再 hoist。
        upstream_body["messages"] = [
            {"role": "system", "content": body["system"]},
            *upstream_body["messages"],
        ]
    if body.get("max_tokens"):
        upstream_body["max_tokens"] = body["max_tokens"]
    if body.get("temperature") is not None:
        upstream_body["temperature"] = body["temperature"]
    if body.get("top_p") is not None:
        upstream_body["top_p"] = body["top_p"]
    if body.get("response_format"):
        upstream_body["response_format"] = body["response_format"]
    if body.get("thinking"):
        upstream_body["thinking"] = body["thinking"]
    # W2c: Runtime Profile Resolver（flag ON）或旧 merge（flag OFF）。
    # 必须在 adapt_request 之前写出 canonical reasoning_effort；
    # 绝不把 thinking_mode 送进 wire_adapter。
    runtime_profile_downgrade_events = _apply_runtime_params_for_proxy(
        upstream_body, body, ctx,
    )
    if body.get("parallel_tool_calls") is not None:
        upstream_body["parallel_tool_calls"] = body["parallel_tool_calls"]
    # stream_options 仅属于流式协议；非流式响应本身就携带 usage。
    if upstream_stream:
        upstream_body["stream_options"] = {"include_usage": True}

    # 门禁轮标记：runtime 只在 login-wall-gate 门禁轮下发 tool_choice。
    # 必须在 adapt_request 之前取（适配层可能按能力表剥掉 tool_choice）。
    is_forced_tool_call_turn = upstream_body.get("tool_choice") is not None

    # === wire_adapter feature flag 决策点 ===
    if wire_adapter_active:
        # 全链路适配:capability gate / image / system / tool / json / reasoning
        # 6c6b7a1ae（AI 能力统一宪法 v0.1）已删除 LLMModel.get_wire_capabilities()
        # 方法,统一改走 utils helper(与 wire_adapter/probes.py 同方向)。
        upstream_body, downgrade_events = adapt_request(
            upstream_body, caps, ctx,
        )
        # Resolver 降级在前，wire 降级在后（同一 SSE 通道）。
        downgrade_events = [
            *runtime_profile_downgrade_events,
            *downgrade_events,
        ]
        # downgrade_events 在 stream 开始前先 yield 给客户端,让 Renderer 可以
        # 渲染降级提示气泡(例如:json_schema 不支持 → 已自动降级为 system 提示)。
        # 例外：门禁轮的 tool_choice/reasoning 降级属内部机制细节，用户只需
        # 看到 ask_user 卡片，不发气泡（排障走服务端日志）。
        for event in downgrade_events:
            if (
                is_forced_tool_call_turn
                and event.get("stage") in _GATE_TURN_SILENCED_DOWNGRADE_STAGES
            ):
                logger.info(
                    "[LLMProxy][%s] 门禁轮静默降级气泡 stage=%s reason=%s",
                    ctx.request_id, event.get("stage"), event.get("reason"),
                )
                continue
            yield (
                "event: capability_downgrade\n"
                f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            )
        if downgrade_events:
            logger.info(
                "[LLMProxy][%s] wire_adapter applied; downgrade_events=%d",
                ctx.request_id, len(downgrade_events),
            )
    else:
        # Feature flag OFF:仅做 image normalize 兜底(只解决 image,
        # 不做 system/tool/json/reasoning 适配)。
        logger.info(
            "[LLMProxy][%s] wire_adapter disabled, falling back to image "
            "normalizer only",
            ctx.request_id,
        )
        upstream_body["messages"] = normalize_image_urls(
            upstream_body["messages"],
        )
        # wire 关时仍需下发 Runtime Profile 降级提示（若 resolver 已跑）。
        for event in runtime_profile_downgrade_events:
            if (
                is_forced_tool_call_turn
                and event.get("stage") in _GATE_TURN_SILENCED_DOWNGRADE_STAGES
            ):
                continue
            yield (
                "event: capability_downgrade\n"
                f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            )

    upstream_body = apply_provider_request_policy(
        upstream_body,
        ctx,
        incoming_body=body,
    )

    upstream_body["messages"], pairing_changed = _sanitize_openai_tool_pairing(
        upstream_body.get("messages") or [],
    )
    if pairing_changed:
        logger.warning(
            "[LLMProxy][%s] sanitized invalid tool/message pairing before upstream",
            ctx.request_id,
        )

    _normalize_upstream_request_params(upstream_body, ctx)
    payload_size = _enforce_request_payload_limit(
        upstream_body,
        caps,
        ctx.model_instance,
    )

    # 通用降级（预判路径）：该模型此前已在本进程内拒收过强制工具调用，
    # 直接摘除 tool_choice/thinking，省掉一次注定 400 的往返。
    if (
        upstream_body.get("tool_choice") is not None
        and upstream_body.get("model") in _FORCED_TOOL_CHOICE_REJECTED_MODELS
    ):
        _strip_forced_tool_call_params(upstream_body)
        logger.info(
            "[LLMProxy][%s] model=%s 此前拒收强制工具调用，已预先摘除 tool_choice/thinking",
            ctx.request_id, upstream_body.get("model"),
        )

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {ctx.api_key}",
        "Accept": "text/event-stream" if upstream_stream else "application/json",
    }

    # 上下文档位（如 ZenMux 1M 上下文）注入额外 header 给上游
    tier_headers = _resolve_upstream_tier_headers(ctx)
    if tier_headers:
        headers.update(tier_headers)
        logger.info(
            "[LLMProxy][%s] context_tier=%s injecting headers=%s",
            ctx.request_id, ctx.context_tier_id, list(tier_headers.keys()),
        )

    last_usage: Optional[dict] = None

    msg_summary = []
    for m in upstream_body.get("messages", []):
        role = m.get("role", "?")
        tc = m.get("tool_calls")
        tcid = m.get("tool_call_id")
        content_len = len(str(m.get("content", "")))
        extra = f" tool_calls={len(tc)}" if tc else ""
        extra += f" tool_call_id={tcid}" if tcid else ""
        msg_summary.append(f"{role}({content_len}c{extra})")
    tools_count = len(upstream_body.get("tools", []))
    logger.info(
        "[LLMProxy][%s] ▶ upstream model=%s stream=%s msgs=[%s] tools=%d payload=%dB",
        ctx.request_id, upstream_body["model"],
        upstream_stream, ", ".join(msg_summary), tools_count, payload_size,
    )

    t0 = time.monotonic()
    yield _build_timing_comment(
        ctx,
        "django_upstream_request_start",
        elapsed_ms=_ms_since(ctx.view_started_at),
        extras={
            "message_count": len(upstream_body.get("messages", [])),
            "tool_count": tools_count,
        },
    )
    _log_timing(
        ctx,
        "django_upstream_request_start",
        elapsed_ms=_ms_since(ctx.view_started_at),
        extras={
            "message_count": len(upstream_body.get("messages", [])),
            "tool_count": tools_count,
        },
    )

    if not upstream_stream:
        with contextlib.nullcontext(_get_upstream_client()) as client:
            for is_degrade_retry in (False, True):
                response = client.post(url, json=upstream_body, headers=headers)
                response_elapsed = _ms_since(t0)
                yield _build_timing_comment(
                    ctx,
                    "django_upstream_http_response",
                    elapsed_ms=response_elapsed,
                    extras={"http_status": response.status_code},
                )
                _log_timing(
                    ctx,
                    "django_upstream_http_response",
                    elapsed_ms=response_elapsed,
                    extras={"http_status": response.status_code},
                )
                if response.status_code != 200:
                    if _handle_upstream_http_error(
                        ctx,
                        upstream_body,
                        response.status_code,
                        response.content,
                        is_degrade_retry=is_degrade_retry,
                    ):
                        continue

                try:
                    response_data = response.json()
                except (json.JSONDecodeError, ValueError) as exc:
                    raise ProxyError(
                        502,
                        "upstream_error",
                        f"上游非流式响应不是合法 JSON: {exc}",
                    ) from exc

                payload = _nonstream_response_to_sse_payload(response_data)
                first_data_elapsed = _ms_since(t0)
                yield _build_timing_comment(
                    ctx,
                    "django_upstream_first_data",
                    elapsed_ms=first_data_elapsed,
                )
                _log_timing(
                    ctx,
                    "django_upstream_first_data",
                    elapsed_ms=first_data_elapsed,
                )
                last_usage = _parse_usage_from_sse(payload)
                if last_usage:
                    ctx.accumulated_usage = last_usage
                ctx.streamed_output_chars += _parse_delta_chars_from_sse(payload)
                yield f"data: {payload}\n\n"
                break

        elapsed = (time.monotonic() - t0) * 1000
        yield _build_timing_comment(
            ctx,
            "django_upstream_stream_total",
            elapsed_ms=elapsed,
        )
        _log_timing(
            ctx,
            "django_upstream_stream_total",
            elapsed_ms=elapsed,
        )
        logger.info(
            "[LLMProxy][%s] non-stream done: elapsed=%.0fms usage=%s",
            ctx.request_id,
            elapsed,
            last_usage,
        )
        return last_usage

    # 复用进程级连接池：nullcontext 保证请求结束后不关闭共享 client，
    # 只有内层 client.stream 的响应上下文会正常关闭。
    # 通用降级（撞墙路径）：带 tool_choice 的请求被上游 400 拒收时，摘除
    # tool_choice/thinking 原地重试一次（is_degrade_retry=True 的第二轮
    # 不再降级，仍 400 就照常抛 ProxyError）。
    with contextlib.nullcontext(_get_upstream_client()) as client:
        for is_degrade_retry in (False, True):
            with client.stream(
                "POST", url, json=upstream_body, headers=headers,
            ) as response:
                response_elapsed = _ms_since(t0)
                yield _build_timing_comment(
                    ctx,
                    "django_upstream_http_response",
                    elapsed_ms=response_elapsed,
                    extras={"http_status": response.status_code},
                )
                _log_timing(
                    ctx,
                    "django_upstream_http_response",
                    elapsed_ms=response_elapsed,
                    extras={"http_status": response.status_code},
                )
                if response.status_code != 200:
                    error_body = response.read()
                    if _handle_upstream_http_error(
                        ctx,
                        upstream_body,
                        response.status_code,
                        error_body,
                        is_degrade_retry=is_degrade_retry,
                    ):
                        continue

                first_data_seen = False
                for line in response.iter_lines():
                    if not line:
                        continue

                    if line.startswith("data: "):
                        if not first_data_seen:
                            first_data_seen = True
                            first_data_elapsed = _ms_since(t0)
                            yield _build_timing_comment(
                                ctx,
                                "django_upstream_first_data",
                                elapsed_ms=first_data_elapsed,
                            )
                            _log_timing(
                                ctx,
                                "django_upstream_first_data",
                                elapsed_ms=first_data_elapsed,
                            )
                        payload = line[6:]

                        if payload.strip() == "[DONE]":
                            break

                        # 上游偶发 HTTP 200 后在 SSE 里塞 error chunk（豆包/火山
                        # burst 限流）。勿原样透传英文，升格为 ProxyError 走中文模板。
                        sse_error_msg = _extract_sse_payload_error_message(payload)
                        if _is_upstream_burst_rate_limit(sse_error_msg):
                            _report_key_error(ctx, 429)
                            raise ProxyError(
                                429,
                                "upstream_rate_limited",
                                (
                                    "上游服务返回错误，status=429, "
                                    f"detail={sse_error_msg}"
                                ),
                            )

                        u = _parse_usage_from_sse(payload)
                        if u:
                            last_usage = u
                            ctx.accumulated_usage = u
                        ctx.streamed_output_chars += _parse_delta_chars_from_sse(payload)

                        yield f"data: {payload}\n\n"

                    elif line.startswith(":"):
                        # 上游 comment 可透传 keepalive，但不能伪造 TabTin 内部 timing comment。
                        if line.strip().startswith(": tabtin_timing "):
                            continue
                        yield f"{line}\n\n"

            # 流式响应正常结束（或 200 后走完），不进入降级重试。
            break

    elapsed = (time.monotonic() - t0) * 1000
    yield _build_timing_comment(
        ctx,
        "django_upstream_stream_total",
        elapsed_ms=elapsed,
    )
    _log_timing(
        ctx,
        "django_upstream_stream_total",
        elapsed_ms=elapsed,
    )
    logger.info(
        "[LLMProxy][%s] ◀ done: elapsed=%.0fms usage=%s",
        ctx.request_id, elapsed, last_usage,
    )

    return last_usage


def _report_key_error(ctx: ProxyContext, status_code: int) -> None:
    """向 key_manager 反馈上游错误，用于 Key 级别熔断/冷却。"""
    if not ctx.key_obj:
        return
    try:
        from .key_manager import mark_key_cooldown, mark_key_disabled
        if status_code in (401, 403):
            mark_key_disabled(ctx.key_obj, reason=f"upstream_{status_code}")
        elif status_code in (429, 500, 502, 503, 529):
            mark_key_cooldown(ctx.key_obj, reason=f"upstream_{status_code}")
    except Exception as exc:
        logger.warning(
            "[LLMProxy][%s] key_manager 反馈失败: %s", ctx.request_id, exc,
        )


def proxy_stream_events(ctx: ProxyContext, body: dict) -> Generator[str, None, None]:
    """完整的 proxy 流式事件生成器。

    在 generator 内部完成流转发和结算，确保冻结在任何情况下都被释放。
    捕获 GeneratorExit 以便在客户端断连时及时释放冻结和上游连接。
    """

    def _settle_accumulated_or_release(tag: str) -> None:
        """如已累积 usage，走结算；否则仅释放冻结。用于异常路径复用。"""
        has_provider_usage = bool(ctx.accumulated_usage)
        acc = ctx.accumulated_usage or _estimate_usage_for_interrupted_stream(ctx, body)
        if acc:
            if not ctx.is_byok:
                interrupted_usage_source = (
                    "provider_partial"
                    if has_provider_usage
                    else "estimated_interrupted"
                )
                logger.warning(
                    "[LLMProxy][%s] %s，按已收 usage 结算: usage=%s",
                    ctx.request_id, tag, acc,
                )
                settle_and_charge(
                    ctx,
                    acc,
                    usage_source=interrupted_usage_source,
                )
            else:
                logger.warning(
                    "[LLMProxy][%s] BYOK %s，仅记录 UsageFact: usage=%s",
                    ctx.request_id, tag, acc,
                )
                from .billed_call import _record_usage_fact_for_billed_call
                try:
                    _record_usage_fact_for_billed_call(
                        request_id=ctx.request_id,
                        user_id=ctx.user_id,
                        organization_id=ctx.organization_id,
                        model_instance=ctx.model_instance,
                        usage=acc,
                        scene_key=ctx.scene_key or map_source_to_scene_key(ctx.source),
                        capability_domain='chat',
                        status="completed",
                        context_tier_id=ctx.context_tier_id,
                    )
                except Exception:
                    pass
                release_freeze(ctx)
        else:
            release_freeze(ctx)

    last_usage: Optional[dict] = None
    try:
        for phase, duration_ms in ctx.timings.items():
            yield _build_timing_comment(
                ctx,
                f"django_{phase}",
                duration_ms=duration_ms,
                elapsed_ms=_ms_since(ctx.view_started_at),
            )
            _log_timing(
                ctx,
                f"django_{phase}",
                duration_ms=duration_ms,
                elapsed_ms=_ms_since(ctx.view_started_at),
            )
        gen = stream_upstream(ctx, body)
        try:
            while True:
                chunk = next(gen)
                yield chunk
        except StopIteration as si:
            last_usage = si.value
    except GeneratorExit:
        _settle_accumulated_or_release("客户端断连")
        return
    except CapabilityGateError as exc:
        # wire_adapter capability gate 拒绝(目前覆盖图片输入:不支持 vision /
        # 仅支持非 url+非 base64 等场景)。其他 capability(json_schema /
        # json_object / tool / system / reasoning)在 wire_adapter 内部走的是
        # **silent drop / capability_downgrade event** 软降级路径,不会抛
        # CapabilityGateError;这里 catch 主要是把图片侧的硬阻断转成 SSE error。
        # CapabilityGateError 自带渲染好的中文 user_message,extras 透传给前端
        # 让 Renderer 能区分渲染"换 model"按钮 vs"移除图片"按钮。
        release_freeze(ctx)
        logger.warning(
            "[LLMProxy][%s] capability gate reject code=%s status=%d detail=%s",
            ctx.request_id, exc.error_code, exc.status, exc.technical_detail,
        )
        yield build_sse_error_chunk(
            user_message=exc.user_message,
            technical_detail=exc.technical_detail,
            error_code=exc.error_code,
            status=exc.status,
            extras={
                "stage": "capability_gate",
                "backend_error_type": exc.error_code,
            },
        )
        yield "data: [DONE]\n\n"
        return
    except ImageFetchError as exc:
        # ImageFetchError 双签名兼容:
        #   - W0 风(image_fetcher 抛):exc.reason / exc.host / exc.status / exc.failed_count
        #     齐全 → 用 render_error 重新渲染中文文案
        #   - W1b 风(直接 user_message= 构造):exc.user_message 已渲染好 →
        #     直接用,避免二次渲染丢失原文中已带的 host / 占位
        # error_code 走 exc.error_code 透传(默认 image_fetch_failed)。
        release_freeze(ctx)
        logger.warning(
            "[LLMProxy][%s] image fetch failed reason=%s host=%s status=%s "
            "failed=%s/%s",
            ctx.request_id, exc.reason, exc.host, exc.status,
            exc.failed_count, exc.total_count,
        )
        if exc.user_message:
            # W1b 风:user_message 已渲染好(可能含 host/timeout 等信息),直接用
            user_msg = exc.user_message
            tech_detail = exc.technical_detail
        else:
            # W0 风:用 reason / host 走模板渲染中文文案。reason 含 timeout /
            # http_error / network_error / oversize / too_many_images 五类,
            # error_messages.py 都有专属模板;命中 miss 时 render_error 内部
            # 会 logger.warning + 兜底,不会让用户看到 KeyError。
            render_vars = {
                "host": exc.host or "未知主机",
                "status": exc.status if exc.status is not None else "未知",
                "timeout": exc.timeout if exc.timeout is not None else 5.0,
                "total_count": exc.total_count,
                "failed_count": exc.failed_count,
            }
            # too_many_images：把上限本身传给文案（failed_count 仅为超额张数）
            if (
                exc.reason == "too_many_images"
                and isinstance(exc.total_count, int)
                and isinstance(exc.failed_count, int)
                and exc.total_count >= exc.failed_count >= 0
            ):
                render_vars["max_count"] = exc.total_count - exc.failed_count
            user_msg, tech_detail = render_error(
                "image_fetch", "image", exc.reason,
                **render_vars,
            )
        yield build_sse_error_chunk(
            user_message=user_msg,
            technical_detail=tech_detail,
            error_code=exc.error_code or "image_fetch_failed",
            status=exc.status if exc.status is not None else 502,
            extras={
                "stage": "image_fetch",
                "reason": exc.reason,
                "host": exc.host,
                "failed_count": exc.failed_count,
                "total_count": exc.total_count,
            },
        )
        yield "data: [DONE]\n\n"
        return
    except ProxyError as exc:
        # v0.2.1:yield SSE error chunk + [DONE](替代原 raise 让客户端死等)。
        user_msg, tech, extras = _proxy_error_to_friendly(exc, ctx.model_name)
        yield build_sse_error_chunk(
            user_message=user_msg,
            technical_detail=tech,
            error_code=exc.error_code,
            status=exc.status,
            extras=extras,
        )
        yield "data: [DONE]\n\n"
        _report_key_error(ctx, exc.status)
        release_freeze(ctx)
        logger.warning("[LLMProxy][%s] ProxyError: %s/%d", ctx.request_id, exc.error_code, exc.status)
        return
    except (httpx.ReadTimeout, httpx.ConnectTimeout) as exc:
        _report_key_error(ctx, 504)
        logger.error("[LLMProxy][%s] 上游超时: %s", ctx.request_id, exc)
        _settle_accumulated_or_release("上游超时")
        if ctx.is_byok:
            yield build_sse_error_chunk(
                user_message="您组织自备的 API Key 对应的上游服务响应超时，过几分钟一般会自动恢复。",
                technical_detail=f"byok_timeout httpx_err={type(exc).__name__}",
                error_code="byok_provider_unavailable",
                status=504,
                extras={"error_category": "byok_provider_unavailable"},
            )
        else:
            user_msg, tech = render_error("upstream", "*", "timeout", status=504)
            yield build_sse_error_chunk(
                user_message=user_msg,
                technical_detail=f"{tech} httpx_err={type(exc).__name__}",
                error_code="upstream_timeout",
                status=504,
            )
        yield "data: [DONE]\n\n"
        return
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        _report_key_error(ctx, status)
        release_freeze(ctx)
        logger.error("[LLMProxy][%s] 上游 HTTP %d", ctx.request_id, status)
        reason = "5xx" if status >= 500 else "4xx"
        user_msg, tech = render_error("upstream", "*", reason, status=status)
        yield build_sse_error_chunk(
            user_message=user_msg,
            technical_detail=tech,
            error_code="upstream_error",
            status=status,
        )
        yield "data: [DONE]\n\n"
        return
    except Exception as exc:
        logger.error("[LLMProxy][%s] 流转发异常: %s", ctx.request_id, exc, exc_info=True)
        _settle_accumulated_or_release("流转发异常")
        user_msg, tech = render_error("upstream", "*", "5xx", status=500)
        yield build_sse_error_chunk(
            user_message=user_msg,
            technical_detail=f"{tech} internal_err={type(exc).__name__}",
            error_code="internal_error",
            status=500,
        )
        yield "data: [DONE]\n\n"
        return

    # 流正常结束 → 结算 + 追发计费尾帧（PRD-04 Phase 1 / T1.1 + Wave 2 A2）
    if not last_usage:
        last_usage = _estimate_usage_for_interrupted_stream(ctx, body)
    credits_charged: float = 0.0
    charge_status: str = "failed"
    charge_error_category: Optional[str] = None
    if not ctx.is_byok:
        credits_charged, charge_ok, charge_error_category = settle_and_charge(
            ctx, last_usage,
        )
        charge_status = "success" if charge_ok else "failed"
        if charge_ok:
            charge_error_category = None
        elif not charge_error_category:
            charge_error_category = "billing_charge_failed"
    else:
        from .billed_call import _record_usage_fact_for_billed_call
        try:
            _record_usage_fact_for_billed_call(
                request_id=ctx.request_id,
                user_id=ctx.user_id,
                organization_id=ctx.organization_id,
                model_instance=ctx.model_instance,
                usage=last_usage,
                scene_key=ctx.scene_key or map_source_to_scene_key(ctx.source),
                capability_domain='chat',
                context_tier_id=ctx.context_tier_id,
            )
        except Exception as exc:
            logger.warning("[LLMProxy][%s] BYOK UsageFact 记录失败: %s", ctx.request_id, exc)
        release_freeze(ctx)
        charge_status = "byok_exempt"

    billing_payload: Dict[str, Any] = {
        "request_id": ctx.request_id,
        "model": ctx.model_name,
        "is_byok": ctx.is_byok,
        "credits_charged": credits_charged,
        "charge_status": charge_status,
    }
    if charge_error_category:
        billing_payload["error_category"] = charge_error_category
    if last_usage:
        billing_payload["usage"] = last_usage
    yield f"event: tabtin.billing\ndata: {json.dumps(billing_payload)}\n\n"
    yield "data: [DONE]\n\n"
