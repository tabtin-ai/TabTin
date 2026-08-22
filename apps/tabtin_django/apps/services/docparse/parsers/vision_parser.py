"""
Vision 模型封装 (v0.2)

通过 LLM Service（ZenMux）调用 VLM 模型，将文档页面图片解析为结构化 chunks。
v0.2 改进：
- prompt 要求返回归一化 bbox [x0, y0, x1, y1]（0-1000 坐标系），前端按页面实际尺寸缩放
- 图片压缩：限制最大边长 + JPEG 有损压缩，减少 token 消耗
- 重试机制：API 失败自动重试，JSON 解析失败可尝试备用模型
"""

from __future__ import annotations

import base64
import concurrent.futures
import io
import json
import logging
import re
import time
import uuid as _uuid_mod

from .base import ChunkResult

logger = logging.getLogger(__name__)

MAX_IMAGE_EDGE = 1600
JPEG_QUALITY = 85
MAX_RETRIES = 2
RETRY_DELAY = 2.0
# SVC-11: 单次 VLM API 调用的独立超时（秒），防止 LLM 服务挂起时无限阻塞
_VLM_CALL_TIMEOUT = 120

# 注：原 EXTRACT_PROMPT 字面量已迁移到 prompt bundle
#   apps/services/llm/scenes/bundled/vision_parse_document/{SCENE.md, user.md, output_schema.json}
# vision_parse(scene_key='vision_parse_document', ...) 入口会自动加载并渲染。
# 业务文件不再持有 prompt 副本（宪法 §A.2 / §5 Prompt 资源化）。


class VisionParser:
    """VLM 模型解析封装 — 通过 vision_service.parse 单入口调用"""

    def __init__(
        self,
        model: str = "",
        user_id: str = "",
        organization_id: str = "",
        selected_model_id: _uuid_mod.UUID | str | None = None,
    ):
        from apps.services.docparse.model_selection import normalize_selected_model_id

        # model 是 legacy feature/config label；绝不能用它反查 LLMModel。
        self.user_id = user_id
        self.organization_id = organization_id
        self.selected_model_id = normalize_selected_model_id(selected_model_id)

    def parse_image_bytes(
        self,
        image_bytes: bytes,
        page_number: int = 1,
        page_width: float = 0,
        page_height: float = 0,
    ) -> list[ChunkResult]:
        compressed = _compress_image(image_bytes)
        b64 = base64.b64encode(compressed).decode()
        return self._call_with_retry(
            b64, page_number, page_width, page_height,
        )

    def _call_with_retry(
        self,
        image_b64: str,
        page_number: int,
        page_width: float,
        page_height: float,
    ) -> list[ChunkResult]:
        from apps.services.billing.exceptions import BillingError

        last_error = None
        for attempt in range(MAX_RETRIES + 1):
            try:
                raw_text = self._call_api(image_b64)
                model_name = "vision_parse_document"
                chunks = self._parse_response(
                    raw_text, page_number, page_width, page_height, model_name,
                )
                if chunks:
                    return chunks
                logger.warning(
                    "Vision API 返回空 blocks (attempt=%d)，跳过重试",
                    attempt + 1,
                )
                break
            except BillingError:
                raise
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "Vision API 调用失败 (attempt=%d): %s",
                    attempt + 1, exc,
                )
                if attempt < MAX_RETRIES:
                    time.sleep(RETRY_DELAY * (attempt + 1))

        return self._fallback_error(str(last_error or "Vision 解析失败"))

    def _call_api(self, image_b64: str) -> str:
        from apps.services.docparse.service import get_vlm_semaphore
        from apps.services.llm.services.vision import parse as vision_parse

        mime = _detect_mime_from_b64(image_b64)
        image_data_url = f"data:{mime};base64,{image_b64}"

        sem = get_vlm_semaphore()
        acquired = sem.acquire(timeout=120)
        if not acquired:
            raise TimeoutError("VLM 并发队列已满，等待超时")
        try:
            _pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            _future = _pool.submit(
                vision_parse,
                scene_key="vision_parse_document",
                image=image_data_url,
                user_id=self.user_id,
                organization_id=self.organization_id,
                response_format="json_object",
                timeout_sec=_VLM_CALL_TIMEOUT,
                selected_model_id=self.selected_model_id,
            )
            try:
                result = _future.result(timeout=_VLM_CALL_TIMEOUT)
            except concurrent.futures.TimeoutError:
                _future.cancel()
                _pool.shutdown(wait=False, cancel_futures=True)
                raise TimeoutError(
                    f"VLM API 单次调用超时 ({_VLM_CALL_TIMEOUT}s)"
                )
            else:
                _pool.shutdown(wait=False)
        finally:
            sem.release()

        if isinstance(result.content, dict):
            return json.dumps(result.content, ensure_ascii=False)
        return str(result.content)

    def _parse_response(
        self,
        raw_text: str,
        page_number: int,
        page_width: float,
        page_height: float,
        model: str,
    ) -> list[ChunkResult]:
        parsed = _try_parse_json(raw_text)
        if not parsed or "blocks" not in parsed:
            logger.warning("Vision 输出无法解析为 JSON，回退为纯文本 (model=%s)", model)
            return [ChunkResult(
                chunk_type="paragraph",
                content=raw_text.strip(),
                sequence=1,
                metadata={"source": "vision", "model": model, "raw": True, "quality": "medium"},
            )]

        chunks: list[ChunkResult] = []
        for idx, block in enumerate(parsed["blocks"]):
            btype = block.get("type", "paragraph")
            content = block.get("content", "")

            children = block.get("children")
            if children and isinstance(children, list):
                field_lines = [
                    f"{c.get('label', '')}: {c.get('value', '')}"
                    for c in children
                ]
                content = (content + "\n" + "\n".join(field_lines)).strip() if content else "\n".join(field_lines)

            bbox = _normalize_bbox(
                block.get("bbox"), page_width, page_height,
            )

            heading_level = block.get("heading_level")
            if btype == "heading" and heading_level is None:
                heading_level = 2

            chunks.append(ChunkResult(
                chunk_type=btype,
                content=content,
                sequence=idx + 1,
                bbox=bbox,
                heading_level=heading_level if btype == "heading" else None,
                metadata={
                    "source": "vision",
                    "model": model,
                    "quality": "medium",
                },
            ))

        return chunks

    @staticmethod
    def _fallback_error(error: str) -> list[ChunkResult]:
        return [ChunkResult(
            chunk_type="paragraph",
            content="[Vision 解析失败，请重试或联系支持]",
            sequence=1,
            metadata={
                "source": "vision",
                "is_error": True,
                "error_detail": error,
                "quality": "low",
            },
        )]


# ======================================================================
# 辅助函数
# ======================================================================

_B64_MIME_MAP = {
    "/9j/": "image/jpeg",
    "iVBO": "image/png",
    "UklG": "image/webp",
    "R0lG": "image/gif",
    "SUkq": "image/tiff",
    "TU0A": "image/tiff",
    "Qk0": "image/bmp",
}


def _detect_mime_from_b64(b64: str) -> str:
    """从 base64 前缀推断 MIME 类型，支持 JPEG/PNG/WebP/GIF/TIFF/BMP。"""
    for prefix, mime in _B64_MIME_MAP.items():
        if b64.startswith(prefix):
            return mime
    return "image/jpeg"


def _compress_image(image_bytes: bytes) -> bytes:
    """压缩图片：限制最大边长 + JPEG 有损压缩"""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(image_bytes))

        if max(img.size) > MAX_IMAGE_EDGE:
            ratio = MAX_IMAGE_EDGE / max(img.size)
            new_size = (int(img.width * ratio), int(img.height * ratio))
            img = img.resize(new_size, Image.LANCZOS)

        if img.mode in ("RGBA", "P"):
            bg = Image.new("RGB", img.size, (255, 255, 255))
            if img.mode == "P":
                img = img.convert("RGBA")
            bg.paste(img, mask=img.split()[-1])
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        compressed = buf.getvalue()

        if len(compressed) < len(image_bytes):
            logger.debug(
                "图片压缩: %dKB → %dKB (%.0f%%)",
                len(image_bytes) // 1024,
                len(compressed) // 1024,
                len(compressed) / len(image_bytes) * 100,
            )
            return compressed
    except ImportError:
        logger.debug("Pillow 未安装，跳过图片压缩")
    except Exception as exc:
        logger.debug("图片压缩失败: %s", exc)

    return image_bytes


def _normalize_bbox(
    raw_bbox, page_width: float, page_height: float,
) -> tuple[float, float, float, float] | None:
    """
    将 Vision 返回的 bbox 转为 PDF 点坐标。

    如果 bbox 是 [x0, y0, x1, y1]（0-1000 归一化坐标），
    转换为 PDF 点坐标（乘以 page_width/1000, page_height/1000）。
    如果没有页面尺寸信息，保留归一化坐标（0-1 比例）。
    """
    if not raw_bbox or not isinstance(raw_bbox, (list, tuple)):
        return None
    if len(raw_bbox) != 4:
        return None

    try:
        x0, y0, x1, y1 = [float(v) for v in raw_bbox]
    except (ValueError, TypeError):
        return None

    # 确保值在合法范围
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(1000, x1), min(1000, y1)

    if x0 >= x1 or y0 >= y1:
        return None

    if page_width > 0 and page_height > 0:
        return (
            x0 / 1000 * page_width,
            y0 / 1000 * page_height,
            x1 / 1000 * page_width,
            y1 / 1000 * page_height,
        )

    # 没有页面尺寸：返回 0-1 比例
    return (x0 / 1000, y0 / 1000, x1 / 1000, y1 / 1000)


def _try_parse_json(text: str) -> dict | None:
    cleaned = text.strip()
    m = re.search(r"```(?:json)?\s*\n(.*?)```", cleaned, re.DOTALL)
    if m:
        cleaned = m.group(1).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    try:
        import json_repair  # type: ignore
        return json_repair.loads(cleaned)
    except Exception:
        return None
