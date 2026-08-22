"""
User Portrait 面向用户的错误文案映射（v0.2）。

  - 错误的「技术原文」进 logger（含 LLM scene_key、内部 traceback、stack 等）
  - 错误的「用户视角字段」（``portrait.last_distill_error`` + API 4xx
    response.message）必须是短中文人话——不暴露 LLM / scene / organization_id
    这种内部术语，并尽量给出"下一步指引"

为什么要单独成文件、不挂在 ``error_codes.py`` 里：
  - ``error_codes.py`` 是错误码 + ServiceError 异常的"骨架定义"，跨模块共享语义
  - 本模块只负责"骨架 → 用户文案"的最后一跳，对应业务上的产品决策
    （比如要不要给"再试一次"、术语怎么说），未来产品会反复 tune；

如果未来要做错误码差异化的 UI（例如"模型未配置"显示"联系管理员"按钮，
"网络问题"显示"重试"按钮），UI 组件可以基于 ServiceError.code 做分支——
本模块的 ``UserMessage.code`` 跟 ``ErrorCode`` 一一对应，前端 i18n 的
``userPortrait.errors.<code>`` 键也按本模块给出的 code 命名，便于对齐。
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from apps.user_portrait.error_codes import ErrorCode


# ── 蒸馏失败子类（distill 流程内部细分） ─────────────
#
# DISTILL_FAILED 在错误码层是一个，但用户感知层面有多种"失败原因"。
# 这里的常量只用于 distill_service 内部决定要给哪条人话；不进 ErrorCode 是
# 因为 ErrorCode 想保持"对外稳定"——这层"失败子类"是 distill 实现细节，
# 未来 LLM 抽象层换实现时这些子类也会跟着变。

class DistillFailureKind:
    """蒸馏失败的产品语义子类型。"""

    EMPTY_OUTPUT = "empty_output"          # LLM 调用成功但返回空文本
    INCOMPLETE_OUTPUT = "incomplete_output"  # 5 段中至少缺 1 段
    MODEL_UNAVAILABLE = "model_unavailable"  # scene 模型不可用 / API key 失效
    LLM_CALL_FAILED = "llm_call_failed"     # chat 调用返回 success=False
    UNEXPECTED = "unexpected"               # 其它兜底（防御性）


# ── 主映射表 ──────────────────────────────────────────
#
# 文案约束（产品规范）：
#   1. 短：≤ 30 字
#   2. 中文，不出现英文术语
#   3. 不暴露内部术语（LLM / scene / organization_id / portrait 等）
#   4. 给"下一步指引"：能重试的说"稍后重试"，需要管理员的说"联系管理员"
#   5. 蒸馏失败要透出"已为你保留旧画像"——降低用户焦虑

_API_ERROR_MESSAGES: Dict[str, str] = {
    # ── 认证 / 授权 ──
    ErrorCode.UNAUTHORIZED: "请先登录后再访问画像",
    ErrorCode.PERMISSION_DENIED: "你不是该组织的成员，无法访问画像",

    # ── 输入校验 ──
    ErrorCode.INVALID_HINT: "请填写你想告诉 Tin 的内容",
    ErrorCode.INVALID_ORGANIZATION_ID: "组织信息有误，请刷新后重试",
    ErrorCode.INVALID_AGENT_ID: "Agent 信息有误，请刷新后重试",
    ErrorCode.INVALID_INPUT: "提交内容有误，请检查后重试",

    # ── 授权 ──
    # 非该 Agent owner——区别于"非组织成员"，避免误导（用户可能是成员、只是非该 Agent 主人）
    ErrorCode.AGENT_ACCESS_DENIED: "这个 Agent 不属于你，无法查看它对你的画像",

    # ── 状态冲突 ──
    ErrorCode.DISTILL_IN_PROGRESS: "整理任务进行中，请稍候再试",
    ErrorCode.MEMORY_DISABLED: "记忆功能已关闭，无法整理或提交画像",

    # ── 资源不存在 ──
    ErrorCode.PORTRAIT_NOT_FOUND: "暂未找到这份画像，请稍后重试",

    # ── 蒸馏失败兜底（细化版本由 humanize_distill_failure 处理）──
    ErrorCode.DISTILL_FAILED: "整理失败，已为你保留旧画像，可稍后重试",
}


_DISTILL_FAILURE_MESSAGES: Dict[str, str] = {
    DistillFailureKind.EMPTY_OUTPUT: "这次没能整理出内容，已为你保留旧画像，可稍后重试",
    DistillFailureKind.INCOMPLETE_OUTPUT: "这次整理不完整，已为你保留旧画像，可稍后重试",
    # MODEL_UNAVAILABLE：scene 配置或 API key 问题，多半需要管理员介入
    DistillFailureKind.MODEL_UNAVAILABLE: "整理服务暂时不可用，旧画像仍在，请联系组织管理员检查",
    # LLM_CALL_FAILED：网络瞬断 / 服务侧抖动，自助重试有概率成功
    DistillFailureKind.LLM_CALL_FAILED: "整理服务暂时不可用，旧画像仍在，可稍后重试",
    DistillFailureKind.UNEXPECTED: "整理时出了点问题，已为你保留旧画像，可稍后重试",
}


# 同一 ErrorCode 在不同上下文需要不同人话时的扩展槽（v0.2 🟡-4 / 用户审）。
# 当前只有 INVALID_HINT 需要——空 vs 超长是两种用户操作。
INVALID_HINT_TOO_LONG_MESSAGE_TEMPLATE = "内容太长了，请精简到 {limit} 字以内"


# ── 公开 API ─────────────────────────────────────────


def humanize_api_error(
    code: str,
    *,
    fallback: Optional[str] = None,
    ctx: Optional[Dict[str, Any]] = None,
) -> str:
    """把 API 层的 ServiceError.code 翻成短中文人话。

    Args:
        code: ErrorCode 常量值
        fallback: 找不到映射时的兜底文案；不传则用通用兜底
        ctx: 文案模板的占位符（当前主映射表都不带占位符，预留扩展）

    Returns:
        短中文人话（≤ 30 字，无内部术语）
    """
    msg = _API_ERROR_MESSAGES.get(code)
    if not msg:
        return fallback or "请求失败，请稍后重试"
    if ctx:
        try:
            return msg.format(**ctx)
        except (KeyError, IndexError):
            return msg
    return msg


def humanize_distill_failure(
    kind: str,
    *,
    fallback: Optional[str] = None,
) -> str:
    """把蒸馏失败的子类翻成短中文人话。

    给 ``portrait.last_distill_error`` / FailedBanner 用。

    Args:
        kind: DistillFailureKind 常量值
        fallback: 子类未识别时的兜底文案

    Returns:
        短中文人话，包含"已为你保留旧画像"等用户安抚信息
    """
    msg = _DISTILL_FAILURE_MESSAGES.get(kind)
    if msg:
        return msg
    return fallback or _DISTILL_FAILURE_MESSAGES[DistillFailureKind.UNEXPECTED]


def known_api_error_codes() -> tuple[str, ...]:
    """供测试和文档用——所有当前已映射的 API 错误码。"""
    return tuple(_API_ERROR_MESSAGES.keys())


def known_distill_failure_kinds() -> tuple[str, ...]:
    """供测试和文档用——所有当前已映射的蒸馏失败子类。"""
    return tuple(_DISTILL_FAILURE_MESSAGES.keys())
