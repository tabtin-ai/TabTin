"""通知中心用户可见文案。

业务事件只负责提供事实字段；本模块统一把事实转换成产品文案，并在字段缺失时
使用安全降级文案，避免把内部事件名、裸 ID 或空占位暴露给用户。
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any


ROLE_LABELS = {
    "owner": "所有者",
    "admin": "管理员",
    "editor": "成员",
    "member": "成员",
    "viewer": "访客",
}

PERMISSION_LABELS = {
    "viewer": "可查看",
    "editor": "可编辑",
    "admin": "可管理",
    "owner": "所有者",
}

RESOURCE_TYPE_LABELS = {
    "doc": "文档",
    "table": "多维表格",
    "slide": "演示文稿",
    "video": "视频",
    "canvas": "画布",
    "memo": "碎片",
    "memo_collection": "碎片集",
    "site": "站点",
    "storage": "云文档存储",
}

REASON_LABELS = {
    "insufficient_balance": "账户余额不足",
    "multiple_failed_invoices": "存在多笔扣款失败的账单",
    "payment_method_invalid": "付款方式已失效",
    "payment_method_expired": "付款方式已失效",
    "original_account_unavailable": "原付款账户不可用",
    "platform_callback_failed": "支付平台未能完成退款",
    "organization_billing_guard": "账户状态不满足计费条件",
}


def _text(source: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        value = source.get(key)
        if value not in (None, ""):
            return str(value).strip()
    return ""


def _decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return number if number.is_finite() else None


def _quantity(value: Any) -> str:
    number = _decimal(value)
    if number is None:
        return ""
    normalized = number.quantize(Decimal("1")) if number == number.to_integral() else number.normalize()
    return f"{normalized:,}"


def _money(value: Any) -> str:
    number = _decimal(value)
    return f"{number:,.2f}" if number is not None else ""


def _date_label(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = date.fromisoformat(raw[:10])
    except ValueError:
        return ""
    return f"{parsed.year} 年 {parsed.month} 月 {parsed.day} 日"


def _bytes_label(value: Any) -> str:
    number = _decimal(value)
    if number is None or number < 0:
        return ""
    units = ((Decimal(1024) ** 4, "TB"), (Decimal(1024) ** 3, "GB"), (Decimal(1024) ** 2, "MB"))
    for divisor, unit in units:
        if number >= divisor:
            amount = number / divisor
            rendered = f"{amount:,.1f}".rstrip("0").rstrip(".")
            return f"{rendered} {unit}"
    return f"{_quantity(number)} B"


def _reason(payload: Mapping[str, Any]) -> str:
    raw = _text(payload, "failure_reason", "reason", "last_error_code", "error_code")
    return REASON_LABELS.get(raw, "系统暂时无法完成处理")


def _role(value: Any) -> str:
    raw = str(value or "").strip().lower()
    return ROLE_LABELS.get(raw, "")


def _permission(value: Any) -> str:
    raw = str(value or "").strip().lower()
    return PERMISSION_LABELS.get(raw, "")


def _preview(value: Any, limit: int = 120) -> str:
    normalized = " ".join(str(value or "").split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[:limit - 1].rstrip()}…"


def _resource_title(metadata: Mapping[str, Any]) -> str:
    return _text(metadata, "resource_title") or "未命名资源"


def _resource_type(metadata: Mapping[str, Any]) -> str:
    raw = _text(metadata, "resource_type")
    return RESOURCE_TYPE_LABELS.get(raw, "资源")


def _format_resource_shared(
    title: str,
    body: str,
    metadata: Mapping[str, Any],
) -> tuple[str, str]:
    action = _text(metadata, "action")
    resource_title = _resource_title(metadata)
    if action == "permission_changed":
        before = _permission(metadata.get("permission_from"))
        after = _permission(metadata.get("permission_to"))
        detail = (
            f"你的权限已由“{before}”调整为“{after}”。"
            if before and after
            else "你的资源权限已完成调整。"
        )
        return f"「{resource_title}」的权限已变更", detail
    if action == "removed":
        return f"你已被移出「{resource_title}」", f"你已无法继续访问该{_resource_type(metadata)}。"
    if action == "auto_removed":
        organization_name = _text(metadata, "organization_name")
        detail = (
            f"因你已离开组织「{organization_name}」，系统已自动移除你的访问权限。"
            if organization_name
            else "因你已离开所属组织，系统已自动移除你的访问权限。"
        )
        return f"你对「{resource_title}」的访问权限已移除", detail
    if action == "auto_removed_summary":
        member_name = _text(metadata, "removed_user_name") or "离队成员"
        count = _quantity(metadata.get("total_removed"))
        detail = (
            f"系统已从 {count} 个资源中移除该成员的协作权限。"
            if count
            else "系统已移除该成员的资源协作权限。"
        )
        return f"已清理{member_name}的资源协作关系", detail
    if action == "owner_reassigned_summary":
        member_name = _text(metadata, "reassigned_user_name") or "离队成员"
        count = _quantity(metadata.get("total_reassigned"))
        detail = (
            f"{count} 个资源已转交给组织所有者。"
            if count
            else "相关资源已转交给组织所有者。"
        )
        return f"{member_name}创建的资源已完成转交", detail
    return title, body


def _format_organization(
    notification_type: str,
    title: str,
    body: str,
    metadata: Mapping[str, Any],
) -> tuple[str, str]:
    organization_name = _text(metadata, "organization_name")
    organization_label = f"「{organization_name}」" if organization_name else "该组织"
    if notification_type == "organization.invitation":
        inviter = _text(metadata, "inviter_name") or "组织管理员"
        role = _role(metadata.get("role"))
        detail = (
            f"{inviter}邀请你以“{role}”身份加入该组织。"
            if role
            else f"{inviter}邀请你加入该组织。"
        )
        return f"你收到来自{organization_label}的邀请", detail
    if notification_type == "organization.invitation.responded":
        responder = _text(metadata, "responder_name") or "受邀成员"
        if metadata.get("accepted") is True:
            role = _role(metadata.get("role"))
            detail = f"对方已加入{organization_label}" + (f"，角色为“{role}”。" if role else "。")
            return f"{responder}已接受组织邀请", detail
        return f"{responder}已拒绝组织邀请", f"对方没有加入{organization_label}。"
    if notification_type == "organization.invitation.cancelled":
        operator = _text(metadata, "operator_name")
        detail = (
            f"该邀请已由{operator}取消，无需继续处理。"
            if operator
            else "该邀请已被取消，无需继续处理。"
        )
        return f"加入{organization_label}的邀请已取消", detail
    if notification_type == "organization.invitation.sync":
        return (
            f"加入{organization_label}的邀请已处理",
            "该邀请已在其他入口完成处理，无需重复操作。",
        )
    if notification_type == "member_added":
        member_added_title = (
            f"你已被添加到组织{organization_label}"
            if organization_name
            else "你已被添加到组织"
        )
        return member_added_title, ""
    if notification_type == "member_removed":
        return f"你已被移出{organization_label}", "你将无法继续访问该组织及其组织资源。"
    if notification_type == "role_changed":
        before = _role(metadata.get("old_role"))
        after = _role(metadata.get("new_role"))
        detail = (
            f"角色已由“{before}”调整为“{after}”。"
            if before and after
            else "你的组织角色已完成调整。"
        )
        return f"你在{organization_label}的角色已变更", detail
    if notification_type == "ownership_transfer":
        before = _text(metadata, "previous_owner_name")
        after = _text(metadata, "new_owner_name")
        detail = (
            f"组织所有者已由{before}变更为{after}。"
            if before and after
            else "组织所有者已完成变更。"
        )
        return f"{organization_label}的所有权已转移", detail
    return title, body


def format_notification_copy(
    notification_type: str,
    title: str,
    body: str,
    metadata: Mapping[str, Any] | None,
) -> tuple[str, str]:
    """格式化非自动化通知；未知事件保持调用方原文。"""
    meta = metadata or {}
    if meta.get("canonical_display") is True:
        return title, body
    if notification_type == "resource_shared":
        return _format_resource_shared(title, body, meta)
    if notification_type == "resource_access_request":
        applicant = _text(meta, "requester_name") or "有成员"
        resource_title = _resource_title(meta)
        permission = _permission(meta.get("role")) or "访问"
        return f"{applicant}申请访问「{resource_title}」", f"对方申请“{permission}”权限。"
    if notification_type in {"tabdoc.comment.mention", "tabdata.comment.mention"}:
        preview = _preview(body)
        return title, f"评论：“{preview}”" if preview else "你在一条评论中被提到了。"
    if notification_type == "tabdata.record.user_assigned":
        resource_title = _resource_title(meta)
        field_names = meta.get("field_names")
        field_name = (
            "、".join(str(value).strip() for value in field_names if str(value).strip())
            if isinstance(field_names, list)
            else ""
        ) or "成员字段"
        actor = _text(meta, "actor_name") or "有成员"
        return (
            f"你被设为多维表格「{resource_title}」的{field_name}",
            f"{actor}在多维表格「{resource_title}」中进行了设置。",
        )
    if notification_type.startswith("organization.invitation") or notification_type in {
        "member_added",
        "member_removed",
        "role_changed",
        "ownership_transfer",
    }:
        return _format_organization(notification_type, title, body, meta)
    return title, body


def format_account_notification_copy(
    event_type: str,
    payload: Mapping[str, Any],
) -> tuple[str, str]:
    """把账户事实格式化为标题与详情，缺少字段时使用安全降级。"""
    if event_type == "balance_low":
        critical = _text(payload, "level") == "critical"
        title = "点券余额严重不足" if critical else "点券余额不足"
        current = _quantity(payload.get("current_balance"))
        threshold = _quantity(payload.get("threshold"))
        if current and threshold and not critical:
            return title, f"当前可用 {current} 点券，已低于预警值 {threshold} 点券。"
        if current and critical:
            return title, f"当前可用 {current} 点券，继续消耗可能导致付费任务停止。"
        return title, "当前可用点券已低于安全阈值，请及时处理。"
    if event_type in {"budget_warning", "budget_critical"}:
        limit = _quantity(payload.get("budget_limit"))
        title = "月度花费达到上限" if event_type == "budget_critical" else "月度花费接近上限"
        body = (
            f"本月点券花费已接近配置上限 {limit} 点券。"
            if limit
            else "本月点券花费已达到配置的预警范围。"
        )
        if event_type == "budget_critical":
            body = (
                f"本月点券花费已达到配置上限 {limit} 点券。"
                if limit
                else "本月点券花费已达到配置上限。"
            )
        return title, body
    if event_type == "billing_blocked":
        return "组织计费已被阻断", f"因{_reason(payload)}，需要付费的任务暂时无法继续执行。"
    if event_type == "degradation_alert":
        return "计费服务出现异常", "部分计费能力暂时受到影响，系统正在处理中。"
    if event_type == "credits_recharged":
        amount = _quantity(payload.get("amount"))
        detail = f"本次到账 +{amount} 点券。" if amount else "本次点券充值已确认到账。"
        return "点券充值已到账", detail
    if event_type == "cash_recharged":
        amount = _money(payload.get("amount_cny"))
        detail = f"本次到账 +{amount} 元。" if amount else "本次现金充值已确认到账。"
        return "现金充值已到账", detail
    if event_type == "membership_expiring":
        plan = _text(payload, "tier_name") or "会员方案"
        end_date = _date_label(payload.get("end_date"))
        title = f"{plan}将于{end_date}到期" if end_date else f"{plan}即将到期"
        return title, "到期后部分会员权益将受到影响。请及时完成续费。"
    if event_type == "membership_expired":
        plan = _text(payload, "old_tier_name") or "会员方案"
        next_plan = _text(payload, "new_tier_name")
        body = (
            f"当前已切换为{next_plan}，部分会员权益已停止。"
            if next_plan
            else "部分会员权益已停止。"
        )
        return f"{plan}已到期", body
    if event_type == "auto_renew_failed":
        plan = _text(payload, "tier_name") or "会员方案"
        return (
            f"{plan}自动续费失败",
            f"失败原因：{_reason(payload)}。请检查账户状态后重新续费。",
        )
    if event_type == "membership_downgraded_overlimit":
        items = payload.get("exceeded_items")
        first = items[0] if isinstance(items, list) and items and isinstance(items[0], Mapping) else {}
        resource_type = RESOURCE_TYPE_LABELS.get(_text(first, "type", "resource_type"), "资源")
        current = _quantity(first.get("current"))
        limit = _quantity(first.get("limit"))
        detail = (
            f"{resource_type}已使用 {current}，当前上限为 {limit}。"
            if current and limit
            else "部分资源已超过当前方案上限。"
        )
        return "会员降级后存在资源超限", detail
    if event_type in {"invoice_refunded", "platform_refund_completed"}:
        nested = payload.get("refund_result") if isinstance(payload.get("refund_result"), Mapping) else {}
        amount = _money(payload.get("refund_amount") or nested.get("refund_amount"))
        invoice = _text(payload, "invoice_no")
        detail = f"本次退款 +{amount} 元" if amount else "本次退款已完成"
        detail += f"，对应账单 {invoice}。" if invoice else "。"
        return "退款已完成", detail
    if event_type == "invoice_collection_succeeded":
        amount = _money(payload.get("total_amount"))
        invoice = _text(payload, "invoice_no")
        detail = f"本次扣款 -{amount} 元" if amount else "本次账单扣款已完成"
        detail += f"，对应账单 {invoice}。" if invoice else "。"
        return "账单扣款成功", detail
    if event_type == "invoice_collection_failed":
        return "账单扣款失败", f"账单扣款未完成。失败原因：{_reason(payload)}。"
    if event_type == "platform_refund_failed":
        return "退款处理失败", f"退款未完成。失败原因：{_reason(payload)}。"
    if event_type == "refund_partial_failure":
        return "退款仅完成一部分", "部分退款暂未完成，系统正在继续处理。"
    if event_type in {"storage_warning", "storage_critical"}:
        used = _bytes_label(payload.get("used_bytes"))
        total = _bytes_label(payload.get("package_bytes"))
        critical = event_type == "storage_critical"
        title = "存储空间严重不足" if critical else "存储空间即将用满"
        if used and total:
            ending = "上传和创建资源可能受到限制。" if critical else "请及时清理或扩充空间。"
            return title, f"已使用 {used}/{total}，{ending}"
        return title, "可用存储空间已低于安全阈值，请及时处理。"
    if event_type == "storage_package_expiring":
        package = _text(payload, "package_name") or "存储包"
        end_date = _date_label(payload.get("end_at"))
        title = f"{package}将于{end_date}到期" if end_date else f"{package}即将到期"
        return title, "到期后可用存储空间将减少，请及时续费。"
    if event_type == "storage_auto_renew_failed":
        package = _text(payload, "package_name") or "存储包"
        return (
            f"{package}自动续费失败",
            f"失败原因：{_reason(payload)}。请检查账户状态后重新续费。",
        )
    if event_type in {"member_budget_warning", "member_budget_exhausted"}:
        consumed = _quantity(payload.get("consumed"))
        limit = _quantity(payload.get("limit"))
        remaining = ""
        consumed_value = _decimal(payload.get("consumed"))
        limit_value = _decimal(payload.get("limit"))
        if consumed_value is not None and limit_value is not None:
            remaining = _quantity(max(Decimal("0"), limit_value - consumed_value))
        if event_type == "member_budget_warning":
            detail = (
                f"已使用 {consumed}/{limit} 点券，剩余 {remaining} 点券。"
                if consumed and limit and remaining
                else "你的成员预算已进入预警范围。"
            )
            return "你的预算即将用尽", detail
        return "你的预算已用尽", "后续需要付费的任务可能无法继续执行。"
    return "账户状态已更新", "请进入账户与用量页面查看详情。"


__all__ = ["format_account_notification_copy", "format_notification_copy"]
