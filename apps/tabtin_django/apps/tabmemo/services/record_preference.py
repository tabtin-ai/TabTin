"""
记录偏好渲染器 —— 把 ``MemoRecordStyle`` 配置渲染成一段注入蒸馏 prompt 的
「记录偏好说明」文本。

设计（守 AI 能力统一宪法 不变量5：prompt 必须在 bundle、可审计、禁止裸 prompt）：
  - 各维度话术措辞（风格档 / density / depth / tone / focus / 框定语 / 连接词）
    **不再硬编码在本模块**，而是落在 bundle 可审计资源面
    ``scenes/bundled/_shared/record_styles.yaml``——prompt 工程师在 bundle 里
    看/改话术、走 git PR review；本模块退化为「读 bundle 话术 + 按配置组装」的逻辑层。
  - 本模块输出的是**平台拼装的结构化中文说明**，作为 template variable
    （``record_preference``）注入 memory_capture / task_summary 的 system prompt
    固定槽位——骨架（话术 + 框定语）在 bundle，用户内容只进变量槽。
  - 用户的 ``extra_preference`` 自由文本只作为「额外偏好」追加（受控变量），不作裸 prompt。
  - ``faithful``（默认）返回空串——等价现状行为，不向 prompt 注入额外指令，
    保证存量 (user, organization) 100% 向后兼容。

话术资源在**模块导入时一次性读入内存**（fail-fast：资源缺失/损坏即抛错，不拖到运行期
才暴露）；``render_record_preference`` 本身仍是读内存 dict 的纯函数，无 per-call IO，
便于单测与跨层复用（蒸馏链路 import 本模块）。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from apps.services.llm.scenes.loader import BUNDLED_DIR

# 话术资源（bundle 可审计资源面）——见 scenes/bundled/_shared/record_styles.yaml。
# _shared 以下划线开头，PromptRegistry / SceneRegistry 加载器均跳过（不当作 scene），
# 故放共享话术不会触发「孤立 bundle」启动校验。
_RECORD_STYLES_PATH = BUNDLED_DIR / "_shared" / "record_styles.yaml"


def _load_record_styles() -> Dict[str, Any]:
    """从 bundle 资源面读入记录偏好话术（模块导入时调用一次，fail-fast）。"""
    import yaml

    try:
        text = _RECORD_STYLES_PATH.read_text(encoding="utf-8")
        data = yaml.safe_load(text)
    except (OSError, yaml.YAMLError) as exc:
        raise RuntimeError(
            f"记录偏好话术资源加载失败（{_RECORD_STYLES_PATH}）：{exc}"
        ) from exc
    if not isinstance(data, dict):
        raise RuntimeError(
            f"记录偏好话术资源格式非法（应为 mapping）：{_RECORD_STYLES_PATH}"
        )
    return data


_STYLES = _load_record_styles()

# ── 把 bundle 话术资源展开成渲染用的话术表 ──
# faithful 不在 styles 表（= 返回空串 = 现状默认）。
_STYLE_INSTRUCTIONS: Dict[str, str] = _STYLES.get("styles", {})

_DIMENSIONS: Dict[str, Dict[str, str]] = _STYLES.get("dimensions", {})
_DENSITY: Dict[str, str] = _DIMENSIONS.get("density", {})
_DEPTH: Dict[str, str] = _DIMENSIONS.get("depth", {})
_TONE: Dict[str, str] = _DIMENSIONS.get("tone", {})

_FOCUS_CFG: Dict[str, Any] = _STYLES.get("focus", {})
_FOCUS: Dict[str, str] = _FOCUS_CFG.get("labels", {})
_FOCUS_PREFIX: str = _FOCUS_CFG.get("prefix", "")
_FOCUS_SEPARATOR: str = _FOCUS_CFG.get("separator", "")
_FOCUS_SUFFIX: str = _FOCUS_CFG.get("suffix", "")

_EXTRA_PREFERENCE_LABEL: str = _STYLES.get("extra_preference_label", "")

# 框定语（TM-16）：注入文本开头的平台骨架说明，让蒸馏模型把后面的内容理解为
# 「用户对记录风格的偏好」，而非对话指令主体。属平台骨架文本（话术现落 bundle）。
_FRAMING_PREFIX: str = _STYLES.get("framing_prefix", "")


def render_record_preference(
    style: str,
    custom_config: Optional[Dict[str, Any]] = None,
    extra_preference: str = "",
) -> str:
    """把记录风格配置渲染成注入 prompt 的偏好说明文本。

    Returns:
        一段中文说明；``faithful`` / 无可渲染内容时返回空串（调用方据此决定
        是否注入该 prompt 段）。
    """
    parts: List[str] = []

    if style in _STYLE_INSTRUCTIONS:
        parts.append(_STYLE_INSTRUCTIONS[style])
    elif style == "custom":
        cfg = custom_config or {}
        density = _DENSITY.get(cfg.get("density"))
        depth = _DEPTH.get(cfg.get("depth"))
        tone = _TONE.get(cfg.get("tone"))
        if density:
            parts.append(density)
        if depth:
            parts.append(depth)
        if tone:
            parts.append(tone)
        focus_labels = [_FOCUS[f] for f in (cfg.get("focus") or []) if f in _FOCUS]
        if focus_labels:
            parts.append(_FOCUS_PREFIX + _FOCUS_SEPARATOR.join(focus_labels) + _FOCUS_SUFFIX)
    # faithful / 未知 style → 不加风格指令（等价现状默认）

    extra = (extra_preference or "").strip()
    if extra:
        parts.append(_EXTRA_PREFERENCE_LABEL + extra)

    body = "\n".join(parts).strip()
    if not body:
        # faithful / 未知 style / 无可渲染内容 → 空串（不注入，不加框定语）
        return ""
    return _FRAMING_PREFIX + "\n" + body
