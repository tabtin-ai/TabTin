"""Scheduler 共享工具函数。"""

from __future__ import annotations

import heapq
import logging
import re
from datetime import datetime, timedelta
from typing import Iterator, Optional, Tuple

logger = logging.getLogger("scheduler.utils")

# 日历预览：单任务 / 全量 occurrence 上限（避免无界循环）。
SCHEDULE_PREVIEW_PER_TRACKER_LIMIT = 200
SCHEDULE_PREVIEW_TOTAL_LIMIT = 2000
SCHEDULE_PREVIEW_MAX_WINDOW_DAYS = 42
SCHEDULE_PREVIEW_QUERY_CHUNK_SIZE = 1000


_SENSITIVE_PATTERNS = [
    (re.compile(r'/\S*tabtin\S*', re.IGNORECASE), '[internal_path]'),
    (re.compile(r'host\s+"[^"]*"\s+port\s+\d+', re.IGNORECASE), '[db_connection]'),
    (re.compile(r'(api[_-]?key|secret|token|password)\s*[:=]\s*\S+', re.IGNORECASE), '[redacted]'),
    (re.compile(r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?'), '[host:port]'),
    (re.compile(r'\w+://\S+:\S+@\S+', re.IGNORECASE), '[connection_uri]'),
    (re.compile(r'File\s+"[^"]*\.py"', re.IGNORECASE), '[traceback_path]'),
]


def sanitize_error_for_user(msg: str) -> str:
    """对错误信息做脱敏，防止内部路径、DB 连接信息、凭据泄露给用户。"""
    for pattern, replacement in _SENSITIVE_PATTERNS:
        msg = pattern.sub(replacement, msg)
    return msg


# ── Wave 6 (charter v1.8 §4.4 / §6.7) — Skill 失败信息翻译 ───────────────
#
# Skill 失败汇报必须是"人话 + 恢复建议",不许把堆栈/错误码/技术名词扔给用户。
# 落地方式参考 plan §Phase 6 / 总控 §4 Wave 6:
#   方案 A: packages/skills/README.md 加规范
#   方案 B: 工具函数 translate_skill_error 在 TrackerRun 状态写入前自动 sanitize
#   方案 C: 写入 error_summary 前做断言(无堆栈格式 / 无错误码字面)
# 本期采用 A+B+C 组合,本模块承担 B+C 实现。
#
# 设计约束:
#   - 翻译规则按"现象 → 人话 + 恢复动作"两段式产出;调用方拿到 dict
#     可决定是否拼装到 ChatSession 末尾消息(charter §4.4 留痕)
#   - 默认 fallback "执行没能完成,请稍后再试或换个 Agent 重新尝试" — 永远
#     不会甩出原始 exc str
#   - 检测堆栈/错误码格式作为断言失败兜底(WAR_FOR_USER 通知日志,但仍返回安全文案)


# 堆栈/错误码常见特征(用于 _is_raw_traceback_or_error_code 断言)。
# 这些 pattern 命中即视为"未翻译,仍是技术错误":
#   - Traceback (most recent call last) — Python 标准堆栈头
#   - File ".../xxx.py", line NN — 行号标记
#   - <ClassName: ...> — Python repr 格式异常
#   - ValueError / RuntimeError / KeyError 等异常类名 + ":" 开头
#   - error_code= / errno: 后跟代码
_RAW_TRACEBACK_MARKERS = (
    re.compile(r'Traceback\s*\(', re.IGNORECASE),
    re.compile(r'File\s+["\']([^"\']*\.py)["\']', re.IGNORECASE),
    re.compile(r'\bat\s+line\s+\d+', re.IGNORECASE),
    # 异常类名 + ":" 开头(允许 prefix 任意空白/标点)
    # 误判风险已知:用户失败叙述里偶尔出现"ValueError: xxx"。本期接受偏严控。
    re.compile(r'(?:^|[^a-zA-Z])([A-Z][a-zA-Z]+(?:Error|Exception|Warning))\s*:', re.MULTILINE),
    re.compile(r'errno\s*[:=]\s*-?\d+', re.IGNORECASE),
    re.compile(r'error_code\s*[:=]', re.IGNORECASE),
    re.compile(r'<[A-Z][a-zA-Z]+\s+object\s+at\s+0x', re.IGNORECASE),  # <Foo object at 0x...>
)


def _is_raw_traceback_or_error_code(msg: str) -> bool:
    """检测字符串是否仍是"堆栈或错误码"未翻译形态。

    True = 仍是技术语言(违反 charter §4.4 / Wave 6 6.1),应被翻译或拒绝。
    """
    if not msg:
        return False
    for marker in _RAW_TRACEBACK_MARKERS:
        if marker.search(msg):
            return True
    return False


# 已知技术错误关键词 → 人话 + 恢复建议(Wave 6 6.1)。
#
# 匹配规则:lowercase substring 匹配,长 key 优先(更具体的 key 先匹配)。
# 每条:(message, recovery)。message 是面向用户的现象描述;recovery 是
# 一句带"动作"的提示(charter §4.4 留痕 + 6.7 失败汇报"像同事一样")。
#
# **永远不要在 message / recovery 里出现:堆栈、错误码、内部模块名、
# python 类名、SQL/Redis 之类的基础设施名词** — 这是宪法 §4.4 硬约束。
_KNOWN_ERROR_PATTERNS: Tuple[Tuple[str, str, str], ...] = (
    (
        "llm_proxy_result_backend_unavailable",
        "远程数据库/结果服务暂时不可用,这次 Tracker 没能拿到模型执行结果",
        "请稍后重试;如果连续出现,请联系管理员检查数据库连接状态。",
    ),
    (
        "llm proxy database unavailable",
        "远程数据库/结果服务暂时不可用,这次 Tracker 没能拿到模型执行结果",
        "请稍后重试;如果连续出现,请联系管理员检查数据库连接状态。",
    ),
    (
        "远程数据库/结果服务暂时不可用",
        "远程数据库/结果服务暂时不可用,这次 Tracker 没能拿到模型执行结果",
        "请稍后重试;如果连续出现,请联系管理员检查数据库连接状态。",
    ),
    (
        "llm proxy server error (500)",
        "模型请求服务暂时不可用,这次 Tracker 没能拿到模型执行结果",
        "请稍后重试;如果连续出现,请联系管理员检查服务状态。",
    ),
    (
        "kimi returned empty",
        "我用的 kimi 模型这次没返回结果,可能是接口暂时不稳定",
        "要不要换 GPT-4 重试?",
    ),
    (
        "openai",
        "调用 OpenAI 模型的过程中出了问题,可能是网络抖动或额度限制",
        "可以换个模型(比如 Claude / Kimi)再试一次。",
    ),
    (
        "rate limit",
        "刚才调用的速度太快被限流了",
        "稍等 1-2 分钟再试,或换一个模型分担。",
    ),
    (
        # 模型上游 429 / engine_overloaded（中文 user_message 常见形态）
        "模型上游返回错误",
        "模型服务现在太忙了,这次没能拿到结果",
        "稍等 1-2 分钟再试,或换一个模型重试。",
    ),
    (
        "engine overloaded",
        "模型服务现在太忙了,这次没能拿到结果",
        "稍等 1-2 分钟再试,或换一个模型重试。",
    ),
    (
        "engine_overloaded",
        "模型服务现在太忙了,这次没能拿到结果",
        "稍等 1-2 分钟再试,或换一个模型重试。",
    ),
    (
        # 裸 429 状态码（英文/中文混排错误里常见）；用带边界的形态避免误伤端口号
        "(429)",
        "模型服务现在太忙了,这次没能拿到结果",
        "稍等 1-2 分钟再试,或换一个模型重试。",
    ),
    (
        "status=429",
        "模型服务现在太忙了,这次没能拿到结果",
        "稍等 1-2 分钟再试,或换一个模型重试。",
    ),
    (
        "http 429",
        "模型服务现在太忙了,这次没能拿到结果",
        "稍等 1-2 分钟再试,或换一个模型重试。",
    ),
    (
        "device_dropped",
        "执行设备在任务中途掉线了,这次没能跑完",
        "请确认客户端在线后重试;设备上线后系统也会自动重派。",
    ),
    (
        "dropped to offline",
        "执行设备在任务中途掉线了,这次没能跑完",
        "请确认客户端在线后重试;设备上线后系统也会自动重派。",
    ),
    (
        "timed out",
        "执行时间超过了上限,任务被自动中止",
        "可以让我把任务拆细一些,或者换更快的模型重试。",
    ),
    (
        "timeout",
        "执行时间超过了上限,任务被自动中止",
        "可以让我把任务拆细一些,或者换更快的模型重试。",
    ),
    (
        "超时",
        "这次执行超时了",
        "要不要重新跑一次,或者把范围调小一点?",
    ),
    (
        "connection reset",
        "网络连接被中断了,这次没能完成",
        "等网络稳定后让我重新跑一次。",
    ),
    (
        "connection refused",
        "依赖的服务暂时连不上",
        "稍后再试一次,或者告诉我换一种实现方式。",
    ),
    (
        # GH ：Redis 等结果存储在等待窗口内持续不可用，导致无法确认本次
        # 执行的最终状态（任务很可能已成功）。不能误标成「执行时间超过了上限」。
        "result_backend_unavailable",
        "这次执行可能已经完成,但我暂时连不上结果存储,没法确认最终状态",
        "稍等一两分钟再看一眼,或者重新运行一次确认。",
    ),
    (
        "runtime done returned error",
        "执行 Agent 这次返回了失败状态,但没有带回更具体的错误详情",
        "可以重新运行一次;如果连续出现,请换一个 Agent / 模型重试。",
    ),
    (
        "insufficient_credits",
        "组织的额度不够本次执行",
        "可以联系管理员充值,或换一个更省的模型再试。",
    ),
    (
        "budget_exceeded",
        "已经超过本月预算上限",
        "调整预算或下个周期再来跑这个任务。",
    ),
    (
        "permission denied",
        "我没有权限完成这一步",
        "请帮我开通对应的资源访问权限再试。",
    ),
    (
        # TS-39：执行 Agent 仍绑定旧离线设备时，设备路径会返回
        # error_category=device_offline。这个场景用户可自助恢复，不能落到
        # “原因暂时没看清楚”的兜底文案。
        "device_offline",
        "执行这个 Tracker 的 Agent 绑定的设备当前离线,所以任务还没开始就停止了",
        "请把这个 Agent 重新绑定到一台在线设备,或者换一个已在线的 Agent 后重试。",
    ),
    (
        "not found",
        "我需要的资源没找到",
        "确认一下被引用的对象还在不在,或者换一份输入再让我跑。",
    ),
    (
        "agent 未返回有效结果",
        "Agent 这次执行没生成实际结果",
        "可以让我换个角度再试一次,或者看看是不是输入太模糊。",
    ),
    (
        "skill 未找到",
        "我引用的 Skill 找不到了,可能是被删了或还没安装",
        "确认 Skill 是否已安装,然后重新跑这个任务。",
    ),
    (
        "skill 解析失败",
        "我引用的 Skill 无法解析,可能配置出错了",
        "看看 Skill 的内容是否完整,或换一个 Skill 重试。",
    ),
    (
        "tracker 未关联 skill",
        "这个 Tracker 还没绑定 Skill,无法执行",
        "在 Tracker 设置里挑一个合适的 Skill 再激活。",
    ),
    (
        "未找到",
        "我需要的资源没找到",
        "确认一下被引用的对象还在不在,或者换一份输入再让我跑。",
    ),
    (
        "无法发起 agent 执行",
        "执行 Tracker 的人(创建者账号)已经不在了",
        "可以让一位仍在组织的成员重新接管这个 Tracker。",
    ),
    (
        # TS-18（v1 决策 C）：执行 Agent 未绑定可用设备时，无人值守任务无法运行
        # （lightweight 路径会 fire-and-forget 静默失败）。当场清晰失败 + 引导绑设备。
        "未绑定可用设备",
        "执行这个 Tracker 的 Agent 还没绑定可用设备,无法运行无人值守任务",
        "请在 Agent 设置里绑定一个在线设备后重试。",
    ),
    (
        "execution failed",
        "执行没能跑完",
        "稍后再试一次；若持续失败，请查看执行记录详情或换一个 Agent。",
    ),
    (
        "未填写执行指令",
        "这个自动化任务还没写执行指令,Agent 不知道要做什么",
        "请编辑任务,在「执行指令」里写清楚要 Agent 做什么,保存后再试。",
    ),
    (
        # 仅系统默认模型链全空时出现；自动化本应走默认模型，不要求用户手选。
        "系统默认模型解析失败",
        "系统暂时找不到可用的默认聊天模型",
        "这通常是模型路由配置问题，请联系管理员检查后再试。",
    ),
)


_DEFAULT_FALLBACK_MESSAGE = "这次执行没跑完,具体原因暂时还没看清楚。"
_DEFAULT_FALLBACK_RECOVERY = "可以稍等再试一次,或者换一个 Agent / 模型重试。"


# ── Wave 6 续作 (charter §4.4 / plan §Phase 6 验收 #1) — 结构化 RecoveryAction ───
#
# Wave 6 主实施只把 recovery_actions 拼成纯文本写进 error_summary,前端拿不到
# "可点击的恢复动作"。续作把 RecoveryAction 升级为结构化字段,前端按 enum
# 渲染按钮(每个按钮触发明确动作)。
#
# RecoveryAction enum 设计(本期 v1):
#   - rerun:             重新跑一次(沿用原配置)
#   - retry_with_model:  换模型重试(model 字段指定 model_id)
#   - switch_agent:      换 Agent 重试(本期不指定具体 Agent,跳详情页人选)
#   - check_permission:  检查权限/资源后重试(打开 Tracker 配置面板)
#   - adjust_budget:     调整预算/额度(跳 settings/billing)
#   - wait_and_rerun:    稍等再试(给 1-2 分钟冷却时间)
#
# 如果未来需要更多动作,扩 enum + 在前端 TrackerRunStatusIndicator 渲染层
# 加 case,不要再回退到纯文本。

_RECOVERY_ACTION_KINDS = {
    "rerun",
    "retry_with_model",
    "switch_agent",
    "check_permission",
    "adjust_budget",
    "wait_and_rerun",
}


def make_recovery_action(
    *,
    kind: str,
    label: str,
    model: Optional[str] = None,
) -> dict:
    """构造一条结构化 RecoveryAction(charter §4.4 / plan §Phase 6 验收 #1)。

    返回:
      {
        "kind": "<RecoveryActionKind>",
        "label": "<面向用户的中文短句,直接渲染为按钮文字>",
        "model": "<可选,仅 retry_with_model 用>",
      }

    kind 不在 enum 内 → 视为非法,记 warning + 退化为 ``rerun``。
    """
    safe_kind = kind if kind in _RECOVERY_ACTION_KINDS else "rerun"
    if safe_kind != kind:
        logger.warning(
            "[make_recovery_action] unknown kind=%r, falling back to rerun. label=%r",
            kind, label,
        )
    action: dict = {"kind": safe_kind, "label": label}
    if model and safe_kind == "retry_with_model":
        action["model"] = model
    return action


# 翻译规则配套的 RecoveryAction 模板:每个 _KNOWN_ERROR_PATTERNS 条目
# 在文本 recovery 之外,**额外**关联一组结构化 RecoveryAction,前端按
# 顺序渲染按钮。
#
# 与 _KNOWN_ERROR_PATTERNS needle 索引对齐(同 needle → 同动作集)。
# 没列出的 needle → 走 _DEFAULT_RECOVERY_ACTIONS 兜底。
_NEEDLE_TO_ACTIONS: dict[str, list[dict]] = {
    "llm_proxy_result_backend_unavailable": [
        {"kind": "wait_and_rerun", "label": "稍后重试"},
    ],
    "llm proxy database unavailable": [
        {"kind": "wait_and_rerun", "label": "稍后重试"},
    ],
    "远程数据库/结果服务暂时不可用": [
        {"kind": "wait_and_rerun", "label": "稍后重试"},
    ],
    "llm proxy server error (500)": [
        {"kind": "wait_and_rerun", "label": "稍后重试"},
    ],
    "kimi returned empty": [
        {"kind": "retry_with_model", "label": "换 GPT-4 重试", "model": "gpt-4"},
        {"kind": "rerun", "label": "重新运行"},
    ],
    "openai": [
        {"kind": "retry_with_model", "label": "换 Claude 重试", "model": "claude-sonnet-4"},
        {"kind": "retry_with_model", "label": "换 Kimi 重试", "model": "kimi"},
        {"kind": "rerun", "label": "重新运行"},
    ],
    "rate limit": [
        {"kind": "wait_and_rerun", "label": "等 1-2 分钟再试"},
        {"kind": "retry_with_model", "label": "换个模型重试", "model": "claude-sonnet-4"},
    ],
    "模型上游返回错误": [
        {"kind": "wait_and_rerun", "label": "等 1-2 分钟再试"},
        {"kind": "retry_with_model", "label": "换个模型重试", "model": "claude-sonnet-4"},
    ],
    "engine overloaded": [
        {"kind": "wait_and_rerun", "label": "等 1-2 分钟再试"},
        {"kind": "retry_with_model", "label": "换个模型重试", "model": "claude-sonnet-4"},
    ],
    "engine_overloaded": [
        {"kind": "wait_and_rerun", "label": "等 1-2 分钟再试"},
        {"kind": "retry_with_model", "label": "换个模型重试", "model": "claude-sonnet-4"},
    ],
    "(429)": [
        {"kind": "wait_and_rerun", "label": "等 1-2 分钟再试"},
        {"kind": "retry_with_model", "label": "换个模型重试", "model": "claude-sonnet-4"},
    ],
    "status=429": [
        {"kind": "wait_and_rerun", "label": "等 1-2 分钟再试"},
        {"kind": "retry_with_model", "label": "换个模型重试", "model": "claude-sonnet-4"},
    ],
    "http 429": [
        {"kind": "wait_and_rerun", "label": "等 1-2 分钟再试"},
        {"kind": "retry_with_model", "label": "换个模型重试", "model": "claude-sonnet-4"},
    ],
    "device_dropped": [
        {"kind": "wait_and_rerun", "label": "等设备上线后再试"},
        {"kind": "switch_agent", "label": "换一个在线 Agent"},
    ],
    "dropped to offline": [
        {"kind": "wait_and_rerun", "label": "等设备上线后再试"},
        {"kind": "switch_agent", "label": "换一个在线 Agent"},
    ],
    "timed out": [
        {"kind": "rerun", "label": "重新运行"},
        {"kind": "retry_with_model", "label": "换更快的模型", "model": "claude-haiku-4"},
    ],
    "timeout": [
        {"kind": "rerun", "label": "重新运行"},
        {"kind": "retry_with_model", "label": "换更快的模型", "model": "claude-haiku-4"},
    ],
    "超时": [
        {"kind": "rerun", "label": "重新运行"},
    ],
    "connection reset": [
        {"kind": "wait_and_rerun", "label": "等网络恢复后再试"},
        {"kind": "rerun", "label": "立即重试"},
    ],
    "connection refused": [
        {"kind": "wait_and_rerun", "label": "稍后再试"},
    ],
    "result_backend_unavailable": [
        {"kind": "wait_and_rerun", "label": "等一会儿再看"},
        {"kind": "rerun", "label": "重新运行确认"},
    ],
    "runtime done returned error": [
        {"kind": "rerun", "label": "重新运行"},
        {"kind": "switch_agent", "label": "换一个 Agent"},
    ],
    "insufficient_credits": [
        {"kind": "adjust_budget", "label": "去额度页充值"},
        {"kind": "retry_with_model", "label": "换更省的模型", "model": "claude-haiku-4"},
    ],
    "budget_exceeded": [
        {"kind": "adjust_budget", "label": "调整预算"},
    ],
    "permission denied": [
        {"kind": "check_permission", "label": "检查并授权后重试"},
    ],
    "device_offline": [
        {"kind": "switch_agent", "label": "换一个在线 Agent"},
        {"kind": "rerun", "label": "重新绑定设备后重试"},
    ],
    "not found": [
        {"kind": "rerun", "label": "重新运行"},
    ],
    "agent 未返回有效结果": [
        {"kind": "rerun", "label": "重新运行"},
        {"kind": "switch_agent", "label": "换一个 Agent"},
    ],
    "skill 未找到": [
        {"kind": "rerun", "label": "确认 Skill 后重试"},
    ],
    "skill 解析失败": [
        {"kind": "rerun", "label": "重新运行"},
    ],
    "tracker 未关联 skill": [
        {"kind": "check_permission", "label": "去配置 Skill"},
    ],
    "未找到": [
        {"kind": "rerun", "label": "重新运行"},
    ],
    "无法发起 agent 执行": [
        {"kind": "switch_agent", "label": "换一位接管这个 Tracker"},
    ],
    # TS-18（v1 决策 C）：未绑设备时引导换一个已绑设备的 Agent，或绑设备后重跑。
    "未绑定可用设备": [
        {"kind": "switch_agent", "label": "换一个已绑定设备的 Agent"},
        {"kind": "rerun", "label": "绑定设备后重新运行"},
    ],
    "未填写执行指令": [
        {"kind": "check_permission", "label": "去编辑任务补上指令"},
    ],
    "系统默认模型解析失败": [
        {"kind": "rerun", "label": "稍后再试"},
        {"kind": "switch_agent", "label": "换一个 Agent"},
    ],
    "execution failed": [
        {"kind": "rerun", "label": "重新运行"},
        {"kind": "switch_agent", "label": "换一个 Agent"},
    ],
}

_DEFAULT_RECOVERY_ACTIONS: list[dict] = [
    {"kind": "rerun", "label": "重新运行"},
    {"kind": "switch_agent", "label": "换一个 Agent"},
]


def _is_llm_proxy_database_unavailable(raw: str) -> bool:
    """识别 LLM proxy 500 背后的数据库连接故障,避免误标成模型异常。"""
    lower = raw.lower()
    if "llm proxy" not in lower:
        return False
    has_proxy_500 = "server error (500)" in lower or "status=500" in lower or " 500" in lower
    has_db_marker = any(
        marker in lower
        for marker in (
            "operationalerror",
            "databaseerror",
            "database error",
            "database unavailable",
            "connection to server",
            "could not connect to server",
            "pg.rds.aliyuncs.com",
            ":5432",
        )
    )
    has_timeout_marker = any(
        marker in lower
        for marker in (
            "timeout",
            "timed out",
            "timeout expired",
            "connection attempt failed",
            "could not connect",
        )
    )
    return has_proxy_500 and has_db_marker and has_timeout_marker


def translate_skill_error(
    raw_error: str,
    *,
    skill_key: Optional[str] = None,
    error_category: Optional[str] = None,
) -> dict:
    """把 Skill 失败时的技术错误翻译成"人话 + 恢复建议"。

    charter v1.8 §4.4 / Wave 6 6.1:Skill 失败汇报 ChatSession 末尾 Agent
    消息**必须**包含人话现象 + 恢复动作建议,**不允许**把原始堆栈/错误码
    /模块名直接抛出。

    参数:
      raw_error: Skill 抛出的技术错误(可能是 ``str(exc)`` 或 ``f"{tag}: {exc}"``)
      skill_key: 当前 Skill 标识,可让翻译规则按 Skill 定制(暂未消费,预留)
      error_category: 上游 Agent 协议的 ``error_category`` 字段(例:
        ``rate_limit`` / ``budget_exceeded``),优先级高于 raw_error 关键词

    返回:
      {
        "message": str,                  # 现象描述(人话,无堆栈)
        "recovery_actions": list[str],   # 恢复动作的"文本话语"(向后兼容,每条一句话)
        "recovery_action_items": list[dict],  # 结构化 RecoveryAction(charter §4.4 续作 P0-4)
                                              # 每条:{kind, label, model?}
      }

    实现:
      1. 先按 ``error_category`` 匹配(更精确的协议级分类)
      2. 再按 ``raw_error`` 内容做 substring 匹配(对开发期没分类的场景兜底)
      3. 都未命中 → fallback 通用文案("可以稍等再试一次,或者换一个 Agent")
      4. 整段输出再过 ``sanitize_error_for_user`` 防内部路径泄露
      5. ``recovery_action_items`` 由命中 needle 在 ``_NEEDLE_TO_ACTIONS`` 查表得到;
         未命中走 ``_DEFAULT_RECOVERY_ACTIONS``
    """
    raw = (raw_error or "").strip()
    cat = (error_category or "").strip().lower()

    matched_message: Optional[str] = None
    matched_recovery: Optional[str] = None
    matched_needle: Optional[str] = None  # Wave 6 续作:用于反查 _NEEDLE_TO_ACTIONS

    # 1) error_category 直查(更可靠,因 protocol 已分类)
    # category 字段惯例使用下划线(rate_limit),关键词字典里用空格 + 下划线
    # 都尝试一遍,匹配更宽容。
    if cat:
        cat_underscored = cat.replace(" ", "_")
        cat_spaced = cat.replace("_", " ")
        if cat_underscored in (
            "llm_proxy_result_backend_unavailable",
            "llm_proxy_database_unavailable",
        ):
            cat = "llm_proxy_result_backend_unavailable"
            cat_underscored = cat
            cat_spaced = cat.replace("_", " ")
        for needle, msg, rec in _KNOWN_ERROR_PATTERNS:
            n = needle.lower()
            n_underscored = n.replace(" ", "_")
            if (
                n == cat
                or n in cat
                or n_underscored == cat
                or n_underscored in cat_underscored
                or n in cat_spaced
            ):
                matched_message = msg
                matched_recovery = rec
                matched_needle = n
                break

    # 2) raw_error substring 匹配(兜底)
    if matched_message is None and raw:
        lower = raw.lower()
        # skill_executor 外层 catch 会包一层 ``execution failed: {exc}``。
        # 若先命中笼统的 "execution failed" needle，会把真实原因（额度/设备/权限）
        # 吞成「执行没能跑完」。先剥前缀，用细节再匹配一次。
        match_sources = [raw]
        if lower.startswith("execution failed:"):
            detail = raw.split(":", 1)[1].strip()
            if detail:
                match_sources.insert(0, detail)

        matched_from_detail = False
        for source in match_sources:
            source_lower = source.lower()
            if _is_llm_proxy_database_unavailable(source):
                matched_message = "远程数据库/结果服务暂时不可用,这次 Tracker 没能拿到模型执行结果"
                matched_recovery = "请稍后重试;如果连续出现,请联系管理员检查数据库连接状态。"
                matched_needle = "llm proxy database unavailable"
                matched_from_detail = True
                break
            if "control_device" in source_lower and re.search(r"status\s*=\s*offline", source_lower):
                matched_message = "执行这个 Tracker 的 Agent 绑定的设备当前离线,所以任务还没开始就停止了"
                matched_recovery = "请把这个 Agent 重新绑定到一台在线设备,或者换一个已在线的 Agent 后重试。"
                matched_needle = "device_offline"
                matched_from_detail = True
                break
            for needle, msg, rec in _KNOWN_ERROR_PATTERNS:
                n = needle.lower()
                # 笼统 wrapper 只允许在「没有更细细节」时命中，避免吞掉后缀原因
                if n == "execution failed" and source is not match_sources[-1]:
                    continue
                if n == "execution failed" and source_lower.startswith("execution failed:") and ":" in source:
                    # 仍有后缀细节但未命中其它规则时，留给后面的 fallback / 末轮匹配
                    continue
                if n in source_lower:
                    matched_message = msg
                    matched_recovery = rec
                    matched_needle = n
                    matched_from_detail = True
                    break
            if matched_from_detail:
                break

        # 仅当整段就是笼统的 execution failed（无可用细节）时，才用人话兜底句。
        # 有后缀但未识别时，带上脱敏后的短原因，避免运维/用户只能看到「没能跑完」。
        if matched_message is None and "execution failed" in lower:
            detail = ""
            if lower.startswith("execution failed:"):
                detail = sanitize_error_for_user(raw.split(":", 1)[1].strip())
            if detail and not _is_raw_traceback_or_error_code(detail) and len(detail) <= 160:
                matched_message = f"执行没能跑完（{detail}）"
            else:
                matched_message = "执行没能跑完"
            matched_recovery = "稍后再试一次；若持续失败，请查看执行记录详情或换一个 Agent。"
            matched_needle = "execution failed"

    # 3) fallback
    if matched_message is None:
        # raw 已是人话（无堆栈/错误码）时直接透传，避免谎称「没有带回详情」。
        if raw and not _is_raw_traceback_or_error_code(raw):
            matched_message = sanitize_error_for_user(raw)[:300]
            matched_recovery = _DEFAULT_FALLBACK_RECOVERY
            matched_needle = None
        elif cat == "runtime_failed":
            matched_message = "执行 Agent 这次返回了失败状态,但没有带回更具体的错误详情"
            matched_recovery = "可以重新运行一次;如果连续出现,请换一个 Agent / 模型重试。"
            matched_needle = "runtime done returned error"
        else:
            matched_message = _DEFAULT_FALLBACK_MESSAGE
            matched_recovery = _DEFAULT_FALLBACK_RECOVERY
            matched_needle = None

    # 4) 输出前再过一遍脱敏(以防 needle 命中但 raw 仍混进 message)
    safe_message = sanitize_error_for_user(matched_message)
    safe_recovery = sanitize_error_for_user(matched_recovery or "")

    # 5) 自校验:输出仍是堆栈格式时,直接走 fallback(防止规则误命中"伪人话")
    if _is_raw_traceback_or_error_code(safe_message):
        logger.warning(
            "[translate_skill_error] translation still looks like traceback, "
            "falling back to default. raw=%r skill_key=%s",
            raw[:200], skill_key,
        )
        safe_message = _DEFAULT_FALLBACK_MESSAGE
        safe_recovery = _DEFAULT_FALLBACK_RECOVERY
        matched_needle = None

    # 6) Wave 6 续作 (charter §4.4 / plan §Phase 6 验收 #1):反查结构化 RecoveryAction
    if matched_needle and matched_needle in _NEEDLE_TO_ACTIONS:
        action_items = [
            make_recovery_action(**item)
            for item in _NEEDLE_TO_ACTIONS[matched_needle]
        ]
    else:
        action_items = [
            make_recovery_action(**item) for item in _DEFAULT_RECOVERY_ACTIONS
        ]

    return {
        "message": safe_message,
        "recovery_actions": [safe_recovery] if safe_recovery else [],
        "recovery_action_items": action_items,
    }


def assert_failure_message_is_human_readable(msg: str) -> bool:
    """断言失败消息已经"人话化"——返回 True 即合规,False 表明仍含堆栈/错误码。

    Wave 6 6.1 落地约束:Run service 在写入 ``TrackerRun.error_summary`` /
    ``progress_message`` 等用户可见字段前调用此断言,违规则记日志(暂不抛
    异常,避免引入新故障路径)。

    判定:
      - 含 ``Traceback`` / ``File "...py"`` / ``at line N`` / ``XxxError:`` 模式
      - 含 ``error_code=`` / ``errno: -N`` 模式
      - 含 Python repr 格式 ``<X object at 0xN>``
      - 任一命中 → False(违规)
    """
    return not _is_raw_traceback_or_error_code(msg)


def humanize_failure_message(
    raw_error: str,
    *,
    skill_key: Optional[str] = None,
    error_category: Optional[str] = None,
) -> str:
    """把 raw_error 翻译为单一字符串(message + 恢复建议拼接),供 ``TrackerRun.error_summary``
    等单字段写入路径直接使用。

    charter v1.8 §4.4 / Wave 6 6.1 强制:任何写入 ``error_summary`` 的代码
    路径都应通过此函数过一遍,不允许直接 ``str(exc)`` 写入。
    """
    payload = translate_skill_error(
        raw_error,
        skill_key=skill_key,
        error_category=error_category,
    )
    if payload["recovery_actions"]:
        return f"{payload['message']} {payload['recovery_actions'][0]}".strip()
    return payload["message"]


def default_cron_timezone() -> str:
    """cron 缺省时区：跟 Django ``TIME_ZONE``（产品默认 Asia/Shanghai）走。

    历史默认曾是 UTC，导致「每天 09:00」在东八区实际 17:00 触发。
    UI / CLI 应显式写 IANA；此处兜底保证漏传也不再按 UTC 解析墙钟。
    """
    from django.conf import settings

    return (getattr(settings, "TIME_ZONE", None) or "Asia/Shanghai").strip() or "Asia/Shanghai"


def ensure_cron_timezone(trigger_type: str, trigger_config: dict | None) -> dict:
    """cron 触发配置入库前补齐 ``timezone``；其它类型原样返回副本。"""
    cfg = dict(trigger_config or {})
    if (trigger_type or "").strip() != "cron":
        return cfg
    tz = cfg.get("timezone")
    if isinstance(tz, str) and tz.strip():
        cfg["timezone"] = tz.strip()
        return cfg
    cfg["timezone"] = default_cron_timezone()
    return cfg


def compute_next_run_at(
    trigger_type: str,
    trigger_config: dict,
    *,
    fail_loud: bool = False,
) -> Optional[datetime]:
    """根据触发类型和配置计算下次执行时间。

    统一兼容新旧 key 命名：
      cron:     cron_expression | expression
      interval: interval_seconds | seconds
      at:       at（ISO 格式字符串）
    """
    from django.utils import timezone

    config = trigger_config or {}

    if trigger_type == "cron":
        cron_expr = config.get("cron_expression") or config.get("expression", "")
        if not cron_expr:
            return None
        try:
            from croniter import croniter as Croniter
            import pytz

            raw_tz = config.get("timezone")
            tz_name = (
                raw_tz.strip()
                if isinstance(raw_tz, str) and raw_tz.strip()
                else default_cron_timezone()
            )
            tz = pytz.timezone(tz_name)
            now_tz = timezone.now().astimezone(tz)
            next_time = Croniter(cron_expr, now_tz).get_next(datetime)
            if timezone.is_naive(next_time):
                next_time = tz.localize(next_time)
            return next_time.astimezone(timezone.get_current_timezone())
        except Exception:
            logger.warning("cron 表达式解析失败: %s", cron_expr, exc_info=True)
            if fail_loud:
                from django.core.exceptions import ValidationError
                raise ValidationError(f"Cron 表达式无效或时区不可用：{cron_expr}")
            return None

    elif trigger_type == "interval":
        seconds = config.get("interval_seconds") or config.get("seconds", 3600)
        return timezone.now() + timedelta(seconds=int(seconds))

    elif trigger_type == "at":
        at_str = config.get("at")
        if at_str:
            try:
                from django.utils.dateparse import parse_datetime
                dt = parse_datetime(at_str)
                if dt and timezone.is_naive(dt):
                    dt = timezone.make_aware(dt)
                return dt
            except Exception:
                logger.warning("at 时间解析失败: %s", at_str, exc_info=True)
                if fail_loud:
                    from django.core.exceptions import ValidationError
                    raise ValidationError(f"'at' 时间格式无效：{at_str}")
        return None

    return None


def _coerce_aware_datetime(value: object) -> Optional[datetime]:
    if not isinstance(value, datetime):
        return None
    from django.utils import timezone as dj_tz

    if dj_tz.is_naive(value):
        return dj_tz.make_aware(value)
    return value


def iter_schedule_occurrences(
    trigger_type: str,
    trigger_config: dict,
    *,
    next_run_at: Optional[datetime],
    window_start: datetime,
    window_end: datetime,
    max_count: int = SCHEDULE_PREVIEW_PER_TRACKER_LIMIT,
    last_run_at: Optional[datetime] = None,
    created_at: Optional[datetime] = None,
) -> Iterator[datetime]:
    """展开 [window_start, window_end) 内的虚拟未来执行点（不落库）。

    锚点与本机持钟一致：上次执行 / 创建时间 / 规则；``next_run_at`` 只作历史 leftover 回退。
    """
    if max_count <= 0 or window_end <= window_start:
        return

    from django.utils import timezone as dj_tz

    config = trigger_config or {}
    tt = (trigger_type or "").strip()
    last_run_at = _coerce_aware_datetime(last_run_at)
    created_at = _coerce_aware_datetime(created_at)
    next_run_at = _coerce_aware_datetime(next_run_at)
    if next_run_at is None and last_run_at is None and created_at is None and tt != "at":
        return
    if dj_tz.is_naive(window_start):
        window_start = dj_tz.make_aware(window_start)
    if dj_tz.is_naive(window_end):
        window_end = dj_tz.make_aware(window_end)

    if tt == "interval":
        raw_seconds = config.get("interval_seconds") or config.get("seconds", 3600)
        try:
            seconds = int(raw_seconds)
        except (TypeError, ValueError):
            return
        if seconds <= 0:
            return
        if last_run_at is not None:
            cursor = last_run_at + timedelta(seconds=seconds)
        elif created_at is not None:
            cursor = created_at + timedelta(seconds=seconds)
        else:
            cursor = next_run_at
        if cursor is None:
            return
        # 若锚点早于窗口起点，步进到窗口内（仍保持锚点相位）。
        if cursor < window_start:
            delta = window_start - cursor
            steps = int(delta.total_seconds() // seconds)
            cursor = cursor + timedelta(seconds=steps * seconds)
            if cursor < window_start:
                cursor = cursor + timedelta(seconds=seconds)
        count = 0
        while cursor < window_end and count < max_count:
            if cursor >= window_start:
                yield cursor
                count += 1
            cursor = cursor + timedelta(seconds=seconds)
        return

    if tt == "at":
        point = next_run_at
        at_str = config.get("at") if point is None else None
        if point is None and at_str:
            try:
                from django.utils.dateparse import parse_datetime

                parsed = parse_datetime(at_str)
                if parsed is not None:
                    if dj_tz.is_naive(parsed):
                        parsed = dj_tz.make_aware(parsed)
                    point = parsed
            except Exception:
                logger.warning("schedule preview at 解析失败: %s", at_str, exc_info=True)
        if point is not None and window_start <= point < window_end:
            yield point
        return

    if tt == "cron":
        cron_expr = config.get("cron_expression") or config.get("expression", "")
        if not cron_expr:
            return
        try:
            from croniter import croniter as Croniter
            import pytz

            raw_tz = config.get("timezone")
            tz_name = (
                raw_tz.strip()
                if isinstance(raw_tz, str) and raw_tz.strip()
                else default_cron_timezone()
            )
            tz = pytz.timezone(tz_name)
            # 锚点本身若在窗口内则先产出；后续用 croniter.get_next 推进。
            # 与 compute_next_run_at 一致：在 IANA 墙钟上迭代，再转回当前 Django TZ。
            current_tz = dj_tz.get_current_timezone()
            count = 0
            skip_anchor = last_run_at is not None or next_run_at is None
            cursor = last_run_at or next_run_at or window_start
            if (not skip_anchor) and window_start <= cursor < window_end:
                yield cursor.astimezone(current_tz) if cursor.tzinfo else cursor
                count += 1
            # 陈旧锚点不能逐拍追赶到窗口。cron 是墙钟规则；当锚点早于窗口时，
            # 从 window_start 前 1 微秒取下一拍，既是 O(1) 快进，也能保留恰好
            # 命中 window_start 的 occurrence。
            if cursor < window_start:
                base_local = (
                    window_start.astimezone(tz) - timedelta(microseconds=1)
                )
            else:
                # croniter 从「严格晚于 base」取下一拍；base 用锚点的本地墙钟。
                base_local = cursor.astimezone(tz)
            itr = Croniter(cron_expr, base_local)
            while count < max_count:
                nxt = itr.get_next(datetime)
                if dj_tz.is_naive(nxt):
                    nxt = tz.localize(nxt)
                nxt = nxt.astimezone(current_tz)
                if nxt >= window_end:
                    break
                if nxt >= window_start:
                    yield nxt
                    count += 1
        except Exception:
            logger.warning(
                "schedule preview cron 展开失败: expr=%s", cron_expr, exc_info=True
            )
        return

    return


def schedule_preview_window_calendar_days(
    from_dt: datetime,
    to_dt: datetime,
) -> int:
    """按请求中保留的日历日期计算窗口跨度，不受 DST 23/25 小时日影响。"""
    return (to_dt.date() - from_dt.date()).days


def validate_schedule_preview_window(from_dt: datetime, to_dt: datetime) -> None:
    """校验 [from,to)：最多 42 个日历日，绝对时长最多 43 天。"""
    from django.utils import timezone as dj_tz

    if dj_tz.is_naive(from_dt) or dj_tz.is_naive(to_dt):
        raise ValueError("from/to 必须是 timezone-aware ISO datetime")
    if to_dt <= from_dt:
        raise ValueError("to 必须大于 from")
    # offset 可由调用方提供；绝对时长兜底阻止极端 offset 绕过日历日约束。
    if to_dt - from_dt > timedelta(days=SCHEDULE_PREVIEW_MAX_WINDOW_DAYS + 1):
        raise ValueError("预览窗口绝对时长不得超过 43 天")
    if (
        schedule_preview_window_calendar_days(from_dt, to_dt)
        > SCHEDULE_PREVIEW_MAX_WINDOW_DAYS
    ):
        raise ValueError(
            f"预览窗口最长 {SCHEDULE_PREVIEW_MAX_WINDOW_DAYS} 个日历日"
        )


def _preview_timezone(trigger_type: str, trigger_config: dict | None) -> str:
    """返回响应元数据中的稳定 IANA 时区；缺失/非法统一为 UTC。

    interval/at 的调度本身不是墙钟规则，不能借用 cron 的 Django 默认时区。
    """
    cfg = trigger_config or {}
    raw = cfg.get("timezone")
    if isinstance(raw, str) and raw.strip():
        tz_name = raw.strip()
        try:
            import pytz

            pytz.timezone(tz_name)
            return tz_name
        except pytz.UnknownTimeZoneError:
            pass
    if trigger_type == "cron":
        return default_cron_timezone()
    return "UTC"


def build_schedule_preview(
    trackers,
    *,
    from_dt: datetime,
    to_dt: datetime,
    now: Optional[datetime] = None,
) -> dict:
    """把可访问 Tracker 列表展开为虚拟 occurrence 列表。

    只保留 status=active 且 trigger_type ∈ {cron, interval, at}。
    有效窗口为 [max(from, now), to)；触顶单任务 / 总量上限时 truncated=true。
    不泄漏 trigger_config。
    """
    from django.utils import timezone as dj_tz

    validate_schedule_preview_window(from_dt, to_dt)
    if now is None:
        now = dj_tz.now()
    elif dj_tz.is_naive(now):
        now = dj_tz.make_aware(now)

    effective_start = from_dt if from_dt > now else now
    if effective_start >= to_dt:
        return {"occurrences": [], "truncated": False}

    time_triggers = {"cron", "interval", "at"}
    per_limit = SCHEDULE_PREVIEW_PER_TRACKER_LIMIT
    total_limit = SCHEDULE_PREVIEW_TOTAL_LIMIT

    # 流式扫描全部可访问任务，但只保留首个 occurrence 最早的 N+1 个任务。
    # 任一被丢弃任务的首点都不可能进入全局前 N；内存恒为 O(total_limit)。
    candidate_limit = total_limit + 1
    candidate_heap: list[tuple[float, int, datetime, str, dict]] = []
    streaming_iterator = getattr(trackers, "iterator", None)
    if callable(streaming_iterator):
        tracker_iter = streaming_iterator(chunk_size=SCHEDULE_PREVIEW_QUERY_CHUNK_SIZE)
    else:
        tracker_iter = iter(trackers)

    for tracker in tracker_iter:
        status = getattr(tracker, "status", None)
        trigger_type = (getattr(tracker, "trigger_type", None) or "").strip()
        if status != "active" or trigger_type not in time_triggers:
            continue

        config = getattr(tracker, "trigger_config", None) or {}
        occurrence_iter = iter(
            iter_schedule_occurrences(
                trigger_type,
                config,
                next_run_at=getattr(tracker, "next_run_at", None),
                last_run_at=getattr(tracker, "last_run_at", None),
                created_at=getattr(tracker, "created_at", None),
                window_start=effective_start,
                window_end=to_dt,
                max_count=per_limit + 1,
            )
        )
        first = next(occurrence_iter, None)
        if first is None:
            continue

        workspace = getattr(tracker, "workspace", None)
        space_name = getattr(workspace, "name", None) if workspace is not None else None
        if not isinstance(space_name, str) or not space_name:
            space_name = None
        tracker_id = str(tracker.id)
        state = {
            "iterator": occurrence_iter,
            "emitted": 0,
            "tracker_id": tracker_id,
            "name": getattr(tracker, "name", "") or "",
            "space_id": (
                str(tracker.workspace_id)
                if getattr(tracker, "workspace_id", None) is not None
                else None
            ),
            "space_name": space_name,
            "status": status,
            "trigger_type": trigger_type,
            "timezone": _preview_timezone(trigger_type, config),
        }
        tracker_id_int = int(tracker_id.replace("-", ""), 16)
        # Python 3.11 只有 min-heap；负 timestamp / UUID 让根节点成为“最晚”候选。
        candidate = (
            -first.timestamp(),
            -tracker_id_int,
            first,
            tracker_id,
            state,
        )
        if len(candidate_heap) < candidate_limit:
            heapq.heappush(candidate_heap, candidate)
        else:
            worst = candidate_heap[0]
            if (first, tracker_id) < (worst[2], worst[3]):
                heapq.heapreplace(candidate_heap, candidate)

    # 对有界候选做 k-way merge；堆键保证 scheduled_at、tracker_id 稳定排序。
    heap: list[tuple[datetime, str, dict]] = [
        (candidate[2], candidate[3], candidate[4])
        for candidate in candidate_heap
    ]
    heapq.heapify(heap)
    occurrences: list[dict] = []
    truncated = False
    while heap and len(occurrences) < total_limit:
        scheduled_at, tracker_id, state = heapq.heappop(heap)
        occurrences.append(
            {
                "tracker_id": tracker_id,
                "name": state["name"],
                "space_id": state["space_id"],
                "space_name": state["space_name"],
                "scheduled_at": scheduled_at.isoformat(),
                "status": state["status"],
                "trigger_type": state["trigger_type"],
                "timezone": state["timezone"],
            }
        )
        state["emitted"] += 1

        nxt = next(state["iterator"], None)
        if state["emitted"] < per_limit:
            if nxt is not None:
                heapq.heappush(heap, (nxt, tracker_id, state))
        elif nxt is not None:
            # 单任务确有第 201 个点；不入堆，但准确标记截断。
            truncated = True

    # 总量 N 个之后堆内仍有候选，才表示确有额外 occurrence。
    if heap:
        truncated = True

    return {"occurrences": occurrences, "truncated": truncated}
