"""Tracker / 自动化预置场景模板库。

内置模板是通用「任务蓝图」：提供名称、指令与默认 cron，不硬编码不存在的
业务实体。Agent / Workspace / 敏感能力由创建弹窗确认。

只读查询：GET /api/tracker/templates。不提供 create-from-template 写接口，
也不落模板数据库；新建 tracker 仍走现有 create + activate。

字段：
- id / version / name / description / category / icon_key
- default_name / instructions
- trigger_type / trigger_config（expression|cron_expression + timezone）
- requirements（说明文案，不做第三方连接校验）

locale：可选查询参数；默认 zh-CN。文案字段按 locale 浅拷贝本地化，
cron / timezone / category / icon / id / version 不变。
"""

from __future__ import annotations

from copy import copy

_LOCALIZED_TEXT_KEYS = (
    "name",
    "description",
    "default_name",
    "instructions",
    "requirements",
)
_HIDDEN_TEMPLATE_IDS = {"daily_email_summary"}

GOAL_TEMPLATES = [
    {
        "id": "ai_news_digest",
        "version": "1",
        "name": "AI 新闻推送",
        "description": "定期汇总值得关注的 AI 行业动态，整理成简洁摘要",
        "category": "content",
        "icon_key": "newspaper",
        "default_name": "AI 新闻推送",
        "instructions": (
            "汇总自上次执行以来值得关注的 AI 行业动态，整理成简洁摘要。"
            "优先覆盖模型发布、产品动态与重要开源进展；每条标明信息来源与时间；"
            "不要编造未核实的事实。输出结构清晰，便于快速扫读。"
        ),
        "trigger_type": "cron",
        "trigger_config": {
            "expression": "0 9 * * 1-5",
            "timezone": "Asia/Shanghai",
        },
        "requirements": "需要可访问公开信息源的 Agent；推送渠道请在指令中自行说明。",
    },
    {
        "id": "daily_report_summary",
        "version": "1",
        "name": "日报总结",
        "description": "在约定时间汇总当日进展，生成结构化日报",
        "category": "ops",
        "icon_key": "file-text",
        "default_name": "日报总结",
        "instructions": (
            "根据当前 Workspace 内可访问的任务、文档与近期对话，汇总今日工作进展。"
            "按「完成 / 进行中 / 风险与阻塞 / 明日计划」组织输出；信息不足时明确标注缺口，"
            "不要臆造具体业务数据。"
        ),
        "trigger_type": "cron",
        "trigger_config": {
            "expression": "0 18 * * 1-5",
            "timezone": "Asia/Shanghai",
        },
        "requirements": "需要绑定可访问相关 Workspace 内容的 Agent。",
    },
    {
        "id": "daily_standup_meeting",
        "version": "1",
        "name": "每日总结会议",
        "description": "生成站会式简报，帮助团队对齐进度与阻塞",
        "category": "collaboration",
        "icon_key": "users",
        "default_name": "每日总结会议",
        "instructions": (
            "生成一份站会式每日简报：昨日完成、今日计划、阻塞与需要协助的事项。"
            "语气简洁、条目化；无法确认的信息写成待确认问题，而不是当作事实。"
        ),
        "trigger_type": "cron",
        "trigger_config": {
            "expression": "0 10 * * 1-5",
            "timezone": "Asia/Shanghai",
        },
        "requirements": "需要绑定执行 Agent；团队成员与渠道由你在创建时确认。",
    },
    {
        "id": "group_chat_digest",
        "version": "1",
        "name": "群聊信息摘要",
        "description": "归纳近期群聊要点、待办与未决问题",
        "category": "collaboration",
        "icon_key": "messages-square",
        "default_name": "群聊信息摘要",
        "instructions": (
            "归纳近期群聊中的关键信息：决策结论、行动项（负责人/截止若可知）、未决问题。"
            "忽略寒暄与重复内容；信息不足时说明缺少哪些上下文，不要假装已接入具体群。"
        ),
        "trigger_type": "cron",
        "trigger_config": {
            "expression": "0 20 * * *",
            "timezone": "Asia/Shanghai",
        },
        "requirements": "需要 Agent 具备读取目标会话的权限；具体群/频道在指令中说明。",
    },
    {
        "id": "wiki_compile",
        "version": "1",
        "name": "定时整理 TabDoc",
        "description": "定期整理 TabDoc 内容变更，输出结构化更新摘要",
        "category": "knowledge",
        "icon_key": "book-open",
        "default_name": "定时整理 TabDoc",
        "instructions": (
            "检查可访问 TabDoc 的近期变更，整理成结构化更新摘要："
            "新增主题、重要修订、过时内容提示。保持中立客观，不虚构未出现的页面。"
        ),
        "trigger_type": "cron",
        "trigger_config": {
            "expression": "0 2 * * *",
            "timezone": "Asia/Shanghai",
        },
        "requirements": "需要可访问目标 TabDoc 的 Agent 与 Workspace。",
    },
    {
        "id": "daily_email_summary",
        "version": "1",
        "name": "每日邮件总结",
        "description": "汇总近期邮件要点，标出需跟进事项",
        "category": "ops",
        "icon_key": "mail",
        "default_name": "每日邮件总结",
        "instructions": (
            "汇总近期邮件中的关键信息：紧急事项、需回复、可归档。"
            "每条给出主题、发送方与一句话摘要；无法访问邮箱时明确说明，不要假装已连接第三方邮箱。"
        ),
        "trigger_type": "cron",
        "trigger_config": {
            "expression": "0 9 * * 1-5",
            "timezone": "Asia/Shanghai",
        },
        "requirements": "需要已授权邮件读取能力的 Agent；本模板不校验第三方连接状态。",
    },
]

# en-US 文案覆盖（仅本地化字段）。英文指令遵循：不编造、缺权限明确说明。
_EN_US_TEXT: dict[str, dict[str, str]] = {
    "ai_news_digest": {
        "name": "AI News Digest",
        "description": "Periodically summarize noteworthy AI industry updates into a concise brief",
        "default_name": "AI News Digest",
        "instructions": (
            "Summarize noteworthy AI industry developments since the last run into a concise brief. "
            "Prioritize model releases, product updates, and important open-source progress; "
            "cite the source and time for each item; do not invent unverified facts. "
            "Keep the output well-structured for quick scanning."
        ),
        "requirements": (
            "Requires an Agent that can access public information sources; "
            "specify delivery channels in the instructions."
        ),
    },
    "daily_report_summary": {
        "name": "Daily Report Summary",
        "description": "At a scheduled time, summarize the day's progress into a structured daily report",
        "default_name": "Daily Report Summary",
        "instructions": (
            "Based on tasks, documents, and recent conversations accessible in the current Workspace, "
            "summarize today's work progress. Organize output as Completed / In Progress / Risks & Blockers / "
            "Tomorrow's Plan. When information is missing, clearly mark the gaps; "
            "do not invent specific business data."
        ),
        "requirements": "Requires an Agent bound with access to the relevant Workspace content.",
    },
    "daily_standup_meeting": {
        "name": "Daily Standup Brief",
        "description": "Generate a standup-style brief to align progress and blockers",
        "default_name": "Daily Standup Brief",
        "instructions": (
            "Produce a standup-style daily brief: yesterday's completed work, today's plan, "
            "blockers, and items needing help. Keep it concise and bulleted; "
            "write unconfirmed information as open questions, not as facts."
        ),
        "requirements": (
            "Requires a bound execution Agent; confirm team members and channels when creating the tracker."
        ),
    },
    "group_chat_digest": {
        "name": "Group Chat Digest",
        "description": "Summarize recent group chat highlights, action items, and open questions",
        "default_name": "Group Chat Digest",
        "instructions": (
            "Summarize key information from recent group chats: decisions, action items "
            "(owner/deadline when known), and open questions. Ignore small talk and duplicates; "
            "when context is missing, state what is unavailable—do not pretend a specific group is connected."
        ),
        "requirements": (
            "Requires an Agent with permission to read the target conversation; "
            "name the specific group/channel in the instructions."
        ),
    },
    "wiki_compile": {
        "name": "Scheduled TabDoc Digest",
        "description": "Periodically organize TabDoc changes into a structured update digest",
        "default_name": "Scheduled TabDoc Digest",
        "instructions": (
            "Review recent changes in accessible TabDoc content and compile a structured update digest: "
            "new topics, important revisions, and outdated-content notices. Stay neutral and objective; "
            "do not invent pages that do not exist."
        ),
        "requirements": "Requires an Agent and Workspace with access to the target TabDoc.",
    },
    "daily_email_summary": {
        "name": "Daily Email Summary",
        "description": "Summarize recent email highlights and flag items that need follow-up",
        "default_name": "Daily Email Summary",
        "instructions": (
            "Summarize key information from recent emails: urgent items, needs reply, and can archive. "
            "For each item give subject, sender, and a one-line summary; "
            "if the mailbox cannot be accessed, say so clearly—do not pretend a third-party mailbox is connected."
        ),
        "requirements": (
            "Requires an Agent authorized for email read access; "
            "this template does not validate third-party connection status."
        ),
    },
}


def normalize_template_locale(locale: str | None) -> str:
    """Normalize locale query aliases to zh-CN / en-US; unknown → zh-CN."""
    if not locale or not str(locale).strip():
        return "zh-CN"
    key = str(locale).strip().replace("_", "-").lower()
    if key in ("en", "en-us"):
        return "en-US"
    if key in ("zh", "zh-cn"):
        return "zh-CN"
    return "zh-CN"


def _localize_template(template: dict, locale: str) -> dict:
    """Return a shallow copy with localized text fields; never mutate GOAL_TEMPLATES."""
    out = copy(template)
    out["trigger_config"] = dict(template.get("trigger_config") or {})
    if locale == "en-US":
        overlay = _EN_US_TEXT.get(template["id"])
        if overlay:
            for key in _LOCALIZED_TEXT_KEYS:
                if key in overlay:
                    out[key] = overlay[key]
    return out


def get_templates(
    category: str | None = None,
    format: str | None = None,
    locale: str | None = None,
) -> list[dict]:
    resolved = normalize_template_locale(locale)
    result = [t for t in GOAL_TEMPLATES if t["id"] not in _HIDDEN_TEMPLATE_IDS]
    if category:
        result = [t for t in result if t.get("category") == category]
    if format:
        # 历史查询参数保留；新模板不再声明 format，按精确匹配过滤。
        result = [t for t in result if t.get("format") == format]
    return [_localize_template(t, resolved) for t in result]


def get_template_by_id(template_id: str, locale: str | None = None) -> dict | None:
    if template_id in _HIDDEN_TEMPLATE_IDS:
        return None
    resolved = normalize_template_locale(locale)
    for t in GOAL_TEMPLATES:
        if t["id"] == template_id:
            return _localize_template(t, resolved)
    return None
