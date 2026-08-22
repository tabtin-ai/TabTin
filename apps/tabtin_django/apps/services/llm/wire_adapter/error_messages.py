"""LLM Wire Adapter · 错误文案模板表 + render_error API.

设计要点（W0 起即用）：
- key 是 (stage, capability, reason) 三元组
- value 是含 {model_name} / {host} / {status} / {total_count} / {failed_count}
  / {timeout} 等占位的中文文案
- 通配 capability='*' 用于跨能力共享文案（billing / upstream 等场景）
- render_error 先精确匹配，再 fallback 到 (stage, '*', reason)，最后兜底
- 所有文案统一中文术语（避免英文残留，与产品 V0.3 一致）：
    * 用"组织"，禁止英文 W-o-r-k-t-e-a-m
    * 用"模型"，禁止英文 m-o-d-e-l
    * 用"换一个模型"/"切换到其他模型"，禁止半英文"换 m-o-d-e-l"
    * 用"余额不足"/"扣费"，禁止英文 credit balance / billing
- 注释里讨论术语对照仅限本段说明（用断字写法），user-facing 文案严格中文

ImageFetchError：由 ``wire_adapter.image_fetcher.normalize_image_urls`` /
``fetch_image_to_data_url`` 在下载图片失败时抛出（W0 风 reason / W1b 风
user_message 双签名），由 ``services.proxy_service.proxy_stream_events``
在流内 catch 并 yield SSE error chunk + [DONE]，走 stage='image_fetch'
模板路径渲染中文文案（同时透传 host/failed_count/total_count 等占位）。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Error Templates（W0 起即用，源自 v0.3 总控 § 5）
# ---------------------------------------------------------------------------

# 文案口径：统一中文术语（避免 "model" / "fallback" / "Organization" 等英文残留），
# "组织" 而非 "Organization"、"模型" 而非 "model"、"换一个模型" 而非 "换 model"。
ERROR_TEMPLATES: Dict[Tuple[str, str, str], str] = {
    # === Image fetch（image normalizer 抛 ImageFetchError 触发）===
    ("image_fetch", "image", "timeout"):
        "图片下载超时（共 {total_count} 张图，{failed_count} 张失败，主机：{host}，"
        "超时 {timeout}s）。请检查网络或重新上传图片再发送。",
    ("image_fetch", "image", "http_error"):
        "图片下载失败（共 {total_count} 张图，{failed_count} 张失败，主机：{host}，"
        "HTTP {status}）。请确认图片可公开访问后重新上传图片再发送。",
    ("image_fetch", "image", "network_error"):
        "图片下载网络错误（共 {total_count} 张图，{failed_count} 张失败，主机：{host}）。"
        "请检查网络后重新上传图片再发送。",
    ("image_fetch", "image", "oversize"):
        "图片体积过大（共 {total_count} 张图，{failed_count} 张超限）。"
        "请压缩图片到 5 MB 以内后重新上传，或更换更小的图片。",
    ("image_fetch", "image", "too_many_images"):
        # 必须写出 {max_count}（上限本身）。旧文案「共 N 张，M 张超过单次上限」
        # 里的 M 是超额张数，易被误读成「上限=M」（见 ）。
        "本次请求包含 {total_count} 张图片，超过单次上限 {max_count} 张。"
        "请减少到 {max_count} 张以内，或分多次发送。",
    ("image_fetch", "image", "forbidden_url"):
        "图片地址不可访问（共 {total_count} 张图，{failed_count} 张失败，主机：{host}）。"
        "请重新上传图片，或使用可公开访问的 HTTPS 图片地址。",

    # === Capability gate（W1+ 用，W0 先落模板）===
    ("capability_gate", "image", "upload_failed"):
        "图片上传到模型服务失败，请稍后重试。",
    ("capability_gate", "image", "oversize"):
        "图片过大，超出模型允许的大小上限。请压缩后再上传。",
    ("capability_gate", "image", "unsupported_via"):
        "当前模型 \"{model_name}\" 不支持图片输入。建议：换一个模型"
        "（如 Claude/GPT-4o/Qwen-VL），或移除图片后重发。",
    ("capability_gate", "video", "unsupported_via"):
        "当前模型 \"{model_name}\" 不支持视频输入。建议：换一个支持视频理解的模型"
        "（如 Kimi K2.5/K2.6），或移除视频后重发。",
    ("capability_gate", "video", "upload_failed"):
        "视频上传到模型服务失败，无法完成视频理解。请稍后重试，或换更短的视频后再发。",
    ("capability_gate", "video", "oversize"):
        "视频体积过大，超过模型服务允许的上限（约 100 MB）。请压缩或截短后再上传。",
    ("capability_gate", "video", "unreadable"):
        "无法读取视频附件并转交模型服务。请重新上传视频后再发。",
    ("capability_gate", "video", "unsupported_url"):
        "视频地址无法被服务端读取（不在允许的存储范围内）。请重新上传视频后再发。",
    ("capability_gate", "document", "unsupported_via"):
        "当前模型 \"{model_name}\" 不支持文档附件直传。建议：换一个支持文档理解的模型"
        "（如 Kimi），或移除附件后重发。",
    ("capability_gate", "document", "upload_failed"):
        "文档上传到模型服务并提取内容失败，无法完成附件理解。请稍后重试，或换更小的文件后再发。",
    ("capability_gate", "document", "oversize"):
        "文档体积过大，超过模型服务允许的上限。请压缩或拆分后再上传。",
    ("capability_gate", "document", "unreadable"):
        "无法读取本地文档附件并转交模型服务。请重新上传文件后再发。",
    ("capability_gate", "json_schema", "unsupported"):
        "当前模型 \"{model_name}\" 不支持 JSON Schema 输出，已自动降级为提示词约束。"
        "Agent 输出可能不严格符合 schema；如需完整能力请换模型。",
    ("capability_gate", "json_object", "unsupported"):
        "当前模型 \"{model_name}\" 不支持 JSON Object 输出，已自动降级为提示词约束"
        "（在 system 中提示模型按 JSON 格式输出）。Agent 输出格式可能不严格保证；"
        "如需完整能力请换模型。",

    # === Upstream（generic 4xx/5xx/timeout）===
    ("upstream", "*", "4xx"):
        "模型上游返回错误（{status}）。这不是组织余额不足；可能是模型暂时不可用、"
        "上游账号限制或请求格式不兼容。建议：换一个模型重试，或联系管理员排查模型配置。",
    ("upstream", "*", "request_format"):
        "模型调用参数或上下文格式不兼容，已停止本次调用。这不是组织余额不足；"
        "系统已释放本次预扣冻结。请换一个模型重试，或联系管理员排查模型适配配置。",
    # 豆包 / 火山方舟等 burst / RPM 限流：勿落到通用 LLM_ERROR「网络连接异常」。
    ("upstream", "*", "rate_limited"):
        "该模型暂无法使用，请稍后重试或更换模型",
    ("upstream", "*", "5xx"):
        "上游服务异常（{status}）。已自动重试失败。请稍后重试或换一个模型。",
    ("upstream", "*", "timeout"):
        "上游服务响应超时（{status}）。可能原因：网络拥堵 / 模型负载过高。"
        "请稍后重试或换一个模型。",

    # === Billing（calling user 的组织余额 / 预算 / 冻结）===
    ("billing", "*", "budget_exceeded"):
        "本次请求超出预算限制。请检查组织配额或联系管理员。",
    ("billing", "*", "membership_expired"):
        "组织会员已过期。请续费会员后继续使用。",
    ("billing", "*", "insufficient_credits"):
        "组织余额不足。请联系管理员充值，或换一个收费更低的模型。",
    ("billing", "*", "freeze_failed"):
        "扣费冻结失败，可能余额不足。请检查组织账户余额。",

    # === System routing（model 解析 / key 选择 / organization 上下文）===
    ("system_routing", "*", "model_not_found"):
        "模型 \"{model_name}\" 不存在或未激活。请刷新页面或换一个模型。",
    ("system_routing", "*", "key_unavailable"):
        "模型 \"{model_name}\" 当前不可用（API Key 异常）。请稍后重试或联系管理员。",
    ("system_routing", "*", "missing_api_base"):
        "模型 \"{model_name}\" 未配置上游 API 地址 (api_base)。"
        "请联系管理员检查模型配置。",
    ("system_routing", "*", "missing_organization_id"):
        "缺少组织上下文，无法执行 LLM 调用。请刷新页面后重试。",
    ("system_routing", "*", "all_keys_exhausted"):
        "模型 \"{model_name}\" 所有 API Key 当前都不可用。请稍后重试或联系管理员。",

    # === Auth ===
    ("auth", "*", "organization_forbidden"):
        "无权使用当前组织。请检查身份或重新登录。",
    ("auth", "*", "unauthorized"):
        "认证失败,请重新登录后再试。",

    # === Request validation（早期 view-layer 校验失败）===
    ("request", "*", "body_too_large"):
        "请求体超过 1 MB 限制。请减少消息内容或分批发送。",
    ("request", "*", "invalid_json"):
        "请求格式错误。请刷新页面后重试。",
    ("request", "*", "missing_model"):
        "请求缺少模型参数。请检查会话设置。",
    ("request", "*", "missing_messages"):
        "请求缺少消息内容。请检查后重发。",
    ("request", "*", "stream_required"):
        "当前请求模式不支持。请联系管理员排查。",
}


# ---------------------------------------------------------------------------
# Custom Exceptions
# ---------------------------------------------------------------------------

class ImageFetchError(Exception):
    """Image normalizer 下载图片失败。

    支持两套签名(W0 reason 风 / W1b user_message 风),向后兼容:

    1. W0 风(image_fetcher.py 用):
       ``ImageFetchError(reason='timeout'/'http_error'/'network_error'/'oversize'/'too_many_images',
                          host=..., status=..., total_count=..., failed_count=...,
                          timeout=..., detail=...)``
    2. W1b 风(proxy_service.py 用):
       ``ImageFetchError(user_message=..., technical_detail=...,
                          status=..., error_code='image_fetch_timeout')``

    任一形态都会规范化到内部 attrs:reason / user_message / technical_detail /
    error_code / host / status / total_count / failed_count / timeout / detail。
    """

    def __init__(
        self,
        reason: str = "",
        host: str = "",
        status: Optional[int] = None,
        total_count: int = 1,
        failed_count: int = 1,
        timeout: Optional[float] = None,
        detail: str = "",
        # W1b 别名(proxy_service.py 用)
        user_message: str = "",
        technical_detail: str = "",
        error_code: str = "",
    ):
        # reason 兜底:从 error_code 或字符串关键字反推
        if not reason and error_code:
            if "timeout" in error_code:
                reason = "timeout"
            elif "http" in error_code:
                reason = "http_error"
            elif "oversize" in error_code:
                reason = "oversize"
            elif "too_many" in error_code:
                reason = "too_many_images"
            else:
                reason = "network_error"

        # status default:W1b 风(只传 user_message)期望 502;
        # W0 风(reason 风)默认 None(由 caller 显式传)
        if status is None and not reason and user_message:
            status = 502

        # error_code default:W1b 风默认 image_fetch_failed
        if not error_code:
            if reason:
                error_code = f"image_fetch_{reason}"
            else:
                error_code = "image_fetch_failed"

        self.reason = reason
        self.host = host
        self.status = status
        self.total_count = total_count
        self.failed_count = failed_count
        self.timeout = timeout
        self.detail = detail or technical_detail or f"image fetch {reason} host={host}"
        # W1b 字段别名
        self.user_message = user_message
        self.technical_detail = technical_detail or self.detail
        self.error_code = error_code

        # str(err) 优先 user_message(W1b 期望),否则 detail
        super().__init__(user_message or self.detail)


# ---------------------------------------------------------------------------
# Render API
# ---------------------------------------------------------------------------

def render_error(
    stage: str,
    capability: str,
    reason: str,
    **vars: Any,
) -> Tuple[str, str]:
    """根据 (stage, capability, reason) 渲染中文用户文案。

    匹配顺序：
      1) 精确 (stage, capability, reason)
      2) 通配 (stage, '*', reason)
      3) 兜底英文 detail（不应该走到这里）

    Args:
        stage: 'image_fetch' / 'capability_gate' / 'upstream' / 'billing' /
               'system_routing' / 'auth' / 'request'
        capability: 'image' / 'json_schema' / '*' 等
        reason: 具体错误码（'timeout' / '4xx' / 'budget_exceeded' 等）
        **vars: 占位符变量（model_name / host / status / total_count /
                failed_count / max_count / timeout 等）

    Returns:
        (user_message, technical_detail) 元组
        - user_message: 中文用户文案，给 BillingErrorCard / 系统气泡用
        - technical_detail: 技术详情（含原始 stage/capability/reason + vars），
          给"查看技术详情"折叠面板用
    """
    # too_many_images：failed_count 是超额张数；上限 = total - failed。
    # caller 未显式传 max_count 时在此补齐，避免文案只能写超额、用户误读上限。
    if reason == "too_many_images" and "max_count" not in vars:
        total = vars.get("total_count")
        failed = vars.get("failed_count")
        if (
            isinstance(total, int)
            and isinstance(failed, int)
            and total >= failed >= 0
        ):
            vars = {**vars, "max_count": total - failed}

    # 尝试精确匹配
    template = ERROR_TEMPLATES.get((stage, capability, reason))

    # 通配 capability='*' fallback
    if template is None and capability != "*":
        template = ERROR_TEMPLATES.get((stage, "*", reason))

    if template is not None:
        try:
            user_message = template.format(**_safe_vars(vars))
        except (KeyError, IndexError) as exc:
            logger.warning(
                "[wire_adapter] render_error 占位渲染失败 stage=%s capability=%s "
                "reason=%s err=%s vars=%s",
                stage, capability, reason, exc, list(vars.keys()),
            )
            user_message = template  # 保留原文，不要让用户看到 KeyError
    else:
        # 兜底（理论不应走到，仅防御）
        logger.warning(
            "[wire_adapter] render_error 模板未命中 stage=%s capability=%s reason=%s",
            stage, capability, reason,
        )
        user_message = f"调用失败（{stage}/{capability}/{reason}）。请稍后重试或联系管理员。"

    technical_detail = _format_technical_detail(stage, capability, reason, vars)
    return user_message, technical_detail


def _safe_vars(vars: Dict[str, Any]) -> Dict[str, Any]:
    """模板渲染前，把 None 值替换成可读占位，避免渲染出 'None'。"""
    safe: Dict[str, Any] = {}
    for k, v in vars.items():
        if v is None:
            safe[k] = "未知"
        else:
            safe[k] = v
    # 常见占位的默认值（用户文案里频繁出现的）
    safe.setdefault("total_count", 1)
    safe.setdefault("failed_count", 1)
    safe.setdefault("max_count", "未知")
    safe.setdefault("timeout", 5)
    safe.setdefault("host", "未知")
    safe.setdefault("status", "未知")
    safe.setdefault("model_name", "未知模型")
    return safe


def _format_technical_detail(
    stage: str,
    capability: str,
    reason: str,
    vars: Dict[str, Any],
) -> str:
    """构造技术详情字符串，用于"查看技术详情"折叠。"""
    parts = [f"stage={stage}", f"capability={capability}", f"reason={reason}"]
    for k, v in vars.items():
        if v is None or v == "":
            continue
        parts.append(f"{k}={v}")
    return " | ".join(parts)
