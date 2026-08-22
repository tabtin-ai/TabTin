"""
UserPortrait 蒸馏 Prompt 工具函数（v0.2 单 Organization 语境）。

System / User prompt 文本本身已迁到 LLMSceneBinding bundle：
  apps/tabtin_django/apps/services/llm/scenes/bundled/user_portrait_distill/

本模块只保留两类东西：
  1. SECTION_TITLES —— bundle 渲染后下游用来校验 5 段标题完整性
  2. format_*_line —— 把 TabMemo / hint 拼成 prompt 输入字符串的小工具

历史背景：v0.1 时代这里曾有 1642 字符 inline 系统 prompt 常量 + user message
拼装函数，违反 AI 能力统一宪法 §A.2（inline prompt 反例）。
v0.1 修复阶段（2026-05）已删除，全部走 unified_llm_call(scene_key='user_portrait_distill')。
"""

from __future__ import annotations


SECTION_TITLES = [
    "工作背景",
    "个人背景",
    "最近在想",
    "近期历史",
    "长期背景",
]


def format_memo_line(*, organization_name: str, created_at_iso: str, content: str) -> str:
    """把单条 TabMemo 格式化成 prompt 输入的一行。

    例：[Organization: 个人, 2026-04-15] 我把家里的三条狗都送人了

    注：v0.2 所有 memo 都来自同一个 Organization，行内仍然带 Organization 标签是为了
    跟时间一起作为可读的元信息——但模型层面已经被 system prompt 明确告知
    "本次只针对一个 Organization"，不会误以为存在多个。
    """
    safe_content = (content or "").strip().replace("\n", " ")
    if len(safe_content) > 500:
        safe_content = safe_content[:500] + "..."
    date_part = (created_at_iso or "")[:10] if created_at_iso else ""
    organization_label = organization_name or "未知"
    return f"[Organization: {organization_label}, {date_part}] {safe_content}"


def format_hint_line(*, text: str, submitted_at: str = "") -> str:
    """把单条 hint 格式化成 prompt 输入的一行。"""
    safe_text = (text or "").strip().replace("\n", " ")
    if submitted_at:
        return f"- [{submitted_at[:10]}] {safe_text}"
    return f"- {safe_text}"
