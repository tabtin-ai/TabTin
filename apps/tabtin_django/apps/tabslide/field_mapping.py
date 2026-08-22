"""
TabSlide 前后端字段映射（Single Source of Truth）

前端 Slide 类型使用 camelCase，后端 SlidePage 模型使用 snake_case。
本模块是所有映射逻辑的唯一入口，杜绝散弹式手动映射。

字段对照表：
    前端 (camelCase)     → 后端 SlidePage (snake_case)
    ─────────────────────────────────────────────────
    elements             → elements_data
    html                 → html_source
    contentFormat        → content_format
    masterElements       → master_elements
    layout               → layout_ref
    turningMode          → turning_mode
    sectionTag           → section_tag
    slideType            → slide_type
    slideNotes           → slide_notes
    background           → background        (同名)
    remark               → remark            (同名)
    animations           → animations        (同名)
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import SlidePage

# ── 映射表（唯一真相源）──

# key = 前端字段名, value = SlidePage model 字段名
_FE_TO_MODEL: dict[str, str] = {
    "elements": "elements_data",
    "html": "html_source",
    "contentFormat": "content_format",
    "masterElements": "master_elements",
    "layout": "layout_ref",
    "turningMode": "turning_mode",
    "sectionTag": "section_tag",
    "slideType": "slide_type",
    "slideNotes": "slide_notes",
    "background": "background",
    "remark": "remark",
    "animations": "animations",
}

_MODEL_TO_FE: dict[str, str] = {v: k for k, v in _FE_TO_MODEL.items()}

# 需要映射的字段集合（前端名 ≠ 模型名的那些）
MAPPED_FIELDS = {k for k, v in _FE_TO_MODEL.items() if k != v}

# 所有参与映射的前端字段名
ALL_FE_FIELDS = frozenset(_FE_TO_MODEL.keys())

# 所有参与映射的模型字段名
ALL_MODEL_FIELDS = frozenset(_FE_TO_MODEL.values())

# bulk_create / update_fields 需要的内容字段列表（模型字段名，固定顺序）
MODEL_CONTENT_UPDATE_FIELDS: list[str] = sorted(_FE_TO_MODEL.values())

_ALIASES_TO_FE: dict[str, str] = {
    # 前端保存链路里历史上混用过 snake_case / notes
    "content_format": "contentFormat",
    "notes": "remark",
    "master_elements": "masterElements",
    # backend-adapter.ts 使用 snake_case 发送这三个字段
    "section_tag": "sectionTag",
    "slide_type": "slideType",
    "slide_notes": "slideNotes",
}

# JSON-first 哲学：HTML 模式已在前端下线，PPTElement[] 是唯一运行时真相源。
# - content_format 永远是 'json'，写入侧强制归一。
# - html_source 仅在创建期（create_slides / import_pptx）写入一次，作 Agent 后续创作的
#   "风格参考语料"。增量更新路径（save_pages / save_pages_v2 / collab persist）永远
#   不更新 html_source —— 一旦创建即只读。
# - 见 frontend_page_to_defaults vs frontend_page_to_full_defaults 的写入控制。

# 增量更新路径不允许写入的"密封字段"（防止从用户编辑/协同链路重新引入 HTML 真相源）
_SEALED_AFTER_CREATION_MODEL_FIELDS = frozenset({"html_source", "content_format"})


def normalize_background_for_api(bg: dict | None) -> dict | None:
    """
    将 DB 存储的后端背景格式规范化为前端兼容格式。

    后端存储使用 type='color' + value, 前端期望 type='solid' + color
    或 type='theme'（带 theme 对象时）。gradient / image 类型透传。
    """
    if not bg or not isinstance(bg, dict):
        return bg

    bg_type = bg.get("type", "")
    inherited = bg.get("inherited")

    if bg_type in ("color", "solid"):
        theme = bg.get("theme")
        if isinstance(theme, dict) and theme.get("key"):
            color = (
                theme.get("color")
                or (bg.get("value") if isinstance(bg.get("value"), str) else None)
                or "#ffffff"
            )
            result: dict = {
                "type": "theme",
                "color": color,
                "theme": {**theme, "color": theme.get("color") or color},
            }
        else:
            color = (
                (bg.get("value") if isinstance(bg.get("value"), str) else None)
                or bg.get("color")
                or "#ffffff"
            )
            result = {"type": "solid", "color": color}
    elif bg_type == "theme":
        theme = bg.get("theme")
        color = (
            (theme.get("color") if isinstance(theme, dict) else None)
            or (bg.get("value") if isinstance(bg.get("value"), str) else None)
            or bg.get("color")
            or "#ffffff"
        )
        if isinstance(theme, dict) and theme.get("key"):
            result = {
                "type": "theme",
                "color": color,
                "theme": {**theme, "color": theme.get("color") or color},
            }
        else:
            result = {"type": "solid", "color": color}
    else:
        return bg

    if inherited:
        result["inherited"] = True
    return result


def _normalize_frontend_like_page_data(page_data: dict) -> dict:
    """
    统一前端页面字典键，兼容历史别名（notes/content_format 等）。

    JSON-first：contentFormat 强制归一为 'json'，杜绝从写入侧重新引入 HTML 模式。
    """
    normalized = dict(page_data or {})
    for alias, canonical in _ALIASES_TO_FE.items():
        if canonical not in normalized and alias in normalized:
            normalized[canonical] = normalized[alias]
    normalized["contentFormat"] = "json"
    return normalized


def fe_key_to_model(fe_key: str) -> str | None:
    """前端字段名 → SlidePage 模型字段名。未知字段返回 None。"""
    return _FE_TO_MODEL.get(fe_key)


def model_key_to_fe(model_key: str) -> str | None:
    """SlidePage 模型字段名 → 前端字段名。未知字段返回 None。"""
    return _MODEL_TO_FE.get(model_key)


# ── 前端 → 模型（写入方向） ──

def frontend_page_to_defaults(page_data: dict) -> dict:
    """
    将前端 camelCase 页面数据转为 SlidePage 增量更新的 defaults dict。

    只包含 page_data 中实际存在的字段，不会填充缺失字段。
    适用于增量更新（changed_pages、collab persist）场景。

    JSON-first 哲学（密封写）：
        - html_source / content_format 是 _SEALED_AFTER_CREATION_MODEL_FIELDS，
          即便 page_data 带了 html / contentFormat，也会被丢弃。
        - 这两个字段只能由 frontend_page_to_full_defaults（创建路径）写入。

    >>> frontend_page_to_defaults({"elements": [...], "turningMode": "fade"})
    {"elements_data": [...], "turning_mode": "fade"}

    >>> # 即便带了 html / contentFormat，也不会进入 defaults
    >>> frontend_page_to_defaults({"elements": [...], "html": "<x>", "contentFormat": "html"})
    {"elements_data": [...]}
    """
    normalized = _normalize_frontend_like_page_data(page_data)
    defaults: dict = {}
    for fe_key, model_key in _FE_TO_MODEL.items():
        if model_key in _SEALED_AFTER_CREATION_MODEL_FIELDS:
            continue
        if fe_key in normalized:
            defaults[model_key] = normalized[fe_key]
    return defaults


def frontend_page_to_full_defaults(page_data: dict) -> dict:
    """
    将前端 camelCase 页面数据转为 SlidePage 的完整字段 dict（含默认值）。

    适用于**创建路径**：create_slides、import_pptx、batch backfill、首次落库 fallback。
    这是 _SEALED_AFTER_CREATION_MODEL_FIELDS（html_source、content_format）唯一允许写入
    的入口。后续编辑/协同 persist 走 frontend_page_to_defaults，那条路径会丢弃这两个字段。

    缺失的字段填充为模型默认值：
        - elements_data → []
        - remark → ""
        - turning_mode → ""
        - 其他 JSONField → None
    """
    normalized = _normalize_frontend_like_page_data(page_data)
    return {
        "elements_data": normalized.get("elements", []),
        # html_source 是创作期"风格参考语料"快照，create 后即只读
        "html_source": normalized.get("html", ""),
        "content_format": "json",
        "background": normalized.get("background"),
        "master_elements": normalized.get("masterElements"),
        "layout_ref": normalized.get("layout"),
        "remark": normalized.get("remark", ""),
        "animations": normalized.get("animations"),
        "turning_mode": normalized.get("turningMode", ""),
        "section_tag": normalized.get("sectionTag"),
        "slide_type": normalized.get("slideType", ""),
        "slide_notes": normalized.get("slideNotes"),
    }


# ── 模型 → 前端（读取方向） ──

def model_row_to_frontend_page(row: SlidePage) -> dict:
    """
    将 SlidePage 模型实例转为 BackendSlidePage 兼容 dict。

    遵循现有约定：
        - elements_data 为 None 时返回 []
        - remark/turning_mode 为空字符串时不包含
        - 其他 JSONField 为 None 时不包含

    JSON-first：永远不向前端透出 contentFormat / html 字段，HTML 模式已下线。
    """
    page: dict = {
        "id": row.page_id,
        "elements": row.elements_data or [],
    }
    if row.background is not None:
        page["background"] = normalize_background_for_api(row.background)
    if row.master_elements is not None:
        page["masterElements"] = row.master_elements
    if row.layout_ref is not None:
        page["layout"] = row.layout_ref
    if row.remark:
        page["remark"] = row.remark
    if row.animations is not None:
        page["animations"] = row.animations
    if row.turning_mode:
        page["turningMode"] = row.turning_mode
    if row.section_tag is not None:
        page["section_tag"] = row.section_tag
    if row.slide_type:
        page["slide_type"] = row.slide_type
    if row.slide_notes is not None:
        page["slide_notes"] = row.slide_notes
    return page


def model_row_to_full_frontend_page(row: SlidePage) -> dict:
    """
    将 SlidePage 模型实例转为前端 camelCase 格式（总是包含所有字段）。

    适用于需要完整数据的场景（如 get_page_detail）。
    JSON-first：永远输出 contentFormat='json'，html 字段不暴露给前端。
    """
    return {
        "id": row.page_id,
        "elements": row.elements_data or [],
        "background": normalize_background_for_api(row.background),
        "masterElements": row.master_elements,
        "layout": row.layout_ref,
        "remark": row.remark or "",
        "animations": row.animations,
        "turningMode": row.turning_mode or "",
        "section_tag": row.section_tag,
        "slide_type": row.slide_type or "",
        "slide_notes": row.slide_notes,
    }
