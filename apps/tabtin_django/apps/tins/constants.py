from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Tuple


@dataclass(frozen=True)
class ChoiceGroup:
    """与 scheduler.constants 保持一致的 choices 封装。"""
    _items: List[Tuple[str, str]] = field(default_factory=list)

    def as_choices(self) -> List[Tuple[str, str]]:
        return list(self._items)

    def values(self) -> List[str]:
        return [v for v, _ in self._items]


# ── Tin 状态 ──────────────────────────────────────
TIN_STATUS_CHOICES = ChoiceGroup([
    ("draft", "草稿"),
    ("active", "已启用"),
    ("disabled", "已停用"),
])

# ── Tin 来源 ──────────────────────────────────────
TIN_SOURCE_CHOICES = ChoiceGroup([
    ("agent_generated", "Agent 生成"),
    ("user_created", "用户创建"),
    ("market", "市场安装"),
    ("shared", "组织共享"),
])

# ── 激活模式 ──────────────────────────────────────
TIN_ACTIVATION_MODE_CHOICES = ChoiceGroup([
    ("auto", "自动展开"),
    ("suggest", "提示激活"),
    ("manual", "仅手动"),
])

# ── 规则匹配模式 ──────────────────────────────────
TIN_ACTIVATION_MATCH_CHOICES = ChoiceGroup([
    ("any", "任一匹配"),
    ("all", "全部匹配"),
])

# ── 激活规则类型 ──────────────────────────────────
TIN_ACTIVATION_RULE_TYPES = ChoiceGroup([
    ("url_pattern", "URL 匹配"),
    ("page_language", "页面语言"),
    ("page_content", "页面内容语义匹配"),
    ("always", "始终激活"),
])

# ── 权限声明 ──────────────────────────────────────
TIN_PERMISSIONS = ChoiceGroup([
    ("page_content", "读取页面内容"),
    ("page_selection", "读取选区文本"),
    ("page_inject", "注入页面脚本"),
    ("table_read", "读取表格"),
    ("table_write", "写入表格"),
    ("agent_invoke", "调用 Agent"),
    ("goal_trigger", "触发 Goal"),
    ("notification", "发送通知"),
])

# ── 运行日志操作类型 ──────────────────────────────
TIN_RUN_LOG_ACTION_CHOICES = ChoiceGroup([
    ("activate", "激活"),
    ("deactivate", "停用"),
    ("script_run", "脚本运行"),
    ("agent_invoke", "Agent 调用"),
    ("goal_trigger", "Goal 触发"),
    ("variable_update", "变量更新"),
    ("error", "错误"),
])

# ── UI 面板位置 ────────────────────────────────────
TIN_PANEL_POSITION_CHOICES = ChoiceGroup([
    ("sidebar_right", "右侧边栏"),
    ("sidebar_left", "左侧边栏"),
    ("bottom_panel", "底部面板"),
    ("overlay", "浮层"),
])

# ── Agent 工具名称 ─────────────────────────────────
TIN_ACTIVATE_TOOLS: List[str] = [
    "tin_create", "tin_update_file", "tin_list",
    "tin_activate", "tin_get_context",
]
