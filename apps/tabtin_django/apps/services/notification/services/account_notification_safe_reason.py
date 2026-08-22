"""将内部失败原因收敛为允许展示给用户的窄语义。"""

from __future__ import annotations


SAFE_REASON_TEXT = {
    "insufficient_balance": "账户余额不足",
    "payment_method_unavailable": "付款方式不可用",
    "payment_declined": "付款未通过",
    "provider_unavailable": "支付服务暂时不可用",
    "timeout": "处理超时，请稍后重试",
    "account_restricted": "账户状态限制了本次处理",
    "unknown": "暂时无法完成处理",
}

SAFE_CAPABILITY_TEXT = {
    "llm": "AI 模型调用",
    "llm.billing": "AI 模型调用",
    "model_inference": "AI 模型调用",
    "storage": "存储服务",
    "storage.billing": "存储服务",
    "payment": "支付服务",
    "payment.billing": "支付服务",
}


def resolve_safe_reason(value: object) -> str:
    """只解析明确允许的稳定 code，未知输入统一使用安全文案。"""
    if not isinstance(value, str):
        return SAFE_REASON_TEXT["unknown"]
    return SAFE_REASON_TEXT.get(value.strip(), SAFE_REASON_TEXT["unknown"])


def resolve_safe_capability(*values: object) -> str:
    """将内部 meter/biz key 映射为产品能力名，不回显未知 key。"""
    for value in values:
        if not isinstance(value, str):
            continue
        resolved = SAFE_CAPABILITY_TEXT.get(value.strip())
        if resolved:
            return resolved
    return "部分计费能力"
