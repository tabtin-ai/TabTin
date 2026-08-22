# 会员体系模块
# 注意：不要在这里导入models，会导致Django应用注册错误

__all__ = [
    "QuotaService",
    "OrganizationMembershipService",
]


def __getattr__(name):
    """懒加载服务类，避免循环导入"""
    if name == "QuotaService":
        from .services import QuotaService
        return QuotaService
    if name == "OrganizationMembershipService":
        from .services import OrganizationMembershipService
        return OrganizationMembershipService
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
