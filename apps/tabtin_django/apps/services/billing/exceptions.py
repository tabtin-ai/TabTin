"""
计费模块异常层次。

所有 billing 相关的可预期业务异常都应继承 BillingError，
以便上层代码通过 ``except BillingError`` 统一捕获。

运行时防护异常（请求链路上抛出的）：
- BillingBlockedError   — 会员过期/异常告警阻断 (guard_service.py)
- BudgetExceededException — 预算超限硬阻断 (llm/services/billing.py)
- ServiceDisabledError  — 管理员关闭服务 (service_guard.py)
- MemberBudgetExceededError — 成员级限额/模型等级阻断 (member_budget_service.py)
- InsufficientBalanceError — 钱包余额不足 (billed_call.py)

离线结算异常：
- BillingSettlementError
- BillingCollectionError
"""


class BillingError(Exception):
    """计费模块通用基类异常。

    所有计费相关可预期异常的根类。上层代码可通过
    ``except BillingError`` 统一兜底所有计费阻断，
    再按子类做差异化处理。
    """

    def __init__(self, message: str = "", *, code: str = "BILLING_ERROR"):
        self.code = code
        super().__init__(message)


class BillingSettlementError(BillingError):
    """日聚合 / 月账单结算过程中的可预期错误"""

    def __init__(self, message: str = ""):
        super().__init__(message, code="SETTLEMENT_ERROR")


class BillingCollectionError(BillingError):
    """扣款回收过程中的可预期错误"""

    def __init__(self, message: str = ""):
        super().__init__(message, code="COLLECTION_ERROR")
