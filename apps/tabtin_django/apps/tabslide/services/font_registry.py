"""平台内置字体注册表 — 用于 PPTX 导出时自动嵌入。

设计：
- 注册 family_name → OSS URL 的映射
- 支持别名（alimamashuheiti / 阿里妈妈数黑体 / AlibabaPuHuiTi → 同一份字体文件）
- 商业字体（如阿里妈妈数黑体、MiSans）必须在 OSS 上有对应文件
- 不做字体子集化（先满足"嵌入字体"，子集化是后续优化）

如果某个字体在注册表里没找到（如用户自定义字体）：
- 不嵌入，记 warning
- PPTX 仍能导出，只是该字体在没装的电脑上会回退

工作流：
- dom_extractor 在每个 text PPTElement 上记 `props.defaultFontName`
- create_slides 调用 `build_font_meta_for_pages(pages)` 拿到 embedded_fonts 列表
- 合并到 SlideProject.font_meta，PPTX 导出时由 `_embed_fonts_into_pptx` 注入

扩展方式：
- 新增字体只需在 `_FONT_OSS_URLS` 添加一条 entry（含 url / style / format）
- 别名在 `_FONT_ALIASES` 加映射；同一字体不同写法都映射到同一 canonical name
- 系统默认字体（Arial / PingFang SC 等）映射到 None 表示永不嵌入
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, Iterable, List, Optional, Set

logger = logging.getLogger(__name__)


# 平台内置字体登记 — 别名映射（写法 → canonical name）
# 大小写敏感命中优先，未命中再尝试 lower()
_FONT_ALIASES: Dict[str, Optional[str]] = {
    # --- 阿里妈妈数黑体 / Alibaba PuHuiTi 系列 ---
    "alimamashuheiti": "AlibabaPuHuiTi",
    "AlimamaShuHeiTi": "AlibabaPuHuiTi",
    "阿里妈妈数黑体": "AlibabaPuHuiTi",
    "AlibabaPuHuiTi": "AlibabaPuHuiTi",
    "AlibabaPuHuiTi3.0Bold": "AlibabaPuHuiTi",
    "Alibaba PuHuiTi 3.0": "AlibabaPuHuiTi",
    "阿里巴巴普惠体": "AlibabaPuHuiTi",

    # --- MiSans / 小米兰亭 ---
    "MiSans": "MiSans",
    "MiSansRegular": "MiSans",
    "MiSans VF": "MiSans",
    "小米兰亭": "MiSans",
    "Xiaomi MiSans": "MiSans",

    # --- Inter ---
    "Inter": "Inter",
    "InterVariable": "Inter",
    "Inter Variable": "Inter",

    # --- Liter ---
    "Liter": "Liter",

    # --- Noto Sans SC ---
    "NotoSansSC": "NotoSansSC",
    "Noto Sans SC": "NotoSansSC",
    "Noto Sans CJK SC": "NotoSansSC",
    "思源黑体": "NotoSansSC",
    "Source Han Sans SC": "NotoSansSC",

    # --- 系统默认字体 → 不嵌入（操作系统自带，嵌入也无法商用 / 不必要）---
    "Arial": None,
    "Helvetica": None,
    "Helvetica Neue": None,
    "Times New Roman": None,
    "Times": None,
    "Calibri": None,
    "Courier New": None,
    "Verdana": None,
    "Tahoma": None,
    "Georgia": None,
    "Segoe UI": None,
    "system-ui": None,
    "-apple-system": None,
    "BlinkMacSystemFont": None,
    "sans-serif": None,
    "serif": None,
    "monospace": None,
    # 中文系统字体
    "PingFang SC": None,
    "PingFang TC": None,
    "PingFang HK": None,
    "Microsoft YaHei": None,
    "Microsoft JhengHei": None,
    "SimSun": None,
    "SimHei": None,
    "宋体": None,
    "黑体": None,
    "微软雅黑": None,
    "苹方": None,
}


# 字体 → 默认风格的 OSS URL
# 字体格式：truetype / opentype
# 注意：商用字体（如阿里妈妈数黑体）请确保获得授权后再上传
#
# TODO(Wave-2): 后续上传以下字体到 OSS 并填充本注册表
#   - MiSans-Regular.ttf  (开源免费商用，推荐首批上传)
#     建议路径: tabslide/fonts/MiSans-Regular.ttf
#   - AlibabaPuHuiTi-3-65-Medium.ttf  (开源免费商用)
#     建议路径: tabslide/fonts/AlibabaPuHuiTi-3-65-Medium.ttf
#   - Inter-Regular.ttf  (OFL 协议，免费商用)
#   - NotoSansSC-Regular.otf  (OFL 协议，免费商用)
#
# 字段说明：
#   url:        OSS 公开可下载 URL（_embed_fonts_into_pptx 走 ssrf_safe_urlopen 拉取）
#   style:      normal / bold / italic / bolditalic（写入 PPTX embeddedFont 标签）
#   format:     truetype / opentype（仅用于元信息，不影响嵌入逻辑）
#   size_bytes: 字体大小（仅作记录与日志，可选）
_FONT_OSS_URLS: Dict[str, Dict[str, Any]] = {
    # ⚠️  以下为 placeholder，待真实字体文件上传到 OSS 后启用
    # "MiSans": {
    #     "url": "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabslide/fonts/MiSans-Regular.ttf",
    #     "style": "normal",
    #     "format": "truetype",
    #     "size_bytes": 4_700_000,
    # },
    # "AlibabaPuHuiTi": {
    #     "url": "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabslide/fonts/AlibabaPuHuiTi-3-65-Medium.ttf",
    #     "style": "normal",
    #     "format": "truetype",
    #     "size_bytes": 5_400_000,
    # },
    # "Inter": {
    #     "url": "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabslide/fonts/Inter-Regular.ttf",
    #     "style": "normal",
    #     "format": "truetype",
    #     "size_bytes": 320_000,
    # },
    # "NotoSansSC": {
    #     "url": "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabslide/fonts/NotoSansSC-Regular.otf",
    #     "style": "normal",
    #     "format": "opentype",
    #     "size_bytes": 5_400_000,
    # },
    # "Liter": {
    #     "url": "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabslide/fonts/Liter-Regular.ttf",
    #     "style": "normal",
    #     "format": "truetype",
    #     "size_bytes": 34_000,
    # },
}


# 提取 inline 富文本里 font-family 的正则（content 是 HTML 富文本）
_INLINE_FONT_FAMILY_RE = re.compile(
    r"font-family\s*:\s*([^;\"'>]+)", re.IGNORECASE
)


def _normalize_family_name(family_name: str) -> str:
    """规范化 family_name：CSS font stack 取第一个、去引号、去首尾空格。"""
    if not family_name:
        return ""
    # CSS font-family 可能是 'MiSans', 'Helvetica', sans-serif 这样的栈
    first = family_name.split(",")[0]
    # 去 ' " 引号 + 首尾空格
    return first.strip().strip("'\"").strip()


def resolve_font_alias(family_name: str) -> Optional[str]:
    """把 family_name 规范化为内置字体名。

    返回值：
      - canonical name (str) —— 命中注册表的内置字体
      - None —— 系统默认字体（永不嵌入）或未注册字体
    """
    normalized = _normalize_family_name(family_name)
    if not normalized:
        return None
    if normalized in _FONT_ALIASES:
        return _FONT_ALIASES[normalized]
    # 大小写不敏感二次查（用 lower）
    lower = normalized.lower()
    for key, value in _FONT_ALIASES.items():
        if key.lower() == lower:
            return value
    return None


def get_font_embed_info(family_name: str) -> Optional[Dict[str, Any]]:
    """返回字体嵌入信息（含 oss_url），未注册或无 URL 返回 None。

    返回结构（喂给 _embed_fonts_into_pptx）：
        {
            "name": "MiSans",      # canonical name，写入 PPTX embeddedFont typeface
            "oss_url": "...",      # OSS 下载地址
            "style": "normal",     # normal / bold / italic / bolditalic
            "format": "truetype",  # 仅元信息
        }
    """
    canonical = resolve_font_alias(family_name)
    if not canonical:
        return None
    info = _FONT_OSS_URLS.get(canonical)
    if not info or not info.get("url"):
        return None
    return {
        "name": canonical,
        "oss_url": info["url"],
        "style": info.get("style", "normal"),
        "format": info.get("format", "truetype"),
    }


def _extract_inline_font_families(content: str) -> Iterable[str]:
    """从 HTML 富文本里抽取 inline `font-family:` 声明的字体名。"""
    if not content or not isinstance(content, str):
        return ()
    matches = _INLINE_FONT_FAMILY_RE.findall(content)
    for raw in matches:
        # raw 可能是 "MiSans, sans-serif"，复用 normalize
        first = _normalize_family_name(raw)
        if first:
            yield first


def collect_used_fonts(pages: List[Dict[str, Any]]) -> List[str]:
    """扫描页面里所有 text PPTElement，收集用过的字体 family（去重）。

    扫描范围：
      - element.props.defaultFontName / defaultFontFamily（dom_extractor 默认输出）
      - element.props.content 中的 inline `style="font-family:..."`（防漏 Agent 改写）

    返回的是 dedup 后按字典序排序的字体名列表。
    """
    fonts: Set[str] = set()
    for page in pages or []:
        if not isinstance(page, dict):
            continue
        for el in page.get("elements", []) or []:
            if not isinstance(el, dict):
                continue
            if el.get("type") != "text":
                continue
            props = el.get("props", {}) if isinstance(el.get("props"), dict) else {}
            # 兼容 props-wrapped 与 flat 两种格式
            family = (
                props.get("defaultFontName")
                or props.get("defaultFontFamily")
                or el.get("defaultFontName")
                or el.get("defaultFontFamily")
                or ""
            )
            normalized = _normalize_family_name(family)
            if normalized:
                fonts.add(normalized)
            content = props.get("content") or el.get("content") or ""
            for inline in _extract_inline_font_families(content):
                fonts.add(inline)
    return sorted(fonts)


def build_font_meta_for_pages(pages: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """根据页面用了哪些字体，构造 font_meta 结构。

    返回值：
      - dict with "embedded_fonts" 列表 —— 至少有一个字体可嵌入
      - None —— 没有需要嵌入的字体（全是系统字体 / 未注册 / 注册表无 OSS URL）
    """
    used_fonts = collect_used_fonts(pages)
    if not used_fonts:
        return None

    embedded: List[Dict[str, Any]] = []
    seen_canonical: Set[str] = set()
    unregistered: List[str] = []
    no_oss: List[str] = []

    for family in used_fonts:
        canonical = resolve_font_alias(family)
        if canonical is None:
            # 区分"系统字体"和"未注册"：系统字体在 _FONT_ALIASES 里显式 → None
            if _normalize_family_name(family) not in _FONT_ALIASES:
                # 不在别名表里 = 未注册（用户自定义字体）
                # 大小写不敏感二次查后仍未命中
                lower = _normalize_family_name(family).lower()
                if not any(k.lower() == lower for k in _FONT_ALIASES):
                    unregistered.append(family)
            continue
        if canonical in seen_canonical:
            continue
        info = get_font_embed_info(family)
        if not info:
            no_oss.append(canonical)
            seen_canonical.add(canonical)
            continue
        embedded.append(info)
        seen_canonical.add(canonical)

    if unregistered:
        logger.info(
            "font_registry: unregistered fonts (will not embed, may render fallback): %s",
            unregistered,
        )
    if no_oss:
        logger.warning(
            "font_registry: registered but no OSS URL yet (skip embed): %s",
            no_oss,
        )

    if not embedded:
        return None
    return {"embedded_fonts": embedded}
