"""飞书 Docx 图片：从 blocks / Markdown 引用转存到 TabTin OSS。"""

from __future__ import annotations

import logging
import mimetypes
import re
import uuid as uuid_mod
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from urllib.parse import unquote, urlparse
from uuid import UUID

from django.utils import timezone

from .client import FeishuAPIError, FeishuClient
from .constants import (
    DOCX_BLOCK_TYPE_IMAGE,
    MAX_ATTACHMENT_BYTES,
    MAX_DOC_IMAGES_PER_DOCUMENT,
)
from .feishu_markdown import (
    classify_feishu_docx_blocks,
    find_feishu_docx_structure_issues,
    sanitize_feishu_docx_markdown_artifacts,
)

logger = logging.getLogger(__name__)

# Markdown 图片 / 独立行 <img>
_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_HTML_IMG_RE = re.compile(
    r'<img\b[^>]*\bsrc=["\']([^"\']+)["\'][^>]*>',
    re.IGNORECASE,
)

# 文本类 block_type → 字段名
_TEXT_BLOCK_FIELDS = {
    2: "text",
    3: "heading1",
    4: "heading2",
    5: "heading3",
    6: "heading4",
    7: "heading5",
    8: "heading6",
    9: "heading7",
    10: "heading8",
    11: "heading9",
    12: "bullet",
    13: "ordered",
    14: "code",
    15: "quote",
    17: "todo",
}


def enrich_feishu_docx_markdown_images(
    markdown: str,
    *,
    client: FeishuClient,
    access_token: str,
    doc_token: str,
    organization_id: UUID,
    user_id: str,
    issues: List[str],
    doc_title: str = "",
    collected_blocks: Optional[List[Dict[str, Any]]] = None,
    uploaded_assets: Optional[List[Dict[str, str]]] = None,
) -> str:
    """把飞书文档图片转存 OSS，并写回 Markdown。

    - 官方 Markdown 导出会丢掉 Image Block，故以 docx blocks 为准；
    - 若 Markdown 里已有飞书外链 / token，一并改写；
    - 缺 ``docx:document:readonly`` 时记 issues，不拖死整篇正文。
    """
    text = markdown or ""
    label = (doc_title or doc_token or "文档").strip()

    blocks: List[Dict[str, Any]] = []
    block_images: List[Dict[str, str]] = []
    try:
        blocks = client.list_docx_blocks(access_token, doc_token)
        block_images = extract_docx_images_in_order(blocks)
    except FeishuAPIError as exc:
        if exc.code == 99991679 or "docx:document" in str(exc):
            issues.append(
                f"文档「{label}」含图片可能未导入：缺少 docx 只读权限，"
                "请在云盘断开飞书后重新授权"
            )
        else:
            issues.append(f"文档「{label}」读取图片块失败: {exc}")
            logger.warning("[FeishuDocImages] list blocks failed doc=%s: %s", doc_token, exc)
    except Exception as exc:
        issues.append(f"文档「{label}」读取图片块失败: {exc}")
        logger.exception("[FeishuDocImages] unexpected list blocks doc=%s", doc_token)

    if collected_blocks is not None:
        collected_blocks.extend(blocks)

    text, hidden_artifacts = sanitize_feishu_docx_markdown_artifacts(text, blocks)
    fidelity = classify_feishu_docx_blocks(blocks)
    if fidelity["degraded"] or fidelity["hidden"] or hidden_artifacts:
        fidelity_issue = (
            f"文档「{label}」包含 {fidelity['degraded']} 个已静态降级、"
            f"{fidelity['hidden']} 个暂不支持的飞书块；"
            f"已隐藏 {hidden_artifacts} 处无效导出占位"
        )
        if fidelity_issue not in issues:
            issues.append(fidelity_issue)
    for structure_issue in find_feishu_docx_structure_issues(text, blocks):
        message = f"文档「{label}」结构预检异常：{structure_issue}"
        if message not in issues:
            issues.append(message)

    # 1) 改写 Markdown 内已有图片引用
    text, rewritten_tokens = rewrite_inline_markdown_images(
        text,
        download=lambda token, tmp_url: _download_doc_media(
            client, access_token, token, tmp_url=tmp_url, doc_token=doc_token,
        ),
        upload=lambda content, file_name, mime: _upload_doc_image(
            content,
            file_name=file_name,
            mime=mime,
            organization_id=organization_id,
            user_id=user_id,
            doc_token=doc_token,
            uploaded_assets=uploaded_assets,
        ),
        issues=issues,
        doc_label=label,
        known_block_tokens={row["token"] for row in block_images},
    )

    # 2) blocks 中尚未出现在 Markdown 的图片：按文档序插入
    pending = [
        row for row in block_images
        if row["token"] not in rewritten_tokens
    ][:MAX_DOC_IMAGES_PER_DOCUMENT]
    if len(block_images) > MAX_DOC_IMAGES_PER_DOCUMENT:
        issues.append(
            f"文档「{label}」图片超过上限 {MAX_DOC_IMAGES_PER_DOCUMENT}，已截断"
        )

    uploaded: List[Tuple[Dict[str, str], str]] = []
    for row in pending:
        token = row["token"]
        try:
            content = _download_doc_media(
                client, access_token, token, doc_token=doc_token,
            )
            if not content:
                raise FeishuAPIError("空图片内容")
            if len(content) > MAX_ATTACHMENT_BYTES:
                raise FeishuAPIError(f"图片超过上限 {MAX_ATTACHMENT_BYTES} 字节")
            mime = _sniff_image_mime(content)
            ext = mimetypes.guess_extension(mime) or ".png"
            if ext == ".jpe":
                ext = ".jpg"
            file_name = f"{token[:16]}{ext}"
            public_url = _upload_doc_image(
                content,
                file_name=file_name,
                mime=mime,
                organization_id=organization_id,
                user_id=user_id,
                doc_token=doc_token,
                uploaded_assets=uploaded_assets,
            )
            uploaded.append((row, public_url))
        except Exception as exc:
            logger.warning(
                "[FeishuDocImages] download/upload failed doc=%s token=%s: %s",
                doc_token, token, exc,
            )
            issues.append(f"文档「{label}」图片导入失败: {exc}")

    if uploaded:
        text = insert_images_into_markdown(text, uploaded)

    return text


def extract_docx_images_in_order(blocks: Sequence[Dict[str, Any]]) -> List[Dict[str, str]]:
    """按文档阅读顺序（page DFS）收集 Image Block。"""
    by_id: Dict[str, Dict[str, Any]] = {}
    children_map: Dict[str, List[str]] = {}
    page_id: Optional[str] = None
    for raw in blocks:
        bid = str(raw.get("block_id") or "").strip()
        if not bid:
            continue
        by_id[bid] = raw
        kids = [str(x) for x in (raw.get("children") or []) if x]
        children_map[bid] = kids
        if int(raw.get("block_type") or 0) == 1:
            page_id = bid

    out: List[Dict[str, str]] = []
    seen: set[str] = set()
    last_text = ""

    def visit(block_id: str) -> None:
        nonlocal last_text
        node = by_id.get(block_id)
        if not node:
            return
        btype = int(node.get("block_type") or 0)
        if btype in _TEXT_BLOCK_FIELDS:
            plain = _block_plain_text(node, _TEXT_BLOCK_FIELDS[btype]).strip()
            if plain:
                last_text = plain
        if btype == DOCX_BLOCK_TYPE_IMAGE:
            image = node.get("image") if isinstance(node.get("image"), dict) else {}
            token = str(image.get("token") or "").strip()
            if token and token not in seen:
                seen.add(token)
                out.append({
                    "token": token,
                    "alt": "图片",
                    "anchor": last_text[:80],
                })
        for child_id in children_map.get(block_id) or []:
            visit(child_id)

    if page_id:
        visit(page_id)
    else:
        for bid in list(by_id.keys()):
            visit(bid)
    return out


def rewrite_inline_markdown_images(
    markdown: str,
    *,
    download: Callable[[str, str], bytes],
    upload: Callable[[bytes, str, str], str],
    issues: List[str],
    doc_label: str,
    known_block_tokens: Optional[set[str]] = None,
) -> Tuple[str, set[str]]:
    """改写 Markdown / HTML 中的飞书图片引用，返回 (新正文, 已处理 token 集)。"""
    known = known_block_tokens or set()
    rewritten: set[str] = set()
    text = markdown or ""

    def replace_md(match: re.Match[str]) -> str:
        alt = (match.group(1) or "图片").strip() or "图片"
        dest = (match.group(2) or "").strip()
        if not dest or not _looks_like_feishu_image_ref(dest):
            return match.group(0)
        token, tmp_url = _parse_image_dest(dest)
        if not token and not tmp_url:
            return match.group(0)
        try:
            content = download(token, tmp_url)
            if not content:
                raise FeishuAPIError("空图片内容")
            if len(content) > MAX_ATTACHMENT_BYTES:
                raise FeishuAPIError(f"图片超过上限 {MAX_ATTACHMENT_BYTES} 字节")
            mime = _sniff_image_mime(content)
            ext = mimetypes.guess_extension(mime) or ".png"
            file_name = f"{(token or 'img')[:16]}{ext}"
            url = upload(content, file_name, mime)
            if token:
                rewritten.add(token)
            return f"![{alt}]({url})"
        except Exception as exc:
            issues.append(f"文档「{doc_label}」内联图片导入失败: {exc}")
            return match.group(0)

    def replace_html(match: re.Match[str]) -> str:
        dest = (match.group(1) or "").strip()
        if not dest or not _looks_like_feishu_image_ref(dest):
            return match.group(0)
        token, tmp_url = _parse_image_dest(dest)
        if not token and not tmp_url:
            return match.group(0)
        try:
            content = download(token, tmp_url)
            if not content:
                raise FeishuAPIError("空图片内容")
            mime = _sniff_image_mime(content)
            ext = mimetypes.guess_extension(mime) or ".png"
            url = upload(content, f"{(token or 'img')[:16]}{ext}", mime)
            if token:
                rewritten.add(token)
            return f"![图片]({url})"
        except Exception as exc:
            issues.append(f"文档「{doc_label}」内联图片导入失败: {exc}")
            return match.group(0)

    text = _MD_IMAGE_RE.sub(replace_md, text)
    text = _HTML_IMG_RE.sub(replace_html, text)
    # 标记 blocks 里已在 md 中出现过的 token（即使未改写成功也不重复插入）
    for token in known:
        if token and token in text:
            rewritten.add(token)
    return text, rewritten


def insert_images_into_markdown(
    markdown: str,
    uploaded: Sequence[Tuple[Dict[str, str], str]],
) -> str:
    """按 anchor 文本插入图片；找不到锚点则追加到文末。"""
    text = markdown or ""
    leftovers: List[str] = []
    for row, url in uploaded:
        alt = (row.get("alt") or "图片").strip() or "图片"
        snippet = f"\n\n![{alt}]({url})\n"
        anchor = (row.get("anchor") or "").strip()
        inserted = False
        if anchor:
            # 用锚点前 24 个非空白字符在正文中定位
            key = re.sub(r"\s+", "", anchor)[:24]
            if key:
                # 在原文找包含该关键字符的段落末尾
                compact_idx = re.sub(r"\s+", "", text).find(key)
                if compact_idx >= 0:
                    # 映射回原文字符位置：扫描累积非空白
                    seen = 0
                    pos = 0
                    for i, ch in enumerate(text):
                        if not ch.isspace():
                            if seen == compact_idx + len(key) - 1:
                                pos = i + 1
                                break
                            seen += 1
                    # 推到段落结束
                    nl = text.find("\n\n", pos)
                    insert_at = nl if nl >= 0 else len(text)
                    text = text[:insert_at] + snippet + text[insert_at:]
                    inserted = True
        if not inserted:
            leftovers.append(snippet.strip())
    if leftovers:
        text = text.rstrip() + "\n\n" + "\n\n".join(leftovers) + "\n"
    return text


def _download_doc_media(
    client: FeishuClient,
    access_token: str,
    file_token: str,
    *,
    tmp_url: str = "",
    doc_token: str = "",
) -> bytes:
    extra = {"drive_route_token": doc_token} if doc_token else None
    try:
        return client.download_media(
            access_token,
            file_token,
            tmp_url=tmp_url,
            extra=extra,
        )
    except FeishuAPIError:
        # 部分租户不需要 extra；失败再裸下一次
        if extra:
            return client.download_media(
                access_token,
                file_token,
                tmp_url=tmp_url,
            )
        raise


def _upload_doc_image(
    content: bytes,
    *,
    file_name: str,
    mime: str,
    organization_id: UUID,
    user_id: str,
    doc_token: str,
    uploaded_assets: Optional[List[Dict[str, str]]] = None,
) -> str:
    from apps.services.oss.services.factory import get_oss_service
    from apps.services.oss.services.file_access import resolve_authorized_file
    from apps.services.oss.services.file_registry import FileRegistryService

    safe_name = (
        str(file_name or "image.png").replace("\\", "_").replace("/", "_").strip()
        or "image.png"
    )[:180]
    stamp = timezone.now().strftime("%Y%m%d%H%M%S")
    object_key = (
        f"feishu_import/{organization_id}/docx/{doc_token}/"
        f"{stamp}_{uuid_mod.uuid4().hex[:8]}_{safe_name}"
    )
    oss = get_oss_service()
    oss.upload_bytes(content, object_key, content_type=mime or "image/png")
    if not oss.set_object_private(object_key):
        try:
            oss.delete_file(object_key)
        except Exception:
            logger.warning(
                "[FeishuDocImages] private ACL failure cleanup failed key=%s",
                object_key,
                exc_info=True,
            )
        raise RuntimeError("飞书文档图片私有权限设置失败")

    file_record = FileRegistryService.register_uploaded_file(
        object_key=object_key,
        file_name=safe_name,
        file_size=len(content),
        content_type=mime or "image/png",
        module="tabdoc",
        user_id=user_id or "",
        organization_id=str(organization_id),
        context_type="feishu_import",
        context_id=str(doc_token),
        upload_source="feishu_import",
        is_public=False,
    )
    access = resolve_authorized_file(file_record, oss_service=oss)
    signed_url = str(access.url or "")
    if not signed_url:
        raise RuntimeError("飞书文档图片换签失败")
    if uploaded_assets is not None:
        uploaded_assets.append({
            "file_id": str(file_record.id),
            "url": signed_url,
        })
    return signed_url


def _block_plain_text(node: Dict[str, Any], field: str) -> str:
    payload = node.get(field) if isinstance(node.get(field), dict) else {}
    elements = payload.get("elements") or []
    parts: List[str] = []
    for el in elements:
        if not isinstance(el, dict):
            continue
        run = el.get("text_run") if isinstance(el.get("text_run"), dict) else None
        if run and run.get("content"):
            parts.append(str(run.get("content")))
            continue
        mention = el.get("mention_doc") or el.get("mention_user")
        if isinstance(mention, dict):
            title = mention.get("title") or mention.get("text")
            if title:
                parts.append(str(title))
    return "".join(parts)


def _looks_like_feishu_image_ref(dest: str) -> bool:
    d = unquote((dest or "").strip())
    if not d:
        return False
    # 纯 token：无 scheme，像 boxcn... / img_...
    if "://" not in d and re.fullmatch(r"[A-Za-z0-9_-]{10,}", d):
        return True
    # HTTPS + 飞书 hostname allowlist（禁止字符串 contains）
    from .media_url_security import looks_like_feishu_media_url

    return looks_like_feishu_media_url(d)


def _parse_image_dest(dest: str) -> Tuple[str, str]:
    """返回 (file_token, tmp_url)。"""
    raw = unquote((dest or "").strip())
    if not raw:
        return "", ""
    if "://" in raw:
        # 尝试从 query / path 抠 token
        parsed = urlparse(raw)
        path = parsed.path or ""
        m = re.search(r"/(?:download|file)/([A-Za-z0-9_-]{10,})", path)
        token = m.group(1) if m else ""
        if not token:
            m2 = re.search(r"([A-Za-z0-9_-]{16,})", path)
            token = m2.group(1) if m2 else ""
        return token, raw
    return raw, ""


def _sniff_image_mime(content: bytes) -> str:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"
