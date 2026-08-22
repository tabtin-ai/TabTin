"""LLM Wire Adapter · Request Adapter(W1b 落地)。

把 LLMProxy 构造好的内部规范化 ``upstream_body`` 重写成上游 wire 格式。

入口 ``adapt_request(body, caps, ctx) -> (adjusted_body, downgrade_events)``,
内部按固定顺序调 ``_normalize_*`` helpers,每个 helper 是 pure function
(read body+caps,return new body,不 mutate input)。

顺序约束(harness 总控 § 15.6 + ):

1. ``_normalize_images``(必须最先 — capability gate 拒绝 short-circuit
   后续 helpers,无谓适配 system/tool 等)
2. ``_normalize_videos``
3. ``_normalize_documents``(：file part → Files API extract → system 注入；
   须在 ``_normalize_system`` 之前完成剥离/注入)
4. ``_normalize_system``(在 tools 之前,因为 tool message 不影响 system 形态)
5. ``_normalize_tool_definitions``(在 tool_choice 之前,把 tools[].function.parameters
   改名为 input_schema)
6. ``_normalize_tool_choice``(依赖 tool_definitions 已经改名)
7. ``_normalize_parallel_tool_calls``(依赖 tool 字段已存在)
8. ``_normalize_cache_control``(在 messages/tools 都已重写后剥离 cache_control)
9. ``_normalize_json_mode``(可能 inject system 提示;若先于 _normalize_system
   会导致 system 还没归位被 mutate 错误)
10. ``_normalize_reasoning_param``(独立字段,放最后)

异常:任何 capability gate 拒绝抛 ``CapabilityGateError``,LLMProxy
``proxy_stream_events`` 捕获后通过 W0 已有 SSE error 路径透传中文文案。

降级事件:某些 helpers(如 _normalize_json_mode)触发兜底降级时(json_schema
→ system prompt hint)往 ``downgrade_events`` 列表 append 一条
``{"event": "capability_downgrade", "feature": ..., "message": ...,
"fallback_to": ...}``,LLMProxy 在 stream 开始前先 yield 给客户端。
"""

from __future__ import annotations

import copy
import json as json_lib
import logging
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

from .error_messages import render_error
from .resolved_capabilities import ResolvedCapabilities

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 异常
# ---------------------------------------------------------------------------

class CapabilityGateError(Exception):
    """capability gate 拒绝,例如把图片发给不支持 vision 的 model。

    LLMProxy ``proxy_stream_events`` 捕获后通过 W0 SSE error 路径透传给
    客户端。携带:
    - ``user_message``:中文用户文案(由 ``error_messages.render_error`` 渲染)
    - ``technical_detail``:技术详情(给"查看技术详情"折叠)
    - ``error_code``:错误代码(``image_not_supported`` / ``json_schema_unsupported``)
    - ``status``:HTTP 状态码(默认 400 — 客户端请求侧问题)
    """

    def __init__(
        self,
        user_message: str,
        technical_detail: str,
        error_code: str,
        status: int = 400,
    ):
        self.user_message = user_message
        self.technical_detail = technical_detail
        self.error_code = error_code
        self.status = status
        super().__init__(technical_detail or user_message)


# ---------------------------------------------------------------------------
# Top-level
# ---------------------------------------------------------------------------

def adapt_request(
    body: Dict[str, Any],
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """把 LLMProxy 构造的 upstream_body 重写成上游 wire 格式。

    Args:
        body: LLMProxy 构造的 ``upstream_body``,已含 ``model`` / ``messages`` /
              可选的 ``tools`` / ``tool_choice`` / ``response_format`` /
              ``thinking`` / ``stream_options`` 等字段。
        caps: ``utils.capabilities.resolve_for_wire(model, provider=...)`` 解析出来的
            ResolvedCapabilities(原 ``model.get_wire_capabilities()`` 包装方法在
            6c6b7a1ae 后已退役)。
        ctx: 可选 ProxyContext(用于日志 request_id / model_name 上下文)。

    Returns:
        (adjusted_body, downgrade_events)
          - adjusted_body:重写后的 body(深拷贝,不 mutate input)
          - downgrade_events:list of ``{"event": "capability_downgrade", ...}``,
            LLMProxy 在 stream 开始前 yield 给客户端

    Raises:
        CapabilityGateError: capability gate 拒绝(用户应换 model / 移除图片)。
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    model_name = getattr(ctx, "model_name", "") if ctx is not None else ""

    logger.debug(
        "[wire_adapter][adapt_request] start request_id=%s model=%s "
        "is_configured=%s",
        request_id, model_name, caps.is_configured,
    )

    # 深拷贝避免 mutate input
    body = copy.deepcopy(body)
    downgrade_events: List[Dict[str, Any]] = []

    body = _normalize_images(body, caps, ctx)
    body = _normalize_videos(body, caps, ctx)
    body = _normalize_documents(body, caps, ctx)
    body = _normalize_system(body, caps, ctx, downgrade_events)
    body = _normalize_tool_definitions(body, caps, ctx, downgrade_events)
    body = _normalize_tool_choice(body, caps, ctx, downgrade_events)
    body = _normalize_parallel_tool_calls(body, caps, ctx)
    body = _normalize_cache_control(body, caps, ctx)
    body = _normalize_json_mode(body, caps, ctx, downgrade_events)
    body = _normalize_reasoning_param(body, caps, ctx, downgrade_events)

    logger.debug(
        "[wire_adapter][adapt_request] done request_id=%s downgrade_events=%d",
        request_id, len(downgrade_events),
    )
    return body, downgrade_events


def _append_capability_downgrade_event(
    downgrade_events: Optional[List[Dict[str, Any]]],
    *,
    ctx: Optional[Any],
    stage: str,
    feature: str,
    fallback_to: str,
    reason: str,
    message: str,
) -> None:
    """记录一次非阻断能力降级事件,由 proxy_service 在流开始前发给前端。"""
    if downgrade_events is None:
        return
    model_name = getattr(ctx, "model_name", "") if ctx is not None else ""
    downgrade_events.append({
        "event": "capability_downgrade",
        "stage": stage,
        "feature": feature,
        "capability": feature,
        "fallback_to": fallback_to,
        "reason": reason,
        "message": message,
        "user_message": message,
        "model_name": model_name,
    })


# ---------------------------------------------------------------------------
# Stub: adapt_stream(W2 真实实装,W1b 占位)
# ---------------------------------------------------------------------------

# 注:adapt_stream 真实定义在 stream_adapter.py,这里仅作为 W1b 验收 grep 的
# 引用点 — adapt_request 与 adapt_stream 同模块声明的 spec 在 W1b 范围里
# 只对 adapt_request 生效。


# ---------------------------------------------------------------------------
# 1. _normalize_images
# ---------------------------------------------------------------------------

def _normalize_images(
    body: Dict[str, Any],
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
) -> Dict[str, Any]:
    """图像 wire-format 适配 + capability gate。

    顺序约束:必须最先(capability gate 拒绝可 short-circuit 后续 helpers)。

    行为由 ``caps.image``（provider 的 ``wire_adapter.image``）驱动：

    - gate：``enabled`` 且 ``input_via`` 非空
    - ``upload_mode=inline_base64`` → 本机不可达 URL → ``data:image/...;base64,...``
      （默认；对齐  / 官方图片示例）
    - ``upload_mode=files_api`` → 本机不可达 URL → Files API → ``url_scheme`` 引用
    - ``upload_mode=none`` → 不主动改写本机 URL
    - 随后：``input_via`` 含 ``url`` 则透传剩余；否则含 ``base64`` 则下载公网 URL

    Raises:
        CapabilityGateError: model 不支持图片输入。
        ImageFetchError(由 image_fetcher 抛):下载失败,LLMProxy 捕获走 SSE 路径。
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    model_name = getattr(ctx, "model_name", "") if ctx is not None else ""
    messages = body.get("messages") or []

    has_image = False
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    has_image = True
                    break
        if has_image:
            break

    if not has_image:
        return body

    if not caps.image.enabled or not caps.image.input_via:
        logger.warning(
            "[wire_adapter][normalize_images] capability gate reject "
            "request_id=%s model=%s image.enabled=%s input_via=%s",
            request_id, model_name, caps.image.enabled, caps.image.input_via,
        )
        user_msg, tech_detail = render_error(
            "capability_gate", "image", "unsupported_via",
            model_name=model_name or "未知模型",
        )
        raise CapabilityGateError(
            user_message=user_msg,
            technical_detail=tech_detail,
            error_code="image_not_supported",
            status=400,
        )

    from .image_fetcher import (
        rewrite_local_oss_images,
        normalize_image_urls,
        DEFAULT_MAX_COUNT_PER_REQUEST,
        DEFAULT_MAX_SIZE_BYTES,
    )

    max_size_bytes = caps.image.max_size_bytes
    if max_size_bytes is None and caps.image.max_size_mb is not None:
        max_size_bytes = caps.image.max_size_mb * 1024 * 1024
    if max_size_bytes is None:
        max_size_bytes = DEFAULT_MAX_SIZE_BYTES

    upload_mode = str(getattr(caps.image, "upload_mode", "inline_base64") or "inline_base64")
    upload_mode = upload_mode.strip().lower()

    if upload_mode == "inline_base64":
        # ：本机 OSS 直读 → data URL（由 caps 开启，不写死 provider）
        local_rewritten = rewrite_local_oss_images(
            messages, max_size_bytes=max_size_bytes,
        )
        if local_rewritten is not messages:
            body["messages"] = local_rewritten
            messages = local_rewritten
    elif upload_mode == "files_api":
        rewritten = _rewrite_images_for_upstream(
            messages,
            image_caps=caps.image,
            ctx=ctx,
            request_id=request_id,
            max_size_bytes=max_size_bytes,
        )
        if rewritten is not messages:
            body["messages"] = rewritten
            messages = rewritten

    if "url" in caps.image.input_via:
        logger.debug(
            "[wire_adapter][normalize_images] passthrough url request_id=%s",
            request_id,
        )
        return body

    if "base64" not in caps.image.input_via:
        # 仅 file_id：upload_mode 已把本机图改成 ms:// 等原生形态则可结束
        if "file_id" in caps.image.input_via:
            logger.debug(
                "[wire_adapter][normalize_images] file_id-only done request_id=%s",
                request_id,
            )
            return body
        logger.warning(
            "[wire_adapter][normalize_images] capability gate: only %s accepted "
            "(url/base64 都不接受)request_id=%s",
            caps.image.input_via, request_id,
        )
        user_msg, tech_detail = render_error(
            "capability_gate", "image", "unsupported_via",
            model_name=model_name or "未知模型",
        )
        raise CapabilityGateError(
            user_message=user_msg,
            technical_detail=tech_detail,
            error_code="image_input_via_unsupported",
            status=400,
        )

    max_count = caps.image.max_count_per_request or DEFAULT_MAX_COUNT_PER_REQUEST

    logger.debug(
        "[wire_adapter][normalize_images] downloading request_id=%s "
        "max_size=%dB max_count=%d",
        request_id, max_size_bytes, max_count,
    )
    body["messages"] = normalize_image_urls(
        messages,
        max_size_bytes=max_size_bytes,
        max_count_per_request=max_count,
    )
    return body


def _is_native_media_url(url: str, media_caps: Any) -> bool:
    u = (url or "").strip()
    if not u:
        return False
    for prefix in tuple(getattr(media_caps, "native_url_prefixes", ()) or ()):
        if prefix and u.startswith(str(prefix)):
            return True
    files_api = getattr(media_caps, "files_api", None)
    scheme = str(getattr(files_api, "url_scheme", "") or "").strip() if files_api else ""
    if scheme and u.startswith(scheme):
        return True
    if u.startswith("data:image/") or u.startswith("data:video/"):
        return True
    return False


def _rewrite_images_for_upstream(
    messages: List[Dict[str, Any]],
    *,
    image_caps: Any,
    ctx: Any,
    request_id: str,
    max_size_bytes: int,
) -> List[Dict[str, Any]]:
    """``upload_mode=files_api``：本机可读图 → Files API → ``url_scheme`` 引用。"""
    from .image_fetcher import (
        _is_trusted_local_oss_url,
        _local_oss_provider_enabled,
        _read_local_oss_to_data_url,
    )
    from .provider_media_upload import (
        to_provider_file_url,
        upload_media_bytes,
        infer_filename_from_url,
    )

    if not _local_oss_provider_enabled():
        return messages

    files_api = getattr(image_caps, "files_api", None)
    if files_api is None:
        raise RuntimeError("image.files_api missing for upload_mode=files_api")

    api_base = getattr(ctx, "api_base", "") or ""
    api_key = getattr(ctx, "api_key", "") or ""
    model_name = getattr(ctx, "model_name", "") or "未知模型"

    changed = False
    out_messages: List[Dict[str, Any]] = []

    for msg in messages:
        content = msg.get("content")
        if not isinstance(content, list):
            out_messages.append(msg)
            continue

        new_parts: List[Any] = []
        part_changed = False
        for part in content:
            if not (isinstance(part, dict) and part.get("type") == "image_url"):
                new_parts.append(part)
                continue

            image_url_obj = part.get("image_url")
            url = ""
            if isinstance(image_url_obj, dict):
                url = image_url_obj.get("url") or ""
            elif isinstance(image_url_obj, str):
                url = image_url_obj

            if not url or _is_native_media_url(url, image_caps):
                new_parts.append(part)
                continue
            if not _is_trusted_local_oss_url(url):
                new_parts.append(part)
                continue

            try:
                import base64 as _b64

                # 复用  直读，再拆 data URL 上传（避免再走 HTTP）
                data_url = _read_local_oss_to_data_url(
                    url, max_size_bytes=max_size_bytes,
                )
                header, _, b64 = data_url.partition(",")
                mime = "image/png"
                if header.startswith("data:") and ";base64" in header:
                    mime = header[5:].split(";", 1)[0] or mime
                content_bytes = _b64.b64decode(b64)
                filename = infer_filename_from_url(url, fallback="image.png")
                file_id = upload_media_bytes(
                    api_base=api_base,
                    api_key=api_key,
                    content=content_bytes,
                    filename=filename,
                    purpose=str(getattr(files_api, "purpose", "file") or "file"),
                    endpoint=str(getattr(files_api, "endpoint", "/files") or "/files"),
                    id_field=str(getattr(files_api, "id_field", "id") or "id"),
                    max_size_bytes=max_size_bytes,
                    timeout_s=float(getattr(files_api, "timeout_s", 180.0) or 180.0),
                    default_mime=mime if mime.startswith("image/") else "image/png",
                    mime_prefix="image/",
                )
                new_url = to_provider_file_url(
                    file_id,
                    str(getattr(files_api, "url_scheme", "ms://") or "ms://"),
                )
            except Exception as exc:
                detail = str(exc)
                reason = "oversize" if "oversize" in detail.lower() else "upload_failed"
                logger.warning(
                    "[wire_adapter][normalize_images] files_api failed "
                    "request_id=%s err=%s",
                    request_id, detail,
                )
                user_msg, tech_detail = render_error(
                    "capability_gate", "image", reason,
                    model_name=model_name,
                )
                raise CapabilityGateError(
                    user_message=user_msg,
                    technical_detail=tech_detail or detail,
                    error_code=f"image_{reason}",
                    status=502 if reason == "upload_failed" else 400,
                ) from exc

            new_part = dict(part)
            if isinstance(image_url_obj, dict):
                new_part["image_url"] = {**image_url_obj, "url": new_url}
            else:
                new_part["image_url"] = {"url": new_url}
            new_parts.append(new_part)
            part_changed = True
            logger.info(
                "[wire_adapter][normalize_images] rewrote image_url upload_mode=files_api "
                "request_id=%s file_id=%s",
                request_id, file_id,
            )

        if part_changed:
            new_msg = dict(msg)
            new_msg["content"] = new_parts
            out_messages.append(new_msg)
            changed = True
        else:
            out_messages.append(msg)

    return out_messages if changed else messages


# ---------------------------------------------------------------------------
# 1b. _normalize_videos
# ---------------------------------------------------------------------------

def _normalize_videos(
    body: Dict[str, Any],
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
) -> Dict[str, Any]:
    """视频 wire-format 适配 + capability gate。

    行为由 ``caps.video``（provider 的 ``wire_adapter.video``）驱动，不写死 provider：

    - gate：``enabled`` 且 ``input_via`` 含 ``url`` / ``file_id`` / ``base64``
    - ``upload_mode=none`` → 透传
    - ``upload_mode=files_api`` → 读字节 → Files API → ``{url_scheme}{id}``
    - ``upload_mode=inline_base64`` → 读字节 → ``data:video/...;base64,...``
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    model_name = getattr(ctx, "model_name", "") if ctx is not None else ""
    messages = body.get("messages") or []

    has_video = False
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "video_url":
                    has_video = True
                    break
        if has_video:
            break

    if not has_video:
        return body

    video_caps = getattr(caps, "video", None)
    enabled = bool(getattr(video_caps, "enabled", False)) if video_caps is not None else False
    input_via = tuple(getattr(video_caps, "input_via", ()) or ()) if video_caps is not None else ()

    accepts_wire = enabled and (
        "url" in input_via or "file_id" in input_via or "base64" in input_via
    )
    if not accepts_wire:
        logger.warning(
            "[wire_adapter][normalize_videos] capability gate reject "
            "request_id=%s model=%s video.enabled=%s input_via=%s",
            request_id, model_name, enabled, input_via,
        )
        user_msg, tech_detail = render_error(
            "capability_gate", "video", "unsupported_via",
            model_name=model_name or "未知模型",
        )
        raise CapabilityGateError(
            user_message=user_msg,
            technical_detail=tech_detail,
            error_code="video_not_supported",
            status=400,
        )

    upload_mode = str(getattr(video_caps, "upload_mode", "none") or "none").strip().lower()
    if upload_mode in ("files_api", "inline_base64"):
        rewritten = _rewrite_videos_for_upstream(
            messages,
            video_caps=video_caps,
            ctx=ctx,
            request_id=request_id,
        )
        if rewritten is not messages:
            body["messages"] = rewritten
        logger.debug(
            "[wire_adapter][normalize_videos] upload_mode=%s rewrite done request_id=%s",
            upload_mode,
            request_id,
        )
        return body

    logger.debug(
        "[wire_adapter][normalize_videos] passthrough url request_id=%s",
        request_id,
    )
    return body


def _extract_video_url(part: Dict[str, Any]) -> Optional[str]:
    raw = part.get("video_url")
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        url = raw.get("url")
        return url if isinstance(url, str) else None
    return None


def _set_video_url(part: Dict[str, Any], url: str) -> None:
    raw = part.get("video_url")
    if isinstance(raw, dict):
        raw["url"] = url
    else:
        part["video_url"] = {"url": url}


def _video_max_size_bytes(video_caps: Any) -> int:
    from .provider_media_upload import DEFAULT_VIDEO_MAX_BYTES

    max_bytes = getattr(video_caps, "max_size_bytes", None)
    if max_bytes is None and getattr(video_caps, "max_size_mb", None) is not None:
        max_bytes = int(video_caps.max_size_mb) * 1024 * 1024
    if max_bytes is None:
        return DEFAULT_VIDEO_MAX_BYTES
    return int(max_bytes)


def _rewrite_videos_for_upstream(
    messages: List[Dict[str, Any]],
    *,
    video_caps: Any,
    ctx: Any,
    request_id: str,
) -> List[Dict[str, Any]]:
    """按 ``VideoCaps.upload_mode`` 把不可达 video_url 改写为上游原生形态。"""
    from .provider_media_upload import (
        to_data_video_url,
        to_provider_file_url,
        upload_media_bytes,
    )
    from .video_media_resolver import VideoResolveError, resolve_video_bytes

    upload_mode = str(getattr(video_caps, "upload_mode", "none") or "none").strip().lower()
    files_api = getattr(video_caps, "files_api", None)
    max_size = _video_max_size_bytes(video_caps)
    api_base = getattr(ctx, "api_base", "") or ""
    api_key = getattr(ctx, "api_key", "") or ""
    model_name = getattr(ctx, "model_name", "") or "未知模型"

    changed = False
    out_messages: List[Dict[str, Any]] = []

    for msg in messages:
        content = msg.get("content")
        if not isinstance(content, list):
            out_messages.append(msg)
            continue

        new_parts: List[Any] = []
        part_changed = False
        for part in content:
            if not (isinstance(part, dict) and part.get("type") == "video_url"):
                new_parts.append(part)
                continue

            url = _extract_video_url(part)
            if not url:
                new_parts.append(part)
                continue
            if _is_native_media_url(url, video_caps):
                new_parts.append(part)
                continue

            try:
                video = resolve_video_bytes(url, max_size_bytes=max_size)
                if upload_mode == "inline_base64":
                    new_url = to_data_video_url(video.content, video.mime_type)
                    rewritten_id = "inline_base64"
                else:
                    if files_api is None:
                        raise RuntimeError("video.files_api missing for upload_mode=files_api")
                    file_id = upload_media_bytes(
                        api_base=api_base,
                        api_key=api_key,
                        content=video.content,
                        filename=video.filename,
                        purpose=str(getattr(files_api, "purpose", "video") or "video"),
                        endpoint=str(getattr(files_api, "endpoint", "/files") or "/files"),
                        id_field=str(getattr(files_api, "id_field", "id") or "id"),
                        max_size_bytes=max_size,
                        timeout_s=float(getattr(files_api, "timeout_s", 180.0) or 180.0),
                        default_mime="video/mp4",
                        mime_prefix="video/",
                    )
                    new_url = to_provider_file_url(
                        file_id,
                        str(getattr(files_api, "url_scheme", "ms://") or "ms://"),
                    )
                    rewritten_id = file_id
            except VideoResolveError as exc:
                # ：保留 resolver 语义（oversize / unsupported_url / unreadable…），
                # 避免一律打成 unreadable「本地视频」误导用户。
                if exc.reason == "oversize":
                    reason = "oversize"
                elif exc.reason in ("unsupported_url", "forbidden_url", "invalid_url"):
                    reason = "unsupported_url"
                else:
                    reason = "unreadable"
                logger.warning(
                    "[wire_adapter][normalize_videos] resolve failed "
                    "request_id=%s reason=%s detail=%s",
                    request_id, exc.reason, exc.detail,
                )
                user_msg, tech_detail = render_error(
                    "capability_gate", "video", reason,
                    model_name=model_name,
                )
                raise CapabilityGateError(
                    user_message=user_msg,
                    technical_detail=tech_detail or exc.detail,
                    error_code=f"video_{reason}",
                    status=400,
                ) from exc
            except Exception as exc:
                detail = str(exc)
                reason = "oversize" if "oversize" in detail.lower() else "upload_failed"
                logger.warning(
                    "[wire_adapter][normalize_videos] upload_mode=%s failed "
                    "request_id=%s err=%s",
                    upload_mode, request_id, detail,
                )
                user_msg, tech_detail = render_error(
                    "capability_gate", "video", reason,
                    model_name=model_name,
                )
                raise CapabilityGateError(
                    user_message=user_msg,
                    technical_detail=tech_detail or detail,
                    error_code=f"video_{reason}",
                    status=502 if reason == "upload_failed" else 400,
                ) from exc

            new_part = dict(part)
            _set_video_url(new_part, new_url)
            new_parts.append(new_part)
            part_changed = True
            logger.info(
                "[wire_adapter][normalize_videos] rewrote video_url upload_mode=%s "
                "request_id=%s ref=%s",
                upload_mode, request_id, rewritten_id,
            )

        if part_changed:
            new_msg = dict(msg)
            new_msg["content"] = new_parts
            out_messages.append(new_msg)
            changed = True
        else:
            out_messages.append(msg)

    return out_messages if changed else messages


# ---------------------------------------------------------------------------
# 1c. _normalize_documents
# ---------------------------------------------------------------------------

def _normalize_documents(
    body: Dict[str, Any],
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
) -> Dict[str, Any]:
    """文档 ``type:file`` + ``file_url`` wire 适配（ 方案1）。

    行为由 ``caps.document``（``wire_adapter.document``）驱动：

    - gate：存在 file part 且 ``document.enabled=False`` → 拒绝
    - ``upload_mode=none`` → 透传（仅上游原生支持 file part 时有意义）
    - ``upload_mode=file_extract`` → 读字节 → Files API extract → 注入
      ``inject_role``（默认 system）文本消息，并剥离原 file part
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    model_name = getattr(ctx, "model_name", "") if ctx is not None else ""
    messages = body.get("messages") or []

    file_parts = _collect_file_parts(messages)
    if not file_parts:
        return body

    max_documents = getattr(caps.limits, "max_documents_per_request", None)
    if max_documents and len(file_parts) > max_documents:
        raise CapabilityGateError(
            user_message=(
                f"当前模型单次最多上传 {max_documents} 个文档，"
                f"本次共上传 {len(file_parts)} 个。请减少文档后重试。"
            ),
            technical_detail=(
                f"document_count={len(file_parts)} exceeds "
                f"limits.max_documents_per_request={max_documents}"
            ),
            error_code="too_many_documents",
            status=400,
        )

    document_caps = getattr(caps, "document", None)
    enabled = bool(getattr(document_caps, "enabled", False)) if document_caps is not None else False
    if not enabled:
        logger.warning(
            "[wire_adapter][normalize_documents] capability gate reject "
            "request_id=%s model=%s document.enabled=%s",
            request_id, model_name, enabled,
        )
        user_msg, tech_detail = render_error(
            "capability_gate", "document", "unsupported_via",
            model_name=model_name or "未知模型",
        )
        raise CapabilityGateError(
            user_message=user_msg,
            technical_detail=tech_detail,
            error_code="document_not_supported",
            status=400,
        )

    upload_mode = str(
        getattr(document_caps, "upload_mode", "none") or "none"
    ).strip().lower()
    if upload_mode != "file_extract":
        logger.debug(
            "[wire_adapter][normalize_documents] passthrough upload_mode=%s "
            "request_id=%s file_parts=%d",
            upload_mode, request_id, len(file_parts),
        )
        return body

    rewritten = _rewrite_documents_file_extract(
        messages,
        document_caps=document_caps,
        ctx=ctx,
        request_id=request_id,
    )
    body["messages"] = rewritten
    logger.debug(
        "[wire_adapter][normalize_documents] file_extract done request_id=%s "
        "file_parts=%d",
        request_id, len(file_parts),
    )
    return body


def _collect_file_parts(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    found: List[Dict[str, Any]] = []
    for msg in messages:
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if isinstance(part, dict) and part.get("type") == "file":
                found.append(part)
    return found


def _extract_file_url(part: Dict[str, Any]) -> Optional[str]:
    raw = part.get("file_url")
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        url = raw.get("url")
        return url if isinstance(url, str) else None
    return None


def _document_max_size_bytes(document_caps: Any) -> int:
    from .provider_media_upload import DEFAULT_DOCUMENT_MAX_BYTES

    max_bytes = getattr(document_caps, "max_size_bytes", None)
    if max_bytes is None and getattr(document_caps, "max_size_mb", None) is not None:
        max_bytes = int(document_caps.max_size_mb) * 1024 * 1024
    if max_bytes is None:
        return DEFAULT_DOCUMENT_MAX_BYTES
    return int(max_bytes)


def _rewrite_documents_file_extract(
    messages: List[Dict[str, Any]],
    *,
    document_caps: Any,
    ctx: Any,
    request_id: str,
) -> List[Dict[str, Any]]:
    """file part → Moonshot-style extract 文本 system 消息。"""
    from .document_media_resolver import DocumentResolveError, resolve_document_bytes
    from .provider_media_upload import extract_document_text_via_files_api

    files_api = getattr(document_caps, "files_api", None)
    if files_api is None:
        raise RuntimeError("document.files_api missing for upload_mode=file_extract")

    max_size = _document_max_size_bytes(document_caps)
    max_chars = getattr(document_caps, "max_extract_chars", 200_000)
    use_cache = bool(getattr(document_caps, "cache_extracted_text", True))
    inject_role = str(getattr(document_caps, "inject_role", "system") or "system").strip() or "system"
    api_base = getattr(ctx, "api_base", "") or ""
    api_key = getattr(ctx, "api_key", "") or ""
    model_name = getattr(ctx, "model_name", "") or "未知模型"

    # URL → 提取文本（同请求内去重）
    extract_by_url: Dict[str, str] = {}
    extract_order: List[str] = []

    for msg in messages:
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not (isinstance(part, dict) and part.get("type") == "file"):
                continue
            url = _extract_file_url(part)
            if not url or url in extract_by_url:
                continue
            filename_hint = (
                part.get("file_name")
                if isinstance(part.get("file_name"), str)
                else "document.bin"
            )
            resolved_filename = filename_hint or "document.bin"
            try:
                doc = resolve_document_bytes(
                    url,
                    max_size_bytes=max_size,
                    fallback_filename=resolved_filename,
                )
                resolved_filename = doc.filename
                text = extract_document_text_via_files_api(
                    api_base=api_base,
                    api_key=api_key,
                    content=doc.content,
                    filename=doc.filename,
                    purpose=str(getattr(files_api, "purpose", "file-extract") or "file-extract"),
                    endpoint=str(getattr(files_api, "endpoint", "/files") or "/files"),
                    id_field=str(getattr(files_api, "id_field", "id") or "id"),
                    max_size_bytes=max_size,
                    timeout_s=float(getattr(files_api, "timeout_s", 180.0) or 180.0),
                    max_extract_chars=int(max_chars) if max_chars is not None else None,
                    use_cache=use_cache,
                    cleanup_remote=True,
                )
            except DocumentResolveError as exc:
                reason = "oversize" if exc.reason == "oversize" else "unreadable"
                logger.warning(
                    "[wire_adapter][normalize_documents] resolve failed "
                    "request_id=%s reason=%s detail=%s",
                    request_id, exc.reason, exc.detail,
                )
                user_msg, tech_detail = render_error(
                    "capability_gate", "document", reason,
                    model_name=model_name,
                )
                raise CapabilityGateError(
                    user_message=user_msg,
                    technical_detail=tech_detail or exc.detail,
                    error_code=f"document_{reason}",
                    status=400,
                ) from exc
            except Exception as exc:
                detail = str(exc)
                reason = "oversize" if "oversize" in detail.lower() else "upload_failed"
                logger.warning(
                    "[wire_adapter][normalize_documents] extract failed "
                    "request_id=%s err=%s",
                    request_id, detail,
                )
                user_msg, tech_detail = render_error(
                    "capability_gate", "document", reason,
                    model_name=model_name,
                )
                raise CapabilityGateError(
                    user_message=user_msg,
                    technical_detail=tech_detail or detail,
                    error_code=f"document_{reason}",
                    status=502 if reason == "upload_failed" else 400,
                ) from exc

            extract_by_url[url] = text
            extract_order.append(url)
            logger.info(
                "[wire_adapter][normalize_documents] extracted file request_id=%s "
                "filename=%s chars=%d",
                request_id, resolved_filename, len(text),
            )

    # 剥离所有 file part
    stripped: List[Dict[str, Any]] = []
    for msg in messages:
        content = msg.get("content")
        if not isinstance(content, list):
            stripped.append(msg)
            continue
        new_parts = [
            part for part in content
            if not (isinstance(part, dict) and part.get("type") == "file")
        ]
        if new_parts == content:
            stripped.append(msg)
            continue
        new_msg = dict(msg)
        if not new_parts:
            # 仅附件、无正文：Moonshot/Kimi 拒空 user（"" 与 [] 都会 400），占位非空文案
            new_msg["content"] = "查看这个文件"
        elif len(new_parts) == 1 and isinstance(new_parts[0], dict) and new_parts[0].get("type") == "text":
            # 单 text part 可压成字符串，减少 wire 噪音
            text_val = new_parts[0].get("text")
            new_msg["content"] = text_val if isinstance(text_val, str) else new_parts
        else:
            new_msg["content"] = new_parts
        stripped.append(new_msg)

    if not extract_order:
        return stripped

    inject_msgs = [
        {"role": inject_role, "content": extract_by_url[url]}
        for url in extract_order
    ]
    # Moonshot 官方：file system messages 放在 messages 列表头部
    return inject_msgs + stripped


# ---------------------------------------------------------------------------
# 2. _normalize_system
# ---------------------------------------------------------------------------

def _normalize_system(
    body: Dict[str, Any],
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
    downgrade_events: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """system message 形态归一。

    requires_before: _normalize_images / _normalize_documents
    requires_after:  _normalize_tool_*

    行为(根据 caps.wire.system_message_style / system_placement):

    - ``messages_first_role_system`` (默认 OpenAI 风) → 透传 messages[0].role=system
    - ``top_level_system_field`` (Anthropic 风) → 把 messages[0] role=system
      移到 top-level ``system`` 字段;若 body 已有 ``system`` 字段则跳过(避免覆盖)
    - ``minimax_user_system_role`` → W2 范围,W1b 不实装(透传 + warn)
    - ``unsupported`` → 删除 system message(model 不接受 system)

    SystemQuirks:
    - ``qwq_strip_to_user`` (Qwen QwQ) → drop system + 把内容拼到首条 user
    - ``qvq_drop`` (Qwen QVQ) → 直接 drop system

    幂等:已是目标 wire 形态时不重复转。

    字符串值规范化(W1b-fix Block C1 + Block M2 / 单源真理):

    本 helper 是 wire.system_message_style 字符串的"权威识别器"。识别清单
    在本函数实现内,只接受上述 4 个值;其他值默认走透传分支。

    历史问题(已修复):
    - 0016 migration MiniMax 误用 ``"anthropic_top_level"`` → 不被识别
      → MiniMax system 永远不被 hoist,Anthropic SDK 路径(D7 W2 启用)失效。
    - 已由 0018 migration 把 ``"anthropic_top_level"`` 规范化为
      ``"top_level_system_field"`` (单源真理:不在 helper 加 alias,
      而是修 migration 字符串值)。
    - 0017 ``_sync_field_pairs`` 同步 ``system_placement`` 到新字段值时,
      若新字段是错串,旧字段也被对齐到错串 → 已由 0018 一并规范化。

    新增 provider/migration 时,wire.system_message_style 必须从这 4 值选,
    不允许自创字符串(否则会静默走透传分支,system 不被适配)。
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    model_name = getattr(ctx, "model_name", "") if ctx is not None else ""
    style = caps.wire.system_message_style or caps.wire.system_placement
    quirks = set(caps.wire.system_quirks or ())

    messages = body.get("messages") or []
    if not messages:
        return body
    has_system_message = any(m.get("role") == "system" for m in messages)

    # === SystemQuirks 优先处理 ===
    if "qwq_strip_to_user" in quirks:
        body["messages"] = _strip_system_to_user_prefix(messages)
        if has_system_message:
            _append_capability_downgrade_event(
                downgrade_events,
                ctx=ctx,
                stage="system",
                feature="system",
                fallback_to="user_message_prefix",
                reason="system_prompt_rewritten_to_user_prefix",
                message=(
                    f"当前模型 \"{model_name or '未知模型'}\" 不支持独立 system prompt，"
                    "本轮已自动改写为普通提示；如需完整能力请换模型。"
                ),
            )
        logger.debug(
            "[wire_adapter][normalize_system] qwq_strip_to_user applied "
            "request_id=%s",
            request_id,
        )
        return body
    if "qvq_drop" in quirks:
        body["messages"] = [m for m in messages if m.get("role") != "system"]
        if has_system_message:
            _append_capability_downgrade_event(
                downgrade_events,
                ctx=ctx,
                stage="system",
                feature="system",
                fallback_to="omit_system_prompt",
                reason="system_prompt_unsupported_dropped_by_quirk",
                message=(
                    f"当前模型 \"{model_name or '未知模型'}\" 不支持 system prompt，"
                    "本轮已自动忽略；如需完整能力请换模型。"
                ),
            )
        logger.debug(
            "[wire_adapter][normalize_system] qvq_drop applied request_id=%s",
            request_id,
        )
        return body

    # === 主分支:system_message_style ===
    if style == "top_level_system_field":
        # 已有 top-level system 且 messages 没有 role=system → 幂等,透传
        # 否则:把首条 role=system 抽出来挂到 top-level system
        sys_messages: List[str] = []
        rest_messages: List[Dict[str, Any]] = []
        for msg in messages:
            if msg.get("role") == "system":
                content = msg.get("content")
                if isinstance(content, str):
                    sys_messages.append(content)
                elif isinstance(content, list):
                    # Anthropic 风 system 也支持 list of {type:text,text:...}
                    parts = []
                    for part in content:
                        if isinstance(part, dict) and part.get("type") == "text":
                            parts.append(part.get("text", ""))
                        elif isinstance(part, str):
                            parts.append(part)
                    sys_messages.append("\n".join(p for p in parts if p))
            else:
                rest_messages.append(msg)
        if sys_messages:
            existing_top = body.get("system")
            combined = "\n\n".join(s for s in sys_messages if s)
            if existing_top:
                # body 已有 top-level system → 不覆盖(幂等)
                logger.debug(
                    "[wire_adapter][normalize_system] top-level system already set; "
                    "merging messages role=system into it request_id=%s",
                    request_id,
                )
                if isinstance(existing_top, str):
                    body["system"] = existing_top + "\n\n" + combined
                else:
                    body["system"] = combined
            else:
                body["system"] = combined
            body["messages"] = rest_messages
            logger.debug(
                "[wire_adapter][normalize_system] hoisted %d system msgs to "
                "top-level request_id=%s",
                len(sys_messages), request_id,
            )
        return body

    if style == "unsupported":
        body["messages"] = [m for m in messages if m.get("role") != "system"]
        if has_system_message:
            _append_capability_downgrade_event(
                downgrade_events,
                ctx=ctx,
                stage="system",
                feature="system",
                fallback_to="omit_system_prompt",
                reason="system_prompt_unsupported_dropped",
                message=(
                    f"当前模型 \"{model_name or '未知模型'}\" 不支持 system prompt，"
                    "本轮已自动忽略；如需完整能力请换模型。"
                ),
            )
        logger.debug(
            "[wire_adapter][normalize_system] system unsupported, dropped "
            "request_id=%s",
            request_id,
        )
        return body

    if style == "minimax_user_system_role":
        # W2 范围,W1b 透传 + 单次 warn(避免每请求都 warn)
        logger.debug(
            "[wire_adapter][normalize_system] minimax_user_system_role passthrough "
            "(W2 范围) request_id=%s",
            request_id,
        )
        return body

    # 默认 messages_first_role_system → 透传
    return body


def _strip_system_to_user_prefix(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把所有 role=system 内容拼到首条 role=user 前缀(Qwen QwQ 用)。"""
    sys_texts: List[str] = []
    rest: List[Dict[str, Any]] = []
    for msg in messages:
        if msg.get("role") == "system":
            content = msg.get("content")
            if isinstance(content, str):
                sys_texts.append(content)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        sys_texts.append(part.get("text", ""))
        else:
            rest.append(msg)
    if not sys_texts:
        return rest
    sys_prefix = "\n".join(t for t in sys_texts if t)
    new_messages = [dict(m) for m in rest]
    for msg in new_messages:
        if msg.get("role") == "user":
            content = msg.get("content")
            if isinstance(content, str):
                msg["content"] = sys_prefix + "\n\n" + content
            elif isinstance(content, list):
                msg["content"] = [
                    {"type": "text", "text": sys_prefix},
                    *content,
                ]
            else:
                msg["content"] = sys_prefix
            break
    else:
        # 没有 user 消息 → 单独造一条放最前
        new_messages.insert(0, {"role": "user", "content": sys_prefix})
    return new_messages


# ---------------------------------------------------------------------------
# 3. _normalize_tool_definitions
# ---------------------------------------------------------------------------

def _normalize_tool_definitions(
    body: Dict[str, Any],
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
    downgrade_events: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """tool 字段名归一(parameters ↔ input_schema)。

    requires_before: _normalize_system
    requires_after:  _normalize_tool_choice / _normalize_parallel_tool_calls

    行为:

    - body 无 ``tools`` 字段 → 透传
    - caps.tool.enabled=False → drop tools(model 不支持 function calling)
    - caps.tool.param_field=``"input_schema"`` (Anthropic / MiniMax 风) →
      把 ``tools[].function.parameters`` 升一级到 ``tools[].input_schema``,
      同时把 OpenAI 风 ``{type:'function', function:{name,description,parameters}}``
      解构成 Anthropic 风 ``{name, description, input_schema}``
    - caps.tool.param_field=``"parameters"`` (默认 OpenAI 风) → 透传
    - caps.tool.max_tools 超限 → logger.warning 但不阻断(由上游决定是否 reject)
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    model_name = getattr(ctx, "model_name", "") if ctx is not None else ""
    tools = body.get("tools")
    if not tools:
        return body

    if not caps.tool.enabled:
        logger.warning(
            "[wire_adapter][normalize_tool_definitions] tool unsupported, "
            "dropping %d tools request_id=%s",
            len(tools), request_id,
        )
        body.pop("tools", None)
        body.pop("tool_choice", None)
        _append_capability_downgrade_event(
            downgrade_events,
            ctx=ctx,
            stage="tool",
            feature="tool",
            fallback_to="omit_tools",
            reason="tool_unsupported_dropped",
            message=(
                f"当前模型 \"{model_name or '未知模型'}\" 不支持工具调用，"
                "本轮已自动移除 tools/tool_choice；如需完整能力请换模型。"
            ),
        )
        return body

    if caps.tool.max_tools and len(tools) > caps.tool.max_tools:
        logger.warning(
            "[wire_adapter][normalize_tool_definitions] tools count %d exceeds "
            "caps.max_tools %d request_id=%s",
            len(tools), caps.tool.max_tools, request_id,
        )

    if caps.tool.param_field == "input_schema":
        new_tools = []
        for tool in tools:
            if not isinstance(tool, dict):
                new_tools.append(tool)
                continue
            # OpenAI 风 {type:function, function:{name,description,parameters}}
            #   → Anthropic 风 {name, description, input_schema}
            if tool.get("type") == "function" and isinstance(tool.get("function"), dict):
                fn = tool["function"]
                new_tool = {
                    "name": fn.get("name"),
                    "description": fn.get("description", ""),
                    "input_schema": fn.get("parameters", {}),
                }
                new_tools.append(new_tool)
            elif "input_schema" in tool:
                # 已经是 Anthropic 风 → 幂等
                new_tools.append(tool)
            elif "parameters" in tool:
                # tool 已扁平 + 用 parameters → 改名 input_schema
                new_tool = {
                    "name": tool.get("name"),
                    "description": tool.get("description", ""),
                    "input_schema": tool.get("parameters", {}),
                }
                new_tools.append(new_tool)
            else:
                new_tools.append(tool)
        body["tools"] = new_tools
        logger.debug(
            "[wire_adapter][normalize_tool_definitions] converted %d tools to "
            "input_schema request_id=%s",
            len(new_tools), request_id,
        )
    return body


# ---------------------------------------------------------------------------
# 4. _normalize_tool_choice
# ---------------------------------------------------------------------------

def _normalize_tool_choice(
    body: Dict[str, Any],
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
    downgrade_events: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """tool_choice 词汇表归一。

    requires_before: _normalize_tool_definitions
    requires_after:  _normalize_parallel_tool_calls

    行为:

    - body 无 ``tool_choice`` → 透传
    - caps.tool.enabled=False → 已在 _normalize_tool_definitions 删除
    - tool_choice="required" 但 caps 不支持 → 若 caps 含 ``"any"`` (Anthropic 风)
      改为 ``{"type":"any"}``
    - tool_choice="auto"/"none" 都支持 → 透传(主流都接受)
    - tool_choice 是 dict(specific tool):若 caps 有 ``specific`` 模式 → 透传;
      否则降级为 ``"auto"`` + warn

    幂等:已是目标 wire 形态时不重复转。
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    model_name = getattr(ctx, "model_name", "") if ctx is not None else ""
    choice = body.get("tool_choice")
    if choice is None:
        return body

    modes = set(caps.tool.choice_modes or ())

    # 字符串 tool_choice
    if isinstance(choice, str):
        if choice == "required":
            if "required" in modes:
                return body
            if "any" in modes:
                body["tool_choice"] = {"type": "any"}
                logger.debug(
                    "[wire_adapter][normalize_tool_choice] required → {type:any} "
                    "request_id=%s",
                    request_id,
                )
                return body
            # 都不支持 → 降级 auto + warn
            logger.warning(
                "[wire_adapter][normalize_tool_choice] required not supported "
                "(modes=%s), downgrading to auto request_id=%s",
                modes, request_id,
            )
            body["tool_choice"] = "auto" if "auto" in modes else None
            if body["tool_choice"] is None:
                body.pop("tool_choice", None)
            _append_capability_downgrade_event(
                downgrade_events,
                ctx=ctx,
                stage="tool_choice",
                feature="tool",
                fallback_to="auto_tool_choice" if "auto" in modes else "omit_tool_choice",
                reason="required_tool_choice_unsupported",
                message=(
                    f"当前模型 \"{model_name or '未知模型'}\" 不支持强制工具调用，"
                    "本轮已自动放宽工具调用方式；如需完整能力请换模型。"
                ),
            )
            return body
        if choice in ("auto", "none", "any"):
            if choice in modes:
                return body
            # 不支持的字面量 → 降级
            if choice == "any" and "required" in modes:
                body["tool_choice"] = "required"
                return body
            logger.warning(
                "[wire_adapter][normalize_tool_choice] %s not supported "
                "(modes=%s) request_id=%s",
                choice, modes, request_id,
            )
            return body
        # 未识别字面量 → 透传(让上游决定)
        return body

    # dict tool_choice(specific tool 选择)
    if isinstance(choice, dict):
        choice_type = choice.get("type", "")
        if choice_type == "function":
            # OpenAI 风 {"type":"function","function":{"name":"..."}}
            if "specific" in modes:
                return body
            # 不支持 specific → 降级 auto
            logger.warning(
                "[wire_adapter][normalize_tool_choice] specific tool choice not "
                "supported (modes=%s), downgrading to auto request_id=%s",
                modes, request_id,
            )
            body["tool_choice"] = "auto" if "auto" in modes else None
            if body["tool_choice"] is None:
                body.pop("tool_choice", None)
            _append_capability_downgrade_event(
                downgrade_events,
                ctx=ctx,
                stage="tool_choice",
                feature="tool",
                fallback_to="auto_tool_choice" if "auto" in modes else "omit_tool_choice",
                reason="specific_tool_choice_unsupported",
                message=(
                    f"当前模型 \"{model_name or '未知模型'}\" 不支持指定某个工具调用，"
                    "本轮已自动放宽为模型自行选择工具；如需完整能力请换模型。"
                ),
            )
            return body
        if choice_type in ("any", "auto", "none"):
            # Anthropic 风 dict 词汇表
            if choice_type in modes:
                return body
            return body  # 透传让上游决定
        if choice_type == "tool":
            # Anthropic 风 specific:{type:'tool',name:'...'}
            if "specific" in modes:
                return body
            logger.warning(
                "[wire_adapter][normalize_tool_choice] anthropic 'tool' specific "
                "not supported request_id=%s",
                request_id,
            )
            body["tool_choice"] = "auto" if "auto" in modes else None
            if body["tool_choice"] is None:
                body.pop("tool_choice", None)
            _append_capability_downgrade_event(
                downgrade_events,
                ctx=ctx,
                stage="tool_choice",
                feature="tool",
                fallback_to="auto_tool_choice" if "auto" in modes else "omit_tool_choice",
                reason="specific_tool_choice_unsupported",
                message=(
                    f"当前模型 \"{model_name or '未知模型'}\" 不支持指定某个工具调用，"
                    "本轮已自动放宽为模型自行选择工具；如需完整能力请换模型。"
                ),
            )
            return body

    return body


# ---------------------------------------------------------------------------
# 5. _normalize_parallel_tool_calls
# ---------------------------------------------------------------------------

def _normalize_parallel_tool_calls(
    body: Dict[str, Any],
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
) -> Dict[str, Any]:
    """并行工具默认值 / 反向参数注入。

    requires_before: _normalize_tool_definitions / _normalize_tool_choice
    requires_after:  _normalize_cache_control

    行为:

    - body 无 ``tools`` → 透传(无并行可言)
    - caps.tool.parallel_default=False(Qwen 等)且用户没显式设
      ``parallel_tool_calls`` → 注入 ``parallel_tool_calls=False``
      (Qwen DashScope 必需)
    - caps.tool.parallel_param_inverted=True(Anthropic 风
      ``disable_parallel_tool_use``)→ 反向重写:
      * 用户传 ``parallel_tool_calls=False`` → 重写为 ``disable_parallel_tool_use=True``
      * 用户传 ``parallel_tool_calls=True`` → 重写为 ``disable_parallel_tool_use=False``
      * 用户未传 → 用 caps.parallel_default 的反向值注入

    幂等:已是 ``parallel_param_name`` 字段时不重复转。
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    if not body.get("tools"):
        return body

    param_name = caps.tool.parallel_param_name or "parallel_tool_calls"
    inverted = caps.tool.parallel_param_inverted

    user_explicit_value = body.get("parallel_tool_calls")  # OpenAI 风
    if param_name != "parallel_tool_calls":
        # 用户已用上游真名(disable_parallel_tool_use)→ 幂等
        if param_name in body:
            return body

    # 计算最终值(以 OpenAI 风 parallel=True/False 为内部规范)
    if user_explicit_value is None:
        # 未设 → 用默认
        parallel_value = bool(caps.tool.parallel_default)
    else:
        parallel_value = bool(user_explicit_value)

    if inverted:
        # Anthropic 风:disable_parallel_tool_use = not parallel
        body.pop("parallel_tool_calls", None)
        body[param_name] = not parallel_value
        logger.debug(
            "[wire_adapter][inject_parallel_tool_calls] inverted set %s=%s "
            "request_id=%s",
            param_name, body[param_name], request_id,
        )
    else:
        # OpenAI 风 / Qwen 风:parallel_tool_calls = parallel
        if user_explicit_value is None:
            body[param_name] = parallel_value
            logger.debug(
                "[wire_adapter][inject_parallel_tool_calls] set %s=%s (default) "
                "request_id=%s",
                param_name, parallel_value, request_id,
            )

    return body


# ---------------------------------------------------------------------------
# 6. _normalize_cache_control
# ---------------------------------------------------------------------------

def _normalize_cache_control(
    body: Dict[str, Any],
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
) -> Dict[str, Any]:
    """cache_control 字段过滤。

    requires_before: _normalize_parallel_tool_calls(已经稳定 tools 列表)
    requires_after:  _normalize_json_mode

    行为:

    - caps.caching.cache_control_strip=True (OpenAI / 兼容端不支持显式
      cache_control) → 删除 messages/tools/system 内所有 ``cache_control``
      字段(防 OpenAI 严格端 reject)
    - caps.caching.mode=``"explicit_cache_control"`` (Claude / Anthropic) →
      保留(透传给上游)
    - 其他模式 (automatic_implicit / context_cache / none) → 默认保留
      (cache_control 是 metadata,不影响主流 model 主流程)

    幂等:cache_control 不存在时无操作。
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    if not caps.caching.cache_control_strip:
        return body

    stripped_count = 0

    # messages 内的 cache_control(可能在 message 顶层 / content list 内 part 顶层)
    messages = body.get("messages") or []
    new_messages = []
    for msg in messages:
        new_msg = dict(msg)
        if "cache_control" in new_msg:
            new_msg.pop("cache_control", None)
            stripped_count += 1
        content = new_msg.get("content")
        if isinstance(content, list):
            new_content = []
            for part in content:
                if isinstance(part, dict) and "cache_control" in part:
                    new_part = dict(part)
                    new_part.pop("cache_control", None)
                    new_content.append(new_part)
                    stripped_count += 1
                else:
                    new_content.append(part)
            new_msg["content"] = new_content
        new_messages.append(new_msg)
    body["messages"] = new_messages

    # tools 内的 cache_control
    tools = body.get("tools")
    if isinstance(tools, list):
        new_tools = []
        for tool in tools:
            if isinstance(tool, dict) and "cache_control" in tool:
                new_tool = dict(tool)
                new_tool.pop("cache_control", None)
                new_tools.append(new_tool)
                stripped_count += 1
            else:
                new_tools.append(tool)
        body["tools"] = new_tools

    # system 顶层 list 内的 cache_control(Anthropic 风 system list)
    system = body.get("system")
    if isinstance(system, list):
        new_system = []
        for part in system:
            if isinstance(part, dict) and "cache_control" in part:
                new_part = dict(part)
                new_part.pop("cache_control", None)
                new_system.append(new_part)
                stripped_count += 1
            else:
                new_system.append(part)
        body["system"] = new_system

    if stripped_count > 0:
        logger.debug(
            "[wire_adapter][filter_cache_control] stripped %d cache_control fields "
            "request_id=%s",
            stripped_count, request_id,
        )
    return body


# ---------------------------------------------------------------------------
# 7. _normalize_json_mode
# ---------------------------------------------------------------------------

def _normalize_json_mode(
    body: Dict[str, Any],
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
    downgrade_events: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """JSON mode / response_format / output_config 归一 + 降级。

    requires_before: _normalize_cache_control
    requires_after:  _normalize_reasoning_param

    行为:

    - body 无 ``response_format`` → 透传
    - caps.json_mode.modes 含用户请求的 type → 透传(可能 schema_field 改名)
    - 用户传 ``response_format={"type":"json_schema",...}`` 但 caps.json_mode.modes
      不含 schema → 触发 schema_fallback:
      * caps.json_mode.schema_fallback=True → 删除 response_format,把 schema 拼进
        system prompt 头部("请输出符合以下 JSON Schema..."),emit
        ``capability_downgrade`` event
      * schema_fallback=False → 保留 response_format(让上游决定是否 reject)+ warn
    - caps.json_mode.schema_field=``"output_config.json_schema.schema"``
      (Anthropic 风) → 把 ``response_format`` 改名为 ``output_config``
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    model_name = getattr(ctx, "model_name", "") if ctx is not None else ""
    if downgrade_events is None:
        downgrade_events = []

    response_format = body.get("response_format")
    if response_format is None:
        return body

    rf_type = ""
    if isinstance(response_format, dict):
        rf_type = response_format.get("type", "")

    modes = set(caps.json_mode.modes or ())

    # 用户请求 json_schema 但 caps 不支持
    if rf_type == "json_schema" and "json_schema" not in modes:
        if caps.json_mode.schema_fallback:
            schema_payload: Any = None
            if isinstance(response_format, dict):
                js = response_format.get("json_schema")
                if isinstance(js, dict):
                    schema_payload = js.get("schema") or js
            schema_text = ""
            if schema_payload is not None:
                try:
                    schema_text = json_lib.dumps(
                        schema_payload, ensure_ascii=False, indent=2,
                    )
                except (TypeError, ValueError):
                    schema_text = str(schema_payload)
            hint = (
                "请输出符合以下 JSON Schema 的内容,不要添加额外说明:\n"
                f"{schema_text}"
            )
            body = _inject_system_prefix(body, hint, caps)
            body.pop("response_format", None)

            user_msg, _ = render_error(
                "capability_gate", "json_schema", "unsupported",
                model_name=model_name or "未知模型",
            )
            downgrade_events.append({
                "event": "capability_downgrade",
                "stage": "json_mode",
                "feature": "json_schema",
                "capability": "json_schema",
                "fallback_to": "system_prompt_hint",
                "reason": "schema_unsupported_fallback_to_prompt_hint",
                "message": user_msg,
                "user_message": user_msg,
                "model_name": model_name,
            })
            logger.warning(
                "[wire_adapter][normalize_json_mode] json_schema fallback to "
                "system prompt request_id=%s model=%s",
                request_id, model_name,
            )
            return body
        # 不允许 fallback → warn 透传(上游可能 reject)
        logger.warning(
            "[wire_adapter][normalize_json_mode] json_schema not supported "
            "(modes=%s) and schema_fallback=False, passing through "
            "request_id=%s",
            modes, request_id,
        )
        return body

    # rf_type=json_object 但 caps 不支持 json_object → 降级 text(保 system prompt 提示)
    if rf_type == "json_object" and "json_object" not in modes:
        body.pop("response_format", None)
        body = _inject_system_prefix(body, "请以严格 JSON 格式输出。", caps)
        user_msg, _ = render_error(
            "capability_gate", "json_object", "unsupported",
            model_name=model_name or "未知模型",
        )
        downgrade_events.append({
            "event": "capability_downgrade",
            "stage": "json_mode",
            "feature": "json_object",
            "capability": "json_object",
            "fallback_to": "system_prompt_hint",
            "reason": "json_object_unsupported_fallback_to_prompt_hint",
            "message": user_msg,
            "user_message": user_msg,
            "model_name": model_name,
        })
        logger.warning(
            "[wire_adapter][normalize_json_mode] json_object fallback to prompt "
            "request_id=%s",
            request_id,
        )
        return body

    # caps.json_mode.schema_field 改名(OpenAI response_format → Anthropic output_config)
    schema_field = caps.json_mode.schema_field or ""
    if schema_field.startswith("output_config"):
        # 把 response_format 整体改名 output_config
        body["output_config"] = body.pop("response_format")
        logger.debug(
            "[wire_adapter][normalize_json_mode] response_format → output_config "
            "request_id=%s",
            request_id,
        )

    return body


def _inject_system_prefix(
    body: Dict[str, Any],
    hint: str,
    caps: Optional[ResolvedCapabilities] = None,
) -> Dict[str, Any]:
    """把 hint 文字插入 system 提示词头部。

    若当前模型不支持 system prompt,改为拼到首条 user 前缀,避免 JSON fallback
    在 _normalize_system 之后重新注入不被上游接受的 system message。
    """
    if not hint:
        return body

    style = ""
    quirks = set()
    if caps is not None:
        style = caps.wire.system_message_style or caps.wire.system_placement or ""
        quirks = set(caps.wire.system_quirks or ())

    if style == "unsupported" or "qvq_drop" in quirks or "qwq_strip_to_user" in quirks:
        return _inject_user_prefix(body, hint)

    top_system = body.get("system")
    if top_system is not None:
        if isinstance(top_system, str):
            body["system"] = hint + "\n\n" + top_system
        elif isinstance(top_system, list):
            body["system"] = [{"type": "text", "text": hint}, *top_system]
        else:
            body["system"] = hint
        return body

    if style == "top_level_system_field":
        body["system"] = hint
        return body

    messages = list(body.get("messages") or [])
    # 如果 messages[0] 是 system,prepend 内容;否则插入新 system
    if messages and messages[0].get("role") == "system":
        first = dict(messages[0])
        existing = first.get("content")
        if isinstance(existing, str):
            first["content"] = hint + "\n\n" + existing
        elif isinstance(existing, list):
            first["content"] = [{"type": "text", "text": hint}, *existing]
        else:
            first["content"] = hint
        messages[0] = first
    else:
        messages.insert(0, {"role": "system", "content": hint})
    body["messages"] = messages
    return body


def _inject_user_prefix(
    body: Dict[str, Any],
    hint: str,
) -> Dict[str, Any]:
    """把 capability hint 拼到首条 user,用于不支持 system 的模型。"""
    messages = list(body.get("messages") or [])
    new_messages = [dict(m) for m in messages]
    for msg in new_messages:
        if msg.get("role") == "user":
            content = msg.get("content")
            if isinstance(content, str):
                msg["content"] = hint + "\n\n" + content
            elif isinstance(content, list):
                msg["content"] = [{"type": "text", "text": hint}, *content]
            else:
                msg["content"] = hint
            body["messages"] = new_messages
            return body

    new_messages.insert(0, {"role": "user", "content": hint})
    body["messages"] = new_messages
    return body


# ---------------------------------------------------------------------------
# 8. _normalize_reasoning_param
# ---------------------------------------------------------------------------

# canonical「关闭思考」的等价写法。canonical 值域是 off;none/disabled 作为
# 上游/历史写法的兼容别名一并识别。
_REASONING_OFF_TOKENS: FrozenSet[str] = frozenset({"off", "none", "disabled"})

# canonical effort 档位 → Claude 风 thinking.budget_tokens 默认表。
# per-model 覆盖走 capabilities_config.wire_adapter.reasoning.budget_map。
# 注:max=32768 是相对保守的取值,各 Anthropic 型号上限不同且受 max_tokens
# 约束;发现不合适时改 budget_map 配置,不要改这里的默认值。
_DEFAULT_THINKING_BUDGET_MAP: Dict[str, int] = {
    "low": 1024,
    "medium": 4096,
    "high": 16384,
    "max": 32768,
}


def _resolve_thinking_budget_map(caps: ResolvedCapabilities) -> Dict[str, int]:
    """取当前模型生效的 effort → budget_tokens 映射表。

    优先 ``caps.reasoning.budget_map``(per-model 覆盖),否则用默认表。
    覆盖表里非法项(非 int / 不可转 int)逐项丢弃;全部非法则回退默认表。
    """
    override = getattr(caps.reasoning, "budget_map", None)
    if isinstance(override, dict) and override:
        cleaned: Dict[str, int] = {}
        for level, value in override.items():
            if isinstance(value, bool):
                # bool 是 int 子类,但 budget 语义上不接受 True/False。
                continue
            try:
                cleaned[str(level).lower()] = int(value)
            except (TypeError, ValueError):
                continue
        cleaned = {
            level: budget
            for level, budget in cleaned.items()
            if budget > 0 and level not in _REASONING_OFF_TOKENS
        }
        if cleaned:
            return cleaned
    return dict(_DEFAULT_THINKING_BUDGET_MAP)


_DOUBAO_EFFORT_LEVELS: FrozenSet[str] = frozenset({"low", "medium", "high"})


def _normalize_doubao_thinking_and_effort(
    body: Dict[str, Any],
    *,
    ctx: Optional[Any],
    downgrade_events: Optional[List[Dict[str, Any]]],
    has_reasoning_effort: bool,
    has_thinking: bool,
    request_id: str,
    model_name: str,
) -> Dict[str, Any]:
    """Doubao：canonical ``reasoning_effort`` → ``thinking`` + ``reasoning_effort``。

    - ``off``/``none``/``disabled``/``minimal`` → ``thinking.type=disabled``，删除 effort
    - ``low``/``medium``/``high`` → ``thinking.type=enabled`` + 同档 effort
    - 已有 ``thinking`` 且无 effort（如 tool_choice 强制关思考）→ 幂等透传
    - 不写入 performance / thinking_mode
    """
    if has_reasoning_effort:
        effort_raw = body.pop("reasoning_effort", None)
        effort_norm = (
            str(effort_raw).strip().lower() if effort_raw is not None else ""
        )

        if effort_norm in _REASONING_OFF_TOKENS or effort_norm == "minimal":
            body["thinking"] = {"type": "disabled"}
            body.pop("reasoning_effort", None)
            logger.debug(
                "[wire_adapter][normalize_reasoning_param] doubao "
                "reasoning_effort=%s → thinking.disabled (no effort) request_id=%s",
                effort_raw, request_id,
            )
            return body

        mapped = effort_norm
        if mapped not in _DOUBAO_EFFORT_LEVELS:
            # 官方 Seed 2.x / evolving 强度档仅为 low|medium|high；
            # max/xhigh 等非本批型号档位 → 就近 high，并显式降级。
            if mapped in ("max", "xhigh"):
                mapped = "high"
                fallback = "reasoning_effort_high"
            else:
                mapped = "medium"
                fallback = "reasoning_effort_medium"
            logger.warning(
                "[wire_adapter][normalize_reasoning_param] doubao unknown "
                "reasoning_effort=%r model=%s → %s request_id=%s",
                effort_raw, model_name or "?", mapped, request_id,
            )
            _append_capability_downgrade_event(
                downgrade_events,
                ctx=ctx,
                stage="reasoning",
                feature="reasoning",
                fallback_to=fallback,
                reason="unknown_reasoning_effort_level",
                message=(
                    f"当前模型 \"{model_name or '未知模型'}\" 不支持思考强度 "
                    f"\"{effort_raw}\"，本轮已按 {mapped} 执行。"
                ),
            )

        # 已有 thinking 对象时只校正 type，保留其它键（幂等 / 不破坏附加字段）
        existing = body.get("thinking")
        if isinstance(existing, dict):
            thinking = dict(existing)
            thinking["type"] = "enabled"
        else:
            thinking = {"type": "enabled"}
        body["thinking"] = thinking
        body["reasoning_effort"] = mapped
        logger.debug(
            "[wire_adapter][normalize_reasoning_param] doubao "
            "thinking.enabled + reasoning_effort=%s request_id=%s",
            mapped, request_id,
        )
        return body

    # 无 canonical effort：例如 tool_choice 互斥路径已写入 thinking.disabled
    if has_thinking:
        return body
    return body


def _normalize_reasoning_param(
    body: Dict[str, Any],
    caps: ResolvedCapabilities,
    ctx: Optional[Any] = None,
    downgrade_events: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """reasoning 参数路径归一。

    requires_before: _normalize_json_mode
    requires_after:  (none — pipeline 末端)

    行为:

    - body 无 ``reasoning_effort`` / ``thinking`` / ``extra_body.google.thinking_config``
      → 透传
    - caps.reasoning.format=``"hidden"`` (OpenAI o1) → drop 用户传的 reasoning 相关
      参数(o1 系不接受显式开关)
    - caps.reasoning.param_path=``"thinking"`` (Claude / Kimi K2.x) → 把
      ``reasoning_effort`` 改名为 ``thinking={"type":"enabled","budget_tokens":...}``；
      档位表见 ``_DEFAULT_THINKING_BUDGET_MAP``(可被 ``reasoning.budget_map`` 覆盖)。
      ``off``/``none``/``disabled`` → ``thinking={"type":"disabled"}``；
      未登记档位 → 落最低档 + capability_downgrade 事件(不静默取中档)
    - caps.reasoning.param_path=``"enable_thinking"`` (Qwen DashScope) → 删除
      ``reasoning_effort``，写顶层布尔 ``enable_thinking``；``off``→False，
      其余→True；有 ``budget_param`` 声明时按档位补 thinking budget
    - caps.reasoning.param_path=``"thinking+reasoning_effort"`` (Doubao / 方舟) →
      ``off``→``thinking={"type":"disabled"}`` 且**不**发 ``reasoning_effort``；
      开启→``thinking={"type":"enabled"}`` + 透传 ``low|medium|high``（不把 medium
      抬成 high，也不把 off 误写成 max）
    - caps.reasoning.param_path=``"reasoning_effort"`` (Kimi K3 等) → 透传
      ``reasoning_effort``（档位 low|high|max；medium→high），并剥离 ``thinking``
    - caps.reasoning.param_path 以 ``"extra_body."`` 开头(Gemini) → 解析 nested
      dict path,把 ``reasoning_effort`` 移到 body 内对应位置(W1b-fix Block C2 实装):
      * ``"extra_body.google.thinking_config"`` → 写入
        ``body["extra_body"]["google"]["thinking_config"]={"thinking_level":<effort>,"include_thoughts":True}``
        (Gemini 3.x 风,直接对应 reasoning_effort 三档)
      * 删除顶层 ``reasoning_effort``(Gemini docs 明示与 thinking_level 互斥)
      * 用户已有 ``extra_body`` → 不覆盖,merge nested(幂等)
    - caps.reasoning.enabled=False 但用户传了 reasoning 参数 → drop + warn

    幂等:已是目标字段名时不重复转。
    """
    request_id = getattr(ctx, "request_id", "?") if ctx is not None else "?"
    model_name = getattr(ctx, "model_name", "") if ctx is not None else ""

    has_reasoning_effort = "reasoning_effort" in body
    has_thinking = "thinking" in body
    if not has_reasoning_effort and not has_thinking:
        return body

    if not caps.reasoning.enabled:
        # model 不支持 reasoning,但用户传了 → drop + warn
        if has_reasoning_effort:
            body.pop("reasoning_effort", None)
        if has_thinking:
            body.pop("thinking", None)
        logger.warning(
            "[wire_adapter][normalize_reasoning_param] reasoning unsupported, "
            "dropping user params request_id=%s",
            request_id,
        )
        _append_capability_downgrade_event(
            downgrade_events,
            ctx=ctx,
            stage="reasoning",
            feature="reasoning",
            fallback_to="omit_reasoning_param",
            reason="reasoning_unsupported_dropped",
            message=(
                f"当前模型 \"{model_name or '未知模型'}\" 不支持 reasoning/thinking 参数，"
                "本轮已自动忽略；如需完整能力请换模型。"
            ),
        )
        return body

    fmt = (caps.reasoning.format or caps.reasoning.surface or "").lower()
    param_path = caps.reasoning.param_path or ""

    if fmt == "hidden":
        # Hidden 描述的是响应不暴露 reasoning 内容。新一代 Chat Completions
        # 模型仍可能通过顶层 reasoning_effort 接受显式强度；只有未声明该
        # 请求路径的旧 o1 类模型才摘除。
        if param_path == "reasoning_effort":
            if has_thinking:
                body.pop("thinking", None)
            return body
        if has_reasoning_effort:
            body.pop("reasoning_effort", None)
            logger.debug(
                "[wire_adapter][normalize_reasoning_param] hidden reasoning "
                "drops reasoning_effort request_id=%s",
                request_id,
            )
        if has_thinking:
            body.pop("thinking", None)
        _append_capability_downgrade_event(
            downgrade_events,
            ctx=ctx,
            stage="reasoning",
            feature="reasoning",
            fallback_to="omit_reasoning_param",
            reason="hidden_reasoning_param_dropped",
            message=(
                f"当前模型 \"{model_name or '未知模型'}\" 不支持显式 reasoning/thinking 参数，"
                "本轮已自动忽略；如需完整能力请换模型。"
            ),
        )
        return body

    if param_path == "thinking":
        # Claude:reasoning_effort → thinking={"type":"enabled","budget_tokens":N}
        # Kimi K2.x 二进制：Proxy 写 canonical ``on`` → thinking={"type":"enabled"}
        # （无 budget_tokens / keep；与 Claude 梯子路径分离）
        if has_reasoning_effort and not has_thinking:
            effort = body.pop("reasoning_effort")
            effort_norm = str(effort).lower() if effort is not None else ""

            if effort_norm in _REASONING_OFF_TOKENS:
                # 显式关闭。Claude / Kimi 支持 type=disabled;省略字段不等于关闭
                # (kimi-k2.6 服务端默认开启,见 proxy-provider applyThinkingConfig 注释)。
                body["thinking"] = {"type": "disabled"}
                logger.debug(
                    "[wire_adapter][normalize_reasoning_param] reasoning_effort=%s "
                    "→ thinking disabled request_id=%s",
                    effort, request_id,
                )
                return body

            # 二进制开启哨兵（runtime_profile.EFFORT_ON）：Moonshot K2.x
            if effort_norm == "on":
                body["thinking"] = {"type": "enabled"}
                logger.debug(
                    "[wire_adapter][normalize_reasoning_param] reasoning_effort=on "
                    "→ thinking.enabled (no budget) request_id=%s",
                    request_id,
                )
                return body

            budget_map = _resolve_thinking_budget_map(caps)
            budget = budget_map.get(effort_norm)
            if budget is None:
                # 不猜:未登记档位说明上游传了非 canonical 值(如 OpenAI 私有 xhigh)。
                # 旧实现静默取 4096(= medium),会让「选最高」反而弱于「高」。
                # 改为落到最低可用档 + 显式降级事件,让问题可见而非被吸收。
                fallback_level = min(budget_map, key=lambda level: budget_map[level])
                budget = budget_map[fallback_level]
                logger.warning(
                    "[wire_adapter][normalize_reasoning_param] unknown reasoning_effort=%r "
                    "for param_path=thinking model=%s, downgrading to %s(budget=%d) "
                    "request_id=%s",
                    effort, model_name or "?", fallback_level, budget, request_id,
                )
                _append_capability_downgrade_event(
                    downgrade_events,
                    ctx=ctx,
                    stage="reasoning",
                    feature="reasoning",
                    fallback_to=f"thinking_budget_{fallback_level}",
                    reason="unknown_reasoning_effort_level",
                    message=(
                        f"当前模型 \"{model_name or '未知模型'}\" 不支持思考强度 "
                        f"\"{effort}\"，本轮已按最低档执行。"
                    ),
                )
            body["thinking"] = {"type": "enabled", "budget_tokens": budget}
            logger.debug(
                "[wire_adapter][normalize_reasoning_param] reasoning_effort=%s "
                "→ thinking budget=%d request_id=%s",
                effort, budget, request_id,
            )
        # 已有 thinking 字段 → 透传(幂等)
        return body

    if param_path == "enable_thinking":
        # Qwen DashScope(qwen3 / qwen-plus 混合思考模型):请求侧是顶层布尔,
        # 既不认 OpenAI 的 ``reasoning_effort``,也不认 Anthropic 的 ``thinking``。
        # 该 param_path 早在 capability_enums 里登记,但一直没有实现分支,
        # reasoning_effort 会被原样透传给上游。
        #
        # 显式写 True/False 而非"关闭时省略字段":DashScope 的 enable_thinking
        # 缺省值随型号而变(qwen3 商业版默认 True、开源版默认 False),
        # 省略字段无法表达"用户明确要求关闭"。
        effort_raw = body.pop("reasoning_effort", None)
        if has_thinking:
            body.pop("thinking", None)
            _append_capability_downgrade_event(
                downgrade_events,
                ctx=ctx,
                stage="reasoning",
                feature="reasoning",
                fallback_to="omit_thinking_param",
                reason="thinking_param_unsupported_for_enable_thinking_adapter",
                message=(
                    f"当前模型 \"{model_name or '未知模型'}\" 使用 enable_thinking 开关，"
                    "不支持 thinking 参数，本轮已自动忽略 thinking。"
                ),
            )
        if "enable_thinking" in body:
            # 上游已显式指定 → 幂等,不覆盖
            return body
        if effort_raw is None:
            return body

        effort_norm = str(effort_raw).lower()
        if effort_norm in _REASONING_OFF_TOKENS:
            body["enable_thinking"] = False
            logger.debug(
                "[wire_adapter][normalize_reasoning_param] reasoning_effort=%s "
                "→ enable_thinking=False request_id=%s",
                effort_raw, request_id,
            )
            return body

        body["enable_thinking"] = True
        budget_param = caps.reasoning.budget_param
        if budget_param and budget_param not in body:
            # 该模型声明了 budget 字段(Qwen: thinking_budget)→ 按档位补 token 预算。
            budget = _resolve_thinking_budget_map(caps).get(effort_norm)
            if budget is not None:
                body[budget_param] = budget
            else:
                # 档位未登记:thinking 仍按用户意图开启(主意图未丢),
                # 只是放弃精细预算、沿用上游默认,故记日志不发降级事件。
                logger.warning(
                    "[wire_adapter][normalize_reasoning_param] unknown reasoning_effort=%r "
                    "for param_path=enable_thinking model=%s, keeping upstream default "
                    "%s request_id=%s",
                    effort_raw, model_name or "?", budget_param, request_id,
                )
        logger.debug(
            "[wire_adapter][normalize_reasoning_param] reasoning_effort=%s "
            "→ enable_thinking=True %s=%s request_id=%s",
            effort_raw, budget_param or "-",
            body.get(budget_param) if budget_param else "-", request_id,
        )
        return body

    if param_path == "thinking+reasoning_effort":
        # Doubao / 火山方舟：官方双参数
        # - thinking.type = enabled | disabled（开关）
        # - reasoning_effort = low | medium | high（强度；关思考时不得附带）
        # Runtime Profile 仍只写 canonical reasoning_effort；本分支负责展开。
        return _normalize_doubao_thinking_and_effort(
            body,
            ctx=ctx,
            downgrade_events=downgrade_events,
            has_reasoning_effort=has_reasoning_effort,
            has_thinking=has_thinking,
            request_id=request_id,
            model_name=model_name,
        )

    if param_path == "reasoning_effort":
        # Kimi K3 / OpenAI 风格：顶层 reasoning_effort 透传；剥离 Anthropic/K2 的 thinking。
        # K3 档位为 low|high|max（默认 max）；OpenAI 风 medium → high。
        if has_thinking:
            body.pop("thinking", None)
            _append_capability_downgrade_event(
                downgrade_events,
                ctx=ctx,
                stage="reasoning",
                feature="reasoning",
                fallback_to="omit_thinking_param",
                reason="thinking_param_unsupported_for_reasoning_effort_adapter",
                message=(
                    f"当前模型 \"{model_name or '未知模型'}\" 使用 reasoning_effort，"
                    "不支持 thinking 参数，本轮已自动忽略 thinking。"
                ),
            )
        if has_reasoning_effort:
            effort_raw = body.get("reasoning_effort")
            effort_norm = str(effort_raw).lower() if effort_raw is not None else "max"
            if effort_norm == "medium":
                effort_norm = "high"
            elif effort_norm not in ("low", "high", "max"):
                effort_norm = "max"
            body["reasoning_effort"] = effort_norm
            logger.debug(
                "[wire_adapter][normalize_reasoning_param] keep reasoning_effort=%s "
                "request_id=%s",
                effort_norm, request_id,
            )
        return body

    if param_path and param_path.startswith("extra_body."):
        # Gemini 类:把 reasoning_effort 解析到 nested extra_body path。
        # 文档(https://ai.google.dev/gemini-api/docs/openai)明示
        # ``reasoning_effort`` 与 ``thinking_level/thinking_budget`` 互斥,
        # 必须把 reasoning_effort 移走,不能并存。
        if has_reasoning_effort:
            effort = body.pop("reasoning_effort")
            effort_norm = str(effort).lower() if effort is not None else "medium"
            if effort_norm not in ("low", "medium", "high"):
                effort_norm = "medium"
            # 解析 param_path = "extra_body.google.thinking_config"
            # → ["extra_body", "google", "thinking_config"]
            path_parts = param_path.split(".")
            if path_parts[0] != "extra_body" or len(path_parts) < 2:
                logger.warning(
                    "[wire_adapter][normalize_reasoning_param] malformed extra_body "
                    "param_path=%s, dropping reasoning_effort request_id=%s",
                    param_path, request_id,
                )
                return body

            # 走到 body["extra_body"]["google"]... 末级 dict,设置 thinking 字段
            cursor: Dict[str, Any] = body.setdefault("extra_body", {})
            if not isinstance(cursor, dict):
                logger.warning(
                    "[wire_adapter][normalize_reasoning_param] extra_body is not "
                    "dict, skipping merge request_id=%s",
                    request_id,
                )
                return body
            for part in path_parts[1:-1]:
                nxt = cursor.get(part)
                if not isinstance(nxt, dict):
                    nxt = {}
                    cursor[part] = nxt
                cursor = nxt
            leaf_key = path_parts[-1]
            leaf = cursor.get(leaf_key)
            if not isinstance(leaf, dict):
                leaf = {}
                cursor[leaf_key] = leaf
            # 用户已显式配过的字段不覆盖(幂等):
            # - thinking_level 已存在 → 不动
            # - 否则按 reasoning_effort 三档映射 thinking_level(Gemini 3.x 风)
            if "thinking_level" not in leaf and "thinking_budget" not in leaf:
                leaf["thinking_level"] = effort_norm
            if "include_thoughts" not in leaf:
                leaf["include_thoughts"] = True
            logger.debug(
                "[wire_adapter][normalize_reasoning_param] reasoning_effort=%s "
                "→ %s.thinking_level=%s request_id=%s",
                effort, param_path, leaf.get("thinking_level"), request_id,
            )
        if has_thinking:
            # Gemini 不识别 Anthropic-style ``thinking`` 字段,drop 避免上游 reject
            body.pop("thinking", None)
            _append_capability_downgrade_event(
                downgrade_events,
                ctx=ctx,
                stage="reasoning",
                feature="reasoning",
                fallback_to="omit_thinking_param",
                reason="thinking_param_unsupported_for_reasoning_adapter",
                message=(
                    f"当前模型 \"{model_name or '未知模型'}\" 不支持当前 thinking 参数格式，"
                    "本轮已自动忽略该参数；如需完整能力请换模型。"
                ),
            )
        return body

    if param_path is None or param_path == "":
        # Moonshot/Qwen:reasoning_content 是响应侧 delta 字段,请求侧无显式开关
        # → drop reasoning_effort / thinking(避免污染上游)
        if has_reasoning_effort:
            body.pop("reasoning_effort", None)
        if has_thinking:
            body.pop("thinking", None)
        _append_capability_downgrade_event(
            downgrade_events,
            ctx=ctx,
            stage="reasoning",
            feature="reasoning",
            fallback_to="omit_reasoning_param",
            reason="reasoning_request_param_not_supported_dropped",
            message=(
                f"当前模型 \"{model_name or '未知模型'}\" 不支持显式 reasoning/thinking 参数，"
                "本轮已自动忽略；如需完整能力请换模型。"
            ),
        )
        return body

    # 未登记的 param_path(capability_enums 白名单外,或新增枚举值还没接线):
    # 旧实现原样透传,等于把 canonical 值直接发给不认识它的上游 —— 要么 400,
    # 要么静默忽略(用户以为调了强度其实没调)。这里改为 drop + 显式降级,
    # 让"适配器缺一条分支"这件事在前端和日志里都可见。
    if has_reasoning_effort:
        body.pop("reasoning_effort", None)
    if has_thinking:
        body.pop("thinking", None)
    logger.warning(
        "[wire_adapter][normalize_reasoning_param] unhandled param_path=%r model=%s, "
        "dropped reasoning params request_id=%s",
        param_path, model_name or "?", request_id,
    )
    _append_capability_downgrade_event(
        downgrade_events,
        ctx=ctx,
        stage="reasoning",
        feature="reasoning",
        fallback_to="omit_reasoning_param",
        reason="unhandled_reasoning_param_path",
        message=(
            f"当前模型 \"{model_name or '未知模型'}\" 的思考参数尚未接入，"
            "本轮已按不开启思考执行。"
        ),
    )
    return body


__all__ = [
    "adapt_request",
    "CapabilityGateError",
    "_normalize_images",
    "_normalize_system",
    "_normalize_tool_definitions",
    "_normalize_tool_choice",
    "_normalize_parallel_tool_calls",
    "_normalize_cache_control",
    "_normalize_json_mode",
    "_normalize_reasoning_param",
]
