"""
消息预处理管道。

消息变换管道设计：在调用 LLM API 之前，
通过一组可组合的步骤统一处理消息格式，避免各 Service 子类重复实现。

管道步骤：
  1. inject_images    — 将外部图片列表注入到第一条 user 消息
  2. degrade_unsupported_parts — 模型不支持的模态自动降级为文本提示
  3. normalize_image_urls     — 统一 base64 前缀 / MIME 推断
"""

from __future__ import annotations

import logging
from copy import deepcopy
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _detect_base64_mime(b64_data: str) -> str:
    """从 base64 数据头几字节推断图片 MIME 类型。"""
    import base64 as _b64

    try:
        raw = _b64.b64decode(b64_data[:32], validate=False)
    except Exception:
        return "image/jpeg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw[:3] == b"GIF":
        return "image/gif"
    return "image/jpeg"


class MessageTransformPipeline:
    """消息预处理管道，在调用 LLM API 之前统一处理消息格式。"""

    def __init__(
        self,
        *,
        model_obj: Any = None,
        provider_name: str = "",
        model_name: str = "",
        supports_vision: bool = False,
    ):
        self.model = model_obj
        self.provider_name = provider_name
        self.model_name = model_name
        self._supports_vision = supports_vision

    # ── public API ──

    def transform(
        self,
        messages: List[Dict[str, Any]],
        images: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """
        管道入口：依次执行各处理步骤。

        Args:
            messages: 标准消息列表
            images:   可选的外部图片列表（URL / base64）

        Returns:
            处理后的消息列表（新列表，不修改原始数据）
        """
        msgs = deepcopy(messages)

        if images:
            msgs = self._inject_images(msgs, list(images))

        msgs = self._degrade_unsupported_parts(msgs)
        msgs = self._normalize_image_urls(msgs)

        return msgs

    # ── step 1: 图片注入 ──

    @staticmethod
    def _inject_images(
        messages: List[Dict[str, Any]],
        images: List[str],
    ) -> List[Dict[str, Any]]:
        """将图片列表注入到第一条 user 消息的 content 中。

        与之前 OpenAI/Qwen 各自的 ``_prepare_vision_messages`` 逻辑一致，
        但集中到一处实现。
        """
        if not images:
            return messages

        result: List[Dict[str, Any]] = []
        remaining_images = list(images)

        for msg in messages:
            if msg.get("role") == "user" and remaining_images:
                content_raw = msg.get("content", "")
                if isinstance(content_raw, str):
                    parts: List[Dict[str, Any]] = [
                        {"type": "text", "text": content_raw}
                    ]
                elif isinstance(content_raw, list):
                    parts = list(content_raw)
                else:
                    parts = [{"type": "text", "text": str(content_raw)}]

                for image in remaining_images:
                    if image.startswith(("http://", "https://", "data:")):
                        parts.append({
                            "type": "image_url",
                            "image_url": {"url": image},
                        })
                    else:
                        mime = _detect_base64_mime(image)
                        parts.append({
                            "type": "image_url",
                            "image_url": {"url": f"data:{mime};base64,{image}"},
                        })

                result.append({**msg, "content": parts})
                remaining_images = []
            else:
                result.append(msg)

        if remaining_images:
            logger.warning(
                "[MessageTransform] _inject_images: 消息列表中无 user 角色消息，"
                "%d 张图片无法注入，已丢弃。"
                "常见于 MultiAgent 纯 assistant 续写场景",
                len(remaining_images),
            )

        return result

    # ── step 2: 不支持模态优雅降级 ──

    def _degrade_unsupported_parts(
        self,
        messages: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """如果模型不支持 vision，将 image_url 部分替换为文本提示。

        对 unsupportedParts 的处理：不报错、不丢弃，
        而是给 LLM 一段说明性文本让它告知用户。
        """
        if self._supports_vision:
            return messages

        degraded = False
        result: List[Dict[str, Any]] = []

        for msg in messages:
            content = msg.get("content")
            if not isinstance(content, list):
                result.append(msg)
                continue

            new_parts: List[Dict[str, Any]] = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    new_parts.append({
                        "type": "text",
                        "text": "[该模型不支持图片输入，已自动跳过此图片]",
                    })
                    degraded = True
                else:
                    new_parts.append(part)

            result.append({**msg, "content": new_parts})

        if degraded:
            logger.info(
                "[MessageTransform] 模型 %s 不支持 vision，"
                "已将图片降级为文本提示",
                self.model_name,
            )

        return result

    # ── step 3: 图片 URL 规范化 ──

    @staticmethod
    def _normalize_image_urls(
        messages: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """统一 base64 图片的 data URI 前缀和 MIME 类型。

        - 已有 ``data:`` 或 ``http(s)://`` 前缀的保持不变
        - 裸 base64 字符串自动推断 MIME 并添加前缀
        - 检测并拒绝 ``blob:`` URL（前端本地引用，LLM 无法访问）
        """
        result: List[Dict[str, Any]] = []

        for msg in messages:
            content = msg.get("content")
            if not isinstance(content, list):
                result.append(msg)
                continue

            new_parts: List[Dict[str, Any]] = []
            for part in content:
                if not isinstance(part, dict) or part.get("type") != "image_url":
                    new_parts.append(part)
                    continue

                image_url_obj = part.get("image_url", {})
                url = image_url_obj.get("url", "") if isinstance(image_url_obj, dict) else ""

                if url.startswith("blob:"):
                    new_parts.append({
                        "type": "text",
                        "text": "[图片尚未上传完成，无法发送给模型]",
                    })
                    logger.warning(
                        "[MessageTransform] 检测到 blob: URL，已替换为提示文本"
                    )
                    continue

                if url.startswith(("http://", "https://", "data:")):
                    new_parts.append(part)
                    continue

                mime = _detect_base64_mime(url)
                new_parts.append({
                    "type": "image_url",
                    "image_url": {
                        **image_url_obj,
                        "url": f"data:{mime};base64,{url}",
                    },
                })

            result.append({**msg, "content": new_parts})

        return result
